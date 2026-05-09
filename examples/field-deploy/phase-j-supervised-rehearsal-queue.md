# Phase J — Supervised Rehearsal Queue and Dry-Run Packet

Phase J converts a recorded Phase I `pr-shepherd-review-state-feedback/v1` decision into a supervised rehearsal queue entry. It is a scheduling and evidence step only: it may prepare a `rehearse` / `repair --dry-run` packet for a human operator, but it must not run live `repair`, push, create standing timers, or treat review approval as live repair approval.

## Start marker and source evidence

Post `Start` in the operator ledger before reading the Phase I feedback packet, touching target state, or writing artifacts. Save `startCommentUrl` when the ledger returns one.

Required source evidence:

- Phase I feedback with `status=recorded`, `decisionAllowed=true`, and `outcome=accepted-for-rehearsal`.
- Current PR state showing the same target, head/base refs, dirty classification, and no `CHANGES_REQUESTED` review decision.
- Fresh feedback (`createdAt` and `expiresAt` still valid) and matching `expectedRefs`.
- A contamination check over branch diff paths and artifact evidence paths.

## Queue rules

A Phase J queue packet must be `dryRunOnly`, `supervised`, `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and `noLiveApproval=true`. The queue item may only name the dry-run command:

```sh
node pr-shepherd.mjs rehearse --config <config> --target <id> --artifact-dir <artifact-dir>
```

`repair --dry-run` is acceptable as an equivalent dry-run command. Live `repair`, force-pushes, provider sends, autonomous timers, or approval config edits are out of scope.

Use the CLI form when converting an existing feedback packet into evidence without branch mutation:

```sh
node pr-shepherd.mjs rehearsal-queue --feedback path/to/review-feedback.json --pr-state path/to/current-pr.json --state path/to/state.json --output path/to/phase-j-rehearsal-queue.json
```

The output embeds a `pr-shepherd-rehearsal-dry-run-packet/v1` with gates, expected refs, command argv, operator checklist, and evidence hygiene. The queued rehearsal still requires human supervision and a later Phase D/E one-shot approval before any live repair.

## Fail-closed blockers

Close with `Block` and do not write/publish queue evidence if any blocker is present:

- Phase I feedback is blocked, stale, expired, unsupported, or not `accepted-for-rehearsal`.
- Current PR classification is not dirty, or GitHub `reviewDecision` is `CHANGES_REQUESTED`.
- Current head/base refs differ from feedback `expectedRefs`.
- The dry-run command would be replaced with live `repair` or any mutating action.
- OpenClaw runtime/bootstrap context paths would enter the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

When blocking for runtime/bootstrap contamination, report only the exact repo-relative offending paths and reason; never paste file contents.

## Closeout

Close the operator ledger with exactly one of `PR: <url>`, `Done`, or `Block`. Return `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available. `Done` means the supervised dry-run packet was queued or written; it does not approve live repair.
