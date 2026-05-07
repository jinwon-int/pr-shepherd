# OpenClaw PR Shepherd MVP

Small operational CLI to watch and conservatively repair `openclaw/openclaw#78261`.

## Commands

```bash
node pr-shepherd.mjs check --config config.json
node pr-shepherd.mjs repair --config config.json --dry-run
node pr-shepherd.mjs repair --config config.json
node pr-shepherd.mjs repair --config config.json --artifact-dir ./artifacts --no-keep-failed-rebase-worktree
```

## Safety defaults

- State file: `/root/.openclaw/state/pr-shepherd/78261.json`
- Lock file: `/tmp/pr-shepherd-78261.lock`
- Duplicate runs are blocked by an exclusive lock.
- Auto pushes are limited to 5 per rolling 24h.
- Push uses only `git push --force-with-lease=<branch>:<expected-remote-head>`.
- The CLI refuses to push if the remote head changed after fetch.
- CI failures are reported, never auto-fixed.
- Complex conflicts are escalated.
- Conflict handling is tiered by target `conflictPolicy`:
  - `autoSafe`: deterministic resolvers only; focused checks must pass before the existing `--force-with-lease` push path runs.
  - `codeAssisted`: PR-owned/source conflicts are diagnosed and written to an artifact, but push is blocked by default unless an operator explicitly approves assisted follow-up.
  - `humanOnly`: lockfiles, broad generated/security-sensitive files, unlisted paths, or unrelated subsystems stop immediately for manual handling.
- Merged PRs mark state as `disabled`.

## Code-assisted operations and approval gates

PR Shepherd is intended to assist a human operator, not to make broad autonomous code changes.
Use `check` for read-only classification and notification, and use `repair --dry-run` to confirm a
candidate repair path before allowing any git mutation. A live `repair` run is the approval boundary:
start it only after the operator has confirmed the target PR, prepared worktree, remotes, and write
permissions are correct.

A live repair still fails closed unless every gate below passes:

- the target is classified as `dirty`; clean, failed, pending, merged, disabled, or unknown states are not repaired
- the 24-hour auto-push limit has not been reached, and the same head/base repair did not already fail
- the configured worktree exists, is clean, and can fetch the expected origin/upstream refs
- rebase conflicts are either absent or limited to the configured known-safe `CHANGELOG.md` conflict
- all focused verification commands pass before any push is attempted
- the remote head still matches the fetched head immediately before push
- the push uses `--force-with-lease` against that exact expected remote head

Unsupported conflicts, CI failures, stale remotes, dirty worktrees, repeated repair failures, or exhausted
push budgets are notification-only outcomes that require human intervention.

When preparing code-assisted patches for this repository, also keep OpenClaw runtime/bootstrap context
out of branch diffs and evidence. Fail closed before PR creation if any of these repo-relative paths
would be committed or attached: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
`IDENTITY.md`, or `.openclaw/**`.

## Status classification

- `merged`: `mergedAt` exists or state is `MERGED`; notify once and disable.
- `clean`: mergeable `MERGEABLE`, merge state `CLEAN`, no failed/pending checks.
- `unstable`: mergeable `MERGEABLE`, merge state `UNSTABLE`, pending checks and no failures; no repeat notification until pending exceeds configured duration.
- `failed`: one or more failed checks; report failed check names/details; no repair.
- `dirty`: mergeable `CONFLICTING` or merge state `DIRTY`; repair candidate.

## Worktree requirement

`config.json` currently points to:

```text
/root/.openclaw/workspace/openclaw-pr-78261
```

Before live repair, prepare the worktree with remotes:

```bash
git clone git@github.com:jinon86/openclaw.git /root/.openclaw/workspace/openclaw-pr-78261
cd /root/.openclaw/workspace/openclaw-pr-78261
git remote add upstream https://github.com/openclaw/openclaw.git || true
git fetch origin fix/telegram-outbound-visible-receipts
git fetch upstream main
```

The CLI requires a clean worktree before mutation.

## Focused verification

After successful rebase the CLI runs:

```bash
pnpm test extensions/telegram/src/channel.message-adapter.test.ts extensions/telegram/src/outbound-adapter.test.ts extensions/telegram/src/telegram-outbound.test.ts src/channels/message/outbound-bridge.test.ts
pnpm plugin-sdk:api:check
pnpm check:no-conflict-markers
git diff --check
```

Optional:

```bash
pnpm check:test-types
```

If optional type checks fail due missing/stale dependencies, the CLI runs `pnpm install --frozen-lockfile` once and retries.

## Notification integration

MVP default is `notify.mode=stdout` so OpenClaw cron/systemd can capture output and route summaries.

For later integration, set:

```json
"notify": {
  "mode": "command",
  "command": ["/path/to/notifier"]
}
```

The message is passed as `PR_SHEPHERD_MESSAGE`. The notifier must not print secrets.

## Suggested timer

Run `check` every 5-10 minutes. Run `repair --dry-run` or live `repair` only after the worktree is prepared and operator policy is confirmed.

Example unit files are included but not installed:

- `pr-shepherd@.service.example`
- `pr-shepherd@.timer.example`

A systemd timer should use the CLI lock; overlapping timers fail closed.

## Repository packaging

This repository is intentionally dependency-light. Runtime requirements:

- Node.js 20+
- `git`
- GitHub CLI `gh` authenticated with read access to the watched PR and write access only when live repair/push is explicitly approved
- `pnpm` only inside the watched OpenClaw worktree for focused verification

CI in this repository only runs syntax and unit fixture tests. It does not access GitHub PR state or push branches.
