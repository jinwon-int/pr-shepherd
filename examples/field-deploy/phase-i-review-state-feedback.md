# Phase I review-state feedback operations

Phase I turns GitHub review state and reviewer feedback into a small, non-mutating operator packet. It is a feedback phase: it may read `reviewDecision`, summarize review comments, and recommend a safe follow-up lane, but it must not run live `repair`, push a branch, merge a PR, create a standing timer, or treat a GitHub approval as production repair approval.

## Preconditions

- A reviewable PR, Phase H handoff, or operator issue exists and has already recorded a `Start` marker; save `startCommentUrl` before reading review feedback.
- The target id, PR URL, current head/base refs, and prior evidence link are known.
- Any review collection command is read-only. Prefer `gh pr view <url> --json reviewDecision,latestReviews,comments,statusCheckRollup,headRefOid,baseRefName,mergeStateStatus,mergeable,updatedAt` or equivalent source-backed UI inspection.
- The artifact destination is known and can be checked before attaching summaries to an issue, PR, or chat thread.

## Feedback packet

Create a concise packet that lets an operator decide what changed since the last handoff without reading raw transcripts:

1. **Target and refs:** target id, PR URL, current head SHA, base branch/SHA when known, and prior Phase G/H or review PR evidence.
2. **Review state:** `reviewDecision` (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or unavailable), latest reviewer names, review URLs when available, and whether the review predates the current head.
3. **Check/merge state:** mergeability, merge state status, failed or pending checks, and any mismatch between review state and CI state.
4. **Requested changes:** short bullets for blocking review items, affected repo-owned paths, and links to review comments. Do not paste raw session dumps or long logs.
5. **Feedback classification:** exactly one of approved-no-op, changes-requested, comments-only, stale-review, wait/recheck, or block.
6. **Safe next lane:** continue observation, update docs/code in a review PR, rerun Phase G/H, prepare a Phase C rehearsal, or escalate to human maintainer review. Any branch-mutating repair still needs fresh Phase D/E approval.
7. **Evidence hygiene:** confirm no secrets, private host paths, chat ids, raw session dumps, or OpenClaw runtime/bootstrap context contents are included.

## Decision rules

- **APPROVED:** record the approval source and current head. Approval may close a docs/config review as `Done` or support a review PR marker, but it does not authorize live repair or force-pushes.
- **CHANGES_REQUESTED:** block mutation and summarize requested changes. Either create a small follow-up patch for review or close `Block` if the requested action is unsafe or unclear.
- **COMMENTED / comments-only:** classify whether comments are blocking. Non-blocking comments may close `Done`; blocking comments behave like changes requested.
- **REVIEW_REQUIRED or unavailable:** wait/recheck. Do not advance to rehearsal or live repair based only on missing review state.
- **Stale review:** if the review predates the current head, record stale-review and re-run check/diagnose before choosing a follow-up lane.
- **Failed/pending checks:** review approval does not override CI. Keep mutation disabled until checks are clean or an operator records a separate safe plan.

## Closeout markers

Close Phase I with exactly one terminal marker:

- `PR: <url>` when a docs/code/config patch is published for review and the branch/evidence guard passed.
- `Done` when the feedback packet is recorded and no repository patch is required.
- `Block` when feedback cannot be safely summarized, review state is contradictory, or the requested follow-up is unsafe/unclear.

Save and report the matching `prUrl`, `doneCommentUrl`, or `blockCommentUrl` alongside `startCommentUrl` when available.

## Fail-closed contamination guard

Before posting `PR: <url>` or attaching a feedback packet, inspect the branch diff, staged/unstaged/untracked files, and planned artifact paths. Fail closed if any OpenClaw runtime/bootstrap context path would be committed or attached. Report only repo-relative path names and the blocking reason.

Block on exact matches for:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Do not paste the contents of those files into the ledger, review summary, or artifact evidence.

## Operator template

```markdown
Start: <startCommentUrl>
Target: <target-id> / <owner/repo#pr>
Review PR or evidence: <url>
Current refs: head=<sha-or-unknown>, base=<branch-or-sha-or-unknown>
Review decision: <APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|unavailable>
Latest reviews: <reviewer/status/url bullets>
Checks/merge state: <clean|pending|failed|dirty|unknown>
Requested changes: <blocking bullets or "none">
Feedback classification: <approved-no-op|changes-requested|comments-only|stale-review|wait/recheck|block>
Safe next lane: <continue observation|follow-up PR|rerun Phase G/H|Phase C rehearsal candidate|human maintainer review|block>
Evidence hygiene: no secrets, private paths, raw session dumps, or runtime/bootstrap context paths
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Phase I is feedback handling only. It does not carry review approval into live repair, does not merge on behalf of the operator, and does not weaken the Phase D/E one-shot approval, focused-check, push-budget, expected-head, or `--force-with-lease` gates.
