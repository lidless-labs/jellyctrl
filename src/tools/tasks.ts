import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, READ_ONLY } from "./_util.js";

export function registerTaskTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_scheduled_tasks",
    "List all Jellyfin scheduled tasks with state (Idle/Running), progress %, and last execution info.",
    {},
    READ_ONLY,
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const tasks = yield* fromPromise(() => client.listScheduledTasks());
        return ok(
          tasks.map((t) => ({
            id: t.Id,
            name: t.Name,
            category: t.Category ?? null,
            state: t.State,
            progressPercent: t.CurrentProgressPercentage ?? null,
            lastStart: t.LastExecutionResult?.StartTimeUtc ?? null,
            lastEnd: t.LastExecutionResult?.EndTimeUtc ?? null,
            lastStatus: t.LastExecutionResult?.Status ?? null,
            lastError: t.LastExecutionResult?.ErrorMessage ?? null,
          })),
        );
      })),
    ),
  );

  server.tool(
    "jellyfin_run_scheduled_task",
    "Trigger a privileged server scheduled task to run immediately. Requires confirm: true. Use jellyfin_list_scheduled_tasks to discover IDs.",
    {
      taskId: z.string().describe("Task ID from jellyfin_list_scheduled_tasks"),
      confirm: z.boolean().optional().describe("Must be true to start the scheduled task."),
    },
    DESTRUCTIVE,
    toToolHandler(({ taskId, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed(`run scheduled task ${taskId}`);
        yield* fromPromise(() => client.runScheduledTask(taskId));
        return ok({ result: `task ${taskId} started` });
      })),
    ),
  );

  server.tool(
    "jellyfin_get_activity_log",
    "Get recent entries from Jellyfin's activity log (playback start/stop, login events, plugin updates, errors).",
    {
      limit: z.number().int().positive().max(200).optional().default(20),
      minDate: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp - only return entries newer than this (e.g. 2026-04-19T00:00:00Z)"),
    },
    READ_ONLY,
    toToolHandler(({ limit, minDate }) =>
      toolResult(Effect.gen(function* () {
        const log = yield* fromPromise(() => client.getActivityLog(limit, minDate));
        return ok({
          totalCount: log.TotalRecordCount,
          entries: log.Items.map((e) => ({
            id: e.Id,
            date: e.Date,
            severity: e.Severity,
            type: e.Type,
            name: e.Name,
            userId: e.UserId ?? null,
            summary: e.ShortOverview ?? null,
            detail: e.Overview ?? null,
          })),
        });
      })),
    ),
  );
}
