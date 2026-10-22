import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerAllTools } from "../src/server.js";

type Result = { content: { text: string }[]; isError?: boolean };
interface Tool {
  schema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<Result>;
}

const newlyGated = [
  ["scan_library", "scanLibraries", {}, [undefined]],
  ["create_user", "createUser", { name: "Example" }, ["Example"]],
  ["pause_session", "pauseSession", { sessionId: "session-example" }, ["session-example"]],
  ["resume_session", "resumeSession", { sessionId: "session-example" }, ["session-example"]],
  ["send_message_to_session", "sendMessage", { sessionId: "session-example", text: "Example message" }, ["session-example", "Example message", undefined, 5000]],
  ["seek_session", "seekSession", { sessionId: "session-example", positionSec: 10 }, ["session-example", 10]],
  ["next_track", "nextTrack", { sessionId: "session-example" }, ["session-example"]],
  ["previous_track", "previousTrack", { sessionId: "session-example" }, ["session-example"]],
  ["set_volume", "sendVolume", { sessionId: "session-example", volume: 40 }, ["session-example", 40]],
  ["set_mute", "sendMuteCommand", { sessionId: "session-example", action: "toggle" }, ["session-example", "ToggleMute"]],
  ["set_audio_stream", "setAudioStream", { sessionId: "session-example", index: 0 }, ["session-example", 0]],
  ["set_subtitle_stream", "setSubtitleStream", { sessionId: "session-example", index: -1 }, ["session-example", -1]],
  ["play_on_session", "playOnSession", { sessionId: "session-example", itemIds: ["item-example"] }, ["session-example", ["item-example"], "PlayNow", undefined]],
  ["mark_played", "markPlayed", { userId: "user-example", itemId: "item-example" }, ["user-example", "item-example"]],
  ["mark_unplayed", "markUnplayed", { userId: "user-example", itemId: "item-example" }, ["user-example", "item-example"]],
  ["set_favorite", "setFavorite", { userId: "user-example", itemId: "item-example" }, ["user-example", "item-example"]],
  ["unset_favorite", "unsetFavorite", { userId: "user-example", itemId: "item-example" }, ["user-example", "item-example"]],
  ["create_playlist", "createPlaylist", { name: "Example", userId: "user-example" }, ["Example", "user-example", [], undefined]],
  ["add_to_playlist", "addToPlaylist", { playlistId: "playlist-example", itemIds: ["item-example"], userId: "user-example" }, ["playlist-example", ["item-example"], "user-example"]],
  ["create_collection", "createCollection", { name: "Example" }, ["Example", []]],
  ["add_to_collection", "addToCollection", { collectionId: "collection-example", itemIds: ["item-example"] }, ["collection-example", ["item-example"]]],
] as const;

function capture(clientMethods?: Record<string, unknown>) {
  const calls = vi.fn().mockResolvedValue({ Id: "created-example", Name: "Example" });
  const client = (clientMethods ?? new Proxy({}, { get: () => calls })) as JellyfinClient;
  const tools = new Map<string, Tool>();
  const server = { tool(name: string, _description: string, schema: Tool["schema"], annotations: Tool["annotations"], handler: Tool["handler"]) {
    tools.set(name, { schema, annotations, handler });
  } };
  registerAllTools(server as unknown as McpServer, client);
  return { tools, calls };
}

// Valid required inputs let refusal tests reach the confirmation gate itself.
const requiredInputs = {
  name: "Example", userId: "user-example", itemId: "item-example",
  sessionId: "session-example", taskId: "task-example", seriesId: "series-example",
  playlistId: "playlist-example", collectionId: "collection-example",
  text: "Example message", newPassword: "example-placeholder", code: "EXAMPLE",
  itemIds: ["item-example"], entryIds: ["entry-example"], disabled: true,
  positionSec: 10, volume: 40, action: "toggle", index: 0,
};

describe("mutation confirmation policy", () => {
  const registeredWrites = [...capture().tools].filter(([, tool]) => !tool.annotations.readOnlyHint);

  it.each(registeredWrites)("%s refuses absent or false confirmation before any client call", async (name) => {
    for (const confirm of [undefined, false]) {
      const { tools, calls } = capture();
      const tool = tools.get(name)!;
      const input = z.object(tool.schema).parse({ ...requiredInputs, confirm });
      const result = await tool.handler(input);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining("confirm: true") });
      expect(calls).not.toHaveBeenCalled();
    }
  });

  it.each(newlyGated)("%s executes once with schema-validated confirm true", async (name, method, args, expectedArgs) => {
    const calls = vi.fn().mockResolvedValue({ Id: "created-example", Name: "Example" });
    const { tools } = capture({ [method]: calls });
    const registered = tools.get(`jellyfin_${name}`)!;
    const result = await registered.handler(z.object(registered.schema).parse({ ...args, confirm: true }));
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveBeenCalledExactlyOnceWith(...expectedArgs);
    expect(JSON.parse(result.content[0].text)).toBeTypeOf("object");
  });
});
