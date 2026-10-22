<p align="center">
  <img src="docs/assets/jellyctrl-social-preview.jpg" alt="jellyctrl banner" width="900">
</p>

<p align="center">
  <a href="https://lidless.dev"><img src="docs/assets/marks/jellyctrl-circle.png" width="48" alt="Lidless Labs"></a>
</p>
<h1 align="center">jellyctrl</h1>

<p align="center"><strong>Operator control CLI for Jellyfin, with MCP compatibility built in.</strong></p>

<p align="center">
  <a href="https://lidless.dev/jellyfin-mcp"><strong>Website</strong></a>
  &nbsp;&middot;&nbsp;
  <a href="https://www.npmjs.com/package/jellyfin-mcp">npm</a>
  &nbsp;&middot;&nbsp;
  <a href="#install">Install</a>
  &nbsp;&middot;&nbsp;
  <a href="#cli">CLI</a>
  &nbsp;&middot;&nbsp;
  <a href="#tools">Tools</a>
</p>

<p align="center">
  <img src="https://shieldcn.dev/github/ci/lidless-labs/jellyctrl.svg?branch=main&workflow=ci.yml" alt="CI status">
  <img src="https://shieldcn.dev/npm/jellyfin-mcp.svg" alt="npm version">
  <img src="https://shieldcn.dev/badge/MCP-server-8A2BE2.svg" alt="MCP server">
  <img src="https://shieldcn.dev/badge/license-MIT-green.svg" alt="MIT License">
</p>

jellyctrl is an operator control CLI for [Jellyfin](https://jellyfin.org), the free self-hosted media server. It gives shells, cron, CI, and agents a typed command surface for inspecting and operating a Jellyfin server without clicking through the dashboard. The same npm package is still published as `jellyfin-mcp` for compatibility, and the MCP adapter remains available through both `jellyctrl mcp` and the legacy `jellyfin-mcp` bin.

You want it because asking "what's playing in the living room?" or running `jellyctrl sessions --active-only` is faster than dashboard hopping, and because an agent can chain those steps when launched through MCP. Compared with a generic HTTP tool or hand-written script, the MCP adapter exposes 58 schema-validated tools with `confirm: true` gates on every destructive operation and annotations that let clients route those calls to human approval.

> **Status: WIP.** Used daily against a real Jellyfin server, but the tool surface is still settling and breaking changes can land between minor versions. Pin a released version if you need stability.

Companion to [arr-cli](https://github.com/lidless-labs/arr-cli) (the *arr stack CLI). arr-cli handles acquiring content; jellyctrl handles serving, monitoring, and Jellyfin operations.

## What it does

Jellyfin is a free, self-hosted media server: your movies, shows, music, and photos on hardware you control. jellyctrl puts that media server's management surface in front of operators first: list sessions, inspect libraries, query users, search items, review activity, and script routine checks from the command line.

For MCP-compatible clients, `jellyctrl mcp` exposes the same project as a stdio MCP server with 58 typed tools so an agent can list who is watching what, pause or cast a session, scan a library, manage users, prune Continue Watching, run a scheduled task, or message a client, all as structured tool calls instead of raw REST. The MCP surface is read-and-write: discovery and reporting tools are read-only, while every destructive or privileged operation is gated behind an explicit `confirm: true` flag and a `destructiveHint` annotation. The `jellyfin-mcp` command remains supported as a compatibility bin.

## Install

```bash
npm install -g jellyfin-mcp
```

This installs `jellyctrl`, the compatibility `jellyfin-mcp` stdio MCP bin, and the optional `jellyfin-mcp-http` loopback HTTP bin.

Or from source:

```bash
git clone https://github.com/lidless-labs/jellyctrl.git
cd jellyctrl
npm install
npm run build
```

## Quickstart

Set your Jellyfin connection details, then run a CLI command:

```bash
export JELLYFIN_URL=http://192.0.2.10:8096
export JELLYFIN_API_KEY=your-api-key-here
jellyctrl status
jellyctrl sessions --active-only
```

For MCP clients, start the adapter with `jellyctrl mcp` or keep using the compatibility `jellyfin-mcp` bin. No global install is required for the MCP path; `npx` fetches and runs the published `jellyfin-mcp` package:

```json
{
  "mcpServers": {
    "jellyfin": {
      "command": "npx",
      "args": ["-y", "jellyfin-mcp"],
      "env": {
        "JELLYFIN_URL": "http://192.0.2.10:8096",
        "JELLYFIN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Then ask your agent: *"What's playing on Jellyfin right now?"* It will call `jellyfin_list_sessions` and report back.

## Optional local HTTP transport

The default MCP transport is stdio. Use `jellyfin-mcp-http` when an MCP client needs Streamable HTTP on the same machine, or through an authenticated proxy whose origin runs on that machine. The listener accepts MCP JSON-RPC only at `POST /mcp`, has a non-sensitive `GET /healthz` response, and binds to loopback only.

Set a separate bearer token. Do not reuse `JELLYFIN_API_KEY` for this token.

```bash
export JELLYFIN_URL=http://192.0.2.10:8096
export JELLYFIN_API_KEY=your-jellyfin-api-key
export JELLYFIN_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
jellyfin-mcp-http
```

The HTTP listener defaults to `127.0.0.1:3000`. Its configuration is intentionally strict:

| Variable | Default | Purpose |
| --- | --- | --- |
| `JELLYFIN_MCP_HTTP_HOST` | `127.0.0.1` | Loopback bind, only `127.0.0.1` or `::1`. Wildcards are refused |
| `JELLYFIN_MCP_HTTP_PORT` | `3000` | TCP port, an integer from 1 to 65535 |
| `JELLYFIN_MCP_HTTP_TOKEN` | Required | Independent bearer token, at least 32 characters after trimming whitespace. Send as `Authorization: Bearer <token>` |
| `JELLYFIN_MCP_REMOTE_MODE` | `observe` | Tool policy fixed at process startup, never changed by an MCP request |

Host and Origin checks run before `/healthz` and authentication. Host must identify a loopback alias or the bound host. Origin may be absent or an exact HTTP(S) loopback origin. Invalid headers receive 403 Forbidden.

Remote modes provide a second server-side control in addition to each tool's existing `confirm: true` requirement:

- `observe` permits only read tools.
- `managed` also permits routine media, library, session, and user-data writes.
- `full` permits every registered tool. High-impact tools still require their existing `confirm: true` argument.

In `managed` mode, the server denies restart, shutdown, account creation or deletion, password changes, account enable or disable, scheduled-task execution, session stop or stop-all, destructive playlist or collection removal, bulk resume clearing, and Quick Connect authorization. Unknown or unclassified tools are denied in every mode.

Do not expose this listener directly or change it to a non-loopback bind. For remote clients, keep the loopback origin and put an identity-aware proxy or tunnel in front of it. Keep the HTTP token as a second authentication layer, independent from the Jellyfin API key, and rotate it if a client or its logs may have exposed it.

## Tools

### System
- `jellyfin_get_status` - server name, version, OS, pending restart, update availability
- `jellyfin_list_plugins` - installed plugins with versions, statuses, and uninstallability
- `jellyfin_restart_server` - restart the Jellyfin process *(requires `confirm: true`)*
- `jellyfin_shutdown_server` - stop the Jellyfin process *(requires `confirm: true`)*

### Libraries
- `jellyfin_list_libraries` - all virtual folders with IDs, collection types, paths
- `jellyfin_scan_library` - trigger scan for one library or all

### Users
- `jellyfin_list_users` - with admin / disabled flags and last login timestamps
- `jellyfin_create_user`
- `jellyfin_delete_user` *(requires `confirm: true`)*
- `jellyfin_set_user_disabled` *(requires `confirm: true`)*
- `jellyfin_set_user_password` *(requires `confirm: true`)*

> **Warning:** `jellyfin_set_user_password` takes the new password as plaintext tool input. That means the password transits your LLM conversation, the model provider's request logs, and any saved session transcript. Treat any password set this way as exposed: use a throwaway value and have the user change it in the Jellyfin UI, or set passwords in the Jellyfin dashboard instead.

### Sessions & Playback
- `jellyfin_list_sessions` - active/idle clients with now-playing, progress, paused state
- `jellyfin_pause_session`
- `jellyfin_resume_session`
- `jellyfin_stop_session` *(requires `confirm: true`)*
- `jellyfin_send_message_to_session` - toast/dialog on the client
- `jellyfin_seek_session` - jump to a position in seconds
- `jellyfin_next_track` / `jellyfin_previous_track`
- `jellyfin_set_volume` (0-100) / `jellyfin_set_mute` (mute/unmute/toggle)
- `jellyfin_set_audio_stream` / `jellyfin_set_subtitle_stream` (use -1 to disable subtitles)
- `jellyfin_play_on_session` - cast/remote-play one or more items to a session (PlayNow / PlayNext / PlayLast)
- `jellyfin_pause_all_sessions` - pause matching sessions *(requires `confirm: true`)*
- `jellyfin_stop_all_sessions` - stop matching sessions *(requires `confirm: true`)*
- `jellyfin_message_all_active_sessions` - message matching active sessions *(requires `confirm: true`)*

### User Data
- `jellyfin_mark_played` / `jellyfin_mark_unplayed`
- `jellyfin_set_favorite` / `jellyfin_unset_favorite`
- `jellyfin_preview_continue_watching_clear` - dry-run a Continue Watching cleanup with optional filters
- `jellyfin_clear_continue_watching` - clear resume positions for selected items or a filtered Continue Watching queue *(requires `confirm: true`)*
- `jellyfin_clear_series_continue_watching` - clear resume positions for one show's episodes *(requires `confirm: true`)*
- `jellyfin_clear_episode_continue_watching_except_latest` - keep one episode resume entry and clear older entries for a show *(requires `confirm: true`)*
- `jellyfin_get_watch_history` - recently watched items for a user
- `jellyfin_get_user_item_data` - raw watched/favorite/resume data for one item
- `jellyfin_set_resume_position` - set a user's resume position for an item *(requires `confirm: true`)*

### Playlists
- `jellyfin_list_playlists`
- `jellyfin_create_playlist`
- `jellyfin_get_playlist_items` - returns `playlistEntryId` (use this for removal, not the raw item ID)
- `jellyfin_add_to_playlist`
- `jellyfin_remove_from_playlist` *(requires `confirm: true`)*

### Collections
- `jellyfin_create_collection`
- `jellyfin_add_to_collection`
- `jellyfin_remove_from_collection` *(requires `confirm: true`)*

### Items
- `jellyfin_search_items` - by name, optional type filter
- `jellyfin_get_recent_items` - latest added (per-user)
- `jellyfin_get_item` - full metadata (requires `userId`)
- `jellyfin_get_favorite_items` - user's favorite items, with pagination

### Discovery
- `jellyfin_get_resume_items` - in-progress playback for a user, with resume position in seconds
- `jellyfin_get_next_up` - next unwatched episode per series for a user; optional `seriesId` filter
- `jellyfin_get_similar_items` - Jellyfin's built-in "similar" recommendations for a given item

### Quick Connect
- `jellyfin_quick_connect_status` - whether Quick Connect is enabled on the server
- `jellyfin_quick_connect_authorize` - approve a pending code for a user *(requires `confirm: true`)*

### Tasks & Activity
- `jellyfin_list_scheduled_tasks`
- `jellyfin_run_scheduled_task` (requires `confirm: true`)
- `jellyfin_get_activity_log`

## CLI

`jellyctrl` is the primary operator interface for shells, cron, and CI. It shares the `JellyfinClient` core with the MCP adapter and reads the same env config. The current CLI exposes the read/report/lookup commands; playback control, user management, library scans, and other write operations stay in the MCP surface behind the `confirm: true` gates.

```bash
npx jellyfin-mcp@latest status
# or, installed globally:
jellyctrl status                                  # server info; exit 1 if unreachable
jellyctrl libraries
jellyctrl users
jellyctrl sessions --active-only
jellyctrl search "blade runner" --type Movie --limit 5
jellyctrl item 6e0b... --user 3f1c...             # full metadata for one item
jellyctrl recent --user 3f1c... --limit 10
jellyctrl resume --user 3f1c...                   # Continue Watching, with resume position
jellyctrl next-up --user 3f1c... --series 9a2d...
jellyctrl similar 6e0b... --user 3f1c...
jellyctrl history --user 3f1c... --type Movie,Episode
jellyctrl user-data --user 3f1c... --item 6e0b...
jellyctrl activity --limit 50
jellyctrl tasks
jellyctrl playlists --user 3f1c...
jellyctrl playlist 4c7e... --user 3f1c...
jellyctrl status --json                           # raw JSON for piping
```

Run `jellyctrl help` for the full command and flag list. `--json` emits raw JSON instead of the concise human-readable summary. The CLI reads `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_TIMEOUT`, and `JELLYFIN_VERIFY_SSL` (see [Configuration](#configuration)); for example:

```bash
export JELLYFIN_URL=http://192.0.2.10:8096
export JELLYFIN_API_KEY=your-api-key-here
jellyctrl status
```

Exit codes: `0` success, `1` runtime error (backend unreachable / call failed, and `status` when the server reports no version), `2` usage error (unknown command/flag or bad value).

### Starting the MCP adapter

`jellyctrl mcp` starts the stdio MCP adapter. The compatibility `jellyfin-mcp` bin does the same thing and remains supported. Launchers that reference the file path `dist/index.js` directly keep working; new launchers can point at `dist/mcp-bin.js` (or `dist/cli.js mcp`). Launchers that use the `jellyfin-mcp` bin name need no change.

## Configuration

Set these environment variables in your MCP client config:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JELLYFIN_URL` | yes | none | Base URL, e.g. `http://localhost:8096` or `https://jellyfin.example.com` |
| `JELLYFIN_API_KEY` | yes | none | API key from Jellyfin Dashboard > API Keys |
| `JELLYFIN_TIMEOUT` | no | `30` | Request timeout in seconds |
| `JELLYFIN_VERIFY_SSL` | no | `true` | Set to `false` to skip TLS certificate validation for the Jellyfin connection (e.g. self-signed certs) |

> **Note:** `JELLYFIN_VERIFY_SSL=false` only relaxes certificate validation for the Jellyfin connection itself (via a confined per-request HTTP dispatcher). It does not touch global TLS settings, so certificate validation for any other outbound request in the process is unaffected. Leave it at the secure default unless you specifically need it.

### Getting an API key

1. Log into Jellyfin as an admin
2. Dashboard > API Keys > `+`
3. Name it (e.g. `mcp`) and save
4. Copy the value

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "jellyfin": {
      "command": "jellyfin-mcp",
      "env": {
        "JELLYFIN_URL": "http://localhost:8096",
        "JELLYFIN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add jellyfin \
  --env JELLYFIN_URL=http://localhost:8096 \
  --env JELLYFIN_API_KEY=your-api-key-here \
  -- jellyfin-mcp
```

Add `--scope user` to make it available from any directory instead of only the current project.

### OpenClaw

If you're running from a source checkout instead of the npm-installed binary, point `command`/`args` at the built `dist/index.js`:

```bash
openclaw mcp set jellyfin '{
  "command": "node",
  "args": ["/absolute/path/to/jellyfin-mcp/dist/index.js"],
  "env": {
    "JELLYFIN_URL": "http://localhost:8096",
    "JELLYFIN_API_KEY": "your-api-key-here"
  }
}'
```

Or, with the global npm install:

```bash
openclaw mcp set jellyfin '{
  "command": "jellyfin-mcp",
  "env": {
    "JELLYFIN_URL": "http://localhost:8096",
    "JELLYFIN_API_KEY": "your-api-key-here"
  }
}'
```

Then restart the OpenClaw gateway so the new server is picked up:

```bash
systemctl --user restart openclaw-gateway
openclaw mcp list   # confirm "jellyfin" is registered
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/config.yaml` under the `mcp_servers` key. Add an entry:

```yaml
mcp_servers:
  jellyfin:
    command: "jellyfin-mcp"
    env:
      JELLYFIN_URL: "http://localhost:8096"
      JELLYFIN_API_KEY: "your-api-key-here"
```

Or, when running from a source checkout instead of the global npm install:

```yaml
mcp_servers:
  jellyfin:
    command: "node"
    args: ["/absolute/path/to/jellyfin-mcp/dist/index.js"]
    env:
      JELLYFIN_URL: "http://localhost:8096"
      JELLYFIN_API_KEY: "your-api-key-here"
```

Then reload MCP from inside a Hermes session:

```
/reload-mcp
```

### Codex CLI

[Codex CLI](https://github.com/openai/codex) registers MCP servers via `codex mcp add`:

```bash
codex mcp add jellyfin \
  --env JELLYFIN_URL=http://localhost:8096 \
  --env JELLYFIN_API_KEY=your-api-key-here \
  -- jellyfin-mcp
```

Or, when running from a source checkout:

```bash
codex mcp add jellyfin \
  --env JELLYFIN_URL=http://localhost:8096 \
  --env JELLYFIN_API_KEY=your-api-key-here \
  -- node /absolute/path/to/jellyfin-mcp/dist/index.js
```

Codex writes the entry to `~/.codex/config.toml` under `[mcp_servers.jellyfin]`. Verify with:

```bash
codex mcp list
```

### Remote Jellyfin via SSH tunnel

If Jellyfin binds to `localhost` on a remote host (common on Windows media servers), forward the port before starting your MCP client:

```bash
ssh -N -L 8096:localhost:8096 mediaserver
```

Then point `JELLYFIN_URL` at `http://localhost:8096`. The MCP itself has no SSH logic, it just talks HTTP.

## Features

- `jellyctrl` CLI for operator status, library, user, session, item, activity, task, playlist, history, and user-data checks
- MCP adapter through `jellyctrl mcp` and the compatibility `jellyfin-mcp` bin
- **58 MCP tools** covering system info, libraries, users, sessions, items, scheduled tasks, user data writes, playlists, collections, discovery, and Quick Connect
- Playback control: pause / resume / stop / seek / next / previous / volume / mute / audio-stream / subtitle-stream / cast (remote-play) / send-message / bulk session controls
- User data writes: mark watched/unwatched, add/remove favorites, preview or clear Continue Watching resume positions, set resume position
- Playlists: create, list, append, remove entries
- Collections: create, add, remove
- Discovery: resume queue, next-up episodes, similar items
- Quick Connect: check status, authorize a pending code for a user
- Library scan triggering (per-library or all)
- User admin: list, create, delete, enable/disable, reset password
- Activity log queries for recent events
- Destructive / privileged ops (`restart`, `shutdown`, `delete_user`, `set_user_password`, `quick_connect_authorize`, `jellyfin_run_scheduled_task`, `jellyfin_clear_continue_watching`, bulk session controls, resume-position writes) require explicit `confirm: true`
- Upstream Jellyfin error responses are summarized (status only) before being returned to the client; the full response body is logged to stderr for operators, so internal server detail is not surfaced to the model
- Works from a shell, cron, CI, Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI, and any MCP-compatible client

## Example Prompts

> What's actively playing on Jellyfin right now?

Calls `jellyfin_list_sessions` with `activeOnly=true`.

> Pause whatever's playing in the living room

Calls `jellyfin_list_sessions`, finds the session by device name, then `jellyfin_pause_session`.

> Scan the Movies library

Calls `jellyfin_list_libraries` to find the ID, then `jellyfin_scan_library`.

> Send a message to my partner's Jellyfin that dinner is ready

`jellyfin_list_sessions` -> pick by username -> `jellyfin_send_message_to_session`.

> What scheduled tasks have failed recently?

`jellyfin_list_scheduled_tasks` and filter by `lastStatus`.

> What was I watching last night?

Calls `jellyfin_get_resume_items` with the user's ID. Returns in-progress episodes/movies with resume position in seconds.

> Clear my Continue Watching list for this user.

Calls `jellyfin_list_users` to resolve the target user, then `jellyfin_clear_continue_watching` with `userId` and `confirm: true`.

> Show what would be cleared from Continue Watching for this show.

Calls `jellyfin_preview_continue_watching_clear` with `seriesId` before making changes.

> I opened a bunch of episodes in one show. Keep the latest and clear the rest.

Calls `jellyfin_clear_episode_continue_watching_except_latest` with `seriesId`, `userId`, and `confirm: true`.

> Set this movie to resume at 42 minutes.

Calls `jellyfin_set_resume_position` with `positionSec=2520` and `confirm: true`.

> What's the next episode of this show for me?

Calls `jellyfin_get_next_up` with the user's ID, optionally narrowed with `seriesId`.

> Approve my phone's Jellyfin login. The code is `ABCDEF`.

Calls `jellyfin_list_users` to resolve the target user, then `jellyfin_quick_connect_authorize` with `code`, `userId`, and `confirm: true`.

## Why not alternatives?

- **Why not just call the Jellyfin REST API from a generic HTTP tool?** You can, but then the caller has to know the endpoint shapes, build query strings, and handle pagination and IDs by hand on every call. jellyctrl wraps useful read and reporting operations as stable CLI commands, and its MCP adapter exposes 58 named, schema-validated tools with descriptions, so a model picks `jellyfin_pause_session` instead of guessing at `POST /Sessions/{id}/Playing/Pause`. It also redacts upstream error bodies and Quick Connect codes before they reach the model.
- **Why not a shell script or a few curl aliases?** A script works for one fixed task. jellyctrl gives operators a reusable command surface, while the MCP adapter lets an agent compose steps it was not pre-programmed for ("find the living room session, see what's playing, pause it, then message my partner") and reuse the same tools across Claude Desktop, Claude Code, Codex CLI, OpenClaw, and any other MCP client.
- **Why not the Jellyfin web dashboard?** The dashboard is for a human clicking. jellyctrl is for operators and agents acting through commands, natural language, and larger workflows alongside other tools.

## What jellyctrl is not

- **Not a Jellyfin client or player.** It does not stream, transcode, or render media. It controls and queries an existing Jellyfin server over HTTP; playback happens on your real Jellyfin clients.
- **Not a content acquisition tool.** Downloading, importing, or organizing files is out of scope. Pair it with [arr-cli](https://github.com/lidless-labs/arr-cli) for the acquisition side.
- **Not a security boundary on its own.** The `confirm: true` gates and MCP `destructiveHint` annotations help clients route risky calls to human approval, but anyone who can reach this server with a valid `JELLYFIN_API_KEY` can act as that key allows. Scope the API key and keep `JELLYFIN_VERIFY_SSL` at its secure default.
- **Not a hosted service.** There is no SaaS, no telemetry, and no network egress beyond the calls to the Jellyfin server you configure. It runs locally as a stdio MCP server.

## Development

```bash
npm install
npm run dev       # watch mode with tsx
npm run typecheck # tsc --noEmit
npm run build     # tsup bundle
npm test          # vitest
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the tools are structured and what lands easily, [SECURITY.md](SECURITY.md) for reporting vulnerabilities privately, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the ground rules.

## License

[MIT](LICENSE)

---

<p align="center"><a href="https://lidless.dev">Part of <strong>Lidless Labs</strong></a> &middot; the eye does not close</p>

<p align="center"><sub><strong>Homelab:</strong> <a href="https://github.com/lidless-labs/proxmox-mcp">proxmox-mcp</a> &middot; <a href="https://github.com/lidless-labs/adguardctrl">adguardctrl</a> &middot; <a href="https://github.com/lidless-labs/immichctrl">immichctrl</a> &middot; <a href="https://github.com/lidless-labs/proxguard">proxguard</a></sub></p>

<p align="center"><sub><a href="https://lidless.dev">All tools</a> &middot; <a href="https://github.com/lidless-labs">Lidless Labs on GitHub</a></sub></p>
