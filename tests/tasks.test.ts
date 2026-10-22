import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JellyfinClient } from "../src/client.js";
import { registerTaskTools } from "../src/tools/tasks.js";

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
  registerTaskTools(server as never, methods as unknown as JellyfinClient);
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

describe("scheduled task tools", () => {
  describe("jellyfin_list_scheduled_tasks", () => {
    it("maps last execution fields and defaults absent ones to null", async () => {
      const listScheduledTasks = vi.fn().mockResolvedValue([
        {
          Id: "task-scan",
          Name: "Scan Media Library",
          Category: "Library",
          State: "Running",
          CurrentProgressPercentage: 42.5,
          Description: "ignored",
          LastExecutionResult: {
            StartTimeUtc: "2026-04-19T01:00:00Z",
            EndTimeUtc: "2026-04-19T01:05:00Z",
            Status: "Failed",
            ErrorMessage: "disk offline",
          },
        },
        { Id: "task-clean", Name: "Clean Cache", State: "Idle" },
      ]);
      const call = setup({ listScheduledTasks });

      const result = await call("jellyfin_list_scheduled_tasks");

      expect(listScheduledTasks).toHaveBeenCalledExactlyOnceWith();
      expect(parseResult(result)).toEqual([
        {
          id: "task-scan",
          name: "Scan Media Library",
          category: "Library",
          state: "Running",
          progressPercent: 42.5,
          lastStart: "2026-04-19T01:00:00Z",
          lastEnd: "2026-04-19T01:05:00Z",
          lastStatus: "Failed",
          lastError: "disk offline",
        },
        {
          id: "task-clean",
          name: "Clean Cache",
          category: null,
          state: "Idle",
          progressPercent: null,
          lastStart: null,
          lastEnd: null,
          lastStatus: null,
          lastError: null,
        },
      ]);
    });

    it("keeps a zero progress value instead of turning it into null", async () => {
      const call = setup({
        listScheduledTasks: vi
          .fn()
          .mockResolvedValue([{ Id: "t", Name: "n", State: "Running", CurrentProgressPercentage: 0 }]),
      });

      const [task] = parseResult(await call("jellyfin_list_scheduled_tasks")) as { progressPercent: unknown }[];

      expect(task.progressPercent).toBe(0);
    });

    it("returns an empty array when there are no tasks", async () => {
      const call = setup({ listScheduledTasks: vi.fn().mockResolvedValue([]) });

      expect(parseResult(await call("jellyfin_list_scheduled_tasks"))).toEqual([]);
    });
  });

  describe("jellyfin_get_activity_log", () => {
    it("applies the default limit and maps the entry shape", async () => {
      const getActivityLog = vi.fn().mockResolvedValue({
        TotalRecordCount: 57,
        Items: [
          {
            Id: 9001,
            Date: "2026-04-19T10:00:00Z",
            Severity: "Information",
            Type: "SessionStarted",
            Name: "example-user is online",
            UserId: "user-1",
            ShortOverview: "from 192.0.2.5",
            Overview: "full detail",
            ItemId: "ignored",
          },
          { Id: 9002, Date: "2026-04-19T09:00:00Z", Severity: "Warning", Type: "System", Name: "plain" },
        ],
      });
      const call = setup({ getActivityLog });

      const result = await call("jellyfin_get_activity_log");

      expect(getActivityLog).toHaveBeenCalledExactlyOnceWith(20, undefined);
      expect(parseResult(result)).toEqual({
        totalCount: 57,
        entries: [
          {
            id: 9001,
            date: "2026-04-19T10:00:00Z",
            severity: "Information",
            type: "SessionStarted",
            name: "example-user is online",
            userId: "user-1",
            summary: "from 192.0.2.5",
            detail: "full detail",
          },
          {
            id: 9002,
            date: "2026-04-19T09:00:00Z",
            severity: "Warning",
            type: "System",
            name: "plain",
            userId: null,
            summary: null,
            detail: null,
          },
        ],
      });
    });

    it("forwards an explicit limit and minDate positionally", async () => {
      const getActivityLog = vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] });
      const call = setup({ getActivityLog });

      await call("jellyfin_get_activity_log", { limit: 200, minDate: "2026-04-19T00:00:00Z" });

      expect(getActivityLog).toHaveBeenCalledExactlyOnceWith(200, "2026-04-19T00:00:00Z");
    });

    it("returns zero entries for an empty log", async () => {
      const call = setup({
        getActivityLog: vi.fn().mockResolvedValue({ TotalRecordCount: 0, Items: [] }),
      });

      expect(parseResult(await call("jellyfin_get_activity_log"))).toEqual({
        totalCount: 0,
        entries: [],
      });
    });
  });

  describe("jellyfin_run_scheduled_task", () => {
    it("forwards the task id once when confirmed", async () => {
      const runScheduledTask = vi.fn().mockResolvedValue(undefined);
      const call = setup({ runScheduledTask });

      const result = await call("jellyfin_run_scheduled_task", { taskId: "task-9", confirm: true });

      expect(runScheduledTask).toHaveBeenCalledExactlyOnceWith("task-9");
      expect(parseResult(result)).toEqual({ result: "task task-9 started" });
    });
  });

  it.each([
    ["jellyfin_list_scheduled_tasks", {}, "listScheduledTasks"],
    ["jellyfin_get_activity_log", {}, "getActivityLog"],
    ["jellyfin_run_scheduled_task", { taskId: "task-9", confirm: true }, "runScheduledTask"],
  ])("%s surfaces a client rejection as isError", async (tool, args, method) => {
    const fn = vi.fn().mockRejectedValue(new Error("task api failed"));
    const call = setup({ [method]: fn });

    const result = await call(tool, args);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "task api failed" });
  });
});
