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
npm run doctor:field-deploy
npm run proof:sandbox
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

## Automatic action operating model

PR Shepherd separates automatic observation from operator-approved mutation. Routine automation should
run only read-only commands from a scheduler, while every command that can touch a worktree or branch is
kept as an explicit, logged, one-shot operator action. Before promoting repair mechanics, use the
[sandbox repair proof operating procedure](examples/sandbox-repair-proof.md) for the disposable proof
sequence and go/no-go criteria.

Automatic scheduler lanes:

- `validate`: local config validation only; use it before rollout and after every config change.
- `status`: local state summary only; safe for audits and rollback evidence.
- `canary`: notifier rendering and delivery smoke test only; it does not contact GitHub or update target state.
- `check` / `check-canary`: GitHub PR classification, target state updates, and deduplicated notifications only.

Commands that require operator approval:

- `rehearse` and `repair --dry-run`: allowed after an operator asks for investigation; they may prepare repair
  evidence but must not push.
- live `repair`: allowed only after the operator names the target PR, confirms write credentials and worktree
  readiness, and accepts the expected branch mutation. Prefer `--target <id>`; avoid all-target live repair unless
  a single approval explicitly covers every listed target.

Roll out in this order: validate the config, run a local notifier canary, run one manual `check-canary`, install
one check-only timer for one target, observe at least two intervals, then add more check-only targets. Promotion
never grants repair approval; repair remains a separate one-shot decision. Check-only runs append a bounded
`observationLedger` in the target state and keep a 24h/48h `observationSummary` so operators can see clean,
unknown/recheck, failed, and dirty frequency without branch mutation or raw log attachment.

Rollback is non-destructive: disable the scheduler, run `status` for final evidence, keep or move aside state for
audit, and leave repair/worktrees untouched. Do not rebase, write artifacts, or push as part of rollback. `status`
and `status --all` are the preferred observation closeout views because they include `recentRunAt`, `lastCleanAt`,
`lastWarningAt`/`lastWarningKind`, `doctorWarnings`, and `nextRecommendedAction` in addition to the sanitized
observation/action summaries.

Approval and evidence boundaries are fail-closed. Logs, notifications, PR comments, and artifacts should identify
the command, target id, operator approval, and result, but must not include secrets, private host paths, or
OpenClaw runtime/bootstrap context files. If those files would enter a branch diff or evidence bundle, stop before
PR creation and report the repo-relative offending paths.

## Approval/action ledger operating procedure

Use an append-only ledger in the operator issue, PR thread, or incident record for every PR Shepherd run that may
lead to branch or evidence mutation. The ledger is the audit trail for what was approved, what ran, and what
happened; do not replace it with raw shell history or unsanitized session logs.

Ledger entries should be short, linkable, and ordered:

1. **Start**: post `Start` before work begins. Include the target issue/PR, target id, intended command or doc/code
   scope, actor, and timestamp when the ledger system supports it. Save the resulting `startCommentUrl`.
2. **Approval**: before any live `repair`, record the approving operator, target PR, allowed branch, command argv,
   approval scope, approval time, and the rehearsal/evidence link that justifies the action. Approval must be
   one-shot and target-specific unless it explicitly names every covered target.
3. **Action**: when a command runs, record the sanitized argv, actor, target id, expected head/base refs when
   relevant, start/end time, result, and evidence links. Redact secrets and replace private host paths with stable
   labels such as `<worktree-root>` or `<state-root>`.
4. **Closeout**: finish with exactly one terminal marker:
   - `PR: <url>` when a reviewable branch/PR was created.
   - `Done` when no PR is required and the requested safe action completed.
   - `Block` when the run failed closed or needs human input.
   Save and report the matching `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available.

Before posting `PR` or attaching evidence, run a fail-closed contamination check against the branch diff and any
planned artifact bundle. If any OpenClaw runtime/bootstrap context path would be committed or attached, stop,
post `Block`, and report the exact repo-relative path(s), including matches for `AGENTS.md`, `SOUL.md`, `USER.md`,
`TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`. Do not include the contents of those files in the
ledger; path names and the blocking reason are enough.

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

Automatic action planning is explicit and fail-closed. `check`/`check-canary` may refresh state and notify,
`rehearse`/`repair --dry-run` records recent rehearsal evidence without branch mutation, and conflict handling
plans either deterministic `autoSafe` repair or artifact/escalation. Live branch mutation is blocked unless
target-level `automaticActions.liveRepair` is explicitly enabled with `scope="auto-safe-repair"`, `approvalId`,
`approvedAt`, `approvedBy`, a `branchAllowlist` containing the PR head branch, recent matching rehearsal evidence, the existing push budget,
and the existing expected-head/`--force-with-lease` checks. Maintainer-owned head branches remain blocked unless
that boundary is explicitly acknowledged with `allowMaintainerOwnedBranches=true`. Live `repair` against multiple
selected targets is blocked before GitHub/worktree access unless config-level `automaticActions.multiTargetLiveRepair`
is enabled with `scope="multi-target-auto-safe-repair"`, approval metadata, and `targetIds` naming every selected target.

### Action-class executor operating procedure

Treat the action-class executor as a narrow dispatch layer from a recorded plan to a single approved effect:

1. Build or load the automatic action plan first; do not choose handlers from raw PR state. The plan's
   `actionClass`, `allowed`, `pushAllowed`, `mutatesBranch`, `writesArtifact`, and `requiresOperatorApproval`
   fields are the execution contract.
2. If the plan is `block` or `allowed=false`, stop before invoking any handler. Record the blocked reasons and
   post the terminal `Block` ledger marker when this is an operator-run task.
3. Dispatch only to the handler registered for the exact action class:
   - `recheck`: refresh state or retry ambiguous GitHub data; no branch or artifact mutation.
   - `notify-escalate`: send the deduplicated operator notification only.
   - `repair-rehearsal`: collect dry-run repair evidence and update rehearsal state; do not push.
   - `conflict-artifact`: write sanitized conflict evidence for operator review; do not push.
   - `auto-safe-repair`: run only after live repair approval gates pass, focused checks pass, and the
     expected remote head is still protected by `--force-with-lease`.
   - `block`: terminal policy denial; no handler should mutate anything.
4. Before any handler writes an artifact or mutates a branch, run the contamination check for the planned diff
   and evidence bundle. Fail closed if OpenClaw runtime/bootstrap context paths would be included.
5. Append a sanitized `actionLedger` entry with the action class, target, approval metadata, expected refs or
   repair key, result, and evidence links. Do not store raw shell transcripts, secrets, private host paths, or
   runtime/bootstrap context file contents.

When preparing code-assisted patches for this repository, also keep OpenClaw runtime/bootstrap context
out of branch diffs and evidence. Fail closed before PR creation if any of these repo-relative paths
would be committed or attached: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
`IDENTITY.md`, or `.openclaw/**`. PR Shepherd applies the same guard before writing conflict
artifact evidence or pushing a repaired branch.

## Sandbox repair proof harness

Run `npm run proof:sandbox` before enabling any production live repair lane. The harness builds disposable local
bare remotes and a worktree, fakes `gh pr view` with a dirty sandbox PR state, runs `rehearse`, then runs the gated
live `repair` path only against the local sandbox branch. It proves the deterministic `CHANGELOG.md` autoSafe
resolver, focused checks, expected remote-head verification, and the existing `--force-with-lease` push path without
touching `openclaw/openclaw` branches or sending provider notifications. The sanitized proof JSON is written to
`state/sandbox-proof-artifacts/sandbox-repair-proof.json` by default; override with
`PR_SHEPHERD_SANDBOX_ARTIFACT_DIR` when collecting evidence outside the repository.

## Production readiness commands

`validate` is read-only and fails closed before any GitHub or git mutation when config has unsafe or
ambiguous production settings. It checks target identity, required branches and paths, duplicate enabled
`statePath`/`lockPath`, positive `autoPushLimit24h`, conflict policy shape, duplicate conflict paths
across tiers, notifier mode shape, and obvious secret-looking values such as embedded tokens or
credentialed URLs.

`status` is also read-only and does not contact GitHub. It summarizes the selected target state file(s),
including disabled state, last kind, mergeability fields, last seen head/base, failure names, pending
count, recent auto-push count, the last notification key, and a concise recent action-ledger summary.
The ledger is stored in state as `actionLedger` entries with approval id/operator/scope, expected
head/base or repair key, action class, result, and rollback/disable notes; duplicate entry ids are not
appended on replay, and ledger values are sanitized for secrets and configured private operator paths.

Safe check-only rollout:

1. Install this repo on the operator host and configure `gh` with least privilege.
2. Prepare `config.json`; keep tokens in auth tooling or environment, not in config.
3. Run `node pr-shepherd.mjs validate --config config.json`.
4. Run `node pr-shepherd.mjs check --config config.json --all`.
5. Rehearse repair without git mutation: `node pr-shepherd.mjs rehearse --config config.json --all`.
6. Install only a check timer first, e.g. `check-canary --config <repo>/config.json --target <id>`.
7. Observe `status --all`, stdout/command notifications, and state files.
8. Enable live `repair --target <id>` only later, one target at a time, after explicit operator approval.

Notifier modes are `stdout`, `none`, `command`, or `openclaw`. Command/OpenClaw notifiers receive the rendered
notification in `PR_SHEPHERD_MESSAGE`; do not pass secrets in notifier arguments, and keep notification dedupe per target.
Live `openclaw` delivery (`dryRun=false`) is fail-closed unless the target config includes
`notify.liveActivation` with `scope="check-only-reporting"`, `approvedAt`, and `approvedBy`, and the
live situation-report cadence is at least one hour. Use `canary` for one-shot sends; live activation
must remain check-only and must not imply repair/push approval.

## Field deployment, rollback, and first Telegram canary

Use a staged field rollout: validate config, prove read-only monitoring, prove Telegram delivery, then
promote only more check-only monitoring. Live `repair` remains a separate one-shot operator approval.

Field deployment sequence:

0. Run `npm run doctor:field-deploy` locally. The doctor is read-only: it validates the field deployment
   example package and selected canary config without contacting GitHub, sending messages, touching worktrees,
   creating artifacts, or scheduling services.
1. Install the repository on the operator host with Node.js 20+, `git`, and authenticated `gh`.
2. Keep credentials and Telegram/OpenClaw routing in the service environment or wrapper, not in
   `config.json` or checked-in unit files.
3. Configure one target with unique `worktreePath`, `statePath`, and `lockPath`; use read-only GitHub
   credentials for the first monitor.
4. Run `node pr-shepherd.mjs validate --config config.json` and fix every warning/error before scheduling.
5. Run `node pr-shepherd.mjs canary --config config.json --target <id>` to exercise the notifier without
   contacting GitHub or writing target state.
6. Run `node pr-shepherd.mjs check-canary --config config.json --target <id>` once manually and save the
   JSON summary plus wrapper logs as deployment evidence.
7. Enable only the check-only timer, for example `systemctl enable --now pr-shepherd@<id>.timer`.
8. Observe at least two intervals before adding targets. Promotion means more `check`/`check-canary`
   coverage only; do not schedule `repair`.

First Telegram canary procedure:

1. Configure `notify.mode=openclaw` with `dryRun=true` and run `canary`; confirm the rendered message is
   safe, concise, and contains no secrets or private host paths.
2. Switch to `dryRun=false` only after the operator-owned wrapper is installed and the config records
   `notify.liveActivation` with `scope="check-only-reporting"`, `approvedAt`, and `approvedBy`. The wrapper
   should read Telegram/OpenClaw tokens, chat ids, and routing from its environment and receive the rendered
   report in `PR_SHEPHERD_MESSAGE`. Keep `situationReportEveryMs` at one hour or more for live delivery.
3. Re-run `canary --target <id>` and confirm exactly one Telegram message arrives for the chosen target.
4. Run one manual `check-canary --target <id>` to verify the real read-only GitHub/state path sends the
   expected situation report and does not duplicate messages.
5. Capture the target id, config revision, wrapper version, observed Telegram delivery time, and final
   JSON summary. Do not include tokens, chat ids, private paths, or runtime/bootstrap context files in
   the evidence.

Rollback is intentionally simple and non-destructive:

1. Disable the scheduler, for example `systemctl disable --now pr-shepherd@<id>.timer`, or remove the
   equivalent cron/OpenClaw schedule.
2. Run `node pr-shepherd.mjs status --config config.json --target <id>` and save the final JSON summary
   with scheduler/wrapper logs.
3. Leave the state file in place for audit unless it contains bad dedupe state; if resetting is required,
   move it aside rather than deleting it.
4. Keep live `repair` disabled and leave worktrees untouched. A rollback must not rebase, write conflict
   artifacts, or push branches.

### Operator doctor procedure

Use the doctor procedure when installing PR Shepherd on a new host, after changing `config.json`, or when
the scheduler/notifier looks unhealthy. It is a read-only health check sequence assembled from existing
commands; it is not approval to run `repair`.

Run the checks in this order and save only sanitized summaries:

```bash
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json --all
node pr-shepherd.mjs canary --config config.json --target <id>
node pr-shepherd.mjs check-canary --config config.json --target <id>
```

Doctor pass criteria:

- `validate` exits successfully with no unsafe target, notifier, path, duplicate lock/state, or secret-looking
  config findings.
- `status --all` can read every enabled target state file or clearly reports the missing state for a first run.
- `canary` renders the notifier payload without contacting GitHub, writing target state, touching a worktree,
  or sending live Telegram/OpenClaw traffic unless a check-only live activation is already approved.
- `check-canary` can read the selected GitHub PR, update only that target's state/lock files, and emit at most
  one deduplicated situation report.

If any doctor step fails, stop the rollout, keep timers disabled, and post `Block` with the failing command,
target id, exit code, and sanitized log link. Do not attach raw shell transcripts. Before sharing doctor evidence
or creating a PR from a field run, verify that no branch diff or artifact bundle includes secrets, private host
paths, or OpenClaw runtime/bootstrap context paths such as `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
`HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`; path names are enough for a block report.

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

Hardening checklist for fleet operators:

- Treat `autoPushLimit24h`, recent repair failure keys, and notification cadence as per-target budgets.
  A noisy or exhausted target should not suppress checks, summaries, or notifications for another PR.
- Configure `staleLockMs` only after confirming the scheduler cannot leave legitimate long-running
  repairs behind; stale-lock cleanup must be scoped to that target's lock file.
- Rotate or archive state one target at a time. Before moving a state file, capture `status --target <id>`
  so cooldowns, dedupe keys, and action-ledger entries are not lost accidentally.
- Use `status --all` as the operator summary for mixed fleets: it should show each target's current
  kind, failed/pending check counts, recent push budget, notification key, and action-ledger summary.
- Keep live repair target-specific by default. If an operator approves a rare all-target live repair,
  the approval record must name every covered target and branch before the command starts.

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

Every `check`/`check-canary` run can emit a concise PR situation report suitable for Telegram/OpenClaw
routing. Reports include the target id, repo/PR, classification, mergeable and merge-state values,
failed/pending check counts, the most recent repair/rehearsal summary when recorded, and a clear next
action. Healthy reports explicitly say `현재 조치할 것 없음 / no action needed`; dirty/failed/unknown
states highlight the operator action or approval boundary instead of implying that automation pushed.

Noise control is per target. `notify.situationReportEveryMs` defaults to six hours, sends the first
observed situation immediately, and still sends immediate reports when the situation key changes (for
example clean → failed or failed → clean). Set it to `0` for every scheduled check to produce a report;
use a larger value for quieter periodic summaries.

Before enabling a hook in a timer, run `canary --config config.json --target <id>` to exercise the
configured notifier without contacting GitHub, writing state, touching a worktree, or mutating a branch.
Then run `check-canary --config config.json --target <id>` once manually to exercise the real read-only
GitHub/state/notification path before scheduler installation.

For generic notifier hooks, set `notify.mode=command` and provide an argv array:

```json
"notify": {
  "mode": "command",
  "command": ["/usr/local/bin/pr-shepherd-notify", "--channel", "ops"],
  "situationReportEveryMs": 21600000
}
```

For OpenClaw/Telegram operations, prefer `notify.mode=openclaw`. It is a dry run unless `dryRun` is
explicitly set to `false`; live mode still only executes an operator-owned argv wrapper and never stores
Telegram bot tokens, Gateway tokens, chat ids, or recipient routing in `config.json`:

```json
"notify": {
  "mode": "openclaw",
  "dryRun": true,
  "situationReportEveryMs": 0
}
```

After the canary and wrapper are approved by the operator, switch to a live host wrapper that reads all
credentials and Telegram/OpenClaw routing from the service environment, not this repository:

```json
"notify": {
  "mode": "openclaw",
  "dryRun": false,
  "command": ["/usr/local/bin/pr-shepherd-openclaw-notify"],
  "situationReportEveryMs": 21600000
}
```

The formatted notification line is passed in the `PR_SHEPHERD_MESSAGE` environment variable. Hooks also
receive `PR_SHEPHERD_TARGET`, `PR_SHEPHERD_PR`, `PR_SHEPHERD_URL`, `PR_SHEPHERD_KIND`,
`PR_SHEPHERD_KEY`, and `PR_SHEPHERD_NOTIFY_MODE` for routing/idempotency. The notifier hook receives no
stdin from PR Shepherd, and its configured argv is executed directly without a shell. Hook failures are
allowed so a flaky notifier cannot block state updates; use the process logs or your notifier's own
telemetry to alert on delivery problems.

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
- `examples/field-deploy/pr-shepherd-check-canary@.service.example`
- `examples/field-deploy/pr-shepherd-check-canary@.timer.example`

For Telegram/OpenClaw situation-report packaging, see `examples/field-deploy/`. It includes a
no-send-by-default wrapper that consumes `PR_SHEPHERD_MESSAGE` / `PR_SHEPHERD_*` environment values,
a config `notify` fragment for full reports on every 10-minute check, a Phase A standing-operations
runbook with state/evidence rotation and 24-48h observation templates, a final live-readiness
GO/NO-GO package, and a reversible user-systemd canary install sketch. Keep the copied env file and
Telegram routing/token files outside this repo.

A systemd timer should use the CLI lock; overlapping timers fail closed.

## Repository packaging

This repository is intentionally dependency-light. Runtime requirements:

- Node.js 20+
- `git`
- GitHub CLI `gh` authenticated with read access to the watched PR and write access only when live repair/push is explicitly approved
- `pnpm` only inside the watched OpenClaw worktree for focused verification

CI in this repository only runs syntax and unit fixture tests. It does not access GitHub PR state or push branches.
