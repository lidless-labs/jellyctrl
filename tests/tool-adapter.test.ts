import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
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

describe("tool result byte cap", () => {
  it("truncates an oversize success result with the kit marker", async () => {
    const client = {
      listPlaylists: vi.fn().mockResolvedValue({ Items: [{ Name: "é".repeat(80_000) }], TotalRecordCount: 1 }),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, client);

    const result = await tools.get("jellyfin_list_playlists")!.handler({ userId: "u1" });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(90_000);
    expect(result.content[0].text).toContain("[truncated: output was");
    expect(result).not.toHaveProperty("details");
  });

  it("truncates an oversize error result and keeps isError", async () => {
    const client = {
      listPlaylists: vi.fn().mockRejectedValue(new Error("x".repeat(200_000))),
    } as unknown as JellyfinClient;
    const { server, tools } = makeFakeServer();
    registerPlaylistTools(server as never, client);

    const result = await tools.get("jellyfin_list_playlists")!.handler({ userId: "u1" });

    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(90_000);
    expect(result.content[0].text).toContain("[truncated: output was");
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
