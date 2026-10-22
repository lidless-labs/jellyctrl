import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHttpConfig } from "../src/config.js";
import {
  createHttpListener,
  createHttpRequestHandler,
  isToolAllowed,
  TOOL_REMOTE_POLICIES,
} from "../src/http.js";
import type { JellyfinConfig } from "../src/config.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JellyfinClient } from "../src/client.js";
import { registerUserTools } from "../src/tools/users.js";
import { captureRegisteredToolNames } from "../src/server.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = {
  JELLYFIN_URL: "http://jellyfin.invalid:8096",
  JELLYFIN_API_KEY: "jellyfin-api-key-must-not-leak-".repeat(2),
  JELLYFIN_MCP_HTTP_TOKEN: "independent-http-token-".repeat(2),
};

class FakeResponse extends EventEmitter {
  status = 0;
  headersSent = false;
  writableEnded = false;
  body = "";

  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  end(body = ""): this {
    this.body += body;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

async function request(
  handler: ReturnType<typeof createHttpRequestHandler>,
  options: { method: string; url: string; authorization?: string; body?: string; host?: string | null; origin?: string },
): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([options.body ?? ""]), {
    method: options.method,
    url: options.url,
    headers: {
      ...(options.host === null ? {} : { host: options.host ?? "127.0.0.1" }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.body ? { "content-length": String(Buffer.byteLength(options.body)) } : {}),
    },
  });
  const response = new FakeResponse();
  await handler(req as never, response as never);
  return response;
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected action to throw");
}

describe("HTTP transport configuration", () => {
  beforeEach(() => {
    vi.stubEnv("JELLYFIN_URL", env.JELLYFIN_URL);
    vi.stubEnv("JELLYFIN_API_KEY", env.JELLYFIN_API_KEY);
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", env.JELLYFIN_MCP_HTTP_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults to loopback and observe mode", () => {
    expect(getHttpConfig()).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      remoteMode: "observe",
    });
  });

  it.each(["localhost", "0.0.0.0", "::", "[::]", "192.0.2.1", "[::1]"])(
    "rejects non-loopback host %s",
    (host) => {
      vi.stubEnv("JELLYFIN_MCP_HTTP_HOST", host);
      expect(() => getHttpConfig()).toThrow("127.0.0.1 or ::1");
    },
  );

  it("rejects invalid ports and modes", () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_PORT", "0");
    expect(() => getHttpConfig()).toThrow("JELLYFIN_MCP_HTTP_PORT");
    vi.stubEnv("JELLYFIN_MCP_HTTP_PORT", "3000");
    vi.stubEnv("JELLYFIN_MCP_REMOTE_MODE", "unsafe");
    expect(() => getHttpConfig()).toThrow("JELLYFIN_MCP_REMOTE_MODE");
  });

  it("refuses a token shorter than 32 characters", () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", "a".repeat(31));
    expect(() => getHttpConfig()).toThrow(/at least 32 characters/);
  });

  it("requires an independent HTTP token", () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", "");
    expect(() => getHttpConfig()).toThrow("JELLYFIN_MCP_HTTP_TOKEN");
  });

  it("rejects whitespace-only HTTP tokens", () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", "   ");
    expect(() => getHttpConfig()).toThrow("JELLYFIN_MCP_HTTP_TOKEN");
  });
});

describe("HTTP remote tool policy", () => {
  it("classifies every registered tool exactly once", () => {
    const registered = captureRegisteredToolNames();
    expect(registered).toHaveLength(58);
    expect(Object.keys(TOOL_REMOTE_POLICIES).sort()).toEqual([...registered].sort());
  });

  it("fails closed for unknown tools", () => {
    expect(isToolAllowed("observe", "unknown_tool")).toBe(false);
    expect(isToolAllowed("managed", "unknown_tool")).toBe(false);
    expect(isToolAllowed("full", "unknown_tool")).toBe(false);
  });

  it("enforces observe, managed, and full modes", () => {
    expect(isToolAllowed("observe", "jellyfin_get_status")).toBe(true);
    expect(isToolAllowed("observe", "jellyfin_pause_session")).toBe(false);
    expect(isToolAllowed("managed", "jellyfin_pause_session")).toBe(true);
    expect(isToolAllowed("managed", "jellyfin_shutdown_server")).toBe(false);
    expect(isToolAllowed("managed", "jellyfin_create_user")).toBe(false);
    expect(isToolAllowed("managed", "jellyfin_run_scheduled_task")).toBe(false);
    expect(isToolAllowed("full", "jellyfin_shutdown_server")).toBe(true);
  });
});

describe("HTTP transport", () => {
  beforeEach(() => {
    vi.stubEnv("JELLYFIN_URL", env.JELLYFIN_URL);
    vi.stubEnv("JELLYFIN_API_KEY", env.JELLYFIN_API_KEY);
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", env.JELLYFIN_MCP_HTTP_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { origin: "https://evil.example.com" },
    { host: "evil.example.com" },
    { host: null },
  ])("rejects rebinding headers before authentication: %j", async (headers) => {
    const handler = createHttpRequestHandler(getHttpConfig());
    const result = await request(handler, { method: "POST", url: "/mcp", ...headers });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Forbidden" });
  });

  it("accepts a loopback Origin", async () => {
    const handler = createHttpRequestHandler(getHttpConfig());
    const result = await request(handler, { method: "POST", url: "/mcp", origin: "http://localhost" });
    expect(result.status).toBe(401);
  });

  it("checks Host before serving healthz", async () => {
    const handler = createHttpRequestHandler(getHttpConfig());
    const result = await request(handler, { method: "GET", url: "/healthz", host: "evil.example.com" });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Forbidden" });
  });

  it("authenticates a padded token and lists tools using the SDK client", async () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", `  ${env.JELLYFIN_MCP_HTTP_TOKEN}\n`);
    const server = createServer(createHttpListener(createHttpRequestHandler(getHttpConfig())));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "http-test", version: "1" });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No HTTP port");
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}` } },
      });
      await client.connect(transport);
      expect((await client.listTools()).tools.some((tool) => tool.name === "jellyfin_get_status")).toBe(true);
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("dispatches get-user in observe mode over MCP with a mocked Jellyfin client", async () => {
    const getUser = vi.fn().mockResolvedValue({
      Id: "user-1", Name: "Example", HasPassword: false, Policy: { IsDisabled: false },
    });
    const handler = createHttpRequestHandler(
      { ...getHttpConfig(), remoteMode: "observe" }, undefined,
      () => {
        const server = new McpServer({ name: "user-policy-test", version: "1" });
        registerUserTools(server, { getUser } as unknown as JellyfinClient);
        return { server, dispose: () => server.close() };
      },
    );
    const server = createServer(createHttpListener(handler));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "http-user-policy-test", version: "1" });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No HTTP port");
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}` } },
      }));
      const result = await client.callTool({ name: "jellyfin_get_user", arguments: { userId: "user-1" } });
      expect(result.isError).toBeUndefined();
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0].text)).toMatchObject({
        id: "user-1", name: "Example", hasPassword: false, policy: { isDisabled: false },
      });
      expect(getUser).toHaveBeenCalledExactlyOnceWith("user-1");
      for (const userId of [undefined, "", " ", "\t\n"]) {
        const rejected = await client.callTool({ name: "jellyfin_get_user", arguments: { userId } });
        expect(rejected.isError).toBe(true);
      }
      expect(getUser).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("checks the trimmed token against the Jellyfin API key", () => {
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", `  ${env.JELLYFIN_API_KEY}\n`);
    expect(() => createHttpRequestHandler(getHttpConfig())).toThrow(/must differ from JELLYFIN_API_KEY/);
  });

  it("protects MCP, limits routes and bodies, and keeps healthz minimal", async () => {
    const handler = createHttpRequestHandler(getHttpConfig());
    const health = await request(handler, { method: "GET", url: "/healthz" });
    expect(JSON.parse(health.body)).toEqual({ status: "ok" });
    expect((await request(handler, { method: "GET", url: "/mcp" })).status).toBe(405);
    expect((await request(handler, { method: "GET", url: "/other" })).status).toBe(404);
    expect((await request(handler, { method: "POST", url: "/mcp", body: "{}" })).status).toBe(401);
    expect(
      (await request(handler, { method: "POST", url: "/mcp", authorization: "Bearer wrong", body: "{}" }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(handler, {
          method: "POST",
          url: "/mcp",
          authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}`,
          body: "x".repeat(1_048_577),
        })
    ).status,
    ).toBe(413);
  });

  it("rejects malformed and non-origin-form request targets without leaking configuration", async () => {
    const handler = createHttpRequestHandler(getHttpConfig());
    for (const url of ["//[", "http://example.invalid/mcp", "*"]) {
      const result = await request(handler, { method: "GET", url });
      expect(result.status).toBe(400);
      expect(result.body).toContain("Bad request");
      expect(result.body).not.toContain(env.JELLYFIN_API_KEY);
      expect(result.body).not.toContain(env.JELLYFIN_MCP_HTTP_TOKEN);
    }
  });

  it("rejects a handler configuration that reuses the Jellyfin API key", () => {
    const token = "same-secret-value-".repeat(2);
    const jellyfinConfig: JellyfinConfig = {
      url: env.JELLYFIN_URL,
      apiKey: token,
      verifySsl: true,
      timeout: 5_000,
    };
    const message = thrownMessage(() =>
      createHttpRequestHandler(
        { host: "127.0.0.1", port: 3000, token, remoteMode: "observe" },
        jellyfinConfig,
      ),
    );
    expect(message).toContain("must differ from JELLYFIN_API_KEY");
    expect(message).not.toContain(token);
  });

  it("rejects a blank direct handler token without leaking its value", () => {
    const token = "   ";
    const jellyfinConfig: JellyfinConfig = {
      url: env.JELLYFIN_URL,
      apiKey: "different-secret",
      verifySsl: true,
      timeout: 5_000,
    };
    const message = thrownMessage(() =>
      createHttpRequestHandler(
        { host: "127.0.0.1", port: 3000, token, remoteMode: "observe" },
        jellyfinConfig,
      ),
    );
    expect(message).toContain("must not be blank");
    expect(message).not.toContain(token);
  });

  it("blocks policy violations before Jellyfin dispatch and redacts server errors", async () => {
    const handler = createHttpRequestHandler({ ...getHttpConfig(), remoteMode: "observe" });
    const denied = await request(handler, {
      method: "POST",
      url: "/mcp",
      authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}`,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jellyfin_pause_session", arguments: { sessionId: "s1" } },
      }),
    });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ error: { message: "Tool is not permitted" } });
    expect(denied.body).not.toContain(env.JELLYFIN_API_KEY);
    expect(denied.body).not.toContain(env.JELLYFIN_MCP_HTTP_TOKEN);
  });

  it("redacts unexpected startup errors", async () => {
    const handler = createHttpRequestHandler(
      getHttpConfig(),
      undefined,
      () => {
        throw new Error(env.JELLYFIN_API_KEY);
      },
    );
    const result = await request(handler, {
      method: "POST",
      url: "/mcp",
      authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}`,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(result.status).toBe(500);
    expect(result.body).toContain("Internal server error");
    expect(result.body).not.toContain(env.JELLYFIN_API_KEY);
  });

  it("contains rejected request handlers and replies with a sanitized 500", async () => {
    const listener = createHttpListener(async () => {
      throw new Error(env.JELLYFIN_API_KEY);
    });
    const response = new FakeResponse();
    listener({} as never, response as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toBe(500);
    expect(response.body).toContain("Internal server error");
    expect(response.body).not.toContain(env.JELLYFIN_API_KEY);
  });

  it("disposes a factory-owned request server exactly once after dispatch failure", async () => {
    const dispose = vi.fn(async () => {});
    const server = {
      connect: vi.fn(async () => {
        throw new Error("dispatch failed");
      }),
      close: vi.fn(async () => {}),
    };
    const handler = createHttpRequestHandler(
      getHttpConfig(),
      undefined,
      () => ({ server: server as unknown as McpServer, dispose }),
    );
    const result = await request(handler, {
      method: "POST",
      url: "/mcp",
      authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}`,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(result.status).toBe(500);
    expect(dispose).toHaveBeenCalledOnce();
    expect(server.close).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool and cannot be bypassed with a batch request", async () => {
    const handler = createHttpRequestHandler(getHttpConfig());
    for (const body of [
      { method: "tools/call", params: { name: "unknown_tool" } },
      [
        { method: "initialize", params: {} },
        { method: "tools/call", params: { name: "jellyfin_pause_session" } },
      ],
    ]) {
      const result = await request(handler, {
        method: "POST",
        url: "/mcp",
        authorization: `Bearer ${env.JELLYFIN_MCP_HTTP_TOKEN}`,
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(403);
    }
  });
});
