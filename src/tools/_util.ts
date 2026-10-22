// Shared helpers for tool response formatting. Keeps every tool handler
// returning the same shape without each one reimplementing try/catch.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// MCP tool annotations, passed as the argument before the handler in
// server.tool(). They are hints only (clients must not rely on them for
// security), but clients that implement human-in-the-loop approval use
// destructiveHint to decide which calls need a human, and readOnlyHint to
// skip approval entirely. Every tool registers exactly one of these.
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
// Writes conservatively make no retry-safety promise. Creation, messages,
// watched counts and asynchronous playback can have additional effects.
// Writes that are additive or trivially reversible (pause, favorite, create).
export const NON_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
// Irreversible or disruptive: deletes, password resets, shutdown/restart,
// stopping playback, removing user state, granting sessions.
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const MAX_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

export function ok(payload: unknown): ToolResult {
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    return fail(new Error(
      `Tool result exceeds the ${MAX_TOOL_OUTPUT_BYTES}-byte limit. Request fewer items or a smaller result.`,
    ));
  }
  return { content: [{ type: "text" as const, text }] };
}

export function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  let text = JSON.stringify({ error: message }, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    text = JSON.stringify({ error: `Tool error exceeds the ${MAX_TOOL_OUTPUT_BYTES}-byte limit.` }, null, 2);
  }
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

// Returned by mutating tools when confirm: true was not passed. Surfaces
// as an isError result so MCP clients see it as a refusal, not a success.
export function refuseUnconfirmed(action: string): ToolResult {
  return fail(
    new Error(
      `Refusing to ${action} without explicit confirmation. Re-call this tool with confirm: true to proceed.`,
    ),
  );
}
