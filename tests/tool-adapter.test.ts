import { describe, expect, it, vi } from "vitest";
import type { JellyfinClient } from "../src/client.js";
import { z } from "zod";
import { fail, ok } from "../src/tools/_util.js";
import { registerPlaylistTools } from "../src/tools/playlists.js";

interface CapturedTool {
  name: string;
  schema: z.ZodRawShape;
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
      schema: z.ZodRawShape,
      annotations: CapturedTool["annotations"],
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, { name, schema, annotations, handler });
    },
  };
  return { server, tools };
}

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("tool error contracts", () => {
  it("returns fail() JSON when a transform throws after a successful client call", async () => {
    const client = {
      listPlaylists: vi.fn().mockResolvedValue({ TotalRecordCount: 1 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, client);

    const tool = tools.get("jellyfin_list_playlists");
    const result = await tool!.handler({ userId: "u1" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: expect.stringContaining("map"),
    });
  });
});

describe("MCP output size limit", () => {
  const cap = 2 * 1024 * 1024;

  it.each(["a", "é", "\n"])("returns a valid error instead of oversized JSON for %j", (value) => {
    const result = ok({ example: value.repeat(cap) });
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(cap);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "Tool result exceeds the 2097152-byte limit. Request fewer items or a smaller result." });
  });

  it("accepts the exact serialized byte limit and rejects the next byte", () => {
    const value = "a".repeat(cap - 2);
    const result = ok(value);
    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content[0].text)).toBe(cap);
    expect(JSON.parse(result.content[0].text)).toBe(value);
    expect(ok(value + "a").isError).toBe(true);
  });
});


describe("playlist paging", () => {
  it.each([
    { page: {}, limit: 100, startIndex: 0, upstreamStartIndex: undefined },
    { page: { limit: 25, startIndex: 100 }, limit: 25, startIndex: 100, upstreamStartIndex: 100 },
  ])("maps one playlist page with $limit/$startIndex", async ({ page, limit, startIndex, upstreamStartIndex }) => {
    const getPlaylistItems = vi.fn().mockResolvedValue({
      TotalRecordCount: 350, StartIndex: upstreamStartIndex,
      Items: [
        { Id: "i1", Name: "Track", Type: "Audio", PlaylistItemId: "entry-101" },
        { Id: "i1", Name: "Track", Type: "Audio", PlaylistItemId: "entry-102" },
        { Id: "i2", Name: "Other", Type: "Audio" },
      ],
    });
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, { getPlaylistItems } as unknown as JellyfinClient);
    const tool = tools.get("jellyfin_get_playlist_items")!;
    const args = z.object(tool.schema).parse({ playlistId: "pl1", userId: "u1", ...page });
    const result = await tool.handler(args);

    expect(result.isError).toBeUndefined();
    expect(getPlaylistItems).toHaveBeenCalledExactlyOnceWith("pl1", "u1", limit, startIndex);
    expect(parseResult(result)).toEqual({
      startIndex, totalCount: 350,
      items: [
        { playlistEntryId: "entry-101", itemId: "i1", name: "Track", type: "Audio", seriesName: null },
        { playlistEntryId: "entry-102", itemId: "i1", name: "Track", type: "Audio", seriesName: null },
        { playlistEntryId: null, itemId: "i2", name: "Other", type: "Audio", seriesName: null },
      ],
    });
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "10" },
    { startIndex: -1 }, { startIndex: 0.5 }, { startIndex: "10" },
  ])("rejects invalid MCP page bounds %j", (page) => {
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, {} as JellyfinClient);
    const schema = z.object(tools.get("jellyfin_get_playlist_items")!.schema);
    expect(schema.safeParse({ playlistId: "pl1", userId: "u1", ...page }).success).toBe(false);
  });
});

describe("MCP error output size limit", () => {
  const cap = 2 * 1024 * 1024;
  const overflow = { error: "Tool error exceeds the 2097152-byte limit." };

  it.each(["a", "é", "\n", '"'])("bounds serialized error bytes for %j at the UTF-8/escape boundary", (character) => {
    const overhead = Buffer.byteLength(JSON.stringify({ error: "" }, null, 2));
    const width = Buffer.byteLength(JSON.stringify(character)) - 2;
    const copies = Math.floor((cap - overhead) / width);
    const message = character.repeat(copies) + "a".repeat(cap - overhead - copies * width);
    const accepted = fail(new Error(message));
    expect(accepted.isError).toBe(true);
    expect(Buffer.byteLength(accepted.content[0].text)).toBe(cap);
    expect(accepted.content[0].text).toBe(JSON.stringify({ error: message }, null, 2));
    const result = fail(new Error(message + "a"));
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(cap);
    expect(JSON.parse(result.content[0].text)).toEqual(overflow);
  });

  it.each([new Error("Example error"), "Example error", 42, null])("preserves the normal error contract for %j", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    expect(fail(error)).toEqual({ content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true });
  });

  it("bounds a rejected client error through the Effect adapter", async () => {
    const listPlaylists = vi.fn().mockRejectedValue(new Error("x".repeat(3 * 1024 * 1024)));
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, { listPlaylists } as unknown as JellyfinClient);
    const result = await tools.get("jellyfin_list_playlists")!.handler({ userId: "u1" });
    expect(listPlaylists).toHaveBeenCalledExactlyOnceWith("u1");
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(cap);
    expect(JSON.parse(result.content[0].text)).toEqual(overflow);
  });

  it("bounds a long confirmation refusal before making any client call", async () => {
    const removeFromPlaylist = vi.fn();
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, { removeFromPlaylist } as unknown as JellyfinClient);
    const tool = tools.get("jellyfin_remove_from_playlist")!;
    const args = z.object(tool.schema).parse({ playlistId: "é".repeat(cap), entryIds: ["entry1"] });
    const result = await tool.handler(args);
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(cap);
    expect(JSON.parse(result.content[0].text)).toEqual(overflow);
    expect(removeFromPlaylist).not.toHaveBeenCalled();
  });
});
