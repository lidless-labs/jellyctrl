import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerPlaylistTools } from "../src/tools/playlists.js";

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
  registerPlaylistTools(server as never, methods as unknown as JellyfinClient);
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

describe("playlist tools", () => {
  describe("jellyfin_list_playlists", () => {
    it("scopes the read to the user and maps id and name", async () => {
      const listPlaylists = vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          { Id: "pl-1", Name: "Road Trip", ChildCount: 12 },
          { Id: "pl-2", Name: "Rainy Day" },
        ],
      });
      const call = setup({ listPlaylists });

      const result = await call("jellyfin_list_playlists", { userId: "u-1" });

      expect(listPlaylists).toHaveBeenCalledExactlyOnceWith("u-1");
      expect(parseResult(result)).toEqual({
        totalCount: 2,
        playlists: [
          { id: "pl-1", name: "Road Trip" },
          { id: "pl-2", name: "Rainy Day" },
        ],
      });
    });

    it("returns an empty list when the user has no playlists", async () => {
      const call = setup({
        listPlaylists: vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] }),
      });

      expect(parseResult(await call("jellyfin_list_playlists", { userId: "u-1" }))).toEqual({
        totalCount: 0,
        playlists: [],
      });
    });
  });

  describe("jellyfin_create_playlist", () => {
    it("defaults itemIds to an empty list and falls back to the requested name", async () => {
      const createPlaylist = vi.fn().mockResolvedValue({ Id: "pl-new" });
      const call = setup({ createPlaylist });

      const result = await call("jellyfin_create_playlist", { confirm: true, name: "Fresh", userId: "u-1" });

      expect(createPlaylist).toHaveBeenCalledExactlyOnceWith("Fresh", "u-1", [], undefined);
      expect(parseResult(result)).toEqual({ id: "pl-new", name: "Fresh" });
    });

    it("forwards initial items and media type and prefers the server's name", async () => {
      const createPlaylist = vi.fn().mockResolvedValue({ Id: "pl-new", Name: "Fresh (server)" });
      const call = setup({ createPlaylist });

      const result = await call("jellyfin_create_playlist", { confirm: true,
        name: "Fresh",
        userId: "u-1",
        itemIds: ["i-1", "i-2"],
        mediaType: "Audio",
      });

      expect(createPlaylist).toHaveBeenCalledExactlyOnceWith("Fresh", "u-1", ["i-1", "i-2"], "Audio");
      expect(parseResult(result)).toEqual({ id: "pl-new", name: "Fresh (server)" });
    });
  });

  describe("jellyfin_get_playlist_items", () => {
    it("forwards playlist and user ids and keeps the entry id apart from the item id", async () => {
      const getPlaylistItems = vi.fn().mockResolvedValue({
        TotalRecordCount: 2,
        Items: [
          { Id: "item-1", PlaylistItemId: "entry-A", Name: "Track One", Type: "Audio" },
          { Id: "item-2", Name: "Episode Two", Type: "Episode", SeriesName: "Example Show" },
        ],
      });
      const call = setup({ getPlaylistItems });

      const result = await call("jellyfin_get_playlist_items", { playlistId: "pl-1", userId: "u-1" });

      expect(getPlaylistItems).toHaveBeenCalledExactlyOnceWith("pl-1", "u-1");
      expect(parseResult(result)).toEqual({
        totalCount: 2,
        items: [
          { playlistEntryId: "entry-A", itemId: "item-1", name: "Track One", type: "Audio", seriesName: null },
          { playlistEntryId: null, itemId: "item-2", name: "Episode Two", type: "Episode", seriesName: "Example Show" },
        ],
      });
    });

    it("returns an empty item list for an empty playlist", async () => {
      const call = setup({
        getPlaylistItems: vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] }),
      });

      expect(
        parseResult(await call("jellyfin_get_playlist_items", { playlistId: "pl-1", userId: "u-1" })),
      ).toEqual({ totalCount: 0, items: [] });
    });
  });

  describe("jellyfin_add_to_playlist", () => {
    it("forwards playlist, items, and user in the client's argument order", async () => {
      const addToPlaylist = vi.fn().mockResolvedValue(undefined);
      const call = setup({ addToPlaylist });

      const result = await call("jellyfin_add_to_playlist", { confirm: true,
        playlistId: "pl-1",
        itemIds: ["i-1", "i-2", "i-3"],
        userId: "u-1",
      });

      expect(addToPlaylist).toHaveBeenCalledExactlyOnceWith("pl-1", ["i-1", "i-2", "i-3"], "u-1");
      expect(parseResult(result)).toEqual({ result: "added 3 item(s) to playlist pl-1" });
    });
  });

  describe("jellyfin_remove_from_playlist", () => {
    it("forwards entry ids, not item ids, when confirmed", async () => {
      const removeFromPlaylist = vi.fn().mockResolvedValue(undefined);
      const call = setup({ removeFromPlaylist });

      const result = await call("jellyfin_remove_from_playlist", {
        playlistId: "pl-1",
        entryIds: ["entry-A", "entry-B"],
        confirm: true,
      });

      expect(removeFromPlaylist).toHaveBeenCalledExactlyOnceWith("pl-1", ["entry-A", "entry-B"]);
      expect(parseResult(result)).toEqual({ result: "removed 2 entry/entries from playlist pl-1" });
    });
  });

  it.each([
    ["jellyfin_list_playlists", { userId: "u-1" }, "listPlaylists"],
    ["jellyfin_create_playlist", { confirm: true, name: "Fresh", userId: "u-1" }, "createPlaylist"],
    ["jellyfin_get_playlist_items", { playlistId: "pl-1", userId: "u-1" }, "getPlaylistItems"],
    ["jellyfin_add_to_playlist", { confirm: true, playlistId: "pl-1", itemIds: ["i-1"], userId: "u-1" }, "addToPlaylist"],
    ["jellyfin_remove_from_playlist", { playlistId: "pl-1", entryIds: ["e-1"], confirm: true }, "removeFromPlaylist"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("playlist api failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "playlist api failed" });
  });
});
