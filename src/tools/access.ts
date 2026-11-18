import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, READ_ONLY } from "./_util.js";

export function registerAccessTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_api_keys",
    "List Jellyfin API-key metadata without access tokens. Returns the total count and API-key inventory.",
    {},
    READ_ONLY,
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const result = yield* fromPromise(() => client.listApiKeys());
        return ok({
          totalCount: result.TotalRecordCount,
          apiKeys: result.Items.map((key) => ({
            id: key.Id ?? null,
            appName: key.AppName ?? null,
            appVersion: key.AppVersion ?? null,
            deviceName: key.DeviceName ?? null,
            userName: key.UserName ?? null,
            isActive: key.IsActive ?? null,
            dateCreated: key.DateCreated ?? null,
            dateRevoked: key.DateRevoked ?? null,
            dateLastActivity: key.DateLastActivity ?? null,
          })),
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_list_devices",
    "List Jellyfin device metadata without access tokens, optionally filtered by user ID. Returns the total count and up to the requested number of devices.",
    {
      userId: z.string().optional().describe("Only list devices accessible to this user ID"),
      limit: z.number().int().min(1).max(200).default(50).describe("Maximum device rows to return."),
    },
    READ_ONLY,
    toToolHandler(({ userId, limit }) =>
      toolResult(Effect.gen(function* () {
        const result = yield* fromPromise(() => client.listDevices(userId));
        return ok({
          totalCount: result.TotalRecordCount,
          devices: result.Items.slice(0, limit).map((device) => ({
            id: device.Id ?? null,
            name: device.Name ?? null,
            customName: device.CustomName ?? null,
            appName: device.AppName ?? null,
            appVersion: device.AppVersion ?? null,
            lastUserName: device.LastUserName ?? null,
            lastUserId: device.LastUserId ?? null,
            dateLastActivity: device.DateLastActivity ?? null,
          })),
        });
      })),
    ),
  );
}
