import { describe, it, expect } from "vitest";
import type { JellyfinClient } from "../src/client.js";
import { registerAllTools } from "../src/server.js";

// Fake McpServer that records the annotations each tool registers with. Tool
// registration is positional: (name, description, schema, annotations, handler).
interface Captured {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
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
  registerAllTools(server as never, client);
  return tools;
}

const READ_ONLY_TOOLS = [
  "jellyfin_list_api_keys",
  "jellyfin_list_devices",
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

  it("registers all 59 tools", () => {
    expect(tools.size).toBe(59);
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
});
