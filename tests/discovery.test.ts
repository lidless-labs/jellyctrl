import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerDiscoveryTools } from "../src/tools/discovery.js";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

interface CapturedTool {
  schema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function makeFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (
      name: string,
      _description: string,
      schema: CapturedTool["schema"],
      _annotations: unknown,
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, { schema, handler });
    },
  };
  return { server, tools };
}

// Registers the module against a partial client double and returns a caller
// that runs raw args through the tool's own zod schema, so defaults are real.
function setup(methods: Record<string, unknown>) {
  const { server, tools } = makeFakeServer();
  registerDiscoveryTools(server as never, methods as unknown as JellyfinClient);
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// Tests stay mocked; any accidental real request fails loudly.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("unexpected network call");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const emptyPage = { Items: [], TotalRecordCount: 0 };

describe("discovery tools", () => {
  describe("jellyfin_get_resume_items", () => {
    it("trims the user id, applies the default limit, and converts ticks to rounded seconds", async () => {
      const getResumeItems = vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          {
            Id: "ep-1",
            Name: "Pilot",
            Type: "Episode",
            SeriesName: "Example Show",
            ProductionYear: 2021,
            RunTimeTicks: 27_000_000_000,
            UserData: { PlaybackPositionTicks: 6_005_000_000, PlayedPercentage: 22.2 },
          },
          { Id: "mv-1", Name: "Example Film", Type: "Movie", RunTimeTicks: 0, UserData: { PlaybackPositionTicks: 0 } },
        ],
      });
      const call = setup({ getResumeItems });

      const result = await call("jellyfin_get_resume_items", { userId: "  u-1 " });

      expect(getResumeItems).toHaveBeenCalledExactlyOnceWith("u-1", 20);
      expect(parseResult(result)).toEqual({
        totalCount: 2,
        items: [
          {
            id: "ep-1",
            name: "Pilot",
            type: "Episode",
            seriesName: "Example Show",
            productionYear: 2021,
            runtimeSeconds: 2700,
            resumePositionSeconds: 601,
            playedPercentage: 22.2,
          },
          {
            id: "mv-1",
            name: "Example Film",
            type: "Movie",
            seriesName: null,
            productionYear: null,
            runtimeSeconds: 0,
            resumePositionSeconds: 0,
            playedPercentage: null,
          },
        ],
      });
    });

    it("reports null seconds when tick fields or user data are absent", async () => {
      const call = setup({
        getResumeItems: vi.fn().mockResolvedValue({
          TotalRecordCount: 1,
          Items: [{ Id: "x", Name: "n", Type: "Movie" }],
        }),
      });

      const payload = parseResult(await call("jellyfin_get_resume_items", { userId: "u-1" })) as {
        items: Record<string, unknown>[];
      };

      expect(payload.items[0]).toMatchObject({
        runtimeSeconds: null,
        resumePositionSeconds: null,
        playedPercentage: null,
      });
    });

    it("forwards an explicit limit and handles an empty queue", async () => {
      const getResumeItems = vi.fn().mockResolvedValue(emptyPage);
      const call = setup({ getResumeItems });

      const result = await call("jellyfin_get_resume_items", { userId: "u-1", limit: 100 });

      expect(getResumeItems).toHaveBeenCalledExactlyOnceWith("u-1", 100);
      expect(parseResult(result)).toEqual({ totalCount: 0, items: [] });
    });
  });

  describe("jellyfin_get_next_up", () => {
    it("forwards user, default limit, and an absent series, and maps episode numbering", async () => {
      const getNextUp = vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          {
            Id: "ep-7",
            Name: "Episode Seven",
            Type: "Episode",
            SeriesName: "Example Show",
            ParentIndexNumber: 2,
            IndexNumber: 7,
            ProductionYear: 2022,
            RunTimeTicks: 25_004_000_000,
          },
          { Id: "ep-0", Name: "Special", Type: "Episode", ParentIndexNumber: 0, IndexNumber: 0 },
        ],
      });
      const call = setup({ getNextUp });

      const result = await call("jellyfin_get_next_up", { userId: "u-1" });

      expect(getNextUp).toHaveBeenCalledExactlyOnceWith("u-1", 20, undefined);
      expect(parseResult(result)).toEqual({
        totalCount: 2,
        items: [
          {
            id: "ep-7",
            name: "Episode Seven",
            type: "Episode",
            seriesName: "Example Show",
            seasonNumber: 2,
            episodeNumber: 7,
            productionYear: 2022,
            runtimeSeconds: 2500,
          },
          {
            id: "ep-0",
            name: "Special",
            type: "Episode",
            seriesName: null,
            seasonNumber: 0,
            episodeNumber: 0,
            productionYear: null,
            runtimeSeconds: null,
          },
        ],
      });
    });

    it("forwards seriesId and limit in the client's positional order and handles an empty page", async () => {
      const getNextUp = vi.fn().mockResolvedValue(emptyPage);
      const call = setup({ getNextUp });

      const result = await call("jellyfin_get_next_up", { userId: "u-1", seriesId: "series-5", limit: 3 });

      expect(getNextUp).toHaveBeenCalledExactlyOnceWith("u-1", 3, "series-5");
      expect(parseResult(result)).toEqual({ totalCount: 0, items: [] });
    });
  });

  describe("jellyfin_get_similar_items", () => {
    it("forwards the anchor item, optional user, and limit and maps ratings", async () => {
      const getSimilarItems = vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          { Id: "m-2", Name: "Similar Film", Type: "Movie", ProductionYear: 1999, CommunityRating: 7.8 },
          { Id: "s-2", Name: "Similar Show", Type: "Series", SeriesName: "Parent" },
        ],
      });
      const call = setup({ getSimilarItems });

      const result = await call("jellyfin_get_similar_items", { itemId: "m-1", userId: "u-1", limit: 5 });

      expect(getSimilarItems).toHaveBeenCalledExactlyOnceWith("m-1", "u-1", 5);
      expect(parseResult(result)).toEqual({
        totalCount: 2,
        items: [
          { id: "m-2", name: "Similar Film", type: "Movie", seriesName: null, productionYear: 1999, communityRating: 7.8 },
          { id: "s-2", name: "Similar Show", type: "Series", seriesName: "Parent", productionYear: null, communityRating: null },
        ],
      });
    });

    it("defaults limit to 20, leaves userId undefined, and handles an empty page", async () => {
      const getSimilarItems = vi.fn().mockResolvedValue(emptyPage);
      const call = setup({ getSimilarItems });

      const result = await call("jellyfin_get_similar_items", { itemId: "m-1" });

      expect(getSimilarItems).toHaveBeenCalledExactlyOnceWith("m-1", undefined, 20);
      expect(parseResult(result)).toEqual({ totalCount: 0, items: [] });
    });
  });

  it.each([
    ["jellyfin_get_resume_items", { userId: "u-1" }, "getResumeItems"],
    ["jellyfin_get_next_up", { userId: "u-1" }, "getNextUp"],
    ["jellyfin_get_similar_items", { itemId: "m-1" }, "getSimilarItems"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("discovery failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "discovery failed" });
  });
});
