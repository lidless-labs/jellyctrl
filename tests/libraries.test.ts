import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerLibraryTools } from "../src/tools/libraries.js";

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
  registerLibraryTools(server as never, methods as unknown as JellyfinClient);
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

describe("library tools", () => {
  describe("jellyfin_list_libraries", () => {
    it("maps ItemId (not Name) to id and defaults a missing collection type to null", async () => {
      const listLibraries = vi.fn().mockResolvedValue([
        {
          Name: "Movies",
          ItemId: "lib-movies-id",
          CollectionType: "movies",
          Locations: ["/example/movies", "/example/movies-4k"],
          RefreshStatus: "Idle",
        },
        { Name: "Mixed", ItemId: "lib-mixed-id", Locations: [] },
      ]);
      const call = setup({ listLibraries });

      const result = await call("jellyfin_list_libraries");

      expect(listLibraries).toHaveBeenCalledExactlyOnceWith();
      expect(parseResult(result)).toEqual([
        {
          id: "lib-movies-id",
          name: "Movies",
          collectionType: "movies",
          locations: ["/example/movies", "/example/movies-4k"],
        },
        { id: "lib-mixed-id", name: "Mixed", collectionType: null, locations: [] },
      ]);
    });

    it("returns an empty array when there are no libraries", async () => {
      const call = setup({ listLibraries: vi.fn().mockResolvedValue([]) });

      const result = await call("jellyfin_list_libraries");

      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual([]);
    });
  });

  describe("jellyfin_scan_library", () => {
    it("scans one library and forwards its id", async () => {
      const scanLibraries = vi.fn().mockResolvedValue(undefined);
      const call = setup({ scanLibraries });

      const result = await call("jellyfin_scan_library", { confirm: true, libraryId: "lib-1" });

      expect(scanLibraries).toHaveBeenCalledExactlyOnceWith("lib-1");
      expect(parseResult(result)).toEqual({ result: "scan triggered for library lib-1" });
    });

    it("scans all libraries when libraryId is omitted", async () => {
      const scanLibraries = vi.fn().mockResolvedValue(undefined);
      const call = setup({ scanLibraries });

      const result = await call("jellyfin_scan_library", { confirm: true });

      expect(scanLibraries).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(parseResult(result)).toEqual({ result: "scan triggered for all libraries" });
    });
  });

  it.each([
    ["jellyfin_list_libraries", {}, "listLibraries"],
    ["jellyfin_scan_library", { confirm: true, libraryId: "lib-1" }, "scanLibraries"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("scan refused"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "scan refused" });
  });
});
