import { describe, expect, it, vi } from "vitest";
import type { JellyfinClient } from "../src/client.js";
import { registerCollectionTools } from "../src/tools/collections.js";
import { registerPlaylistTools } from "../src/tools/playlists.js";
import { registerUserTools } from "../src/tools/users.js";
import { registerTaskTools } from "../src/tools/tasks.js";

interface CapturedTool {
  name: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

function makeFakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      annotations: CapturedTool["annotations"],
      handler: CapturedTool["handler"],
    ) => {
      tools.set(name, { name, annotations, handler });
    },
  };
  return { server, tools };
}

function parseResult(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("destructive tool confirmation gates", () => {
  describe("jellyfin_run_scheduled_task", () => {
    it.each([undefined, false])("refuses with confirm %s and makes no client calls", async (confirm) => {
      const client = {
        runScheduledTask: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerTaskTools(server as never, client);

      const result = await tools.get("jellyfin_run_scheduled_task")!.handler({
        taskId: "task-1",
        ...(confirm === undefined ? {} : { confirm }),
      });

      expect(client.runScheduledTask).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatchObject({ error: expect.stringContaining("confirm: true") });
    });

    it("executes once with explicit confirm true", async () => {
      const client = {
        runScheduledTask: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerTaskTools(server as never, client);

      const result = await tools.get("jellyfin_run_scheduled_task")!.handler({
        taskId: "task-1", confirm: true,
      });

      expect(client.runScheduledTask).toHaveBeenCalledExactlyOnceWith("task-1");
      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({ result: "task task-1 started" });
    });
  });

  describe("jellyfin_set_user_disabled", () => {
    it("refuses without confirm", async () => {
      const client = {
        setUserDisabled: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerUserTools(server as never, client);

      const tool = tools.get("jellyfin_set_user_disabled");
      const result = await tool!.handler({ userId: "u1", disabled: true });

      expect(result.isError).toBe(true);
      expect(client.setUserDisabled).not.toHaveBeenCalled();
      expect(parseResult(result)).toMatchObject({ error: expect.stringContaining("confirm") });
    });

    it("executes with confirm true", async () => {
      const client = {
        setUserDisabled: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerUserTools(server as never, client);

      const tool = tools.get("jellyfin_set_user_disabled");
      const result = await tool!.handler({ userId: "u1", disabled: true, confirm: true });

      expect(result.isError).toBeUndefined();
      expect(client.setUserDisabled).toHaveBeenCalledWith("u1", true);
      expect(parseResult(result)).toEqual({ result: "user u1 disabled" });
    });
  });

  describe("jellyfin_remove_from_playlist", () => {
    it("refuses without confirm", async () => {
      const client = {
        removeFromPlaylist: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerPlaylistTools(server as never, client);

      const tool = tools.get("jellyfin_remove_from_playlist");
      const result = await tool!.handler({
        playlistId: "pl1",
        entryIds: ["entry1", "entry2"],
      });

      expect(result.isError).toBe(true);
      expect(client.removeFromPlaylist).not.toHaveBeenCalled();
      expect(parseResult(result)).toMatchObject({ error: expect.stringContaining("confirm") });
    });

    it("executes with confirm true", async () => {
      const client = {
        removeFromPlaylist: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerPlaylistTools(server as never, client);

      const tool = tools.get("jellyfin_remove_from_playlist");
      const result = await tool!.handler({
        playlistId: "pl1",
        entryIds: ["entry1", "entry2"],
        confirm: true,
      });

      expect(result.isError).toBeUndefined();
      expect(client.removeFromPlaylist).toHaveBeenCalledWith("pl1", ["entry1", "entry2"]);
      expect(parseResult(result)).toEqual({
        result: "removed 2 entry/entries from playlist pl1",
      });
    });
  });

  describe("jellyfin_remove_from_collection", () => {
    it("refuses without confirm", async () => {
      const client = {
        removeFromCollection: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerCollectionTools(server as never, client);

      const tool = tools.get("jellyfin_remove_from_collection");
      const result = await tool!.handler({
        collectionId: "col1",
        itemIds: ["i1", "i2"],
      });

      expect(result.isError).toBe(true);
      expect(client.removeFromCollection).not.toHaveBeenCalled();
      expect(parseResult(result)).toMatchObject({ error: expect.stringContaining("confirm") });
    });

    it("executes with confirm true", async () => {
      const client = {
        removeFromCollection: vi.fn().mockResolvedValue(undefined),
      } as unknown as JellyfinClient;
      const { server, tools } = makeFakeServer();
      registerCollectionTools(server as never, client);

      const tool = tools.get("jellyfin_remove_from_collection");
      const result = await tool!.handler({
        collectionId: "col1",
        itemIds: ["i1", "i2"],
        confirm: true,
      });

      expect(result.isError).toBeUndefined();
      expect(client.removeFromCollection).toHaveBeenCalledWith("col1", ["i1", "i2"]);
      expect(parseResult(result)).toEqual({
        result: "removed 2 item(s) from collection col1",
      });
    });
  });
});
