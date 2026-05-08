# Phase A check-only standing operations package

This package moves PR Shepherd into standing operations for check-only monitoring. It is reversible,
no-send by default, and explicitly excludes repair, branch mutation, force-push, and production live-repair
approval.

## GO / NO-GO boundary

- **GO:** schedule `check-canary --config <pr-shepherd-repo>/config.json --target <target-id>` for one
  approved target, with dry-run/no-send notification defaults, read-only GitHub credentials, and operator-visible logs.
- **GO after observation:** add more check-only targets or an aggregate `check --all` only after the first target has
  completed the 24-48h observation window without duplicate notifications, lock contention, or state write errors.
- **NO-GO:** do not schedule or imply `repair`, `rehearse`, live force-with-lease pushes, OpenClaw branch mutation,
  provider-token handling, or production live repair. Those remain separate one-shot operator approvals.

## Preflight

1. Confirm the target config validates:
   ```bash
   node pr-shepherd.mjs validate --config config.json
   ```
2. Confirm the field package doctor is clean and read-only:
   ```bash
   npm run doctor:field-deploy
   ```
3. Confirm local notifier rendering without GitHub or state mutation:
   ```bash
   node pr-shepherd.mjs canary --config config.json --target <target-id>
   ```
4. Run one manual check-only canary before installing a schedule:
   ```bash
   PR_SHEPHERD_NOTIFY_DRY_RUN=1 \
     node pr-shepherd.mjs check-canary --config config.json --target <target-id>
   ```

Keep credentials in the operator environment or GitHub CLI auth. Do not put tokens, chat ids, private operator
paths, raw session logs, or runtime/bootstrap context file contents in config, comments, logs, or evidence bundles.

## Scheduler runbook

### systemd-style lane

Use the included template for one target at a time:

```bash
systemctl --user enable --now pr-shepherd-check-canary@<target-id>.timer
systemctl --user status pr-shepherd-check-canary@<target-id>.timer
journalctl --user -u pr-shepherd-check-canary@<target-id>.service --since -2h
```

The service command must remain equivalent to:

```bash
node <pr-shepherd-repo>/pr-shepherd.mjs check-canary --config <pr-shepherd-repo>/config.json --target <target-id>
```

### OpenClaw cron-style lane

For OpenClaw-managed scheduling, create one check-only job whose payload runs the same command and captures stdout
as operator evidence. Keep it disabled until preflight passes, then enable it for one target only:

- name: `pr-shepherd-check-canary-<target-id>`
- cadence: every 10 minutes during the first observation window
- command: `node <pr-shepherd-repo>/pr-shepherd.mjs check-canary --config <pr-shepherd-repo>/config.json --target <target-id>`
- environment: read-only GitHub auth plus `PR_SHEPHERD_NOTIFY_DRY_RUN=1`
- artifacts: scheduler stdout/stderr summary only; do not attach raw session dumps

Rollback is scheduler-only: disable the timer/job, run `status --target <target-id>`, save the sanitized summary,
and leave repair/worktrees untouched.

## First 24-48h observation template

Record this in the operator issue or incident log; keep entries short and link to sanitized command output.

| Window | Expected evidence | Outcome |
| --- | --- | --- |
| T+0 manual run | `check-canary` JSON summary, notification dry-run output, no repair command | `pass` / `block` |
| T+10m first scheduled run | one state update, no duplicate notification, no lock contention | `pass` / `block` |
| T+30m | stable classification or clear operator action, no state write errors | `pass` / `block` |
| T+24h | `status --target` shows `observationSummary.last24h`, `lastCleanAt`, `lastWarningAt`, doctor warnings, and redacted evidence | `promote` / `extend` / `rollback` |
| T+48h | `observationSummary.last48h` confirms clean/unknown/recheck/failed/dirty frequency is understood before Phase C | `promote` / `extend` / `phase-c-one-shot-rehearsal` / `rollback` |

For Phase B noise control, use the concise `status`/notification summary for Telegram or issue closeout and keep the
bounded `observationLedger` state file as detailed evidence. Duplicate no-action reports should stay cadence-limited;
failed, dirty, or repeated unknown observations should produce a specific `doctorWarnings` entry and remain check-only.

Block promotion if any evidence contains secrets, private host paths, runtime/bootstrap context contents, raw session
dumps, unexplained state corruption, lock contention that overlaps legitimate runs, or any scheduled repair command.

## State and evidence rotation checklist

- Keep `statePath`, `lockPath`, and scheduler logs per target; do not share them between PRs.
- Before rotating a state file, run `status --target <target-id>` and save the JSON summary.
- Move old state aside with an operator timestamp; do not delete it until notification dedupe and action-ledger entries
  are no longer needed for audit.
- Store evidence outside watched worktrees and publish only concise summaries with repo-relative paths where possible.
- Review every evidence bundle before attaching it to an issue or PR. If runtime/bootstrap context paths or contents,
  tokens, chat ids, or private host paths would be included, stop and post `Block` with the offending repo-relative
  path names only.
- Keep live repair disabled during rotation. Rotation must not fetch worktrees, rebase, create conflict artifacts, or push.

## One-shot live Telegram/OpenClaw reporting canary

This is optional and still check-only. It proves operator-visible delivery for one target; it does not authorize repair
or additional live reporting lanes.

1. Finish dry-run preflight and at least one manual `check-canary`.
2. Record `Start` in the operator ledger with the target id and command scope.
3. Set `notify.dryRun=false` only for the selected target and only with `notify.liveActivation.scope="check-only-reporting"`,
   approved operator metadata, and a reporting cadence of at least one hour.
4. Set the wrapper environment for one manual send, including `PR_SHEPHERD_NOTIFY_DRY_RUN=0`; keep routing and credentials
   outside the repository.
5. Run exactly one manual command:
   ```bash
   node pr-shepherd.mjs check-canary --config config.json --target <target-id>
   ```
6. Require an operator-visible receipt before treating the canary as successful. Provider send success alone is not receipt evidence.
7. Close with `Done` if receipt and hygiene checks pass, or `Block` if delivery, redaction, or policy checks fail.
8. Return to dry-run/no-send unless a separate operator decision keeps this one check-only reporting lane live.

Terminal decision: **GO for Phase A check-only standing operations; NO-GO for production live repair unless separately approved.**
