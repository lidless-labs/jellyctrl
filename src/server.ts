import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JellyfinConfig } from "./config.js";
import { JellyfinClient } from "./client.js";
import { registerAccessTools } from "./tools/access.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerItemTools } from "./tools/items.js";
import { registerLibraryTools } from "./tools/libraries.js";
import { registerPlaylistTools } from "./tools/playlists.js";
import { registerQuickConnectTools } from "./tools/quickconnect.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerSystemTools } from "./tools/system.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerUserDataTools } from "./tools/userdata.js";
import { registerUserTools } from "./tools/users.js";

const nodeRequire = createRequire(import.meta.url);
const pkg = nodeRequire("../package.json") as { name: string; version: string };

export interface McpServerResource {
  server: McpServer;
  dispose(): Promise<void>;
}

export function registerAllTools(server: McpServer, client: JellyfinClient): void {
  registerSystemTools(server, client);
  registerAccessTools(server, client);
  registerLibraryTools(server, client);
  registerUserTools(server, client);
  registerSessionTools(server, client);
  registerItemTools(server, client);
  registerTaskTools(server, client);
  registerUserDataTools(server, client);
  registerPlaylistTools(server, client);
  registerCollectionTools(server, client);
  registerDiscoveryTools(server, client);
  registerQuickConnectTools(server, client);
}

function createMcpServerForClient(client: JellyfinClient): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
    description:
      "MCP server for Jellyfin: control playback sessions (pause/resume/seek/volume/cast), manage users and libraries, mark watched/favorite, manage Continue Watching and resume state, manage playlists and collections, run scheduled tasks, query content, discover resume/next-up/similar items, authorize Quick Connect codes, and inspect activity logs.",
  });
  registerAllTools(server, client);
  return server;
}

export function createMcpServerResource(config: JellyfinConfig): McpServerResource {
  const client = new JellyfinClient(config);
  const server = createMcpServerForClient(client);
  let disposed = false;
  return {
    server,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([server.close(), client.close()]);
    },
  };
}

export function createMcpServer(config: JellyfinConfig): McpServer {
  return createMcpServerResource(config).server;
}

export function captureRegisteredToolNames(): string[] {
  const names: string[] = [];
  const capture = { tool: (name: string) => names.push(name) };
  registerAllTools(capture as unknown as McpServer, {} as JellyfinClient);
  return names;
}
