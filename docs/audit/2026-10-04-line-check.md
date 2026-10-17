# Repository audit: jellyfin-mcp (2026-10-04)

## Verdict

The baseline typecheck, 147 mocked tests, and build pass. The highest-value changes protect the shared request boundary and constrain administrative writes. This review does not establish release readiness or compatibility with a live Jellyfin server.

## Scorecard

Scores describe the starting working tree, including its existing uncommitted changes.

| Station | Score | Evidence |
| --- | --- | --- |
| Docs and onboarding | 4/5 | README documents CLI and MCP setup, but the unreleased changelog omits the new required user context. |
| Agent readiness | 4/5 | AGENTS.md defines a single verification command and mocked-only development. Code-graph test attribution is incomplete. |
| Tests and CI | 3/5 | 147 tests pass and CI covers Node 20 and 22. Request redaction, redirect policy, timer boundaries and bulk concurrency lacked regressions. |
| Hygiene | 4/5 | MIT license and ignored generated/local-state paths are present. Existing dirty changes were retained separately. |
| Structure and correctness | 3/5 | Client HTTP calls and tool registration are separated. Shared error mapping and unbounded clearing affect many tools. |
| Release hygiene | 3/5 | Declared Node minimum is below Undici's minimum. A runtime dependency is fetched from GitHub. |
| TODO and issue mining | 3/5 | Local TODO/FIXME search produced no actionable backlog. Remote issue and PR state were not checked. |

## Findings and backlog

Findings 1-5 are implemented and verified. Findings 6-8 remain follow-up work.

1. **High / small: prevent credential forwarding on redirects.** `src/client.ts` sent the then-current `X-Emby-Token` header with fetch's default redirect behavior. The installed HTTP implementation removes standard authorization headers on a cross-origin redirect but retained that custom header. The client now sends `Authorization: MediaBrowser Token=...`, and redirects are still rejected so the token never follows a redirect. Reject redirects and require the final server URL. Regressions should cover GET and POST request options without real network calls.
2. **High / small: redact parse and transport failures.** `JellyfinClient.toPublicError` returned raw causes. A mocked successful response containing malformed JSON exposed a response prefix in the parser error. Return fixed public messages without response content, query parameters or nested causes.
3. **High / small: require confirmation before running scheduled tasks.** `src/tools/tasks.ts` permits arbitrary administrative task execution without `confirm: true`. Require confirmation before calling the client and mark the operation destructive. Test refusal for absent/false confirmation and success with a mocked client.
4. **Medium / small: validate the timer's millisecond range.** `src/effect/config.ts` accepts positive finite seconds that become less than 1 ms, more than 2147483647 ms, or Infinity after conversion. Use the existing warning and default for unsafe values, preserving valid fractional seconds.
5. **Medium / small: bound Continue Watching clears.** `src/tools/userdata.ts` starts every selected write concurrently. Limit concurrent clears to four, preserve selection order, and collect successes and individual failures. This is a resource-bound defect. No claim is made about measured production rate limiting.
6. **Medium / small: correct the declared Node minimum.** `package.json` advertises Node >=20.0.0 while installed Undici requires >=20.18.1. Align manifest, lockfile root metadata and documentation in a separate compatibility change.
7. **Medium / medium: make package distribution independent of Git checkout access.** The runtime kit dependency uses a GitHub commit URL. Assess publishing it to a registry or bundling it, then verify the packed package in a clean installation environment. No dependency changes are included here.
8. **Low / small: reject empty item and user identifiers consistently.** Some tool schemas use bare strings while newer tools require nonempty values. Scope a follow-up around the relevant public schemas and their validation boundary.

## Verification

The integrated `./scripts/verify` completed with exit 0 through `brigade work verify run --target . --command ./scripts/verify --capture brigade-work`.

```text
Test Files  10 passed (10)
     Tests  168 passed (168)
```

Typecheck and build also passed. Baseline: 147 tests. The new checks first produced 10 expected failures for request handling, timeout boundaries and clearing concurrency, then 3 expected failures for scheduled-task confirmation. The corresponding focused checks passed after implementation.

An independent static review found no blocking issues. Its README summary correction was applied before the final gate. The redirect tests verify the fetch option contract with doubles. They do not exercise a real redirect server. No live Jellyfin operations were performed. The Brigade receipt is audit-only and does not score an artifact.

## Change ownership

The implementation changes `src/client.ts`, `src/effect/config.ts`, `src/tools/userdata.ts`, `src/tools/tasks.ts`, five test files (`client`, `config`, `userdata`, `annotations`, `no-confirm-contracts`), `README.md` and `CHANGELOG.md`. This report is new.

Existing changes to `CLAUDE.md`, `src/cli.ts`, `src/tools/items.ts`, `tests/cli.test.ts`, and the untracked `tests/items.test.ts` are unchanged. Existing hunks in the client, user-data tools, client tests and README were preserved before adding this implementation. No dependencies, versions or publication settings changed. Nothing was committed or pushed.

## Not checked

- Live server behavior, permissions, throughput, and version-specific endpoint compatibility.
- Remote GitHub issues, current CI results, npm publication state, or new dependency advisories.
- Clean-install behavior at the declared minimum Node version.
- An exhaustive line-by-line review of every tool.
- Complete static impact coverage: the graph query returned no attributed tests, so test owners were identified by reading the client, configuration and tool test files.

## Working-tree status at completion

The ownership section above distinguishes the implementation from preexisting edits. All changes remain uncommitted.

```text
 M CHANGELOG.md
 M CLAUDE.md
 M README.md
 M src/cli.ts
 M src/client.ts
 M src/effect/config.ts
 M src/tools/items.ts
 M src/tools/tasks.ts
 M src/tools/userdata.ts
 M tests/annotations.test.ts
 M tests/cli.test.ts
 M tests/client.test.ts
 M tests/config.test.ts
 M tests/no-confirm-contracts.test.ts
 M tests/userdata.test.ts
?? docs/audit/2026-10-04-line-check.md
?? tests/items.test.ts
```
