import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { JellyfinClient } from "../src/client.js";
import { registerTaskTools } from "../src/tools/tasks.js";

interface CapturedTool {
  schema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

function setup(response: unknown = { Items: [], TotalRecordCount: 0 }) {
  const getActivityLog = vi.fn().mockResolvedValue(response);
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (
      name: string,
      _description: string,
      schema: CapturedTool["schema"],
      annotations: ToolAnnotations,
      handler: CapturedTool["handler"],
    ) => tools.set(name, { schema, annotations, handler }),
  };
  registerTaskTools(server as never, { getActivityLog } as unknown as JellyfinClient);
  const tool = tools.get("jellyfin_get_activity_log")!;
  const schema = z.object(tool.schema);
  return {
    getActivityLog,
    tool,
    schema,
    call: (args: Record<string, unknown> = {}) => tool.handler(schema.parse(args)),
  };
}

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("jellyfin_get_activity_log", () => {
  it("passes all parsed filters to the client", async () => {
    const { call, getActivityLog } = setup();
    const filters = {
      startIndex: 40,
      limit: 200,
      minDate: "2026-01-01T00:00:00Z",
      maxDate: "2026-02-01T00:00:00Z",
      hasUserId: false,
      username: "example user",
      severity: "Warning",
      type: "VideoPlayback",
      name: "Example episode",
      sortBy: "Date",
      sortOrder: "Descending",
    };
    await call(filters);
    expect(getActivityLog).toHaveBeenCalledExactlyOnceWith(filters);
  });

  it("defaults to the first page of 20 entries", async () => {
    const { call, getActivityLog } = setup();
    const result = await call();
    expect(getActivityLog).toHaveBeenCalledExactlyOnceWith({ limit: 20, startIndex: 0 });
    expect(parseResult(result)).toEqual({ totalCount: 0, startIndex: 0, entries: [] });
  });

  it("returns page metadata and item IDs while preserving existing entry fields", async () => {
    const { call } = setup({
      StartIndex: 40,
      TotalRecordCount: 75,
      Items: [{
        Id: 1,
        Date: "2026-01-01T00:00:00Z",
        Severity: "Information",
        Type: "VideoPlayback",
        Name: "Example episode",
        UserId: "user-1",
        ItemId: "item-1",
        ShortOverview: "Example summary",
        Overview: "Example detail",
      }, {
        Id: 2,
        Date: "2026-01-02T00:00:00Z",
        Severity: "Warning",
        Type: "System",
        Name: "Example event",
      }],
    });
    const result = await call({ startIndex: 20 });
    expect(result.isError).not.toBe(true);
    expect(parseResult(result)).toEqual({
      totalCount: 75,
      startIndex: 40,
      entries: [{
        id: 1,
        date: "2026-01-01T00:00:00Z",
        severity: "Information",
        type: "VideoPlayback",
        name: "Example episode",
        userId: "user-1",
        itemId: "item-1",
        summary: "Example summary",
        detail: "Example detail",
      }, {
        id: 2,
        date: "2026-01-02T00:00:00Z",
        severity: "Warning",
        type: "System",
        name: "Example event",
        userId: null,
        itemId: null,
        summary: null,
        detail: null,
      }],
    });
  });

  it("uses the requested offset when the server omits StartIndex, including an empty page", async () => {
    const { call } = setup({ Items: [], TotalRecordCount: 10 });
    expect(parseResult(await call({ startIndex: 20 }))).toEqual({
      totalCount: 10, startIndex: 20, entries: [],
    });
  });

  it("returns isError when the client rejects", async () => {
    const { call, getActivityLog } = setup();
    getActivityLog.mockRejectedValueOnce(new Error("Example request failure"));
    const result = await call();
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({ error: "Example request failure" });
  });

  it.each([
    { severity: "Fatal" },
    { startIndex: -1 },
    { startIndex: 0.5 },
    { limit: 201 },
    { limit: 0 },
    { sortOrder: "Newest" },
  ])("rejects invalid input %j before calling the client", async (args) => {
    const { call, getActivityLog } = setup();
    await expect(async () => call(args)).rejects.toThrow();
    expect(getActivityLog).not.toHaveBeenCalled();
  });

  it.each(["Trace", "Debug", "Information", "Warning", "Error", "Critical", "None"])(
    "accepts upstream severity %s",
    async (severity) => {
      const { call, getActivityLog } = setup();
      await call({ severity, sortOrder: "Ascending", startIndex: 0 });
      expect(getActivityLog).toHaveBeenCalledExactlyOnceWith({
        limit: 20, startIndex: 0, severity, sortOrder: "Ascending",
      });
    },
  );

  it("declares all four accurate MCP hints for an external read", () => {
    const { tool } = setup();
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});
