import { describe, it, expect, vi } from "vitest";
import { registerUserDataTools } from "../src/tools/userdata.js";
import type { JellyfinClient } from "../src/client.js";

interface CapturedTool {
  name: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

function makeFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      annotations: CapturedTool["annotations"],
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, { name, annotations, handler });
    },
  };
  return { server, tools };
}

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("user data tools", () => {
  it("clear Continue Watching refuses without confirm and does not call the client", async () => {
    const client = {
      getResumeItems: vi.fn(),
      clearPlaybackPosition: vi.fn(),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    expect(tool).toBeDefined();

    const result = await tool!.handler({ userId: "user-42" });

    expect(result.isError).toBe(true);
    expect(client.getResumeItems).not.toHaveBeenCalled();
    expect(client.clearPlaybackPosition).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("confirm: true");
  });

  it("clears explicit item IDs once each and returns item summaries", async () => {
    const client = {
      getResumeItems: vi.fn(),
      getItem: vi
        .fn()
        .mockResolvedValueOnce({ Id: "ep-1", Name: "Episode 1", Type: "Episode" })
        .mockResolvedValueOnce({ Id: "ep-2", Name: "Episode 2", Type: "Episode" }),
      getItemUserData: vi
        .fn()
        .mockResolvedValueOnce({ PlaybackPositionTicks: 12_000_000 })
        .mockResolvedValueOnce({ PlaybackPositionTicks: 34_000_000 }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      itemIds: ["ep-1", "ep-1", "ep-2"],
      confirm: true,
    });

    expect(client.getResumeItems).not.toHaveBeenCalled();
    expect(client.getItem).toHaveBeenCalledTimes(2);
    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(2);
    expect(client.clearPlaybackPosition).toHaveBeenNthCalledWith(
      1,
      "user-42",
      "ep-1",
      { PlaybackPositionTicks: 12_000_000 },
    );
    expect(parseResult(result)).toMatchObject({
      userId: "user-42",
      clearedCount: 2,
      failedCount: 0,
      totalResumeCount: null,
    });
    expect(parseResult(result).clearedItems).toEqual([
      expect.objectContaining({ id: "ep-1", name: "Episode 1" }),
      expect.objectContaining({ id: "ep-2", name: "Episode 2" }),
    ]);
  });

  it("fetches every resume queue page when item IDs are omitted", async () => {
    const client = {
      getResumeItems: vi
        .fn()
        .mockResolvedValueOnce({
          TotalRecordCount: 3,
          Items: [
            { Id: "ep-1", Name: "Episode 1", Type: "Episode" },
            { Id: "ep-2", Name: "Episode 2", Type: "Episode" },
          ],
        })
        .mockResolvedValueOnce({
          TotalRecordCount: 3,
          Items: [{ Id: "ep-3", Name: "Episode 3", Type: "Episode" }],
        }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      pageSize: 2,
      confirm: true,
    });

    expect(client.getResumeItems).toHaveBeenNthCalledWith(1, "user-42", 2, 0);
    expect(client.getResumeItems).toHaveBeenNthCalledWith(2, "user-42", 2, 2);
    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(3);
    expect(parseResult(result)).toMatchObject({
      clearedCount: 3,
      totalResumeCount: 3,
    });
  });

  it("returns zero cleared items for an empty resume queue", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] }),
      clearPlaybackPosition: vi.fn(),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      confirm: true,
    });

    expect(client.clearPlaybackPosition).not.toHaveBeenCalled();
    expect(parseResult(result)).toMatchObject({
      clearedCount: 0,
      failedCount: 0,
      totalResumeCount: 0,
    });
  });

  it("surfaces partial failures while reporting successful clears", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          { Id: "ep-1", Name: "Episode 1", Type: "Episode" },
          { Id: "ep-2", Name: "Episode 2", Type: "Episode" },
        ],
      }),
      clearPlaybackPosition: vi
        .fn()
        .mockResolvedValueOnce({ PlaybackPositionTicks: 0 })
        .mockRejectedValueOnce(new Error("failed to clear")),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      confirm: true,
    });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      partialFailure: true,
      clearedCount: 1,
      failedCount: 1,
    });
    expect(parseResult(result).failedItems).toEqual([
      expect.objectContaining({ id: "ep-2", error: "failed to clear" }),
    ]);
  });

  it("reports explicit item hydration failures without blocking valid IDs", async () => {
    const client = {
      getItem: vi
        .fn()
        .mockResolvedValueOnce({ Id: "ep-1", Name: "Episode 1", Type: "Episode" })
        .mockRejectedValueOnce(new Error("missing item")),
      getItemUserData: vi
        .fn()
        .mockResolvedValueOnce({ PlaybackPositionTicks: 1 })
        .mockResolvedValueOnce({ PlaybackPositionTicks: 2 }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      itemIds: ["ep-1", "missing"],
      confirm: true,
    });

    expect(result.isError).toBeUndefined();
    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(1);
    expect(parseResult(result)).toMatchObject({
      partialFailure: true,
      clearedCount: 1,
      failedCount: 1,
    });
    expect(parseResult(result).failedItems).toEqual([
      expect.objectContaining({ id: "missing", error: "missing item" }),
    ]);
  });

  it("bounds clears to four, continues after rejection, and preserves selection order", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      Id: `ep-${index + 1}`, Name: `Episode ${index + 1}`, Type: "Episode",
    }));
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    let inFlight = 0;
    let peakInFlight = 0;
    const clearPlaybackPosition = vi.fn((_userId: string, itemId: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise<void>((resolve, reject) => {
        pending.set(itemId, { resolve, reject });
      }).finally(() => { inFlight -= 1; });
    });
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({ TotalRecordCount: 8, Items: items }),
      clearPlaybackPosition,
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);
    const resultPromise = tools.get("jellyfin_clear_continue_watching")!.handler({
      userId: "user-42", confirm: true,
    });

    // Finish out of order, with a rejection opening a slot while ep-1 stays pending.
    await vi.waitFor(() => expect(pending.has("ep-4")).toBe(true));
    const initialCalls = clearPlaybackPosition.mock.calls.length;
    pending.get("ep-3")!.reject(new Error("third failed"));
    await vi.waitFor(() => expect(pending.has("ep-5")).toBe(true));
    const progressedAfterRejection = inFlight;
    pending.get("ep-5")!.resolve();
    await vi.waitFor(() => expect(pending.has("ep-6")).toBe(true));
    pending.get("ep-6")!.reject(new Error("sixth failed"));
    await vi.waitFor(() => expect(pending.has("ep-7")).toBe(true));
    pending.get("ep-7")!.resolve();
    await vi.waitFor(() => expect(pending.has("ep-8")).toBe(true));
    for (const id of ["ep-8", "ep-4", "ep-2", "ep-1"]) pending.get(id)!.resolve();

    const result = await resultPromise;
    expect(initialCalls).toBe(4);
    expect(peakInFlight).toBe(4);
    expect(progressedAfterRejection).toBe(4);
    expect(clearPlaybackPosition.mock.calls.map(([, id]) => id)).toEqual(items.map((item) => item.Id));
    expect(inFlight).toBe(0);
    expect(result.isError).toBeUndefined();
    const payload = parseResult(result);
    expect(payload).toMatchObject({ partialFailure: true, clearedCount: 6, failedCount: 2 });
    expect(payload.clearedItems).toEqual(["ep-1", "ep-2", "ep-4", "ep-5", "ep-7", "ep-8"].map(
      (id) => expect.objectContaining({ id }),
    ));
    expect(payload.failedItems).toEqual([
      expect.objectContaining({ id: "ep-3", error: "third failed" }),
      expect.objectContaining({ id: "ep-6", error: "sixth failed" }),
    ]);
  });

  it("applies filters to explicit item IDs", async () => {
    const client = {
      getItem: vi
        .fn()
        .mockResolvedValueOnce({ Id: "ep-1", Name: "Episode 1", Type: "Episode" })
        .mockResolvedValueOnce({ Id: "movie-1", Name: "Movie", Type: "Movie" }),
      getItemUserData: vi
        .fn()
        .mockResolvedValueOnce({ PlaybackPositionTicks: 1 })
        .mockResolvedValueOnce({ PlaybackPositionTicks: 2 }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      itemIds: ["ep-1", "movie-1"],
      itemTypes: ["Episode"],
      confirm: true,
    });

    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(1);
    expect(client.clearPlaybackPosition).toHaveBeenCalledWith(
      "user-42",
      "ep-1",
      { PlaybackPositionTicks: 1 },
    );
    expect(parseResult(result)).toMatchObject({ clearedCount: 1 });
  });

  it("previews filtered Continue Watching entries without clearing them", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          {
            Id: "ep-1",
            Name: "Pilot",
            Type: "Episode",
            SeriesId: "series-1",
            SeriesName: "Show",
            UserData: { PlayedPercentage: 10 },
          },
          {
            Id: "movie-1",
            Name: "Movie",
            Type: "Movie",
            UserData: { PlayedPercentage: 90 },
          },
        ],
      }),
      clearPlaybackPosition: vi.fn(),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_preview_continue_watching_clear");
    const result = await tool!.handler({
      userId: "user-42",
      itemTypes: ["Episode"],
      maxPlayedPercentage: 20,
    });

    expect(client.clearPlaybackPosition).not.toHaveBeenCalled();
    expect(parseResult(result)).toMatchObject({
      matchedCount: 1,
      totalResumeCount: 2,
    });
    expect(parseResult(result).items).toEqual([
      expect.objectContaining({ id: "ep-1", seriesId: "series-1" }),
    ]);
  });

  it("treats entries without LastPlayedDate as matching olderThanDays cleanup", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "ep-1",
            Name: "Episode 1",
            Type: "Episode",
            UserData: { PlayedPercentage: 10 },
          },
        ],
      }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      olderThanDays: 30,
      confirm: true,
    });

    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(1);
    expect(parseResult(result)).toMatchObject({ clearedCount: 1 });
  });

  it("clears all episode resume entries for a series except the latest played", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 3,
        Items: [
          {
            Id: "ep-1",
            Name: "Episode 1",
            Type: "Episode",
            SeriesId: "series-1",
            UserData: { LastPlayedDate: "2026-01-01T00:00:00Z" },
          },
          {
            Id: "ep-2",
            Name: "Episode 2",
            Type: "Episode",
            SeriesId: "series-1",
            UserData: { LastPlayedDate: "2026-01-03T00:00:00Z" },
          },
          {
            Id: "ep-3",
            Name: "Episode 3",
            Type: "Episode",
            SeriesId: "series-2",
          },
        ],
      }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_episode_continue_watching_except_latest");
    const result = await tool!.handler({
      userId: "user-42",
      seriesId: "series-1",
      confirm: true,
    });

    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(1);
    expect(client.clearPlaybackPosition).toHaveBeenCalledWith(
      "user-42",
      "ep-1",
      { LastPlayedDate: "2026-01-01T00:00:00Z" },
    );
    expect(parseResult(result).keptItem).toEqual(expect.objectContaining({ id: "ep-2" }));
  });

  it("can keep the latest episode number instead of the latest played episode", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          {
            Id: "s1e1",
            Name: "Episode 1",
            Type: "Episode",
            SeriesId: "series-1",
            ParentIndexNumber: 1,
            IndexNumber: 1,
            UserData: { LastPlayedDate: "2026-01-03T00:00:00Z" },
          },
          {
            Id: "s1e2",
            Name: "Episode 2",
            Type: "Episode",
            SeriesId: "series-1",
            ParentIndexNumber: 1,
            IndexNumber: 2,
            UserData: { LastPlayedDate: "2026-01-01T00:00:00Z" },
          },
        ],
      }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_episode_continue_watching_except_latest");
    const result = await tool!.handler({
      userId: "user-42",
      seriesId: "series-1",
      keepBy: "episodeNumber",
      confirm: true,
    });

    expect(client.clearPlaybackPosition).toHaveBeenCalledWith(
      "user-42",
      "s1e1",
      { LastPlayedDate: "2026-01-03T00:00:00Z" },
    );
    expect(parseResult(result).keptItem).toEqual(expect.objectContaining({ id: "s1e2" }));
  });

  it("clears series Continue Watching entries", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          { Id: "ep-1", Name: "Episode 1", Type: "Episode", SeriesId: "series-1" },
          { Id: "movie-1", Name: "Movie", Type: "Movie", SeriesId: "series-1" },
        ],
      }),
      clearPlaybackPosition: vi.fn().mockResolvedValue({ PlaybackPositionTicks: 0 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_clear_series_continue_watching");
    const result = await tool!.handler({
      userId: "user-42",
      seriesId: "series-1",
      confirm: true,
    });

    expect(client.clearPlaybackPosition).toHaveBeenCalledTimes(1);
    expect(client.clearPlaybackPosition).toHaveBeenCalledWith("user-42", "ep-1", undefined);
    expect(parseResult(result)).toMatchObject({ clearedCount: 1 });
  });

  it("sets a resume position through the client", async () => {
    const client = {
      getItem: vi.fn().mockResolvedValue({
        Id: "movie-1",
        Name: "Movie",
        Type: "Movie",
        RunTimeTicks: 100_000_000,
      }),
      setPlaybackPosition: vi.fn().mockResolvedValue({
        PlaybackPositionTicks: 30_000_000,
        PlayedPercentage: 30,
      }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_set_resume_position");
    const result = await tool!.handler({
      userId: "user-42",
      itemId: "movie-1",
      positionSec: 3,
      confirm: true,
    });

    expect(client.setPlaybackPosition).toHaveBeenCalledWith(
      "user-42",
      "movie-1",
      3,
      undefined,
      100_000_000,
    );
    expect(parseResult(result)).toMatchObject({
      userId: "user-42",
      requestedPositionSeconds: 3,
      positionSeconds: 3,
    });
  });

  it("gets watch history through the client", async () => {
    const client = {
      getWatchHistory: vi.fn().mockResolvedValue({
        TotalRecordCount: 1,
        StartIndex: 0,
        Items: [
          {
            Id: "movie-1",
            Name: "Movie",
            Type: "Movie",
            UserData: { LastPlayedDate: "2026-01-01T00:00:00Z", PlayCount: 2 },
          },
        ],
      }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerUserDataTools(server as never, client);

    const tool = tools.get("jellyfin_get_watch_history");
    const result = await tool!.handler({
      userId: "user-42",
      itemTypes: ["Movie"],
      limit: 5,
      startIndex: 10,
    });

    expect(client.getWatchHistory).toHaveBeenCalledWith("user-42", 5, 10, "Movie");
    expect(parseResult(result).items).toEqual([
      expect.objectContaining({ id: "movie-1", playCount: 2 }),
    ]);
  });
});
