import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import { ok, fail, refuseUnconfirmed, DESTRUCTIVE, READ_ONLY } from "./_util.js";

// Redact authorization codes even if an alternate client returns an error
// containing the code. Cover raw, percent-encoded and form-encoded values.
function redactSecretFromError(error: unknown, secret: string): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Derive the URLSearchParams encoding by round-tripping through a one-field
  // params object - this is what JellyfinClient actually uses, so it's the
  // form most likely to appear in surfaced error messages.
  const formEncoded = new URLSearchParams([["v", secret]]).toString().slice(2);
  const variants = [secret, encodeURIComponent(secret), formEncoded].filter(
    (v, i, arr) => v.length > 0 && arr.indexOf(v) === i,
  );
  const scrubbed = variants.reduce(
    (acc, value) => acc.split(value).join("[redacted]"),
    rawMessage,
  );
  return new Error(scrubbed);
}

export function registerQuickConnectTools(
  server: McpServer,
  client: JellyfinClient,
): void {
  server.tool(
    "jellyfin_quick_connect_status",
    "Check whether Quick Connect is enabled on the server. Quick Connect lets a user log in on a new client by entering a 6-character code on an already-authenticated client.",
    {},
    READ_ONLY,
    toToolHandler(() =>
      toolResult(Effect.gen(function* () {
        const enabled = yield* fromPromise(() => client.getQuickConnectEnabled());
        return ok({ enabled });
      })),
    ),
  );

  server.tool(
    "jellyfin_quick_connect_authorize",
    "Authorize a pending Quick Connect code for a specific user. The user's new client will then be granted a session for that user account. Requires confirm: true because this grants authenticated access to the specified user's account.",
    {
      code: z
        .string()
        .trim()
        .min(1)
        .describe("The Quick Connect code shown on the new client (typically 6 characters)."),
      userId: z
        .string()
        .trim()
        .min(1)
        .describe("User ID the new client will be authenticated as. Use jellyfin_list_users to find IDs."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to proceed - this grants a session to the specified user account."),
    },
    DESTRUCTIVE,
    toToolHandler(({ code, userId, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          // Don't echo the code back - it's a short-lived auth secret, and tool
          // output/logs are often captured by MCP clients. Identifying the user
          // is enough for the operator to know which approval they're reviewing.
          return refuseUnconfirmed(
            `authorize the pending Quick Connect code for user ${userId}`,
          );
        }
        const authorizedResult = yield* Effect.either(
          fromPromise(() => client.authorizeQuickConnect(code, userId)),
        );
        if (authorizedResult._tag === "Left") {
          return fail(redactSecretFromError(authorizedResult.left, code));
        }
        const authorized = authorizedResult.right;
        // Jellyfin returns `false` when the code is unknown/expired but the
        // request itself succeeded. Treat that as failure so MCP clients see
        // an isError result, not a misleading success with authorized: false.
        if (!authorized) {
          return fail(
            new Error(
              `Quick Connect authorization was not accepted for user ${userId} (code unknown, expired, or already consumed).`,
            ),
          );
        }
        return ok({ userId, authorized: true });
      })),
    ),
  );
}
