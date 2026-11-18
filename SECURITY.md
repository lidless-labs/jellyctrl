# Security Policy

## Supported versions

jellyfin-mcp is WIP (pre-1.0). Only the latest published release receives security fixes. Pin to a released version if you need a known-good build.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems. Email **me@solomonneas.dev** with: <!-- content-guard: allow pii/email -->

- A short description of the issue.
- Steps to reproduce (or a minimal proof of concept).
- The version or commit you tested against.
- Whether you would like to be credited in the release notes.

You should get an acknowledgment within 72 hours. If you do not, please follow up; the mail may have been filtered. You can also use GitHub's private vulnerability reporting from the **Security** tab.

## In scope

- Argument-injection or path-traversal flaws in how tool inputs are forwarded to the Jellyfin API.
- Leaks of secrets, API keys, Quick Connect codes, or upstream Jellyfin response bodies into tool results, model context, or logs.
- A destructive or privileged tool (`jellyfin_restart_server`, `jellyfin_shutdown_server`, `jellyfin_delete_user`, `jellyfin_set_user_password`, `jellyfin_quick_connect_authorize`, the Continue Watching clears, bulk session controls, resume-position writes) executing without the documented `confirm: true` gate.
- HTTP tool discovery or execution that exceeds the policy assigned to the caller's bearer token.
- `JELLYFIN_VERIFY_SSL=false` affecting TLS validation for any outbound request other than the configured Jellyfin connection.

## Known and documented behavior (not a vulnerability)

- `jellyfin_set_user_password` takes the new password as plaintext tool input. That value transits the LLM conversation, the model provider's request logs, and any saved transcript. This is documented in the README and the tool description. Treat any password set this way as exposed and rotate it.
- Direct access to Jellyfin with a valid `JELLYFIN_API_KEY` carries the privileges of that key. The MCP HTTP listener uses separate bearer credentials and enforces the assigned tool policy on each request. The stdio transport relies on local process access and tool confirmation.

## Out of scope

- Bugs in Jellyfin itself; report those upstream at <https://github.com/jellyfin/jellyfin>.
- Bugs in the MCP SDK, Claude Code, Codex, OpenClaw, or other MCP clients; report those to their respective projects.
- Issues that require an attacker to already have your `JELLYFIN_API_KEY`, write access to your MCP client config, or shell access to the host.

## Disclosure

We aim to ship a fix within 14 days of confirming a valid report. A coordinated disclosure timeline can be negotiated for issues that need longer.
