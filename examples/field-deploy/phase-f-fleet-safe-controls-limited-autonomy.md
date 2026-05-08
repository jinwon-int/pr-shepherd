# Phase F fleet-safe controls and limited autonomy policy

Phase F is the standing policy for operating PR Shepherd across more than one target after the Phase A-E gates are documented. It permits bounded, observable automation for checks, notifications, and dry-run evidence, but it does not create a standing live repair lane. Every branch-mutating `repair --target <id>` remains a one-shot Phase D/E approval with its own target, refs, command argv, operator, expiry, and post-action audit.

## Scope and entry conditions

Enter Phase F only when all of these are true:

- Phase A/B check-only operations have produced stable, readable state for the first target and any added target has an owner, PR, state path, lock path, cadence, and rollback owner.
- Phase C/D/E runbooks are available for one-shot rehearsal, operator approval, live execution readiness, and post-action audit.
- `npm run doctor:field-deploy` and `node pr-shepherd.mjs validate --config config.json` pass for the selected fleet config, or documented warnings are non-blocking and do not weaken mutation controls.
- Branch diffs and planned evidence manifests exclude OpenClaw runtime/bootstrap context paths: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`.
- The operator has named the allowed autonomy tier for each target and a fleet-wide maximum tier. Unspecified targets default to F0 observe-only.

If any condition is missing, keep the target out of the fleet lane and close the ledger with `Block`.

## Limited autonomy tiers

Use the lowest tier that does the job:

- **F0 observe-only:** manual `validate`, `status`, `canary`, `check`, or `check-canary`. No scheduled sends, no artifacts, no branch mutation.
- **F1 check-only reporting:** scheduled check-only runs and deduplicated operator notifications. Notifications may be dry-run or separately approved live check-only reporting. No artifacts beyond sanitized state/log summaries and no branch mutation.
- **F2 dry-run evidence:** one target at a time may run `rehearse --target <id>` or write sanitized conflict/rehearsal artifacts after Phase C entry checks. No pushes, no maintainer-branch mutation, and no `--allow-code-assisted-push`.
- **F3 one-shot live repair:** one Phase D/E-approved `repair --target <id>` may run once under the approved argv, expected refs, branch allowlist, focused checks, push budget, and `--force-with-lease` guard. Approval expires after the run, no-op, block, target drift, command drift, or evidence drift.
- **F4 prohibited:** standing live repair timers, aggregate live `repair --all`, unattended force-pushes, automatic expansion from one target to a fleet, or code-assisted pushes without a separate explicit operator approval are not allowed by this policy.

Fleet automation must fail closed when a target asks for a higher tier than its approval permits.

## Fleet-safe controls

Before adding or promoting a target, record these controls in the operator ledger:

- target id, repo/PR, owner, configured autonomy tier, scheduler cadence, state path, lock path, and rollback owner
- exact commands allowed for the target; use `check-canary --target <id>` for standing lanes and reserve `repair --target <id>` for Phase D/E one-shots
- per-target and fleet-wide concurrency limits; start with one target and one running action, then expand only after a clean observation window
- push budget posture; default live push budget is zero unless a Phase D/E one-shot approval raises it for one target
- notification posture; default no-send or dry-run until live check-only reporting is separately approved
- evidence retention and sanitization owner; store raw logs outside public evidence and post only summaries or links that have passed hygiene checks
- rollback path; disable schedules first, preserve state for audit, and do not manually rebase or force-push as rollback

Do not let fleet orchestration bypass per-target locks, state files, notification dedupe, expected-head validation, focused checks, or the runtime/bootstrap contamination guard.

## Start marker and fleet policy record

Post `Start` before enabling, widening, or promoting any fleet lane. Save `startCommentUrl` when the ledger returns one.

Use a concise record:

```text
Start
Phase: F fleet-safe controls
Fleet scope: <target ids or config revision>
Maximum autonomy tier: F0/F1/F2/F3
Standing commands: <exact check-only argv per target>
One-shot repair policy: Phase D/E required per target, no standing repair
Concurrency: target=<n> fleet=<n>
Notification posture: dry-run / live check-only approved by <approval-id>
Evidence hygiene: contamination guard pending
Rollback: disable schedules, preserve state, no manual force-push
```

## Promotion, expansion, and rollback rules

- Promote one dimension at a time: add one target, reduce noise, or raise one target by one tier. Do not add targets and increase autonomy in the same change.
- Require a fresh `status --target <id>` summary before every promotion and after every rollback.
- Keep `--all` to read-only or check-only contexts unless a human has explicitly named every target and the command still cannot mutate branches.
- When a target becomes dirty, failed, unknown, or noisy, freeze promotions for that target until the ledger shows the next action and operator owner.
- If any target blocks on evidence hygiene, approval drift, branch drift, lock contention, duplicate sends, or unexpected mutation intent, stop the affected lane first and then evaluate whether to pause the fleet.

## Contamination guard before evidence or PR closeout

Before attaching artifacts, posting `PR: <url>`, or asking a runner to create a review PR, inspect the branch diff, staged/unstaged/untracked files, and planned artifact paths. Fail closed if any path matches:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only repo-relative offending paths and the blocking reason. Do not paste file contents, raw session dumps, tokens, chat ids, private host paths, or raw fleet logs into the ledger.

## Closeout markers

Close Phase F changes with exactly one terminal marker:

- `Done` when the fleet policy/control update completed and no reviewable repository patch is required.
- `PR: <url>` when a docs/code/config patch should be reviewed before the policy is used.
- `Block` when controls are missing, the requested autonomy exceeds policy, validation fails, or evidence hygiene fails closed.

Return `startCommentUrl` plus `doneCommentUrl`, `prUrl`, or `blockCommentUrl` when the ledger system provides them. A successful Phase F closeout does not approve future live repair; every branch-mutating repair still starts again at Phase D/E for one target.
