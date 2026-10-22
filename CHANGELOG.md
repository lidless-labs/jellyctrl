# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Continue Watching clears run at most four operations concurrently, preserve
  selection order, and report all successes and failures.
- `JELLYFIN_TIMEOUT` values outside the 1 to 2147483647 millisecond timer range
  warn and use the 30s default. Valid fractional seconds remain supported.

### Security

- `jellyfin_run_scheduled_task` requires `confirm: true` and carries a
  destructive annotation before starting a privileged server task.
- Public parse and transport errors use fixed messages without downstream
  response content, query secrets, or raw causes.
- Client requests reject redirects to prevent forwarding the API token.
  Configure the final Jellyfin server URL.

### Added

- `jellyfin_get_user` reads one user's password status, login/activity timestamps,
  and selected policy fields. Missing values return `null`. HTTP `observe` mode
  permits this read-only tool. The MCP surface now has 58 tools.

- `jellyfin_get_favorite_items` — user's favorite items, with optional type
  filtering and pagination.
- Maintainer health files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  GitHub issue templates (bug, feature, blank-issues-disabled config), and a
  pull request template with a no-PII / content-guard checklist.

### Changed

- `jellyfin_get_item` requires `userId`, and CLI `jellyctrl item <itemId>`
  requires `--user <id>` for user-scoped item visibility and state.
- README rewritten to the adoption-upgrade standard: a what / why / how-it-differs
  lead, an npm version and CI badge, a prominent Website link, a copyable
  `npx -y jellyfin-mcp` MCP client config, a keyword-rich "What it does" section,
  and "Why not alternatives?" and "What jellyfin-mcp is not" sections.

## [0.4.0] - 2026-06-10

### Added

- 10 new tools since the v0.3.0 npm publish (46 to 56 total):
  - Continue Watching management: `jellyfin_preview_continue_watching_clear`,
    `jellyfin_clear_continue_watching`, `jellyfin_clear_series_continue_watching`,
    `jellyfin_clear_episode_continue_watching_except_latest`
  - Resume state and history: `jellyfin_set_resume_position`,
    `jellyfin_get_watch_history`, `jellyfin_get_user_item_data`
  - Bulk session control: `jellyfin_pause_all_sessions`,
    `jellyfin_stop_all_sessions`, `jellyfin_message_all_active_sessions`
- MCP tool annotations on all 56 tools: `readOnlyHint: true` on read-only
  tools, `destructiveHint: true` on destructive ones (user deletion, password
  reset, shutdown/restart, stopping sessions, resume-state clears, Quick
  Connect authorization), so MCP clients can route destructive calls to human
  approval. The `confirm: true` gate remains as a second layer.

### Fixed

- Strip the draft-07 `$schema` the MCP SDK stamps on tool schemas; Anthropic
  rejects it when the full tool set is sent (e.g. on subagent spawns).
- `JELLYFIN_TIMEOUT` is validated: non-numeric, zero, or negative values now
  warn on stderr and fall back to the 30s default instead of producing a NaN
  that aborted every request after ~1ms.
- Server name and version are derived from `package.json` instead of
  duplicated literals, so the advertised MCP version can no longer drift from
  the published package version.

### Security

- `JELLYFIN_VERIFY_SSL=false` now relaxes TLS certificate validation for the
  Jellyfin connection only, via a per-request undici dispatcher, instead of
  the process-global `NODE_TLS_REJECT_UNAUTHORIZED` which disabled validation
  for every outbound TLS connection.
- Upstream Jellyfin error response bodies are no longer returned to the MCP
  client; results carry the status summary only and the full body is logged
  to stderr for operators.
- `jellyfin_set_user_password` now warns (tool description and README) that
  the plaintext password transits the LLM conversation and provider logs.

### Changed

- CI: the test step no longer uses `continue-on-error`, so test failures fail
  the build and gate the publish job.

## [0.3.0] - 2026-04-22

### Added

- Discovery tools: `jellyfin_get_resume_items`, `jellyfin_get_next_up`,
  `jellyfin_get_similar_items`
- Quick Connect tools: `jellyfin_quick_connect_status`,
  `jellyfin_quick_connect_authorize` (confirm-gated)

### Fixed

- Reject blank IDs in tool arguments; redact Quick Connect codes from
  authorize error messages in every encoding.

### Changed

- Toolchain and SDK major upgrades (TypeScript 6, MCP SDK, vitest, tsup).

## [0.2.0] - 2026-04-20

### Added

- Deeper playback control: seek, next/previous track, volume, mute,
  audio/subtitle stream selection, cast/remote-play, send message
- User data writes: mark played/unplayed, set/unset favorite
- Playlists: list, create, get items, add, remove entries
- Collections: create, add, remove
- `confirm: true` gates on destructive and privileged operations

## [0.1.0] - 2026-04-19

### Added

- Initial scaffold: 20 MCP tools for Jellyfin covering system info,
  libraries, users, sessions, items, scheduled tasks, and activity log.

[Unreleased]: https://github.com/lidless-labs/jellyctrl/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/lidless-labs/jellyctrl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lidless-labs/jellyctrl/releases/tag/v0.3.0
[0.2.0]: https://github.com/lidless-labs/jellyctrl/commits/9ea3acd
[0.1.0]: https://github.com/lidless-labs/jellyctrl/commits/4f62caa
