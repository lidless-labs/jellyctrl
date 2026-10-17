import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, READ_ONLY } from "./_util.js";
import { VALID_ITEM_TYPES } from "../types.js";


export function registerItemTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_search_items",
    "Search the Jellyfin library for items by name. Optionally filter by type (comma-separated, e.g. 'Movie,Series').",
    {
      query: z.string().min(1).describe("Search term"),
      itemTypes: z
        .string()
        .optional()
        .describe(
          `Comma-separated item types. Valid values: ${VALID_ITEM_TYPES.join(", ")}`,
        ),
      limit: z.number().int().positive().max(200).optional().default(20),
    },
    READ_ONLY,
    toToolHandler(({ query, itemTypes, limit }) =>
      toolResult(Effect.gen(function* () {
        const results = yield* fromPromise(() => client.searchItems(query, itemTypes, limit));
        return ok({
          totalCount: results.TotalRecordCount,
          items: results.Items.map((item) => ({
            id: item.Id,
            name: item.Name,
            type: item.Type,
            seriesName: item.SeriesName ?? null,
            productionYear: item.ProductionYear ?? null,
          })),
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_get_recent_items",
    "Get recently added items from a user's perspective (requires userId because Jellyfin's 'latest' view is per-user). Use jellyfin_list_users to find an appropriate admin user ID.",
    {
      userId: z
        .string()
        .describe("User ID to compute 'latest' for (Jellyfin requires this). Use an admin ID to see everything."),
      limit: z.number().int().positive().max(100).optional().default(20),
    },
    READ_ONLY,
    toToolHandler(({ userId, limit }) =>
      toolResult(Effect.gen(function* () {
        const items = yield* fromPromise(() => client.getRecentItems(userId, limit));
        return ok(
          items.map((item) => ({
            id: item.Id,
            name: item.Name,
            type: item.Type,
            seriesName: item.SeriesName ?? null,
            productionYear: item.ProductionYear ?? null,
            dateCreated: item.DateCreated ?? null,
          })),
        );
      })),
    ),
  );

  server.tool(
    "jellyfin_get_item",
    "Get full metadata for a single item by ID. Requires userId because Jellyfin's single-item read is user-scoped for API-key clients. Returns the raw Jellyfin Item object - use this for deep inspection after narrowing via search.",
    {
      itemId: z.string().describe("Item ID from a search or recent-items result"),
      userId: z
        .string()
        .describe("User ID for item visibility/context (Jellyfin requires this). Use jellyfin_list_users to find an appropriate user ID."),
    },
    READ_ONLY,
    toToolHandler(({ itemId, userId }) =>
      toolResult(Effect.gen(function* () {
        const item = yield* fromPromise(() => client.getItem(itemId, userId));
        return ok(item);
      })),
    ),
  );

  server.tool(
    "jellyfin_get_favorite_items",
    "Get a user's favorite items. Drives 'what do I like?' queries. Returns movies, series, music, and more with their metadata.",
    {
      userId: z.string().describe("User ID whose favorite items to return."),
      itemTypes: z
        .array(z.enum(VALID_ITEM_TYPES))
        .min(1)
        .optional()
        .describe("Optional item types to include (e.g. ['Movie'], ['Series', 'Episode']). Omit for all types."),
      limit: z.number().int().positive().max(200).optional().default(20),
      startIndex: z.number().int().nonnegative().optional().default(0),
    },
    READ_ONLY,
    toToolHandler(({ userId, itemTypes, limit, startIndex }) =>
      toolResult(Effect.gen(function* () {
        const result = yield* fromPromise(() => client.getFavoriteItems(
          userId,
          limit,
          startIndex,
          itemTypes,
        ));
        return ok({
          totalCount: result.TotalRecordCount,
          startIndex: result.StartIndex ?? startIndex,
          items: result.Items.map((item) => ({
            id: item.Id,
            name: item.Name,
            type: item.Type,
            seriesName: item.SeriesName ?? null,
            productionYear: item.ProductionYear ?? null,
          })),
        });
      })),
    ),
  );
}
