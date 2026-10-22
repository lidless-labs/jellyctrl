import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, NON_DESTRUCTIVE } from "./_util.js";

export function registerCollectionTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_create_collection",
    "Create a new collection (BoxSet), optionally pre-populated with items. Collections are server-wide, not per-user. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      name: z.string().min(1).describe("Collection name"),
      itemIds: z
        .array(z.string().min(1))
        .optional()
        .default([])
        .describe("Optional initial item IDs"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, name, itemIds }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("create collection");
        const collection = yield* fromPromise(() => client.createCollection(name, itemIds));
        return ok({ id: collection.Id, name });
      })),
    ),
  );

  server.tool(
    "jellyfin_add_to_collection",
    "Add items to an existing collection. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      collectionId: z.string().describe("Collection ID"),
      itemIds: z.array(z.string().min(1)).min(1).describe("Item IDs to add"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, collectionId, itemIds }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("add to collection");
        yield* fromPromise(() => client.addToCollection(collectionId, itemIds));
        return ok({ result: `added ${itemIds.length} item(s) to collection ${collectionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_remove_from_collection",
    "Remove items from a collection. Requires confirm: true.",
    {
      collectionId: z.string().describe("Collection ID"),
      itemIds: z.array(z.string().min(1)).min(1).describe("Item IDs to remove"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to proceed with removing items from the collection."),
    },
    DESTRUCTIVE,
    toToolHandler(({ collectionId, itemIds, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(`remove items from collection ${collectionId}`);
        }
        yield* fromPromise(() => client.removeFromCollection(collectionId, itemIds));
        return ok({
          result: `removed ${itemIds.length} item(s) from collection ${collectionId}`,
        });
      })),
    ),
  );
}
