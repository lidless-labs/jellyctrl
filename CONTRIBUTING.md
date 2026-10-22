# Contributing to jellyfin-mcp

jellyfin-mcp is a Model Context Protocol server that exposes a [Jellyfin](https://jellyfin.org) media server's management and playback surface to LLM clients as typed tool calls. Patches are welcome. Before you start, please skim this file so we both spend our time on the right things.

## What kinds of changes land easily

- **Bug fixes** in existing tools: wrong endpoint, bad argument mapping, unhandled Jellyfin error shapes, pagination or ID handling.
- **Better tool descriptions and input schemas** so models pick the right tool and fill arguments correctly.
- **New tools** that wrap a useful Jellyfin operation, with a clear name, a Zod input schema, and the right MCP annotation (`readOnlyHint` for queries, `destructiveHint` plus a `confirm: true` gate for anything that mutates or is privileged).
- **Test coverage** for any of the above.
- **Docs**: README clarifications, new client setup recipes, example prompts.

## What needs a conversation first

- **Renaming or removing an existing tool.** Tool names are the public surface; an agent's saved workflow breaks when they change. Open an issue describing the user story first.
- **Changing the `confirm: true` gate or annotation policy.** The default is that anything destructive or privileged must be confirm-gated and annotated `destructiveHint`. Loosening that needs discussion.
- **Anything that adds a runtime dependency.** The dependency surface is intentionally small (the MCP SDK, undici, zod). New runtime deps need a reason.

## What does not land

- Personal details, hostnames, real private IPs, account IDs, or live API keys in code, tests, or docs. Use `192.0.2.x` (RFC 5737) for example IPs and placeholders like `your-api-key-here`. The `content-guard` check will flag leaks.
- Tools that return raw upstream Jellyfin error bodies or secrets to the model. Summarize status and log detail to stderr instead.
- A destructive or privileged tool without a `confirm: true` gate.
- Commits that are not conventional commits, or that do not end with the trailer line `Co-Authored-By: Claude Duet <noreply@anthropic.com>`.
- PRs whose body does not state what changed, why, and the exact tests run.

## Local dev

```bash
git clone https://github.com/lidless-labs/jellyctrl.git
cd jellyctrl
npm install
npm run dev       # watch mode with tsx
npm run typecheck # tsc --noEmit
npm run build     # tsup bundle
npm test          # vitest
```

To exercise the server against a real Jellyfin instance, point the env vars at it and register the built `dist/index.js` (or `npx -y jellyfin-mcp`) in any MCP client:

```bash
export JELLYFIN_URL=http://192.0.2.10:8096
export JELLYFIN_API_KEY=your-api-key-here
npm run build && node dist/index.js
```

## Adding a tool

1. Add the implementation under `src/tools/<group>.ts`, following the existing pattern: a Zod input schema, a handler, and the registration with name `jellyfin_<verb>_<noun>`.
2. Annotate it: `readOnlyHint: true` for a pure query, or `destructiveHint: true` plus a `confirm: true` input gate for anything that mutates state or is privileged.
3. Summarize Jellyfin errors to a status-only result; log the full body to stderr. Do not leak response bodies, secrets, or Quick Connect codes into tool output.
4. Add a row to the relevant section of the **Tools** table in `README.md`, and bump the tool count where it appears.
5. Add or update tests.
6. Add a `## [Unreleased]` entry to `CHANGELOG.md` describing the effect.

## Filing issues

Please use the templates under `.github/ISSUE_TEMPLATE/`. They exist to save you from re-typing the version, client, and config shape every time. Before posting any output, remove API keys, private hostnames, real IPs, and unredacted absolute paths.

## License

By contributing you agree that your contribution is licensed under the MIT License, same as the rest of the repo.
