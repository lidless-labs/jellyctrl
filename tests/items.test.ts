import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { registerItemTools } from "../src/tools/items.js";
import type { JellyfinClient } from "../src/client.js";

interface CapturedTool {
  name: string;
  schema: Record<string, z.ZodType>;
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
      schema: CapturedTool["schema"],
      _annotations: unknown,
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, { name, schema, handler });
    },
  };
  return { server, tools };
}

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("jellyfin_get_item", () => {
  it("requires userId so API-key callers can supply item context", () => {
    const { server, tools } = makeFakeServer();
    registerItemTools(server as never, {} as JellyfinClient);

    const tool = tools.get("jellyfin_get_item");
    expect(tool).toBeDefined();
    const schema = z.object(tool!.schema);

    expect(() => schema.parse({ itemId: "i1" })).toThrow();
    expect(schema.parse({ itemId: "i1", userId: "u1" })).toEqual({
      itemId: "i1",
      userId: "u1",
    });
  });

  it("passes itemId and userId to the client", async () => {
    const client = {
      getItem: vi.fn().mockResolvedValue({ Id: "i1", Name: "Movie", Type: "Movie" }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerItemTools(server as never, client);

    const tool = tools.get("jellyfin_get_item");
    const result = await tool!.handler({ itemId: "i1", userId: "u1" });

    expect(client.getItem).toHaveBeenCalledWith("i1", "u1");
    expect(parseResult(result)).toMatchObject({ Id: "i1", Name: "Movie" });
  });
});

describe("item handlers", () => {
  // Runs raw args through the tool's own schema so defaults are real, against
  // a partial client double. Any accidental real request fails loudly.
  function setup(methods: Record<string, unknown>) {
    const { server, tools } = makeFakeServer();
    registerItemTools(server as never, methods as unknown as JellyfinClient);
    return (name: string, args: Record<string, unknown>) => {
      const tool = tools.get(name)!;
      return tool.handler(z.object(tool.schema).parse(args));
    };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected network call");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("jellyfin_search_items", () => {
    it("applies the default limit, forwards the type filter, and maps the item fields", async () => {
      const searchItems = vi.fn().mockResolvedValue({
        TotalRecordCount: 31,
        Items: [
          { Id: "m-1", Name: "Example Film", Type: "Movie", ProductionYear: 1999, Overview: "ignored" },
          { Id: "e-1", Name: "Pilot", Type: "Episode", SeriesName: "Example Show" },
        ],
      });
      const call = setup({ searchItems });

      const result = await call("jellyfin_search_items", { query: "example", itemTypes: "Movie,Episode" });

      expect(searchItems).toHaveBeenCalledExactlyOnceWith("example", "Movie,Episode", 20);
      expect(parseResult(result)).toEqual({
        totalCount: 31,
        items: [
          { id: "m-1", name: "Example Film", type: "Movie", seriesName: null, productionYear: 1999 },
          { id: "e-1", name: "Pilot", type: "Episode", seriesName: "Example Show", productionYear: null },
        ],
      });
    });

    it("forwards an explicit limit and leaves the type filter undefined when omitted", async () => {
      const searchItems = vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] });
      const call = setup({ searchItems });

      const result = await call("jellyfin_search_items", { query: "nothing", limit: 200 });

      expect(searchItems).toHaveBeenCalledExactlyOnceWith("nothing", undefined, 200);
      expect(parseResult(result)).toEqual({ totalCount: 0, items: [] });
    });
  });

  describe("jellyfin_get_recent_items", () => {
    it("forwards user and default limit and returns a bare array with dateCreated mapped", async () => {
      const getRecentItems = vi.fn().mockResolvedValue([
        {
          Id: "e-9",
          Name: "Newest",
          Type: "Episode",
          SeriesName: "Example Show",
          ProductionYear: 2026,
          DateCreated: "2026-04-19T12:00:00Z",
        },
        { Id: "m-9", Name: "Bare Film", Type: "Movie" },
      ]);
      const call = setup({ getRecentItems });

      const result = await call("jellyfin_get_recent_items", { userId: "u-1" });

      expect(getRecentItems).toHaveBeenCalledExactlyOnceWith("u-1", 20);
      expect(parseResult(result)).toEqual([
        {
          id: "e-9",
          name: "Newest",
          type: "Episode",
          seriesName: "Example Show",
          productionYear: 2026,
          dateCreated: "2026-04-19T12:00:00Z",
        },
        {
          id: "m-9",
          name: "Bare Film",
          type: "Movie",
          seriesName: null,
          productionYear: null,
          dateCreated: null,
        },
      ]);
    });

    it("forwards an explicit limit and returns an empty array when nothing is new", async () => {
      const getRecentItems = vi.fn().mockResolvedValue([]);
      const call = setup({ getRecentItems });

      const result = await call("jellyfin_get_recent_items", { userId: "u-1", limit: 100 });

      expect(getRecentItems).toHaveBeenCalledExactlyOnceWith("u-1", 100);
      expect(parseResult(result)).toEqual([]);
    });
  });

  describe("jellyfin_get_favorite_items", () => {
    it("applies default paging and maps the page, falling back to the requested start index", async () => {
      const getFavoriteItems = vi.fn().mockResolvedValue({
        TotalRecordCount: 4,
        Items: [{ Id: "m-1", Name: "Liked Film", Type: "Movie", ProductionYear: 2001 }],
      });
      const call = setup({ getFavoriteItems });

      const result = await call("jellyfin_get_favorite_items", { userId: "u-1" });

      expect(getFavoriteItems).toHaveBeenCalledExactlyOnceWith("u-1", 20, 0, undefined);
      expect(parseResult(result)).toEqual({
        totalCount: 4,
        startIndex: 0,
        items: [{ id: "m-1", name: "Liked Film", type: "Movie", seriesName: null, productionYear: 2001 }],
      });
    });

    it("forwards type filter, limit, and start index and prefers the server's StartIndex", async () => {
      const getFavoriteItems = vi.fn().mockResolvedValue({ TotalRecordCount: 0, StartIndex: 5, Items: [] });
      const call = setup({ getFavoriteItems });

      const result = await call("jellyfin_get_favorite_items", {
        userId: "u-1",
        itemTypes: ["Series", "Episode"],
        limit: 50,
        startIndex: 10,
      });

      expect(getFavoriteItems).toHaveBeenCalledExactlyOnceWith("u-1", 50, 10, ["Series", "Episode"]);
      expect(parseResult(result)).toEqual({ totalCount: 0, startIndex: 5, items: [] });
    });
  });

  it.each([
    ["jellyfin_search_items", { query: "x" }, "searchItems"],
    ["jellyfin_get_recent_items", { userId: "u-1" }, "getRecentItems"],
    ["jellyfin_get_item", { itemId: "i-1", userId: "u-1" }, "getItem"],
    ["jellyfin_get_favorite_items", { userId: "u-1" }, "getFavoriteItems"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("items api failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "items api failed" });
  });
});
