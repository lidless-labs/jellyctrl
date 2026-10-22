import { describe, expect, it, vi } from "vitest";
import type { JellyfinClient } from "../src/client.js";
import { registerPlaylistTools } from "../src/tools/playlists.js";

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
