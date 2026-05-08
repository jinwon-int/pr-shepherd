# Phase E execution readiness and post-action audit runbook

Phase E is the last execution gate and audit closeout for one operator-approved PR Shepherd live repair. It turns a Phase D `GO` packet into a narrowly logged action, then proves after the action that the branch/evidence effects stayed inside the approval boundary. It is not a standing automation lane and must not install timers, broaden targets, or imply approval for a later retry.

## Scope and entry conditions

Enter Phase E only when all of these are true:

- A Phase D packet exists with `GO` for one target, approval scope `auto-safe-repair`, exact argv, expected head/base refs, allowed head branch, approving operator, and expiry.
- The target still needs the action; clean, pending, failed, merged, disabled, unknown, unsupported-conflict, or stale-rehearsal states return to Phase B/C/D instead.
- The target worktree, PR Shepherd repo, and evidence destination are known and can be audited before anything is pushed or attached.
- The branch diff and planned evidence manifest are free of OpenClaw runtime/bootstrap context paths.

If any condition is missing, do not run live `repair`; post `Block` with the sanitized missing fact.

## Start marker and readiness record

Post `Start` in the operator ledger before touching the target worktree, writing artifacts, or running live `repair`. Save `startCommentUrl` when the ledger returns one.

Use a concise readiness record:

```text
Start
Phase: E execution readiness
Target: <target-id> / <owner/repo#number>
Approved command: node pr-shepherd.mjs repair --config config.json --target <target-id>
Approval: <approval-id> / auto-safe-repair / <approved-by> / <approved-at>
Expected refs: head=<sha> base=<sha>
Allowed branch: <owner>:<branch>
Rehearsal evidence: <url or artifact reference>
Readiness checks planned: doctor, validate, status, contamination guard, live repair
Evidence hygiene: pending
Rollback note: disable live lane, keep state, no manual force-push
```

Do not paste raw session transcripts, secrets, chat ids, private host paths, or OpenClaw runtime/bootstrap context file contents into the ledger.

## Pre-action readiness checklist

Run and record only sanitized summaries:

1. Confirm the local package and field examples are still healthy:
   ```bash
   npm run doctor:field-deploy
   ```
2. Validate the exact config revision that contains the Phase D approval metadata:
   ```bash
   node pr-shepherd.mjs validate --config config.json
   ```
3. Capture current target state before mutation:
   ```bash
   node pr-shepherd.mjs status --config config.json --target <target-id>
   ```
4. Verify the planned command is exactly the approved target-specific live repair. Do not substitute `--all`, `--allow-code-assisted-push`, a different config, or manual git commands.
5. Verify the target worktree is clean and the expected branch/head/base still match the Phase D packet. If they drift, stop and return to Phase D.
6. Run the contamination guard against branch, staged, unstaged, untracked, and planned evidence paths before any PR/evidence closeout:
   ```bash
   offending_paths="$({
     git diff --name-only "${BASE_REF:-main}...HEAD" --
     git diff --name-only --cached --
     git diff --name-only --
     git ls-files --others --exclude-standard
   } | sort -u | grep -E '^(AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw(/|$))' || true)"
   if [ -n "$offending_paths" ]; then
     printf 'Block: runtime/bootstrap context path would enter branch or evidence\n%s\n' "$offending_paths"
     exit 2
   fi
   ```
   Also inspect artifact paths before attachment. Fail closed if any planned path is `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

## Live execution run sheet

Only after every readiness check passes, run the approved command once:

```bash
node pr-shepherd.mjs repair --config config.json --target <target-id>
```

Execution rules:

- Let PR Shepherd perform fetch, rebase, focused checks, remote-head revalidation, and `--force-with-lease`; do not bypass it with manual git commands.
- If PR Shepherd returns a non-repair action class, focused checks fail, the push budget is exhausted, the remote head changes, or evidence hygiene fails, stop and close as `Block`.
- Do not retry under the same Phase E record after target refs, approval metadata, command argv, or evidence changes. Start a new Phase D/E decision instead.
- Keep stdout/stderr evidence summarized. Link sanitized logs or JSON summaries; do not attach raw shell transcripts.

Append an action entry immediately after the command:

```text
Action
Target: <target-id>
Command argv: node pr-shepherd.mjs repair --config config.json --target <target-id>
Approval id: <approval-id>
Expected refs: head=<sha> base=<sha>
Result: pushed / no-op / block
Focused checks: pass / fail / not-run
Push guard: --force-with-lease=<branch>:<expected-head> / not-reached
Evidence: <sanitized link or summary>
```

## Post-action audit

Before posting `PR`, `Done`, or `Block`, verify:

- `status --target <target-id>` reflects the final state and recent `actionLedger` entry.
- Any push, if it happened, was only for the approved head branch and only through PR Shepherd's expected-head `--force-with-lease` path.
- Focused verification commands passed before push, or the run stopped before branch mutation.
- No standing repair timer, aggregate `--all` live lane, or additional target was enabled.
- Evidence contains no secrets, chat ids, private host paths, raw OpenClaw session dumps, or runtime/bootstrap context files.
- The branch diff and evidence manifest still exclude `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`.
- Rollback remains non-destructive: disable any live schedule, keep state for audit, and do not manually rebase or force-push.

Post-action audit template:

```text
Phase E audit
Target: <target-id> / <owner/repo#number>
Approval id: <approval-id>
Command result: pushed / no-op / block
Final status: <classification and next action>
Action ledger: <entry id or summary>
Branch mutation: none / approved branch only
Focused checks: pass / fail / not-run
Evidence hygiene: pass / block
Rollback posture: ready / executed / not-needed
Terminal marker: PR / Done / Block
```

## Closeout markers

Close Phase E with exactly one terminal marker:

- `PR: <url>` when a reviewable repository branch/PR was created or updated and all audit checks passed.
- `Done` when the approved execution completed or no-op'd safely and no repository PR is required.
- `Block` when readiness, execution, push, evidence hygiene, or audit checks failed closed.

Return `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when the ledger system provides them. When blocked for runtime/bootstrap contamination, report only the repo-relative offending paths and reason; never paste file contents.
