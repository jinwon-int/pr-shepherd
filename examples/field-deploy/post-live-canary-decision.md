# Ops decision record: post-live-canary reporting activation

- Date: 2026-05-08
- Scope: `openclaw-78261` check-only canary lane
- Decision: allow limited live situation reporting for the canary target only.

## Observation summary

The live canary is considered ready for limited reporting only after operators confirm all of the
following from a manual `canary` and one manual `check-canary --target openclaw-78261` run:

- Exactly one operator-visible report is delivered for each manual live exercise.
- The report is concise, names the PR/target/classification, and includes a clear next action.
- The state file records notification dedupe keys without duplicate sends on replay.
- Scheduler, wrapper, and PR Shepherd logs contain no secrets, chat ids, private host paths, or
  OpenClaw runtime/bootstrap context files.
- `repair` remains disabled and no worktree, branch, or artifact mutation occurs.

## Activation boundary

Limited live reporting may run only through the check-only timer:

```bash
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
```

Use `notify.mode=openclaw`, an operator-owned wrapper, `notify.dryRun=false`, and
`PR_SHEPHERD_NOTIFY_DRY_RUN=0` only on the operator host. Keep all routing and credentials outside this
repository. Do not enable aggregate reporting, additional targets, or any `repair` command under this
decision.

## Rollback trigger

Disable the `pr-shepherd-check-canary@openclaw-78261.timer` schedule and return to dry-run if any live
report is duplicated, missing, misleading, leaks sensitive context, or if the wrapper exits non-zero.

## Required evidence hygiene

Evidence may include the sanitized JSON summary, scheduler status, and wrapper delivery metadata. It must
not include raw OpenClaw session dumps, runtime/bootstrap context files, credentials, chat ids, or private
operator paths.
