// Shared helpers for tool response formatting. Keeps every tool handler
// returning the same shape without each one reimplementing try/catch.

import { annotate, READ_ONLY as KIT_READ_ONLY } from "@lidless-labs/effect-operator-kit";

// MCP tool annotations, passed as the argument before the handler in
// server.tool(). They are hints only (clients must not rely on them for
// security), but clients that implement human-in-the-loop approval use
// destructiveHint to decide which calls need a human, and readOnlyHint to
// skip approval entirely. Every tool registers exactly one of these, built by
// the kit helper so every hint is explicit and a write defaults to destructive.
export const READ_ONLY = KIT_READ_ONLY;
// Writes that are additive or trivially reversible (pause, favorite, create).
export const NON_DESTRUCTIVE = annotate({ destructive: false });
// Irreversible or disruptive: deletes, password resets, shutdown/restart,
// stopping playback, clearing resume state, granting sessions.
export const DESTRUCTIVE = annotate();

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

// Returned by destructive tools when confirm: true was not passed. Surfaces
// as an isError result so MCP clients see it as a refusal, not a success.
export function refuseUnconfirmed(action: string): ToolResult {
  return fail(
    new Error(
      `Refusing to ${action} without explicit confirmation. Re-call this tool with confirm: true to proceed.`,
    ),
  );
}
