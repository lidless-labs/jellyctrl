import { describe, it, expect, vi } from "vitest";
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
