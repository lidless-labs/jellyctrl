import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import type { Item, UserItemData } from "../types.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, NON_DESTRUCTIVE, READ_ONLY } from "./_util.js";

const TICKS_PER_SECOND = 10_000_000;
const ticksToSeconds = (ticks: number | undefined | null): number | null =>
  typeof ticks === "number" ? Math.round(ticks / TICKS_PER_SECOND) : null;

const CONTINUE_WATCHING_TYPES = [
  "Movie",
  "Episode",
  "Audio",
  "Book",
  "Video",
] as const;

type ContinueWatchingType = (typeof CONTINUE_WATCHING_TYPES)[number];

interface ContinueWatchingFilters {
  itemTypes?: ContinueWatchingType[];
  seriesId?: string;
  nameContains?: string;
  olderThanDays?: number;
  maxPlayedPercentage?: number;
}

interface ClearResult {
  cleared: Item[];
  failed: { item: Item; error: string }[];
}

interface ItemSelection {
  totalResumeCount: number | null;
  items: Item[];
  failed: { item: Item; error: string }[];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function itemSummary(item: Item): Record<string, unknown> {
  return {
    id: item.Id,
    name: item.Name,
    type: item.Type,
    mediaType: item.MediaType ?? null,
    seriesId: item.SeriesId ?? null,
    seriesName: item.SeriesName ?? null,
    seasonNumber: item.ParentIndexNumber ?? null,
    episodeNumber: item.IndexNumber ?? null,
    runtimeSeconds: ticksToSeconds(item.RunTimeTicks),
    resumePositionSeconds: ticksToSeconds(item.UserData?.PlaybackPositionTicks),
    playedPercentage: item.UserData?.PlayedPercentage ?? null,
    playCount: item.UserData?.PlayCount ?? null,
    played: item.UserData?.Played ?? false,
    isFavorite: item.UserData?.IsFavorite ?? false,
    lastPlayedDate: item.UserData?.LastPlayedDate ?? null,
  };
}

function placeholderItem(itemId: string): Item {
  return {
    Id: itemId,
    Name: itemId,
    Type: "Unknown",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cutoffDate(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function matchesFilters(item: Item, filters: ContinueWatchingFilters): boolean {
  if (filters.itemTypes?.length && !filters.itemTypes.includes(item.Type as ContinueWatchingType)) {
    return false;
  }
  if (filters.seriesId && item.SeriesId !== filters.seriesId) {
    return false;
  }
  if (filters.nameContains) {
    const haystack = `${item.Name} ${item.SeriesName ?? ""}`.toLowerCase();
    if (!haystack.includes(filters.nameContains.toLowerCase())) {
      return false;
    }
  }
  if (
    filters.maxPlayedPercentage !== undefined &&
    (item.UserData?.PlayedPercentage ?? 0) > filters.maxPlayedPercentage
  ) {
    return false;
  }
  if (filters.olderThanDays !== undefined) {
    const lastPlayedDate = item.UserData?.LastPlayedDate;
    if (!lastPlayedDate) {
      return true;
    }
    const parsed = new Date(lastPlayedDate);
    if (Number.isNaN(parsed.getTime()) || parsed > cutoffDate(filters.olderThanDays)) {
      return false;
    }
  }
  return true;
}

function getAllResumeItems(
  client: JellyfinClient,
  userId: string,
  pageSize: number,
): Effect.Effect<{ totalResumeCount: number; items: Item[] }, unknown, never> {
  return Effect.gen(function* () {
    let totalResumeCount: number | null = null;
    let startIndex = 0;
    const items: Item[] = [];

    while (totalResumeCount === null || startIndex < totalResumeCount) {
      const resume = yield* fromPromise(() => client.getResumeItems(userId, pageSize, startIndex));
      totalResumeCount = resume.TotalRecordCount;
      items.push(...resume.Items);
      if (resume.Items.length === 0) break;
      startIndex += resume.Items.length;
    }

    return { totalResumeCount: totalResumeCount ?? 0, items };
  });
}

function hydrateExplicitItems(
  client: JellyfinClient,
  userId: string,
  itemIds: string[],
): Effect.Effect<{ items: Item[]; failed: { item: Item; error: string }[] }, never, never> {
  return Effect.promise(async () => {
    const items: Item[] = [];
    const failed: { item: Item; error: string }[] = [];
    for (const itemId of uniqueIds(itemIds)) {
      try {
        const [item, userData] = await Promise.all([
          client.getItem(itemId, userId),
          client.getItemUserData(userId, itemId),
        ]);
        items.push({ ...item, UserData: userData ?? item.UserData });
      } catch (error) {
        failed.push({ item: placeholderItem(itemId), error: errorMessage(error) });
      }
    }
    return { items, failed };
  });
}

function selectContinueWatchingItems(
  client: JellyfinClient,
  userId: string,
  pageSize: number,
  itemIds: string[] | undefined,
  filters: ContinueWatchingFilters,
): Effect.Effect<ItemSelection, unknown, never> {
  return Effect.gen(function* () {
    if (itemIds?.length) {
      const hydrated = yield* hydrateExplicitItems(client, userId, itemIds);
      return {
        totalResumeCount: null,
        items: hydrated.items.filter((item) => matchesFilters(item, filters)),
        failed: hydrated.failed,
      };
    }

    const resume = yield* getAllResumeItems(client, userId, pageSize);
    return {
      totalResumeCount: resume.totalResumeCount,
      items: resume.items.filter((item) => matchesFilters(item, filters)),
      failed: [],
    };
  });
}

function clearItems(
  client: JellyfinClient,
  userId: string,
  items: Item[],
): Effect.Effect<ClearResult, never, never> {
  return Effect.forEach(
    items,
    (item) => Effect.promise(async () => {
      try {
        await client.clearPlaybackPosition(userId, item.Id, item.UserData);
        return { cleared: item };
      } catch (error) {
        return { failed: { item, error: errorMessage(error) } };
      }
    }),
    { concurrency: 4 },
  ).pipe(
    Effect.map((results) => ({
      cleared: results.flatMap((result) => (result.cleared ? [result.cleared] : [])),
      failed: results.flatMap((result) => (result.failed ? [result.failed] : [])),
    })),
  );
}

function clearResultPayload(
  userId: string,
  totalResumeCount: number | null,
  result: ClearResult,
): Record<string, unknown> {
  return {
    userId,
    totalResumeCount,
    partialFailure: result.failed.length > 0,
    clearedCount: result.cleared.length,
    failedCount: result.failed.length,
    clearedItems: result.cleared.map(itemSummary),
    failedItems: result.failed.map((failure) => ({
      ...itemSummary(failure.item),
      error: failure.error,
    })),
  };
}

function resultWithPartialFailure(payload: Record<string, unknown>) {
  return ok(payload);
}

const itemTypesSchema = z
  .array(z.enum(CONTINUE_WATCHING_TYPES))
  .min(1)
  .optional();

const filterSchema = {
  itemTypes: itemTypesSchema.describe("Optional item types to include."),
  seriesId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional series ID to restrict Continue Watching entries to one show."),
  nameContains: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional case-insensitive name or series-name substring filter."),
  olderThanDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only match entries whose LastPlayedDate is older than this many days."),
  maxPlayedPercentage: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Only match entries at or below this played percentage."),
};

function readFilters(args: ContinueWatchingFilters): ContinueWatchingFilters {
  return {
    itemTypes: args.itemTypes,
    seriesId: args.seriesId,
    nameContains: args.nameContains,
    olderThanDays: args.olderThanDays,
    maxPlayedPercentage: args.maxPlayedPercentage,
  };
}

function latestEpisodeScore(item: Item): number {
  return (item.ParentIndexNumber ?? -1) * 10_000 + (item.IndexNumber ?? -1);
}

function latestResumeScore(item: Item): number {
  const lastPlayedDate = item.UserData?.LastPlayedDate;
  return lastPlayedDate ? new Date(lastPlayedDate).getTime() || 0 : 0;
}

export function registerUserDataTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_preview_continue_watching_clear",
    "Preview which Continue Watching entries would be cleared for a user. Supports the same filters as jellyfin_clear_continue_watching and makes no changes.",
    {
      userId: z.string().trim().min(1).describe("User ID whose Continue Watching queue should be previewed."),
      itemIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .optional()
        .describe("Optional explicit item IDs to preview. Omit to preview the filtered Continue Watching queue."),
      pageSize: z.number().int().positive().max(500).optional().default(100),
      ...filterSchema,
    },
    READ_ONLY,
    toToolHandler(({ userId, itemIds, pageSize, ...filters }) =>
      toolResult(Effect.gen(function* () {
        const selection = yield* selectContinueWatchingItems(
          client,
          userId,
          pageSize,
          itemIds,
          readFilters(filters),
        );
        return ok({
          userId,
          totalResumeCount: selection.totalResumeCount,
          matchedCount: selection.items.length,
          failedCount: selection.failed.length,
          items: selection.items.map(itemSummary),
          failedItems: selection.failed.map((failure) => ({
            ...itemSummary(failure.item),
            error: failure.error,
          })),
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_clear_continue_watching",
    "Clear in-progress playback positions from a user's Continue Watching / resume queue without marking items played. Omit itemIds to clear the filtered current resume queue. Requires confirm: true.",
    {
      userId: z
        .string()
        .trim()
        .min(1)
        .describe("User ID whose Continue Watching queue should be cleared."),
      itemIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .optional()
        .describe("Optional item IDs to clear. Omit to clear the filtered Continue Watching queue."),
      pageSize: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .default(100)
        .describe("Resume queue page size when itemIds is omitted."),
      ...filterSchema,
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to proceed because this changes user playback progress."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, itemIds, pageSize, confirm, ...filters }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(
            `clear Continue Watching playback positions for user ${userId}`,
          );
        }

        const selection = yield* selectContinueWatchingItems(
          client,
          userId,
          pageSize,
          itemIds,
          readFilters(filters),
        );
        const result = yield* clearItems(client, userId, selection.items);
        result.failed.push(...selection.failed);
        const payload = clearResultPayload(userId, selection.totalResumeCount, result);
        return result.failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );

  server.tool(
    "jellyfin_clear_series_continue_watching",
    "Clear Continue Watching entries for one TV series without marking episodes played. Requires confirm: true.",
    {
      userId: z.string().trim().min(1).describe("User ID whose series resume entries should be cleared."),
      seriesId: z.string().trim().min(1).describe("Series ID to clear from Continue Watching."),
      pageSize: z.number().int().positive().max(500).optional().default(100),
      confirm: z.boolean().optional().describe("Must be true to proceed."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, seriesId, pageSize, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(
            `clear Continue Watching entries for series ${seriesId} and user ${userId}`,
          );
        }

        const selection = yield* selectContinueWatchingItems(
          client,
          userId,
          pageSize,
          undefined,
          { seriesId, itemTypes: ["Episode"] },
        );
        const result = yield* clearItems(client, userId, selection.items);
        result.failed.push(...selection.failed);
        const payload = clearResultPayload(userId, selection.totalResumeCount, result);
        return result.failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );

  server.tool(
    "jellyfin_clear_episode_continue_watching_except_latest",
    "For one series, clear episode resume entries except the latest one. Defaults to keeping the most recently played episode. Requires confirm: true.",
    {
      userId: z.string().trim().min(1).describe("User ID whose episode resume entries should be cleaned up."),
      seriesId: z.string().trim().min(1).describe("Series ID to clean up."),
      keepBy: z
        .enum(["lastPlayed", "episodeNumber"])
        .optional()
        .default("lastPlayed")
        .describe("How to choose the one episode to keep."),
      pageSize: z.number().int().positive().max(500).optional().default(100),
      confirm: z.boolean().optional().describe("Must be true to proceed."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, seriesId, keepBy, pageSize, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(
            `clear older episode resume entries for series ${seriesId} and user ${userId}`,
          );
        }

        const selection = yield* selectContinueWatchingItems(
          client,
          userId,
          pageSize,
          undefined,
          { seriesId, itemTypes: ["Episode"] },
        );
        const sorted = [...selection.items].sort((a, b) =>
          keepBy === "episodeNumber"
            ? latestEpisodeScore(b) - latestEpisodeScore(a)
            : latestResumeScore(b) - latestResumeScore(a),
        );
        const kept = sorted[0] ?? null;
        const toClear = kept ? sorted.slice(1) : [];
        const result = yield* clearItems(client, userId, toClear);
        result.failed.push(...selection.failed);
        const payload = {
          ...clearResultPayload(userId, selection.totalResumeCount, result),
          keptItem: kept ? itemSummary(kept) : null,
        };
        return result.failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );

  server.tool(
    "jellyfin_get_watch_history",
    "Get recently watched items for a user, sorted by last played date.",
    {
      userId: z.string().trim().min(1).describe("User ID whose watch history should be fetched."),
      itemTypes: itemTypesSchema
        .default(["Movie", "Episode", "Audio"])
        .describe("Optional item types to include. Defaults to played movies, episodes, and audio."),
      limit: z.number().int().positive().max(200).optional().default(20),
      startIndex: z.number().int().nonnegative().optional().default(0),
    },
    READ_ONLY,
    toToolHandler(({ userId, itemTypes, limit, startIndex }) =>
      toolResult(Effect.gen(function* () {
        const result = yield* fromPromise(() => client.getWatchHistory(
          userId,
          limit,
          startIndex,
          itemTypes?.join(","),
        ));
        return ok({
          totalCount: result.TotalRecordCount,
          startIndex: result.StartIndex ?? startIndex,
          items: result.Items.map(itemSummary),
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_get_user_item_data",
    "Get raw per-user Jellyfin user data for an item, including resume position, played state, favorite state, play count, and last played date.",
    {
      userId: z.string().trim().min(1).describe("User ID whose item data should be fetched."),
      itemId: z.string().trim().min(1).describe("Item ID to inspect."),
    },
    READ_ONLY,
    toToolHandler(({ userId, itemId }) =>
      toolResult(Effect.gen(function* () {
        const userData = yield* fromPromise(() => client.getItemUserData(userId, itemId));
        return ok(userData ?? {});
      })),
    ),
  );

  server.tool(
    "jellyfin_set_resume_position",
    "Set a user's resume position for an item in seconds. Does not mark the item played.",
    {
      userId: z.string().trim().min(1).describe("User ID whose resume position should be updated."),
      itemId: z.string().trim().min(1).describe("Item ID to update."),
      positionSec: z.number().nonnegative().describe("Resume position in seconds from the start."),
      confirm: z.boolean().optional().describe("Must be true to proceed because this changes user playback progress."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, itemId, positionSec, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(
            `set resume position for item ${itemId} and user ${userId}`,
          );
        }

        const item = yield* fromPromise(() => client.getItem(itemId, userId));
        const updated = yield* fromPromise(() => client.setPlaybackPosition(
          userId,
          itemId,
          positionSec,
          undefined,
          item.RunTimeTicks,
        ));
        return ok({
          userId,
          item: itemSummary({ ...item, UserData: updated ?? item.UserData }),
          requestedPositionSeconds: positionSec,
          positionSeconds: ticksToSeconds(updated?.PlaybackPositionTicks) ?? positionSec,
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_mark_played",
    "Mark an item as watched/played for a user. Updates resume state and play count. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      userId: z.string().describe("User ID from jellyfin_list_users"),
      itemId: z.string().describe("Item ID from a search or recent-items result"),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm, userId, itemId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("mark played");
        yield* fromPromise(() => client.markPlayed(userId, itemId));
        return ok({ result: `item ${itemId} marked played for user ${userId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_mark_unplayed",
    "Mark an item as unwatched/unplayed for a user. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      userId: z.string().describe("User ID from jellyfin_list_users"),
      itemId: z.string().describe("Item ID from a search or recent-items result"),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm, userId, itemId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("mark unplayed");
        yield* fromPromise(() => client.markUnplayed(userId, itemId));
        return ok({ result: `item ${itemId} marked unplayed for user ${userId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_set_favorite",
    "Add an item to a user's favorites. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      userId: z.string().describe("User ID from jellyfin_list_users"),
      itemId: z.string().describe("Item ID from a search or recent-items result"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, userId, itemId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("set favorite");
        yield* fromPromise(() => client.setFavorite(userId, itemId));
        return ok({ result: `item ${itemId} favorited for user ${userId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_unset_favorite",
    "Remove an item from a user's favorites. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      userId: z.string().describe("User ID from jellyfin_list_users"),
      itemId: z.string().describe("Item ID from a search or recent-items result"),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm, userId, itemId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("unset favorite");
        yield* fromPromise(() => client.unsetFavorite(userId, itemId));
        return ok({ result: `item ${itemId} unfavorited for user ${userId}` });
      })),
    ),
  );
}
