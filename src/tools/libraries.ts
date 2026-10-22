import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, refuseUnconfirmed, NON_DESTRUCTIVE, READ_ONLY } from "./_util.js";

export function registerLibraryTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_libraries",
    "List all Jellyfin libraries (virtual folders) with their name, ID, collection type (movies/tvshows/music/...), and filesystem paths.",
    {},
    READ_ONLY,
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const libs = yield* fromPromise(() => client.listLibraries());
        return ok(
          libs.map((lib) => ({
            id: lib.ItemId,
            name: lib.Name,
            collectionType: lib.CollectionType ?? null,
            locations: lib.Locations,
          })),
        );
      })),
    ),
  );

  server.tool(
    "jellyfin_scan_library",
    "Trigger a library scan. Pass a specific library ID to scan just that one, or omit to scan all libraries. Returns immediately - the scan runs async in Jellyfin. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      libraryId: z
        .string()
        .optional()
        .describe("Library ID from jellyfin_list_libraries. Omit to scan all libraries."),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, libraryId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("scan library");
        yield* fromPromise(() => client.scanLibraries(libraryId));
        return ok({
          result: libraryId
            ? `scan triggered for library ${libraryId}`
            : "scan triggered for all libraries",
        });
      })),
    ),
  );
}
