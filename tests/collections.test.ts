import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerCollectionTools } from "../src/tools/collections.js";

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
  registerCollectionTools(server as never, methods as unknown as JellyfinClient);
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

describe("collection tools", () => {
  describe("jellyfin_create_collection", () => {
    it("defaults itemIds to an empty list and returns the new id with the requested name", async () => {
      const createCollection = vi.fn().mockResolvedValue({ Id: "col-new" });
      const call = setup({ createCollection });

      const result = await call("jellyfin_create_collection", { confirm: true, name: "Example Saga" });

      expect(createCollection).toHaveBeenCalledExactlyOnceWith("Example Saga", []);
      expect(parseResult(result)).toEqual({ id: "col-new", name: "Example Saga" });
    });

    it("forwards the initial items", async () => {
      const createCollection = vi.fn().mockResolvedValue({ Id: "col-new" });
      const call = setup({ createCollection });

      await call("jellyfin_create_collection", { confirm: true, name: "Example Saga", itemIds: ["m-1", "m-2"] });

      expect(createCollection).toHaveBeenCalledExactlyOnceWith("Example Saga", ["m-1", "m-2"]);
    });
  });

  describe("jellyfin_add_to_collection", () => {
    it("forwards the collection and items and reports the count", async () => {
      const addToCollection = vi.fn().mockResolvedValue(undefined);
      const call = setup({ addToCollection });

      const result = await call("jellyfin_add_to_collection", { confirm: true,
        collectionId: "col-1",
        itemIds: ["m-1", "m-2"],
      });

      expect(addToCollection).toHaveBeenCalledExactlyOnceWith("col-1", ["m-1", "m-2"]);
      expect(parseResult(result)).toEqual({ result: "added 2 item(s) to collection col-1" });
    });
  });

  describe("jellyfin_remove_from_collection", () => {
    it("forwards the collection and items when confirmed and reports the count", async () => {
      const removeFromCollection = vi.fn().mockResolvedValue(undefined);
      const call = setup({ removeFromCollection });

      const result = await call("jellyfin_remove_from_collection", {
        collectionId: "col-1",
        itemIds: ["m-3"],
        confirm: true,
      });

      expect(removeFromCollection).toHaveBeenCalledExactlyOnceWith("col-1", ["m-3"]);
      expect(parseResult(result)).toEqual({ result: "removed 1 item(s) from collection col-1" });
    });
  });

  it.each([
    ["jellyfin_create_collection", { confirm: true, name: "Example Saga" }, "createCollection"],
    ["jellyfin_add_to_collection", { confirm: true, collectionId: "col-1", itemIds: ["m-1"] }, "addToCollection"],
    ["jellyfin_remove_from_collection", { collectionId: "col-1", itemIds: ["m-1"], confirm: true }, "removeFromCollection"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("collection api failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "collection api failed" });
  });
});
