import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getConfig,
  getHttpConfig,
  type HttpConfig,
  type JellyfinConfig,
  type RemoteMode,
} from "./config.js";
import { createMcpServerResource, type McpServerResource } from "./server.js";

export const MAX_HTTP_BODY_BYTES = 1_048_576;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type ToolPolicy = "read" | "routine" | "high-impact";

export const TOOL_REMOTE_POLICIES: Record<string, ToolPolicy> = {
  jellyfin_get_status: "read",
  jellyfin_list_api_keys: "read",
  jellyfin_list_devices: "read",
  jellyfin_restart_server: "high-impact",
  jellyfin_shutdown_server: "high-impact",
  jellyfin_list_libraries: "read",
  jellyfin_scan_library: "routine",
  jellyfin_list_users: "read",
  jellyfin_create_user: "high-impact",
  jellyfin_delete_user: "high-impact",
  jellyfin_set_user_disabled: "high-impact",
  jellyfin_set_user_password: "high-impact",
  jellyfin_list_sessions: "read",
  jellyfin_pause_session: "routine",
  jellyfin_resume_session: "routine",
  jellyfin_stop_session: "high-impact",
  jellyfin_send_message_to_session: "routine",
  jellyfin_seek_session: "routine",
  jellyfin_next_track: "routine",
  jellyfin_previous_track: "routine",
  jellyfin_set_volume: "routine",
  jellyfin_set_mute: "routine",
  jellyfin_set_audio_stream: "routine",
  jellyfin_set_subtitle_stream: "routine",
  jellyfin_play_on_session: "routine",
  jellyfin_pause_all_sessions: "routine",
  jellyfin_stop_all_sessions: "high-impact",
  jellyfin_message_all_active_sessions: "routine",
  jellyfin_search_items: "read",
  jellyfin_get_recent_items: "read",
  jellyfin_get_item: "read",
  jellyfin_get_favorite_items: "read",
  jellyfin_list_scheduled_tasks: "read",
  jellyfin_run_scheduled_task: "high-impact",
  jellyfin_get_activity_log: "read",
  jellyfin_mark_played: "routine",
  jellyfin_mark_unplayed: "routine",
  jellyfin_set_favorite: "routine",
  jellyfin_unset_favorite: "routine",
  jellyfin_preview_continue_watching_clear: "read",
  jellyfin_clear_continue_watching: "high-impact",
  jellyfin_get_watch_history: "read",
  jellyfin_get_user_item_data: "read",
  jellyfin_set_resume_position: "routine",
  jellyfin_clear_series_continue_watching: "high-impact",
  jellyfin_clear_episode_continue_watching_except_latest: "high-impact",
  jellyfin_list_playlists: "read",
  jellyfin_create_playlist: "routine",
  jellyfin_get_playlist_items: "read",
  jellyfin_add_to_playlist: "routine",
  jellyfin_remove_from_playlist: "high-impact",
  jellyfin_create_collection: "routine",
  jellyfin_add_to_collection: "routine",
  jellyfin_remove_from_collection: "high-impact",
  jellyfin_get_resume_items: "read",
  jellyfin_get_next_up: "read",
  jellyfin_get_similar_items: "read",
  jellyfin_quick_connect_status: "read",
  jellyfin_quick_connect_authorize: "high-impact",
};

export function isToolAllowed(mode: RemoteMode, name: string): boolean {
  const policy = TOOL_REMOTE_POLICIES[name];
  if (policy === undefined) return false;
  if (mode === "full") return true;
  if (mode === "managed") return policy !== "high-impact";
  return policy === "read";
}

function validHost(value: string | undefined, boundHost: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    // Require an authority only, without userinfo, paths, whitespace or URL normalization tricks.
    if (!/^(\[[a-f\d:]+\]|[a-z\d.-]+)(:\d+)?$/i.test(value)) return false;
    return LOOPBACK_HOSTS.has(url.hostname) || url.hostname === (boundHost.includes(":") ? `[${boundHost}]` : boundHost).toLowerCase();
  } catch {
    return false;
  }
}

function validOrigin(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function tokenMatches(authorization: string | undefined, token: string): boolean {
  const value = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!value) return false;
  const expected = createHash("sha256").update(token).digest();
  const actual = createHash("sha256").update(value).digest();
  return timingSafeEqual(expected, actual);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendInternalServerError(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  try {
    sendJson(response, 500, {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  } catch {
    // The peer may have disconnected while the response was being written.
  }
}

function requestError(status: number, message: string): { status: number; message: string } {
  return { status, message };
}

function originFormPath(target: string | undefined): string | undefined {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    return undefined;
  }
  try {
    return new URL(target, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function assertIndependentHttpToken(config: HttpConfig, jellyfinConfig: JellyfinConfig): void {
  if (config.token.trim().length === 0) {
    throw new Error("JELLYFIN_MCP_HTTP_TOKEN must not be blank");
  }
  if (config.token === jellyfinConfig.apiKey) {
    throw new Error("JELLYFIN_MCP_HTTP_TOKEN must differ from JELLYFIN_API_KEY");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const length = request.headers["content-length"];
  if (typeof length === "string" && (!/^\d+$/.test(length) || Number(length) > MAX_HTTP_BODY_BYTES)) {
    throw requestError(413, "Request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_HTTP_BODY_BYTES) throw requestError(413, "Request body too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError(400, "Invalid JSON request body");
  }
}

function toolNamesFromRequest(body: unknown): string[] {
  if (Array.isArray(body)) return body.flatMap(toolNamesFromRequest);
  if (typeof body !== "object" || body === null) return [];
  const message = body as { method?: unknown; params?: { name?: unknown } };
  return message.method === "tools/call" && typeof message.params?.name === "string"
    ? [message.params.name]
    : [];
}

export interface HttpServerHandle {
  config: HttpConfig;
  port: number;
  close(): Promise<void>;
}

export type HttpServerFactory = () => McpServer | McpServerResource;

function isMcpServerResource(server: McpServer | McpServerResource): server is McpServerResource {
  return "server" in server && "dispose" in server;
}

export type HttpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createHttpRequestHandler(
  config: HttpConfig,
  jellyfinConfig = getConfig(),
  serverFactory: HttpServerFactory = () => createMcpServerResource(jellyfinConfig),
): HttpRequestHandler {
  assertIndependentHttpToken(config, jellyfinConfig);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!validHost(request.headers.host, config.host) || !validOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    const path = originFormPath(request.url);
    if (path === undefined) {
      sendJson(response, 400, { error: "Bad request" });
      return;
    }
    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (path !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (!tokenMatches(request.headers.authorization, config.token)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const failure = error as { status?: number; message?: string };
      sendJson(response, failure.status ?? 400, { error: failure.message ?? "Bad request" });
      return;
    }

    const toolNames = toolNamesFromRequest(body);
    if (toolNames.some((toolName) => !isToolAllowed(config.remoteMode, toolName))) {
      sendJson(response, 403, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Tool is not permitted" },
        id: null,
      });
      return;
    }

    let created: McpServer | McpServerResource;
    try {
      created = serverFactory();
    } catch {
      sendJson(response, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
      return;
    }
    const server = isMcpServerResource(created) ? created.server : created;
    const dispose = isMcpServerResource(created) ? created.dispose : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= Promise.allSettled([
        transport.close(),
        ...(dispose ? [dispose()] : []),
      ]).then(() => undefined);
      return closePromise;
    };
    response.once("close", () => void close());
    response.once("finish", () => void close());
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      sendInternalServerError(response);
      await close();
    } finally {
      if (response.writableEnded || response.destroyed) await close();
    }
  };
}

export function createHttpListener(handler: HttpRequestHandler): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void handler(request, response).catch(() => sendInternalServerError(response));
  };
}

export async function createHttpServer(): Promise<HttpServerHandle> {
  const config = getHttpConfig();
  const listener = createHttpRequestHandler(config);
  const server = createServer(createHttpListener(listener));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP server did not bind a TCP port");
  return {
    config,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
