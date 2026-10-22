import { describe, it, expect } from "vitest";
import { assertToolAnnotations, type ToolAnnotations } from "@lidless-labs/effect-operator-kit";
import type { JellyfinClient } from "../src/client.js";
import { DESTRUCTIVE, NON_DESTRUCTIVE, READ_ONLY } from "../src/tools/_util.js";
import { registerSystemTools } from "../src/tools/system.js";
import { registerLibraryTools } from "../src/tools/libraries.js";
import { registerUserTools } from "../src/tools/users.js";
import { registerSessionTools } from "../src/tools/sessions.js";
import { registerItemTools } from "../src/tools/items.js";
import { registerTaskTools } from "../src/tools/tasks.js";
import { registerUserDataTools } from "../src/tools/userdata.js";
import { registerPlaylistTools } from "../src/tools/playlists.js";
import { registerCollectionTools } from "../src/tools/collections.js";
import { registerDiscoveryTools } from "../src/tools/discovery.js";
import { registerQuickConnectTools } from "../src/tools/quickconnect.js";

// Fake McpServer that records the annotations each tool registers with. Tool
// registration is positional: (name, description, schema, annotations, handler).
interface Captured {
  annotations?: ToolAnnotations;
}

function captureAllTools(): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, annotations: unknown) => {
      tools.set(name, {
        annotations: annotations as Captured["annotations"],
      });
    },
  };
  const client = {} as JellyfinClient;
  registerSystemTools(server as never, client);
  registerLibraryTools(server as never, client);
  registerUserTools(server as never, client);
  registerSessionTools(server as never, client);
  registerItemTools(server as never, client);
  registerTaskTools(server as never, client);
  registerUserDataTools(server as never, client);
  registerPlaylistTools(server as never, client);
  registerCollectionTools(server as never, client);
  registerDiscoveryTools(server as never, client);
  registerQuickConnectTools(server as never, client);
  return tools;
}

const READ_ONLY_TOOLS = [
  "jellyfin_get_status",
  "jellyfin_list_libraries",
  "jellyfin_list_users",
  "jellyfin_list_sessions",
  "jellyfin_search_items",
  "jellyfin_get_recent_items",
  "jellyfin_get_item",
  "jellyfin_get_favorite_items",
  "jellyfin_list_scheduled_tasks",
  "jellyfin_get_activity_log",
  "jellyfin_preview_continue_watching_clear",
  "jellyfin_get_watch_history",
  "jellyfin_get_user_item_data",
  "jellyfin_list_playlists",
  "jellyfin_get_playlist_items",
  "jellyfin_get_resume_items",
  "jellyfin_get_next_up",
  "jellyfin_get_similar_items",
  "jellyfin_quick_connect_status",
];

const DESTRUCTIVE_TOOLS = [
  "jellyfin_restart_server",
  "jellyfin_shutdown_server",
  "jellyfin_delete_user",
  "jellyfin_set_user_disabled",
  "jellyfin_set_user_password",
  "jellyfin_stop_session",
  "jellyfin_pause_all_sessions",
  "jellyfin_stop_all_sessions",
  "jellyfin_message_all_active_sessions",
  "jellyfin_clear_continue_watching",
  "jellyfin_clear_series_continue_watching",
  "jellyfin_clear_episode_continue_watching_except_latest",
  "jellyfin_set_resume_position",
  "jellyfin_remove_from_playlist",
  "jellyfin_remove_from_collection",
  "jellyfin_quick_connect_authorize",
  "jellyfin_run_scheduled_task",
];

describe("MCP tool annotations", () => {
  const tools = captureAllTools();

  it("registers all 57 tools", () => {
    expect(tools.size).toBe(57);
  });

  it("every tool carries annotations with an explicit readOnlyHint", () => {
    for (const [name, tool] of tools) {
      expect(tool.annotations, `${name} is missing annotations`).toBeDefined();
      expect(
        typeof tool.annotations!.readOnlyHint,
        `${name} is missing readOnlyHint`,
      ).toBe("boolean");
    }
  });

  it.each(READ_ONLY_TOOLS)("%s is annotated read-only", (name) => {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it.each(DESTRUCTIVE_TOOLS)("%s is annotated destructive", (name) => {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("remaining write tools are annotated non-destructive", () => {
    const classified = new Set([...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS]);
    for (const [name, tool] of tools) {
      if (classified.has(name)) continue;
      expect(tool.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    }
  });

  it("sets every hint explicitly and passes the kit annotation audit", () => {
    assertToolAnnotations(new Map([...tools].map(([name, tool]) => [name, tool.annotations])));
  });

  it("keeps the three-tier meaning through the kit helper", () => {
    expect(READ_ONLY).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(NON_DESTRUCTIVE).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(DESTRUCTIVE).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
