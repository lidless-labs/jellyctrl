import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, READ_ONLY } from "./_util.js";

export function registerSystemTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_plugins",
    "List installed Jellyfin plugins with version, status, and uninstallability.",
    {},
    { ...READ_ONLY, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const plugins = yield* fromPromise(() => client.listPlugins());
        const byStatus = new Map<string, number>();
        for (const plugin of plugins) {
          byStatus.set(plugin.Status, (byStatus.get(plugin.Status) ?? 0) + 1);
        }
        return ok({
          count: plugins.length,
          byStatus: Object.fromEntries(byStatus),
          plugins: [...plugins]
            .sort((a, b) => a.Name.localeCompare(b.Name))
            .map((plugin) => ({
              id: plugin.Id,
              name: plugin.Name,
              version: plugin.Version,
              description: plugin.Description,
              status: plugin.Status,
              canUninstall: plugin.CanUninstall,
            })),
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_get_status",
    "Get Jellyfin server info: name, version, OS, architecture, local address, pending restart, update availability.",
    {},
    READ_ONLY,
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const info = yield* fromPromise(() => client.getSystemInfo());
        return ok({
          serverName: info.ServerName,
          version: info.Version,
          id: info.Id,
          os: info.OperatingSystemDisplayName ?? null,
          architecture: info.SystemArchitecture ?? null,
          localAddress: info.LocalAddress ?? null,
          hasPendingRestart: info.HasPendingRestart ?? false,
          hasUpdateAvailable: info.HasUpdateAvailable ?? false,
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_restart_server",
    "Restart the Jellyfin server process. Destructive: active playback sessions disconnect. Requires confirm: true.",
    {
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true. Required acknowledgement that active sessions will disconnect."),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) return refuseUnconfirmed("restart the Jellyfin server");
        yield* fromPromise(() => client.restart());
        return ok({ result: "restart signal sent" });
      })),
    ),
  );

  server.tool(
    "jellyfin_shutdown_server",
    "Shut down the Jellyfin server. Destructive: server stays down until something restarts it manually. Requires confirm: true.",
    {
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true. Required acknowledgement that the server will not come back on its own."),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) return refuseUnconfirmed("shut down the Jellyfin server");
        yield* fromPromise(() => client.shutdown());
        return ok({ result: "shutdown signal sent" });
      })),
    ),
  );
}
