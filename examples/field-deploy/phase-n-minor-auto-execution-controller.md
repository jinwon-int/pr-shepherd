# Phase N — Minor-Auto Execution Controller Operations

Phase N documents the controller path for PR Shepherd's built-in `minor-auto-safe-repair` lane. It is narrower than the ordinary Phase D/E live-repair path: the operator has preconfigured one target with `automaticActions.minorAutoRepair`, and the controller may execute only a deterministic, low-risk repair whose branch diff and evidence stay inside the configured allowlists.

Phase N is not a standing broad repair mode. It must not select multiple targets, bypass focused checks, repair failed or pending CI, push without the expected remote head, widen path or resolver allowlists during execution, attach raw evidence, or treat a prior human approval as reusable approval for unrelated work.

## Start marker and admission inputs

Post `Start` in the operator ledger before running the controller, refreshing state, touching a worktree, or collecting artifacts. Save `startCommentUrl` when the ledger returns one.

Required admission inputs:

- One selected target; `--all` or any multi-target live mutation remains approval-required and outside Phase N.
- Target policy with `automaticActions.minorAutoRepair.enabled=true`, `scope="minor-auto-safe-repair"`, `actionClass="auto-safe-repair"`, a matching `branchAllowlist`, explicit `pathAllowlist`, and explicit `resolverAllowlist`.
- Current PR classification is `dirty`; clean, unknown, failed, pending-check, merged, disabled, unsupported-conflict, or stale-ref targets block or return to a non-mutating lane.
- Focused verification is configured and expected to run before any push.
- A positive 24-hour push budget remains for the target.
- Fresh dry-run/rehearsal evidence exists, unless the target explicitly records `zeroRehearsalSafe=true` for a deterministic repair.
- Planned artifact evidence paths are known before execution and do not include runtime/bootstrap context paths.

## Execution controller sequence

Stop at the first failed gate and close with `Block` using sanitized reasons only:

1. Build the automatic action plan from the recorded PR state; do not choose the repair handler directly from raw GitHub fields.
2. If the ordinary live-repair Phase D/E gate passes, keep the plan in the approval-required lane. Phase N is used only when that lane is unavailable and the minor-auto gate independently passes.
3. Build the minor-auto gate preview with the exact target count, target policy, dirty classification, branch allowlist, push budget, focused-verify gate, rehearsal freshness, and runtime/bootstrap evidence guard. The changed-path gate may be marked deferred only before the worktree diff exists.
4. Dispatch only the `auto-safe-repair` handler for `lane="minor-auto-safe-repair"`, `pushAllowed=true`, `mutatesBranch=true`, and `requiresOperatorApproval=false`.
5. Re-fetch refs, prepare the repair, and run focused checks. Failed focused checks stop the controller before push.
6. Compute the exact branch diff paths and resolver identities from the prepared worktree.
7. Re-run the minor-auto gate immediately before push with the exact changed paths, conflict resolver entries, and artifact evidence paths. Save the sanitized preview/gate in state.
8. If any changed path is outside `pathAllowlist`, has a risky class, uses a resolver outside `resolverAllowlist`, or would include OpenClaw runtime/bootstrap context evidence, write a blocked audit/ledger entry, notify the operator, save state, and do not push.
9. Run the final branch contamination guard, verify the remote head still equals the expected head with `ls-remote`, and push only with `--force-with-lease=<head-branch>:<expected-head>`.
10. Record the new head in the 24-hour push budget, append a sanitized action ledger entry, write the post-action audit, notify the operator, save state, and re-check the PR.

## Hard blocks

Phase N must fail closed when any of these are true:

- More than one target is selected, or the selected target lacks the exact minor-auto policy shape.
- The PR is not currently dirty, checks are failed or pending, focused verification is missing or fails, or the push budget is exhausted.
- The head branch is absent from `branchAllowlist` when a branch allowlist is configured.
- `pathAllowlist` or `resolverAllowlist` is empty.
- Rehearsal evidence is stale and `zeroRehearsalSafe` is not explicitly true.
- Exact changed paths are unavailable at the final gate, outside the allowlist, or in a risky class such as source code, dependencies, lockfiles, CI/workflow, security/auth/config, provider behavior, hidden files, binary files, or runtime/bootstrap context.
- Resolver identity is missing, non-`autoSafe`, or outside the configured resolver allowlist.
- The remote head changed after planning, or `--force-with-lease` cannot protect the push.

## Controller closeout packet

A Phase N closeout packet should be compact and source-backed:

```markdown
Start: <startCommentUrl>
Phase: N minor-auto execution controller
Target: <target-id>
PR: <pr-url-or-owner/repo#number>
Lane: minor-auto-safe-repair
Policy: enabled=true scope=minor-auto-safe-repair actionClass=auto-safe-repair
Branch allowlist: <branches>
Path allowlist: <paths-or-globs>
Resolver allowlist: <resolver-names>
Rehearsal gate: fresh|zeroRehearsalSafe|blocked
Focused verification: <command summary and pass|fail>
Changed paths: <repo-relative paths>
Resolver identities: <path:resolver list or none>
Expected head: <sha>
Result head: <sha or none>
Push guard: force-with-lease passed|not-run|blocked
Contamination guard: passed|blocked <repo-relative offending paths>
Audit state: lastMinorAutoRepairGate=<recorded> lastPostActionAudit=<recorded>
Terminal marker: <Done|Block>
Closeout URL: <doneCommentUrl|blockCommentUrl>
```

Do not paste raw shell transcripts, secrets, private host paths, OpenClaw session dumps, provider/chat exports, or runtime/bootstrap context file contents. Link only to sanitized artifacts when evidence is needed.

## Runtime/bootstrap contamination guard

Before attaching evidence, before writing a terminal ledger packet, and immediately before any push, fail closed if any branch diff or planned artifact evidence path would include:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only the exact repo-relative offending paths and the reason. Never paste the file contents. Ignored local runtime files are allowed only when they are not staged, committed, attached, or summarized as evidence.

## Closeout markers

Close Phase N with exactly one terminal marker:

- `Done` — the controller pushed the bounded minor-auto repair safely and recorded post-action audit evidence, or it no-op'd without requiring a repository PR.
- `Block` — any admission, final changed-path, resolver, focused-check, push, or evidence-hygiene gate failed closed.

A successful Phase N closeout means only that this one target's preconfigured minor-auto controller run completed inside its allowlists. It does not enable broad live repair, multi-target mutation, retries after drift, or future patches without a new `Start` marker and fresh gates.
