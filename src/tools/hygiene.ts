import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toToolHandler } from "../effect/tool-adapter.js";
import type { Item } from "../types.js";
import { DESTRUCTIVE, READ_ONLY, ok, refuseUnconfirmed } from "./_util.js";

const SCAN_PAGE_SIZE = 100;
const MAX_SCAN_PAGES = 20;
const MAX_EXAMPLES = 5;
const MAX_EXAMPLE_GROUP_IDS = 10;
const DEFAULT_HYGIENE_TYPES = ["Movie", "Series", "Episode"];
const CURSOR_DESCRIPTION = "The cursor uses an unkeyed hash to detect query changes. It provides no authentication or authorization.";
// Leave room for the response envelope, cursor and JSON escaping in the kit cap.
const LIST_ROW_BYTE_BUDGET = 75_000;

export const libraryInput = {
  libraryId: z.string().trim().min(1).describe("Virtual folder ItemId from jellyfin_list_libraries."),
  cursor: z.string().max(128).optional().describe("Opaque nextCursor from the same tool and query."),
};

function pagination(query: unknown[], cursor?: string) {
  const hash = createHash("sha256").update(JSON.stringify(query)).digest("base64url");
  const encode = (index: number) => Buffer.from(`${index}:${hash}`).toString("base64url");
  if (cursor === undefined) return { startIndex: 0, encode };

  const [offset] = Buffer.from(cursor, "base64url").toString().split(":");
  const startIndex = Number(offset);
  if (!Number.isInteger(startIndex) || startIndex < 1 || startIndex > 2_147_483_647
    || cursor !== encode(startIndex)) {
    throw new Error("Invalid cursor or cursor from a different query.");
  }
  return { startIndex, encode };
}

async function requireLibrary(client: JellyfinClient, libraryId: string) {
  const libraries = await client.listLibraries();
  if (!libraries.some((library) => library.ItemId?.toLowerCase() === libraryId.toLowerCase())) {
    throw new Error("Unknown libraryId. Use an ItemId from jellyfin_list_libraries.");
  }
}

type PageOptions = Parameters<JellyfinClient["listLibraryItems"]>[1];

async function getPage(client: JellyfinClient, libraryId: string, options: PageOptions) {
  const { Items: items, TotalRecordCount: total } = await client.listLibraryItems(libraryId, options);
  if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0
    || items.length > options.limit || (items.length === 0 && options.startIndex < total)) {
    throw new Error("Jellyfin returned an invalid library page. Retry the query.");
  }
  return { items, total };
}

async function scanPages(
  client: JellyfinClient,
  libraryId: string,
  startIndex: number,
  options: Omit<PageOptions, "startIndex" | "limit">,
  visit: (items: Item[]) => void | Promise<void>,
) {
  await requireLibrary(client, libraryId);
  let index = startIndex;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const { items, total } = await getPage(client, libraryId, {
      ...options, startIndex: index, limit: SCAN_PAGE_SIZE,
    });
    if (items.length) await visit(items);
    index += items.length;
    if (index >= total) return { scanned: index - startIndex, complete: true, nextIndex: null };
  }
  return { scanned: index - startIndex, complete: false, nextIndex: index };
}

function scanSummary(scan: Awaited<ReturnType<typeof scanPages>>, page: ReturnType<typeof pagination>) {
  return {
    scanned: scan.scanned,
    complete: scan.complete,
    countsAreLowerBounds: !scan.complete || page.startIndex > 0,
    nextCursor: scan.nextIndex === null ? null : page.encode(scan.nextIndex),
  };
}

function recordExample(examples: string[], id: string) {
  if (examples.length < MAX_EXAMPLES) examples.push(id);
}

const itemTypesSchema = z.array(z.string().regex(/^[a-zA-Z]+$/).max(40)).max(40);

export const missingMetadataInput = {
  ...libraryInput,
  includeItemTypes: itemTypesSchema.min(1).default(DEFAULT_HYGIENE_TYPES)
    .describe("Item types to scan. Defaults to Movie, Series and Episode."),
};

export const libraryItemsInput = {
  ...libraryInput,
  includeItemTypes: itemTypesSchema.optional()
    .describe("Jellyfin item types, such as Movie, Series or Episode."),
  limit: z.number().int().min(1).max(200).default(25),
  includePath: z.boolean().default(false),
  includeOverview: z.boolean().default(false),
};

type LibraryQuery = z.output<z.ZodObject<typeof libraryInput>>;
type MissingMetadataQuery = z.output<z.ZodObject<typeof missingMetadataInput>>;
type ListOptions = z.output<z.ZodObject<typeof libraryItemsInput>>;

export async function listLibraryItems(client: JellyfinClient, { libraryId, cursor, includeItemTypes, limit, includePath, includeOverview }: ListOptions) {
  const types = [...new Set(includeItemTypes)].sort();
  const page = pagination(["list", libraryId, types, limit, includePath, includeOverview], cursor);
  await requireLibrary(client, libraryId);
  const fields = ["ProviderIds"];
  if (includePath) fields.push("Path");
  if (includeOverview) fields.push("Overview");
  const { items, total } = await getPage(client, libraryId, {
    startIndex: page.startIndex, limit, fields, includeItemTypes: types,
  });
  const rows = [];
  let bytes = 0;
  for (const item of items) {
    const row = {
      id: item.Id,
      name: item.Name,
      type: item.Type,
      year: item.ProductionYear ?? null,
      providerIds: item.ProviderIds ?? {},
      ...(includePath ? { path: item.Path ?? null } : {}),
      ...(includeOverview ? { overview: item.Overview ?? null } : {}),
    };
    // Measure the escaped, indented row as carried in the MCP result.
    bytes += Buffer.byteLength(JSON.stringify(ok([row])));
    if (bytes > LIST_ROW_BYTE_BUDGET) break;
    rows.push(row);
  }
  if (items.length && rows.length === 0) {
    throw new Error("One library row exceeds the output budget. Disable path and overview or narrow the item types.");
  }
  const nextIndex = page.startIndex + rows.length;
  return { items: rows, total, nextCursor: nextIndex < total ? page.encode(nextIndex) : null };
}

export async function findMissingMetadata(client: JellyfinClient, { libraryId, cursor, includeItemTypes }: MissingMetadataQuery) {
  const types = [...new Set(includeItemTypes)].sort();
  const page = pagination(["metadata", libraryId, types], cursor);
  const counts = { missingOverview: 0, missingPrimaryImage: 0, missingProviderIds: 0 };
  const examples = { missingOverview: [] as string[], missingPrimaryImage: [] as string[], missingProviderIds: [] as string[] };
  const scan = await scanPages(client, libraryId, page.startIndex, {
    includeItemTypes: types, fields: ["ProviderIds"], includePrimaryImage: true,
  }, async (items) => {
    // Scope Jellyfin's overview predicate to this page so the other reasons
    // are still checked on items that already have an overview.
    const { items: missingOverviews } = await getPage(client, libraryId, {
      startIndex: 0,
      limit: items.length,
      missingOverviewItemIds: items.map((item) => item.Id),
    });
    const missingOverviewIds = new Set(missingOverviews.map((item) => item.Id));
    for (const item of items) {
      if (missingOverviewIds.has(item.Id)) {
        counts.missingOverview++;
        recordExample(examples.missingOverview, item.Id);
      }
      if (!item.ImageTags?.Primary) {
        counts.missingPrimaryImage++;
        recordExample(examples.missingPrimaryImage, item.Id);
      }
      if (!Object.values(item.ProviderIds ?? {}).some((id) => id?.trim())) {
        counts.missingProviderIds++;
        recordExample(examples.missingProviderIds, item.Id);
      }
    }
  });
  return { counts, examples, ...scanSummary(scan, page) };
}

export async function findDuplicates(client: JellyfinClient, { libraryId, cursor }: LibraryQuery) {
  const page = pagination(["duplicates", libraryId], cursor);
  const groups = new Map<string, { type: string; provider: string; providerId: string; ids: Set<string> }>();
  const multiVersion = new Map<string, { type: string; ids: string[]; mediaSourceCount: number }>();
  const scan = await scanPages(client, libraryId, page.startIndex, {
    includeItemTypes: DEFAULT_HYGIENE_TYPES, fields: ["ProviderIds", "MediaSourceCount"],
  }, (items) => {
    for (const item of items) {
      if (!DEFAULT_HYGIENE_TYPES.includes(item.Type)) continue;
      if (item.MediaSourceCount != null && item.MediaSourceCount > 1) {
        multiVersion.set(item.Id, { type: item.Type, ids: [item.Id], mediaSourceCount: item.MediaSourceCount });
      }
      for (const [namespace, value] of Object.entries(item.ProviderIds ?? {})) {
        const providerId = value?.trim();
        if (!providerId) continue;
        const provider = namespace.toLowerCase();
        const key = JSON.stringify([item.Type, provider, providerId]);
        const group = groups.get(key) ?? { type: item.Type, provider, providerId, ids: new Set<string>() };
        group.ids.add(item.Id);
        groups.set(key, group);
      }
    }
  });
  const shared = [...groups.values()].filter((group) => group.ids.size > 1);
  const providerExampleLimit = multiVersion.size > 0 ? MAX_EXAMPLES - 1 : MAX_EXAMPLES;
  const providerExamples = shared.slice(0, providerExampleLimit).map(({ ids, ...key }) => ({
    ...key, ids: [...ids].slice(0, MAX_EXAMPLE_GROUP_IDS), itemCount: ids.size,
  }));
  return {
    providerGroups: shared.length,
    multiVersionItems: multiVersion.size,
    examples: [...providerExamples, ...multiVersion.values()].slice(0, MAX_EXAMPLES),
    ...scanSummary(scan, page),
  };
}

export function registerHygieneTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_library_items",
    `List a compact page of items from one library, with a total and an opaque continuation cursor. ${CURSOR_DESCRIPTION}`,
    libraryItemsInput,
    READ_ONLY,
    toToolHandler((args) => fromPromise(async () => ok(await listLibraryItems(client, args)))),
  );

  server.tool(
    "jellyfin_find_missing_metadata",
    `Count movies, series and episodes missing an overview, Primary image or provider IDs by default. Each call scans one window and returns up to five IDs per reason. ${CURSOR_DESCRIPTION}`,
    missingMetadataInput,
    READ_ONLY,
    toToolHandler((args) => fromPromise(async () => ok(await findMissingMetadata(client, args)))),
  );

  server.tool(
    "jellyfin_find_duplicates",
    `Find review candidates among movies, series and episodes with shared provider IDs or multiple media versions. Groups span all pages in the current scan window. ${CURSOR_DESCRIPTION}`,
    libraryInput,
    READ_ONLY,
    toToolHandler((args) => fromPromise(async () => ok(await findDuplicates(client, args)))),
  );

  server.tool(
    "jellyfin_refresh_item",
    "Queue a metadata and image refresh for an existing item. Replacement is opt-in. Jellyfin decides whether to refresh descendants based on item type.",
    {
      itemId: z.string().trim().min(1),
      replaceAllMetadata: z.boolean().default(false),
      replaceAllImages: z.boolean().default(false),
      confirm: z.boolean().optional(),
    },
    DESTRUCTIVE,
    toToolHandler(({ itemId, confirm, ...options }) => {
      if (confirm !== true) return Effect.succeed(refuseUnconfirmed("refresh an item"));
      return fromPromise(async () => {
        const parameters = await client.refreshItem(itemId, options);
        return ok({ result: "queued", itemId, parameters });
      });
    }),
  );
}
