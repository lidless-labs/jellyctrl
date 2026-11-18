import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, READ_ONLY } from "./_util.js";

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
    "Queue a Jellyfin library scan. Omit libraryId and pass confirm: true to scan all libraries. A scoped refresh with a libraryId needs no confirmation and leaves metadata and image replacement disabled.",
    {
      libraryId: z
        .string()
        .optional()
        .describe("Library ID from jellyfin_list_libraries. Omit to request a full scan."),
      confirm: z.boolean().optional().describe("Must be true for a full scan."),
    },
    DESTRUCTIVE,
    toToolHandler(({ libraryId, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (libraryId === undefined && confirm !== true) {
          return refuseUnconfirmed("scan all Jellyfin libraries");
        }
        yield* fromPromise(() => client.scanLibraries(libraryId));
        return ok({
          result: libraryId === undefined
            ? "scan queued for all libraries"
            : `scan queued for library ${libraryId}`,
        });
      })),
    ),
  );
}
