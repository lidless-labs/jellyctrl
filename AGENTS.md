# Repository Guidance

## Definition of Done

```
./scripts/verify
```

Runs `npm run typecheck`, `npm test` (Vitest), and `npm run build` (tsup).
Report the actual result. Paste failures verbatim. Never claim success you did not observe.

## Hard Prohibitions

- This MCP server talks to a live Jellyfin media server. During development or
  review, never invoke write or destructive tools against it unless the user
  explicitly asks in this session. Highest impact: `jellyfin_delete_user`,
  `jellyfin_shutdown_server`, `jellyfin_restart_server`,
  `jellyfin_set_user_password`, `jellyfin_stop_all_sessions`,
  `jellyfin_stop_session`. These are gated behind `confirm: true` via
  `refuseUnconfirmed` in `src/tools/_util.ts`. Never pass `confirm: true` on
  your own initiative; the gate exists to stop you.
- Need to exercise Jellyfin behavior? Use the Vitest fetch and MCP server
  doubles in `tests/`. Tests stay mocked; never point them at a real server.
- When a test fails, fix the code or report the failure. Never weaken, skip,
  or delete a failing test to get green.
- A pre-push hook (`hooks/pre-push`, wired via `core.hooksPath`) scans for
  content leaks. Never push with `--no-verify`.
- When a gate cannot run, report the exact blocker, the command, and the
  verbatim error. Do not guess or substitute a weaker check.

## Project Shape

- TypeScript MCP server for Jellyfin. Runtime code lives in `src/`, grouped by
  MCP tool area under `src/tools/`.
- `src/client.ts` owns direct Jellyfin HTTP calls. When a tool needs a new
  endpoint, add a client method; do not build URLs inside tool files.
- Minimal Jellyfin response types live in `src/types.ts`. Add only the fields
  this MCP reads or writes.
- Tests live in `tests/` and use Vitest with fetch and MCP server doubles.

## Implementation Rules

- Adding or changing a tool? Type its input with a Zod schema and return
  through `ok`, `fail`, or `refuseUnconfirmed` from `src/tools/_util.ts`. Do
  not hand-build result objects.
- Adding or changing a mutating operation? Require explicit `confirm: true`
  and return `refuseUnconfirmed` when it is missing. Set `destructiveHint: true`
  only for destructive or disruptive effects.
- When behavior depends on watched, resume, favorite, or visibility state,
  prefer user-scoped Jellyfin APIs over global ones.
- When updating a subset of Jellyfin user data, preserve the existing fields
  unless the endpoint is known to patch safely.
- Want a new dependency? Ask first. Do not add one on your own.

## Verification

- For a focused client or tool change, run the smallest meaningful target
  first: `npx vitest run tests/<name>.test.ts`.
- Before claiming repo-wide success, run `./scripts/verify`. If it cannot run,
  report the exact blocker instead.

## Documentation

- After registering or removing a tool, update the README tool counts and
  feature lists in the same change.
- Use plain ASCII punctuation. Do not use em dashes.

## Memory Handoff

- After substantial tasks, write a handoff under `.claude/memory-handoffs/`
  using its `TEMPLATE.md`.
- Do not edit `MEMORY.md` directly.
