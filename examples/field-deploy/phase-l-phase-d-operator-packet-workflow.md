# Phase L — Phase D Operator Packet Workflow

Phase L is the supervised workflow for turning a Phase K `candidateAllowed=true` digest into a Phase D operator decision packet. It is still a publication and approval-preparation step only: it may assemble sanitized evidence, ask for one explicit operator decision, and record the resulting packet. It must not run live `repair`, push a branch, create a timer, edit approval config on behalf of the operator, or treat Phase K candidacy as live repair approval.

## Start marker and inputs

Post `Start` in the operator ledger before reading Phase K evidence, current PR state, branch diff paths, artifact paths, or drafting the Phase D packet. Save `startCommentUrl` when the ledger returns one.

Admissible inputs:

- One Phase K `pr-shepherd-rehearsal-evidence-digest/v1` for a single target, with an embedded `pr-shepherd-phase-d-candidate-gate/v1`.
- `candidateAllowed=true`, `terminalLedgerMarker=Done`, and no stale, blocked, or deferred gate result.
- The matching Phase C/J dry-run rehearsal approval package and matching `actionLedger` entry for the current `repairKey`.
- Current PR metadata read immediately before packet publication: target id, PR URL, head branch, expected/current head/base refs, mergeability, dirty classification, and focused-check gate.
- The exact live command under consideration, normally `node pr-shepherd.mjs repair --config <config> --target <target-id>`.
- Planned branch diff paths and planned artifact evidence paths for the packet or review PR.

Do not ingest raw shell transcripts, OpenClaw session dumps, provider/chat exports, token or environment output, private host paths, or OpenClaw runtime/bootstrap context file contents.

## Workflow

Stop at the first failed gate and close with `Block` using sanitized reasons only:

1. Confirm the Phase K digest and candidate gate belong to exactly one target and current `repairKey`.
2. Re-read current PR metadata. If target, branch, head/base refs, dirty classification, or repair key changed, close `Block` or return to Phase G/H/I/J/K; do not refresh the packet by hand.
3. Verify the strict focused-check gate is present and names the checks that Phase E must run before any push.
4. Build the Phase D packet from links and summaries only: source Phase K URL, dry-run command summary, exact live argv, expected refs, allowed branch, approval scope, expiry, push budget, rollback/disable note, and abort criteria.
5. Run the contamination guard over staged/unstaged/untracked branch diff paths and planned artifact evidence paths.
6. Publish the packet for the operator decision only after the guard passes. The operator must still record a separate one-shot approval before Phase E may run live `repair`.
7. Close with exactly one terminal marker and return `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available.

## Packet contents

A Phase L-prepared Phase D packet should be short enough to audit in the ledger:

```markdown
Start: <startCommentUrl>
Phase: L preparing Phase D operator decision packet
Target: <target-id> <owner/repo#number>
Source Phase K digest: <url-or-artifact>
Candidate gate: candidateAllowed=true repairKey=<repair-key>
Current refs: head=<sha> base=<sha> branch=<head-owner>:<head-branch>
Expected refs: head=<sha> base=<sha> repairKey=<repair-key>
Current classification: dirty
Exact live argv under consideration: node pr-shepherd.mjs repair --config <config> --target <target-id>
Approval scope required: auto-safe-repair one-shot
Approval metadata required: approvalId, approvedAt, approvedBy, expiresAt, targetId, owner, repo, number, pr, headRefOid, baseRefOid, repairKey, actionClass=auto-safe-repair
Focused checks required before push: <argv list>
Push guard: --force-with-lease=<branch>:<expected-head>
Push budget: <remaining>/<window>
Abort criteria: ref drift, non-dirty PR, failed focused checks, failed/pending GitHub checks, push-budget exhaustion, dirty worktree, unsupported conflict, approval mismatch/expiry, contamination finding
Rollback/disable note: disable liveRepair after the one-shot attempt and rerun status
Evidence hygiene: no secrets, private paths, chat ids, raw transcripts, raw session dumps, or runtime/bootstrap context paths
Operator decision requested: GO one-shot Phase E / NO-GO rehearse or observe / Block
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

The packet may quote `approvalConfigTemplate.automaticActions.liveRepair` from the Phase C/K approval package, but it must leave placeholder values as placeholders until the operator explicitly supplies the one-shot approval metadata. Do not silently write those values into `config.json`.

## Runtime/bootstrap contamination guard

Before posting a `PR: <url>` marker, attaching packet evidence, or letting a runner create a review PR, fail closed if any branch diff or planned artifact evidence path would include:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only the exact repo-relative offending paths and the reason. Never paste the file contents. Existing ignored runtime/bootstrap files that are not staged, committed, or attached are not packet evidence, but they should still be named if the planned diff or artifact bundle would include them.

## Closeout markers

Close Phase L with exactly one terminal marker:

- `Done` — the Phase D packet was recorded in the operator ledger without a repository change; live repair is still not approved.
- `PR: <url>` — a sanitized documentation or packet review PR is needed, and the branch/evidence guard passed.
- `Block` — Phase K evidence is stale/mismatched, focused checks are missing, operator intent is unclear, or branch/artifact evidence is contaminated.

A successful Phase L closeout only means the operator has a Phase D packet to review. Phase E live repair still requires fresh one-shot approval metadata, focused checks, push budget, expected-head `--force-with-lease`, clean worktree checks, and another contamination guard immediately before mutation.
