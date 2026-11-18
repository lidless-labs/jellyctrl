import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { run } from "../src/cli.js";
import { JellyfinClient } from "../src/client.js";
import type { Item } from "../src/types.js";
import { registerAllTools } from "../src/server.js";

type Tool = {
  schema: z.ZodRawShape;
  call: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
};

const libraryId = "library-example";
const fetchMock = vi.fn();

function setup() {
  const tools = new Map<string, Tool>();
  const server = {
    tool(name: string, _description: string, schema: Tool["schema"], _annotations: unknown, call: Tool["call"]) {
      tools.set(name, { schema, call });
    },
  };
  registerAllTools(server as never, new JellyfinClient({
    url: "http://jellyfin.test",
    apiKey: "test-key",
    timeout: 1000,
    verifySsl: true,
  }));
  return async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(`jellyfin_${name}`);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await tool.call(z.object(tool.schema).parse(input));
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
  };
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload));
}

function movie(Id: string) {
  return { Id, Name: Id, Type: "Movie" };
}

function mockPages(items: Item[]) {
  fetchMock.mockImplementation(async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/Library/VirtualFolders") return json([{ ItemId: libraryId }]);
    expect(pathname).toBe("/Items");
    expect(searchParams.get("parentId")).toBe(libraryId);
    const limit = Number(searchParams.get("limit"));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(200);
    if (searchParams.get("hasOverview") === "false") {
      expect(searchParams.has("filters")).toBe(false);
      const ids = searchParams.get("ids")?.split(",") ?? [];
      const missing = ids.includes("no-overview") ? [movie("no-overview")] : [];
      return json({ Items: missing, TotalRecordCount: missing.length });
    }
    const offset = Number(searchParams.get("startIndex"));
    return json({ Items: items.slice(offset, offset + limit), TotalRecordCount: items.length });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("library hygiene tools", () => {
  it("lists compact rows and rejects cursors from a different query before fetching", async () => {
    mockPages([
      { ...movie("first"), Path: "/example", Overview: "Summary", ProductionYear: 2026, ProviderIds: { Tmdb: "1" } },
      movie("second"),
    ]);
    const call = setup();
    const query = { libraryId, limit: 1, includeItemTypes: ["Movie"] };
    const { payload } = await call("list_library_items", query);
    expect(payload).toEqual({
      items: [{ id: "first", name: "first", type: "Movie", year: 2026, providerIds: { Tmdb: "1" } }],
      total: 2,
      nextCursor: expect.any(String),
    });
    const calls = fetchMock.mock.calls.length;
    for (const modified of [{ includeItemTypes: ["Episode"] }, { libraryId: "other" }, { includePath: true }]) {
      const result = await call("list_library_items", { ...query, ...modified, cursor: payload.nextCursor });
      expect(result.isError).toBe(true);
      expect(result.payload.error).toMatch(/cursor/i);
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect((await call("list_library_items", { ...query, cursor: payload.nextCursor })).payload)
      .toMatchObject({ items: [{ id: "second" }], nextCursor: null });
    expect((await call("list_library_items", { ...query, includePath: true, includeOverview: true })).payload)
      .toMatchObject({ items: [{ path: "/example", overview: "Summary" }] });
  });

  it("counts each missing metadata reason independently", async () => {
    mockPages([
      { ...movie("no-overview"), ProviderIds: { imdb: "tt1" }, ImageTags: { Primary: "tag" } },
      { ...movie("no-image"), ProviderIds: { imdb: "tt2" }, ImageTags: { Backdrop: "tag" } },
      { ...movie("no-provider"), ProviderIds: {}, ImageTags: { Primary: "tag" } },
    ]);
    expect((await setup()("find_missing_metadata", { libraryId })).payload).toEqual({
      counts: { missingOverview: 1, missingPrimaryImage: 1, missingProviderIds: 1 },
      examples: {
        missingOverview: ["no-overview"],
        missingPrimaryImage: ["no-image"],
        missingProviderIds: ["no-provider"],
      },
      scanned: 3,
      complete: true,
      countsAreLowerBounds: false,
      nextCursor: null,
    });
  });

  it("caps metadata scanning and marks partial counts as lower bounds", async () => {
    mockPages(Array.from({ length: 2001 }, (_, index) => movie(String(index))));
    const call = setup();
    const { payload } = await call("find_missing_metadata", { libraryId });
    expect(payload).toMatchObject({
      counts: { missingPrimaryImage: 2000, missingProviderIds: 2000 },
      scanned: 2000,
      complete: false,
      countsAreLowerBounds: true,
      nextCursor: expect.any(String),
    });
    expect(payload.examples.missingProviderIds).toHaveLength(5);
    expect((await call("find_missing_metadata", { libraryId, cursor: payload.nextCursor })).payload)
      .toMatchObject({ scanned: 1, complete: true, nextCursor: null });
  });

  it("groups provider IDs across pages by type and case-insensitive namespace", async () => {
    mockPages([
      { ...movie("first"), ProviderIds: { Tmdb: "42", TVDB: "42" } },
      ...Array.from({ length: 200 }, (_, index) => movie(String(index))),
      { ...movie("alternate"), ProviderIds: { tmdb: "42" } },
      { ...movie("series"), Type: "Series", ProviderIds: { tmdb: "42" } },
      { ...movie("multi-version"), MediaSourceCount: 2 },
    ]);
    expect((await setup()("find_duplicates", { libraryId })).payload).toEqual({
      groupCount: 2,
      examples: [
        { type: "Movie", provider: "tmdb", providerId: "42", ids: ["first", "alternate"], itemCount: 2 },
        { type: "Movie", ids: ["multi-version"], mediaSourceCount: 2 },
      ],
      scanned: 204,
      complete: true,
      countsAreLowerBounds: false,
      nextCursor: null,
    });
  });

  it("continues from the last emitted ID when verbose rows hit the result budget", async () => {
    mockPages(Array.from({ length: 3 }, (_, index) => ({
      ...movie(String(index)), Overview: "a".repeat(40_000),
    })));
    const call = setup();
    const query = { libraryId, includeOverview: true };
    const first = await call("list_library_items", query);
    expect(first.payload.items.map((item: { id: string }) => item.id)).toEqual(["0"]);
    const second = await call("list_library_items", { ...query, cursor: first.payload.nextCursor });
    expect(second.payload.items.map((item: { id: string }) => item.id)).toEqual(["1"]);
  });

  it.each([
    ["library-items", "total"],
    ["missing-metadata", "counts"],
    ["duplicates", "groupCount"],
  ])("exposes the %s read as JSON in the CLI", async (command, field) => {
    mockPages([movie("one")]);
    const out = vi.fn();
    const err = vi.fn();
    expect(await run([command, libraryId], {
      out, err,
      makeClient: () => new JellyfinClient({
        url: "http://jellyfin.test", apiKey: "test-key", timeout: 1000, verifySsl: true,
      }),
      startServer: vi.fn(),
    })).toBe(0);
    expect(err).not.toHaveBeenCalled();
    expect(JSON.parse(out.mock.calls[0][0])).toHaveProperty(field);
  });

  it("does not queue a refresh for an item that does not exist", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await setup()("refresh_item", { itemId: "missing", confirm: true })).toMatchObject({ isError: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a recursion override Jellyfin cannot honor", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...movie("folder"), Type: "Series", IsFolder: true }));
    const result = await setup()("refresh_item", { itemId: "folder", confirm: true, recursive: false });
    expect(result).toMatchObject({ isError: true, payload: { error: expect.stringContaining("recursion") } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses refresh without confirmation before looking up the item", async () => {
    expect(await setup()("refresh_item", { itemId: "item-example" })).toMatchObject({
      isError: true,
      payload: { error: expect.stringContaining("confirm: true") },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates item existence and sends both replacement flags as false by default", async () => {
    fetchMock.mockResolvedValueOnce(json(movie("item-example")));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await setup()("refresh_item", { itemId: "item-example", confirm: true });
    const parameters = {
      metadataRefreshMode: "FullRefresh",
      imageRefreshMode: "FullRefresh",
      replaceAllMetadata: false,
      replaceAllImages: false,
    };
    expect(result.payload).toEqual({ result: "queued", itemId: "item-example", parameters });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://jellyfin.test/Items/item-example");
    const [url, request] = fetchMock.mock.calls[1];
    expect(request.method).toBe("POST");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/Items/item-example/Refresh");
    expect(Object.fromEntries(parsed.searchParams)).toEqual(
      Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])),
    );
  });
});
