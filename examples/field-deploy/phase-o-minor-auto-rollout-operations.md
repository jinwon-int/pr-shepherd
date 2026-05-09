# Phase O — Minor-Auto Rollout Operations

Phase O is the operator runbook for rolling out PR Shepherd's `minor-auto-safe-repair` lane after the Phase N execution controller has been documented, reviewed, and rehearsed. It governs configuration promotion and operational evidence. It does not itself approve a live repair, widen the controller, or allow unattended broad mutation.

Use Phase O when an operator wants to enable, observe, expand, pause, or roll back `automaticActions.minorAutoRepair` across one or more targets. Each actual branch-mutating run still has to pass Phase N's single-target execution controller gates immediately before push.

## Start marker and rollout inputs

Post `Start` in the operator ledger before changing rollout state, editing config, collecting rollout evidence, or preparing a branch. Save `startCommentUrl` when the ledger returns one.

Required rollout inputs:

- The target id list and rollout tier for each target: `shadow`, `dry-run`, `single-target-live`, `paused`, or `rollback`.
- The source evidence that Phase N works for the intended repair class, such as a rehearsal packet, controller audit, or reviewable docs/config PR.
- The exact `automaticActions.minorAutoRepair` policy shape for every candidate target: `enabled`, `scope`, `actionClass`, `branchAllowlist`, `pathAllowlist`, `resolverAllowlist`, focused checks, push budget, and rehearsal freshness expectations.
- The planned operator-visible ledger, notification, state, and artifact paths for rollout evidence.
- A rollback trigger and owner for every target before any target is promoted to live minor-auto.

Do not ingest raw shell transcripts, OpenClaw session dumps, provider/chat exports, secrets, token or environment output, private host paths, or runtime/bootstrap context file contents.

## Rollout tiers

Roll out one target and one tier at a time:

1. **Shadow** — keep `automaticActions.minorAutoRepair.enabled=false`; run check/status/diagnose evidence only and verify that the candidate policy would be narrow enough. No worktree mutation, no push, and no automatic repair dispatch.
2. **Dry-run** — keep live push disabled; run rehearsal or `repair --dry-run` evidence for the exact target and repair class. Record changed paths, resolver identities, focused checks, and contamination guard output.
3. **Single-target live** — enable `automaticActions.minorAutoRepair` for exactly one target with the Phase N policy shape. The next live controller run must still post its own `Start`, pass Phase N, and close with `Done` or `Block`.
4. **Limited expansion** — promote another target only after the previous live target has a clean post-action audit or a documented no-op/block that does not indicate a policy gap. Do not batch-promote targets.
5. **Paused/rollback** — disable the minor-auto policy for the affected target, preserve state for audit, and return the target to check-only or dry-run operation.

A rollout tier is a configuration and evidence state. It is not reusable approval for future branch mutation.

## Admission gates

Phase O must fail closed before a rollout PR, config change, or terminal ledger marker when any of these are true:

- More than one target is being promoted to a higher tier in the same step.
- The target lacks explicit path and resolver allowlists, focused verification, branch protection expectations, or a positive but bounded push budget.
- The allowed path class is broader than deterministic docs/release-note/changelog-style repair, or includes source code, dependency or lock files, CI/workflow, security/auth/config, provider behavior, hidden files, binary files, generated bundles, or runtime/bootstrap context.
- Phase N rehearsal/controller evidence is stale, missing, mismatched to the target head/repair key, or not source-backed.
- Rollback ownership, pause criteria, or closeout marker handling is unclear.
- Any branch diff path or planned artifact evidence path would include OpenClaw runtime/bootstrap context paths.

## Operational sequence

Stop at the first failed gate and close with `Block` using sanitized reasons only:

1. Post `Start` and save `startCommentUrl`.
2. Identify the current rollout tier for each target and select exactly one target for this step.
3. Confirm the target's proposed policy is the narrow Phase N `minor-auto-safe-repair` shape and that no allowlist is being widened opportunistically during incident response.
4. Run read-only validation/status commands and collect only sanitized summaries.
5. If promoting beyond shadow, confirm fresh dry-run or controller evidence with exact changed paths, resolver identities, focused verification, expected refs, and contamination guard result.
6. Prepare the smallest config or docs patch needed for the rollout step. Do not commit operator host files, state directories, raw logs, credentials, chat ids, or runtime/bootstrap context.
7. Re-run verification, normally `node pr-shepherd.mjs validate --config config.json` plus the repository check/test command when code changed.
8. Run the runtime/bootstrap contamination guard over the final branch diff and planned evidence paths.
9. Publish either a review PR marker, a `Done` marker for no-repo-change operational completion, or a `Block` marker for failed gates.
10. For any live target, require a separate Phase N `Start` and controller closeout for the actual branch-mutating repair run.

## Rollout packet shape

Keep the rollout packet compact and linkable:

```markdown
Start: <startCommentUrl>
Phase: O minor-auto rollout operations
Target: <target-id>
Rollout tier: <shadow|dry-run|single-target-live|limited-expansion|paused|rollback>
Source evidence: <phase-n-rehearsal-or-audit-url>
Policy: enabled=<true|false> scope=minor-auto-safe-repair actionClass=auto-safe-repair
Branch allowlist: <branches>
Path allowlist: <paths-or-globs>
Resolver allowlist: <resolver-names>
Focused verification: <command summary and pass|fail|not-run>
Push budget: <limit and remaining>
Rollback trigger/owner: <summary>
Branch diff paths: <repo-relative paths>
Artifact evidence paths: <repo-relative paths or none>
Contamination guard: passed|blocked <repo-relative offending paths>
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Do not paste raw logs, secrets, private host paths, chat ids, raw session dumps, or runtime/bootstrap file contents. Link only to sanitized artifacts when evidence is needed.

## Runtime/bootstrap contamination guard

Before creating a rollout PR, attaching evidence, or posting a terminal marker, fail closed if any branch diff or planned artifact evidence path would include:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only the exact repo-relative offending paths and the reason. Never paste the file contents. Ignored local runtime files are acceptable only when they are not staged, committed, attached, or summarized as evidence.

## Closeout markers

Close Phase O with exactly one terminal marker:

- `PR: <url>` — a sanitized rollout documentation or config PR was created and the final branch/evidence guard passed.
- `Done` — the rollout step required no repository change and the operator ledger records the safe result.
- `Block` — any rollout, evidence freshness, verification, rollback, or contamination gate failed closed.

A successful Phase O rollout means only that one target moved one operational tier under bounded controls. It does not authorize broad minor-auto repair, multi-target mutation, allowlist expansion during execution, or a future push without a fresh Phase N controller run.
