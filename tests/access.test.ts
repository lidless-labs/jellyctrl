import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { JellyfinClient } from "../src/client.js";
import { registerAllTools } from "../src/server.js";

interface CapturedTool {
  schema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

const fetchMock = vi.fn();
const cases = [
  {
    tool: "jellyfin_list_api_keys",
    path: "/Auth/Keys",
    list: "apiKeys",
    items: [
      {
        Id: 42, AppName: "Example integration", AppVersion: "1.0",
        DeviceName: "Example device", UserName: "Example user", IsActive: false,
        DateCreated: "2026-01-01T00:00:00Z", DateRevoked: null,
        DateLastActivity: "2026-01-02T00:00:00Z",
        AccessToken: "ACCESS_TOKEN_MARKER", DeviceId: "EXTRA_FIELD_MARKER",
        UserId: "EXTRA_FIELD_MARKER", FutureField: "EXTRA_FIELD_MARKER",
      },
      {
        Id: 43, AppName: null, IsActive: true,
        DateCreated: "2026-01-03T00:00:00Z", DateLastActivity: "2026-01-04T00:00:00Z",
      },
    ],
    expected: [
      {
        id: 42, appName: "Example integration", appVersion: "1.0",
        deviceName: "Example device", userName: "Example user", isActive: false,
        dateCreated: "2026-01-01T00:00:00Z", dateRevoked: null,
        dateLastActivity: "2026-01-02T00:00:00Z",
      },
      {
        id: 43, appName: null, appVersion: null, deviceName: null, userName: null,
        isActive: true, dateCreated: "2026-01-03T00:00:00Z", dateRevoked: null,
        dateLastActivity: "2026-01-04T00:00:00Z",
      },
    ],
  },
  {
    tool: "jellyfin_list_devices",
    path: "/Devices",
    list: "devices",
    items: [
      {
        Id: "device-1", Name: "Example device", CustomName: "Example name",
        AppName: "Example app", AppVersion: "1.0", LastUserName: "Example user",
        LastUserId: "00000000-0000-0000-0000-000000000001",
        DateLastActivity: "2026-01-02T00:00:00Z", AccessToken: "ACCESS_TOKEN_MARKER",
        Capabilities: { SupportsMediaControl: true, FutureField: "EXTRA_FIELD_MARKER" },
        IconUrl: "https://example.invalid/EXTRA_FIELD_MARKER", FutureField: "EXTRA_FIELD_MARKER",
      },
      { Id: null, Name: null, DateLastActivity: null },
    ],
    expected: [
      {
        id: "device-1", name: "Example device", customName: "Example name",
        appName: "Example app", appVersion: "1.0", lastUserName: "Example user",
        lastUserId: "00000000-0000-0000-0000-000000000001",
        dateLastActivity: "2026-01-02T00:00:00Z",
      },
      {
        id: null, name: null, customName: null, appName: null, appVersion: null,
        lastUserName: null, lastUserId: null, dateLastActivity: null,
      },
    ],
  },
];

describe("access inventory tools", () => {
  let tools: Map<string, CapturedTool>;
  let client: JellyfinClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    client = new JellyfinClient({
      url: "http://jellyfin.test", apiKey: "example-key", verifySsl: true, timeout: 5000,
    });
    tools = new Map();
    const server = {
      tool(name: string, _description: string, schema: CapturedTool["schema"],
        annotations: ToolAnnotations, handler: CapturedTool["handler"]) {
        tools.set(name, { schema, annotations, handler });
      },
    };
    registerAllTools(server as never, client);
  });

  afterEach(async () => {
    await client.close();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it.each(cases)("$tool returns only inventory fields from the upstream endpoint", async (entry) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      Items: entry.items, TotalRecordCount: 7, StartIndex: 0, FutureField: "EXTRA_FIELD_MARKER",
    })));

    const tool = tools.get(entry.tool);
    expect(tool).toBeDefined();
    const result = await tool!.handler(z.object(tool!.schema).parse({}));

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ totalCount: 7, [entry.list]: entry.expected });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ACCESS_TOKEN_MARKER");
    expect(serialized).not.toContain("AccessToken");
    expect(serialized).not.toContain("EXTRA_FIELD_MARKER");
    expect(serialized).not.toContain("FutureField");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://jellyfin.test${entry.path}`, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(cases)("$tool keeps the envelope for empty results", async (entry) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 })));
    const tool = tools.get(entry.tool);
    expect(tool).toBeDefined();
    const result = await tool!.handler({});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ totalCount: 0, [entry.list]: [] });
  });

  it.each(cases)("$tool reports client rejection as an MCP error", async (entry) => {
    fetchMock.mockRejectedValueOnce(new TypeError("example upstream failure"));
    const tool = tools.get(entry.tool);
    expect(tool).toBeDefined();
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "Unable to connect to Jellyfin" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(cases)("$tool declares all four read-only annotation hints", (entry) => {
    expect(tools.get(entry.tool)?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
  });

  it("accepts no API-key inputs and only an optional device userId", () => {
    expect(tools.get("jellyfin_list_api_keys")?.schema).toEqual({});
    const device = tools.get("jellyfin_list_devices");
    expect(device).toBeDefined();
    expect(Object.keys(device!.schema)).toEqual(["userId"]);
    const schema = z.object(device!.schema);
    expect(schema.parse({})).toEqual({});
    expect(() => schema.parse({ userId: 42 })).toThrow();
  });

  it("passes the device user filter to a single encoded upstream request", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 })));
    const tool = tools.get("jellyfin_list_devices");
    expect(tool).toBeDefined();
    const result = await tool!.handler(z.object(tool!.schema).parse({ userId: "example user/one?&=+#" }));
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "http://jellyfin.test/Devices?userId=example%20user%2Fone%3F%26%3D%2B%23", expect.any(Object),
    );
  });
});
