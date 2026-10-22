import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { JellyfinClient } from "../src/client.js";
import { registerUserTools } from "../src/tools/users.js";

interface CapturedTool {
  schema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

const emptyPolicy = {
  isAdministrator: null,
  isDisabled: null,
  isHidden: null,
  enableRemoteAccess: null,
  enableMediaPlayback: null,
  enableContentDeletion: null,
  enableContentDownloading: null,
  enableRemoteControlOfOtherUsers: null,
  enablePublicSharing: null,
  enableAllFolders: null,
  enabledFolders: null,
  loginAttemptsBeforeLockout: null,
  invalidLoginAttemptCount: null,
  maxActiveSessions: null,
  authenticationProviderId: null,
};

const fetchMock = vi.fn();
let tools: Map<string, CapturedTool>;

function getTool(name = "jellyfin_get_user"): CapturedTool {
  const tool = tools.get(name);
  expect(tool, `${name} must be registered`).toBeDefined();
  return tool!;
}

async function callUser(userId = "user-1") {
  const tool = getTool();
  return tool.handler(z.object(tool.schema).parse({ userId }));
}

function respond(payload: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("jellyfin_get_user", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    tools = new Map();
    const server = {
      tool: (name: string, _description: string, schema: z.ZodRawShape,
        annotations: ToolAnnotations, handler: CapturedTool["handler"]) => {
        tools.set(name, { schema, annotations, handler });
      },
    };
    registerUserTools(server as never, new JellyfinClient({
      url: "http://jellyfin.test", apiKey: "test-key", timeout: 5000, verifySsl: true,
    }));
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns only the requested user and policy fields from one encoded GET", async () => {
    respond({
      Id: "user-1", Name: "Example", HasPassword: true,
      LastLoginDate: "2026-10-01T12:00:00Z", LastActivityDate: "2026-10-02T12:00:00Z",
      HasConfiguredPassword: false, ServerId: "omit-server", Configuration: { Secret: "omit-config" },
      Policy: {
        IsAdministrator: true, IsDisabled: false, IsHidden: true,
        EnableRemoteAccess: false, EnableMediaPlayback: true,
        EnableContentDeletion: false, EnableContentDownloading: true,
        EnableRemoteControlOfOtherUsers: false, EnablePublicSharing: true,
        EnableAllFolders: false, EnabledFolders: ["folder-1"],
        LoginAttemptsBeforeLockout: 5, InvalidLoginAttemptCount: 2, MaxActiveSessions: 3,
        AuthenticationProviderId: "example-provider", PasswordResetProviderId: "omit-provider",
        EnableSyncTranscoding: true,
      },
    });
    const result = await callUser("user/with ?query=#% &é");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: "user-1", name: "Example", hasPassword: true,
      lastLogin: "2026-10-01T12:00:00Z", lastActivity: "2026-10-02T12:00:00Z",
      policy: {
        isAdministrator: true, isDisabled: false, isHidden: true,
        enableRemoteAccess: false, enableMediaPlayback: true,
        enableContentDeletion: false, enableContentDownloading: true,
        enableRemoteControlOfOtherUsers: false, enablePublicSharing: true,
        enableAllFolders: false, enabledFolders: ["folder-1"],
        loginAttemptsBeforeLockout: 5, invalidLoginAttemptCount: 2, maxActiveSessions: 3,
        authenticationProviderId: "example-provider",
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Users/user%2Fwith%20%3Fquery%3D%23%25%20%26%C3%A9");
    expect(options.method ?? "GET").toBe("GET");
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("");
  });

  it.each([
    { label: "absent", user: { HasConfiguredPassword: true } },
    { label: "null", user: { HasPassword: null, Policy: null } },
    { label: "empty", user: { Policy: {} } },
  ])("returns null placeholders for $label policy without inferring password state", async ({ user }) => {
    respond({ Id: "user-1", Name: "Example", ...user });
    const result = await callUser();
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: "user-1", name: "Example", hasPassword: null,
      lastLogin: null, lastActivity: null, policy: emptyPolicy,
    });
  });

  it("preserves false, zero, and empty folders in a partial policy", async () => {
    respond({
      Id: "user-1", Name: null, HasPassword: false, LastLoginDate: null, LastActivityDate: null,
      Policy: { IsAdministrator: false, IsDisabled: false, EnabledFolders: [],
        LoginAttemptsBeforeLockout: 0, InvalidLoginAttemptCount: 0, MaxActiveSessions: 0 },
    });
    const result = await callUser();
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: "user-1", name: null, hasPassword: false, lastLogin: null, lastActivity: null,
      policy: { ...emptyPolicy, isAdministrator: false, isDisabled: false,
        enabledFolders: [], loginAttemptsBeforeLockout: 0, invalidLoginAttemptCount: 0, maxActiveSessions: 0 },
    });
  });

  it("returns a clear MCP error for a missing user", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await callUser("missing-user");
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: "Resource not found: /Users/missing-user (HTTP 404)",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", " ", "\t\n"])("rejects missing or blank userId %j before dispatch", async (userId) => {
    const tool = getTool();
    expect(() => z.object(tool.schema).parse({ userId })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declares all four read-only annotation hints", () => {
    expect(getTool().annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
  });

  it("keeps the existing list-users response unchanged", async () => {
    respond([{ Id: "user-1", Name: "Example", HasPassword: true,
      Policy: { EnableRemoteAccess: true } }]);
    const result = await getTool("jellyfin_list_users").handler({});
    expect(JSON.parse(result.content[0].text)).toEqual([{
      id: "user-1", name: "Example", isAdmin: false, isDisabled: false,
      lastLogin: null, lastActivity: null,
    }]);
  });
});
