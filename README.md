# OpenClaw PR Shepherd MVP

Small operational CLI to watch and conservatively repair `openclaw/openclaw#78261`.

## Commands

```bash
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json
node pr-shepherd.mjs status --config config.json --all
node pr-shepherd.mjs canary --config config.json --target openclaw-78261
node pr-shepherd.mjs check --config config.json
node pr-shepherd.mjs check --config config.json --target openclaw-78261
node pr-shepherd.mjs check --config config.json --all
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
node pr-shepherd.mjs rehearse --config config.json --target openclaw-78261
node pr-shepherd.mjs repair --config config.json --dry-run
node pr-shepherd.mjs repair --config config.json --target openclaw-78261 --dry-run
node pr-shepherd.mjs repair --config config.json --all --dry-run
node pr-shepherd.mjs repair --config config.json
node pr-shepherd.mjs repair --config config.json --artifact-dir ./artifacts --no-keep-failed-rebase-worktree
```

For backward compatibility, omitting both `--target` and `--all` runs the first configured target.
Prefer explicit target selection in automation so operator logs show whether the run was single-target
or all-target.

## Safety defaults

- For backward compatibility, omitting both `--target` and `--all` runs only the first configured target and emits a warning when multiple targets exist.
- Use `--target <id>` or `--target owner/repo#number` to narrow a run; use `--all` to process every configured target serially.
- Each target keeps its own state file and lock file, so one repo/PR cannot share repair state with another.
- Duplicate runs for the same target are blocked by that target's exclusive lock.
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
Use `check` for read-only classification and notification. Use `check-canary` when installing the
first production monitor so logs clearly show the check-only canary lane; it is an explicit alias for
the same read-only check path and does not touch the watched worktree. Use `rehearse` (or
`repair --dry-run`) to confirm a candidate repair path before allowing any git mutation. A live
`repair` run is the approval boundary: start it only after the operator has confirmed the target PR,
prepared worktree, remotes, and write permissions are correct.

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
`IDENTITY.md`, or `.openclaw/**`. PR Shepherd applies the same guard before writing conflict
artifact evidence or pushing a repaired branch.

## Production readiness commands

`validate` is read-only and fails closed before any GitHub or git mutation when config has unsafe or
ambiguous production settings. It checks target identity, required branches and paths, duplicate enabled
`statePath`/`lockPath`, positive `autoPushLimit24h`, conflict policy shape, duplicate conflict paths
across tiers, notifier mode shape, and obvious secret-looking values such as embedded tokens or
credentialed URLs.

`status` is also read-only and does not contact GitHub. It summarizes the selected target state file(s),
including disabled state, last kind, mergeability fields, last seen head/base, failure names, pending
count, recent auto-push count, and the last notification key.

Safe check-only rollout:

1. Install this repo on the operator host and configure `gh` with least privilege.
2. Prepare `config.json`; keep tokens in auth tooling or environment, not in config.
3. Run `node pr-shepherd.mjs validate --config config.json`.
4. Run `node pr-shepherd.mjs check --config config.json --all`.
5. Rehearse repair without git mutation: `node pr-shepherd.mjs rehearse --config config.json --all`.
6. Install only a check timer first, e.g. `check-canary --config <repo>/config.json --target <id>`.
7. Observe `status --all`, stdout/command notifications, and state files.
8. Enable live `repair --target <id>` only later, one target at a time, after explicit operator approval.

Notifier modes are `stdout`, `none`, or `command`. Command notifiers receive the rendered notification in
`PR_SHEPHERD_MESSAGE`; do not pass secrets in notifier arguments, and keep notification dedupe per target.

## Status classification

- `merged`: `mergedAt` exists or state is `MERGED`; notify once and disable.
- `clean`: mergeable `MERGEABLE`, merge state `CLEAN`, no failed/pending checks.
- `unstable`: mergeable `MERGEABLE`, merge state `UNSTABLE`, pending checks and no failures; no repeat notification until pending exceeds configured duration.
- `failed`: one or more failed checks; report failed check names/details; no repair.
- `dirty`: mergeable `CONFLICTING` or merge state `DIRTY`; repair candidate.

## Worktree requirement

`config.json` should point each live repair target at a dedicated prepared worktree, for example:

```text
<worktree-root>/openclaw-pr-78261
```

Before live repair, prepare the worktree with remotes:

```bash
git clone git@github.com:jinon86/openclaw.git <worktree-root>/openclaw-pr-78261
cd <worktree-root>/openclaw-pr-78261
git remote add upstream https://github.com/openclaw/openclaw.git || true
git fetch origin fix/telegram-outbound-visible-receipts
git fetch upstream main
```

The CLI requires a clean worktree before mutation. For multiple targets, configure separate
`worktreePath`, `statePath`, and `lockPath` values per PR.

## Multi-target operations

PR Shepherd can watch multiple repositories and PRs from one config by adding one object per PR to
`targets[]`. Treat every target as an isolated unit: give it a stable `id`, its own worktree, state
file, lock file, push budget, notification dedupe state, conflict policy, and focused checks.

Example shape for a second target:

```json
{
  "id": "owner-repo-123",
  "pr": "owner/repo#123",
  "owner": "owner",
  "repo": "repo",
  "number": 123,
  "headBranch": "feature/example",
  "baseBranch": "main",
  "worktreePath": "<worktree-root>/owner-repo-123",
  "statePath": "<state-root>/owner-repo-123.json",
  "lockPath": "<lock-root>/owner-repo-123.lock",
  "autoPushLimit24h": 5,
  "conflictPolicy": {
    "autoSafe": [],
    "codeAssisted": [],
    "humanOnly": ["package-lock.json"]
  },
  "focusedChecks": ["npm test"],
  "notify": { "mode": "stdout" }
}
```

Operational rules:

- Use `--target <id>` for one PR when approving a repair or investigating a specific notification.
- Use `--all` for routine checks across all enabled targets; all-target repair should normally start
  with `--dry-run` and only move to a live run after explicit operator approval.
- All-target runs are serial. A failure in one target should be reported in the aggregate result and
  must not hide later target results.
- State, lock, artifact, and notification paths must be unique per target. Do not share a state file
  or lock file between repositories or PR numbers.
- Keep `artifact-dir` outside the watched worktrees, and review artifacts before attaching them to
  issues or PRs. They must not contain secrets, private worktree paths, or OpenClaw runtime/bootstrap
  context files.
- A force push is only allowed through the existing per-target `--force-with-lease=<branch>:<head>`
  guard after the target's focused checks pass and the remote head is revalidated.

### Multi-target systemd patterns

For one timer per PR, instantiate the included template with the target id:

```bash
systemctl enable --now pr-shepherd@openclaw-78261.timer
systemctl enable --now pr-shepherd@owner-repo-123.timer
```

For a single aggregate checker, use a dedicated non-template unit whose command runs all targets:

```ini
[Service]
Type=oneshot
WorkingDirectory=<pr-shepherd-repo>
ExecStart=/usr/bin/node <pr-shepherd-repo>/pr-shepherd.mjs check --config <pr-shepherd-repo>/config.json --all
```

Keep live repair units disabled by default. When a repair is approved, prefer a one-shot command with
`--target <id>` so the operator approval, logs, state update, and force-with-lease guard are scoped to
one PR.

## Check-only deployment

Deploy routine automation with the read-only `check` command. A check run queries GitHub PR state,
updates the target state file, and emits deduplicated notifications; it does not touch the watched
worktree, rebase, write conflict artifacts, or push branches.

For a canary rollout, enable check-only automation for one low-risk target before installing aggregate
timers or allowing any repair workflow. The canary should use the same config shape, notifier, lock,
and state paths planned for production, but it should run only `check-canary --target <id>` (or the
older equivalent `check --target <id>`) with read-only GitHub credentials. Treat a quiet canary as
validation of monitoring and notification plumbing only; it is not approval to run `repair`.

Canary checklist:

1. Pick one target id and confirm its `statePath` and `lockPath` are unique and writable.
2. Run `validate`, then one manual `check --target <id>` and inspect the JSON summary plus notifier output.
3. Install `pr-shepherd@<id>.timer` using the example unit, or an equivalent scheduler whose command is
   exactly `check-canary --config <repo>/config.json --target <id>`.
4. Observe at least two timer intervals with no duplicate notifications, lock contention, or state errors.
5. Only after the canary is stable, add more check-only targets or an aggregate `--all` checker. Keep live
   `repair` disabled until a separate explicit operator approval.

Recommended check-only pattern:

```bash
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
# or, for an aggregate monitor after the canary is stable:
node pr-shepherd.mjs check --config config.json --all
```

Operational notes:

- Use a GitHub CLI token with read access for check-only timers; reserve write/push credentials for
  explicitly approved repair commands.
- Ensure each target has a writable, unique `statePath` so notification dedupe and pending-check age
  tracking survive between timer runs.
- Send stdout/stderr to journald, OpenClaw cron, or another operator log. The JSON summary line is
  intended for machine-readable run evidence.
- Do not schedule `repair` from the same timer. Keep repair as a manual one-shot approval boundary,
  starting with `repair --dry-run` when investigation is needed.

Canary rollback:

1. Disable the scheduler for the canary target, for example `systemctl disable --now pr-shepherd@<id>.timer`,
   or remove the equivalent cron/OpenClaw schedule.
2. Run `node pr-shepherd.mjs status --config <repo>/config.json --target <id>` and save the final JSON summary
   with the scheduler logs as rollback evidence.
3. Leave the target state file in place unless it contains bad dedupe data from a misconfigured run; if reset is
   needed, move it aside rather than deleting it so the old notification keys can be audited.
4. Keep live `repair` disabled. A check-only rollback must not fetch worktrees, rebase, create artifacts, or push.

Rehearsal closeout:

- Record the canary target id, config revision, scheduler command, first and last observed run times, and whether
  notifications, locks, and state updates behaved as expected.
- Confirm no duplicate notifications, lock contention, state write errors, secret-looking config values, private
  host paths, or OpenClaw runtime/bootstrap context paths appeared in logs or artifacts.
- Mark the rehearsal outcome as `promote`, `extend`, or `rollback`, and name the operator who approved the next
  step. Promotion means adding more check-only targets only; live repair still requires a separate approval.

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
Set `notify.mode=none` to keep only the final JSON status output.

Before enabling a hook in a timer, run `canary --config config.json --target <id>` to exercise the
configured notifier without contacting GitHub, writing state, touching a worktree, or mutating a branch.
Then run `check-canary --config config.json --target <id>` once manually to exercise the real read-only
GitHub/state/notification path before scheduler installation.

For notifier hooks, set `notify.mode=command` and provide an argv array:

```json
"notify": {
  "mode": "command",
  "command": ["/usr/local/bin/pr-shepherd-notify", "--channel", "ops"]
}
```

The formatted notification line is passed in the `PR_SHEPHERD_MESSAGE` environment variable. Hooks also
receive `PR_SHEPHERD_TARGET`, `PR_SHEPHERD_PR`, `PR_SHEPHERD_URL`, `PR_SHEPHERD_KIND`, and
`PR_SHEPHERD_KEY` for routing/idempotency. The notifier hook receives no stdin from PR Shepherd, and its
configured argv is executed directly without a shell. Hook failures are allowed so a flaky notifier cannot
block state updates; use the process logs or your notifier's own telemetry to alert on delivery problems.

Notifier hook requirements:

- Treat hooks as notification-only; they must not run `repair`, mutate branches, or push code.
- Keep output concise and free of secrets, private worktree paths, and OpenClaw runtime/bootstrap
  context such as `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
  `.openclaw/**`.
- Make delivery idempotent. PR Shepherd deduplicates by notification key in the target state file, but
  operators may still replay timers or rerun checks manually.
- Prefer a small wrapper script when routing to chat/email/webhooks so credentials stay outside
  `config.json` and can be managed by the host service environment.

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
