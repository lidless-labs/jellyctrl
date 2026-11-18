import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerSystemTools } from "../src/tools/system.js";

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
  registerSystemTools(server as never, methods as unknown as JellyfinClient);
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

describe("system tools", () => {
  describe("jellyfin_get_status", () => {
    it("maps the system info fields", async () => {
      const getSystemInfo = vi.fn().mockResolvedValue({
        ServerName: "example-server",
        Version: "10.11.3",
        Id: "srv-1",
        OperatingSystemDisplayName: "Linux",
        SystemArchitecture: "X64",
        LocalAddress: "http://192.0.2.10:8096",
        HasPendingRestart: true,
        HasUpdateAvailable: true,
        WebPath: "/ignored",
      });
      const call = setup({ getSystemInfo });

      const result = await call("jellyfin_get_status");

      expect(getSystemInfo).toHaveBeenCalledExactlyOnceWith();
      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({
        serverName: "example-server",
        version: "10.11.3",
        id: "srv-1",
        os: "Linux",
        architecture: "X64",
        localAddress: "http://192.0.2.10:8096",
        hasPendingRestart: true,
        hasUpdateAvailable: true,
      });
    });

    it("defaults absent optional fields to null and false", async () => {
      const call = setup({
        getSystemInfo: vi.fn().mockResolvedValue({ ServerName: "s", Version: "1", Id: "i" }),
      });

      expect(parseResult(await call("jellyfin_get_status"))).toEqual({
        serverName: "s",
        version: "1",
        id: "i",
        os: null,
        architecture: null,
        localAddress: null,
        hasPendingRestart: false,
        hasUpdateAvailable: false,
      });
    });
  });

  describe.each([
    ["jellyfin_restart_server", "restart", "restart signal sent"],
    ["jellyfin_shutdown_server", "shutdown", "shutdown signal sent"],
  ])("%s", (tool, method, message) => {
    it("calls the client once with confirm true", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const call = setup({ [method]: fn });

      const result = await call(tool, { confirm: true });

      expect(fn).toHaveBeenCalledExactlyOnceWith();
      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({ result: message });
    });
  });

  it.each([
    ["jellyfin_get_status", {}, "getSystemInfo"],
    ["jellyfin_restart_server", { confirm: true }, "restart"],
    ["jellyfin_shutdown_server", { confirm: true }, "shutdown"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("jellyfin down"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "jellyfin down" });
  });
});
