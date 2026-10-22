import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerUserTools } from "../src/tools/users.js";

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
  registerUserTools(server as never, methods as unknown as JellyfinClient);
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

describe("user tools", () => {
  describe("jellyfin_list_users", () => {
    it("maps policy flags and timestamps, with absent values as false and null", async () => {
      const listUsers = vi.fn().mockResolvedValue([
        {
          Id: "u-admin",
          Name: "example-admin",
          LastLoginDate: "2026-04-18T20:00:00Z",
          LastActivityDate: "2026-04-19T08:30:00Z",
          Policy: { IsAdministrator: true, IsDisabled: false, EnableAllFolders: true },
        },
        { Id: "u-off", Name: "example-off", Policy: { IsDisabled: true } },
        { Id: "u-bare", Name: "example-bare" },
      ]);
      const call = setup({ listUsers });

      const result = await call("jellyfin_list_users");

      expect(listUsers).toHaveBeenCalledExactlyOnceWith();
      expect(parseResult(result)).toEqual([
        {
          id: "u-admin",
          name: "example-admin",
          isAdmin: true,
          isDisabled: false,
          lastLogin: "2026-04-18T20:00:00Z",
          lastActivity: "2026-04-19T08:30:00Z",
        },
        {
          id: "u-off",
          name: "example-off",
          isAdmin: false,
          isDisabled: true,
          lastLogin: null,
          lastActivity: null,
        },
        {
          id: "u-bare",
          name: "example-bare",
          isAdmin: false,
          isDisabled: false,
          lastLogin: null,
          lastActivity: null,
        },
      ]);
    });

    it("returns an empty array when there are no users", async () => {
      const call = setup({ listUsers: vi.fn().mockResolvedValue([]) });

      expect(parseResult(await call("jellyfin_list_users"))).toEqual([]);
    });
  });

  describe("jellyfin_create_user", () => {
    it("forwards the name and returns the new id with a password note", async () => {
      const createUser = vi.fn().mockResolvedValue({ Id: "u-new", Name: "example-new" });
      const call = setup({ createUser });

      const result = await call("jellyfin_create_user", { confirm: true, name: "example-new" });

      expect(createUser).toHaveBeenCalledExactlyOnceWith("example-new");
      expect(parseResult(result)).toEqual({
        id: "u-new",
        name: "example-new",
        note: "Password not set. Use jellyfin_set_user_password to set one.",
      });
    });
  });

  describe("jellyfin_delete_user", () => {
    it("deletes exactly the requested user when confirmed", async () => {
      const deleteUser = vi.fn().mockResolvedValue(undefined);
      const call = setup({ deleteUser });

      const result = await call("jellyfin_delete_user", { userId: "u-9", confirm: true });

      expect(deleteUser).toHaveBeenCalledExactlyOnceWith("u-9");
      expect(parseResult(result)).toEqual({ result: "user u-9 deleted" });
    });
  });

  describe("jellyfin_set_user_disabled", () => {
    it.each([
      [true, "disabled"],
      [false, "enabled"],
    ])("forwards disabled=%s and reports %s", async (disabled, word) => {
      const setUserDisabled = vi.fn().mockResolvedValue(undefined);
      const call = setup({ setUserDisabled });

      const result = await call("jellyfin_set_user_disabled", { userId: "u-3", disabled, confirm: true });

      expect(setUserDisabled).toHaveBeenCalledExactlyOnceWith("u-3", disabled);
      expect(parseResult(result)).toEqual({ result: `user u-3 ${word}` });
    });
  });

  describe("jellyfin_set_user_password", () => {
    it("forwards the password to the client without echoing it back", async () => {
      const setUserPassword = vi.fn().mockResolvedValue(undefined);
      const call = setup({ setUserPassword });

      const result = await call("jellyfin_set_user_password", {
        userId: "u-4",
        newPassword: "example-throwaway-pw",
        confirm: true,
      });

      expect(setUserPassword).toHaveBeenCalledExactlyOnceWith("u-4", "example-throwaway-pw");
      expect(parseResult(result)).toEqual({ result: "password updated for user u-4" });
      expect(result.content[0].text).not.toContain("example-throwaway-pw");
    });
  });

  it.each([
    ["jellyfin_list_users", {}, "listUsers"],
    ["jellyfin_create_user", { confirm: true, name: "example-new" }, "createUser"],
    ["jellyfin_delete_user", { userId: "u-9", confirm: true }, "deleteUser"],
    ["jellyfin_set_user_disabled", { userId: "u-3", disabled: true, confirm: true }, "setUserDisabled"],
    ["jellyfin_set_user_password", { userId: "u-4", newPassword: "x", confirm: true }, "setUserPassword"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("user api failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "user api failed" });
  });
});
