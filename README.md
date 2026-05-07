# OpenClaw PR Shepherd MVP

Small operational CLI to watch and conservatively repair `openclaw/openclaw#78261`.

## Commands

```bash
node pr-shepherd.mjs check --config config.json
node pr-shepherd.mjs readiness --config config.json
node pr-shepherd.mjs repair --config config.json --dry-run
node pr-shepherd.mjs repair --config config.json
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
- Only a conservative `CHANGELOG.md` conflict path is eligible for auto-resolution.
- Merged PRs mark state as `disabled`.

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

The CLI requires a clean worktree before mutation. Run `readiness` before an operator-approved live repair to verify the configured worktree is present, clean, not mid-rebase/merge/cherry-pick, has expected remotes, has focused checks configured, has a conservative conflict policy, has notification state suitable for dedupe, and is below the rolling auto-push limit. The command is non-mutating and exits non-zero when any readiness gate fails.

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
