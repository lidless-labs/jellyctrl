import { describe, expect, it, vi } from "vitest";
import type { JellyfinClient } from "../src/client.js";
import { registerSystemTools } from "../src/tools/system.js";

type Handler = (args: Record<string, never>) => Promise<unknown>;

function capturePluginTool(client: JellyfinClient) {
  let captured: { name: string; schema: unknown; annotations: unknown; handler: Handler } | undefined;
  const server = {
    tool: (name: string, _description: string, schema: unknown, annotations: unknown, handler: Handler) => {
      if (name === "jellyfin_list_plugins") captured = { name, schema, annotations, handler };
    },
  };
  registerSystemTools(server as never, client);
  if (!captured) throw new Error("Plugin inventory tool was not registered");
  return captured;
}

const plugin = (Id: string, Name: string, Status: string) => ({
  Id, Name, Version: "1.0", Description: `${Name} plugin`, Status, CanUninstall: false,
  InternalPath: "example-plugin-path",
});

describe("jellyfin_list_plugins", () => {
  it("returns an empty inventory", async () => {
    const tool = capturePluginTool({ listPlugins: vi.fn().mockResolvedValue([]) } as unknown as JellyfinClient);
    const result = await tool.handler({});
    expect(result).not.toMatchObject({ isError: true });
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)).toEqual({
      count: 0, byStatus: {}, plugins: [],
    });
  });

  it("sorts by name, counts every status, and exposes only allowlisted fields", async () => {
    const upstream = [plugin("2", "Zulu", "FutureStatus"), plugin("1", "Alpha", "Active"),
      plugin("3", "Beta", "Active"), plugin("4", "Delta", "Disabled")];
    const tool = capturePluginTool({ listPlugins: vi.fn().mockResolvedValue(upstream) } as unknown as JellyfinClient);
    const result = await tool.handler({});
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload).toEqual({
      count: 4,
      byStatus: { FutureStatus: 1, Active: 2, Disabled: 1 },
      plugins: [
        { id: "1", name: "Alpha", version: "1.0", description: "Alpha plugin", status: "Active", canUninstall: false },
        { id: "3", name: "Beta", version: "1.0", description: "Beta plugin", status: "Active", canUninstall: false },
        { id: "4", name: "Delta", version: "1.0", description: "Delta plugin", status: "Disabled", canUninstall: false },
        { id: "2", name: "Zulu", version: "1.0", description: "Zulu plugin", status: "FutureStatus", canUninstall: false },
      ],
    });
    expect(upstream.map(({ Name }) => Name)).toEqual(["Zulu", "Alpha", "Beta", "Delta"]);
    expect(JSON.stringify(payload)).not.toContain("InternalPath");
  });

  it("surfaces client failures as tool errors", async () => {
    const tool = capturePluginTool({ listPlugins: vi.fn().mockRejectedValue(new Error("unavailable")) } as unknown as JellyfinClient);
    await expect(tool.handler({})).resolves.toMatchObject({ isError: true });
  });

  it("uses a no-input schema and complete read-only hints", () => {
    const tool = capturePluginTool({} as JellyfinClient);
    expect(tool.name).toBe("jellyfin_list_plugins");
    expect(tool.schema).toEqual({});
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
});
