<!--
Thanks for sending a patch. Keep this short; delete sections that do not apply.
See CONTRIBUTING.md for what lands easily and what needs an issue first.
-->

## What and why

<!-- One or two sentences on the user-visible change and the problem it solves. -->

Closes #

## Tests run

<!-- The exact commands you ran and their results, e.g. `./scripts/verify`: 208 tests passed. -->

## Type of change

- [ ] Bug fix in an existing tool
- [ ] New tool
- [ ] Docs
- [ ] Refactor with no tool-surface change
- [ ] Tool-surface change (rename/remove a tool, change a confirm gate or annotation) — opened an issue first per CONTRIBUTING.md

## Checklist

- [ ] `npm run typecheck`, `npm run build`, and `npm test` pass locally
- [ ] Added or updated tests covering the change
- [ ] New or changed destructive/privileged tools are `confirm: true` gated and annotated `destructiveHint`; read-only tools are annotated `readOnlyHint`
- [ ] Updated the `Tools` list and tool count in `README.md` if tools changed
- [ ] Added an `## [Unreleased]` entry to `CHANGELOG.md` for any user-visible effect
- [ ] No personal details, real hostnames, real IPs (use `192.0.2.x`), account names, API keys, or unredacted absolute paths in code, tests, docs, or this PR (the content-guard check will fail otherwise)
- [ ] Conventional commit messages, each ending with `Co-Authored-By: Claude Duet <noreply@anthropic.com>`
