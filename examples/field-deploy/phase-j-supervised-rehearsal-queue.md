# Phase J — Supervised Rehearsal Queue and Dry-Run Packet

Phase J is an operator-supervised queue for Phase H/I candidates that may need a dry-run rehearsal next. It converts a recorded Phase I `pr-shepherd-review-state-feedback/v1` decision into a supervised rehearsal queue entry and dry-run evidence packet. It is a scheduling and evidence step only: the queue may prioritize, reserve, and run one `rehearse --target <id>` at a time, but it must not run live `repair`, push a branch, merge a PR, create standing repair timers, or carry approval from one queued target to another.

## Start marker and source evidence

Post `Start` in the operator ledger before reading the Phase I feedback packet, touching target state, or writing artifacts. Save `startCommentUrl` when the ledger returns one.

Required source evidence:

- Each queue item already has a Phase H repair-plan handoff or Phase I review-state feedback packet with target id, PR URL, current head/base refs, proposed lane, focused verification, and evidence hygiene result.
- Phase I feedback has `status=recorded`, `decisionAllowed=true`, and `outcome=accepted-for-rehearsal` before it can become rehearsal-ready.
- Current PR state shows the same target, head/base refs, dirty classification, and no `CHANGES_REQUESTED` review decision.
- Fresh feedback (`createdAt` and `expiresAt` still valid) and matching `expectedRefs`.
- Queue storage is operator-owned and sanitized. It must contain only target ids, repo/PR references, refs, classification, priority, reservation status, and links to prior evidence.
- The target worktree and any sandbox/rehearsal worktree are treated as evidence sources only. Do not edit the watched worktree or push.
- A contamination check over branch diff paths and artifact evidence paths is clean before evidence is published.

## Queue packet

Record a small packet for the queue window so an operator can audit why each item was or was not rehearsed:

1. **Queue window:** start/end time, operator, `startCommentUrl`, max item count, and whether the queue is intake-only, rehearsal-ready, paused, or blocked.
2. **Item inventory:** target id, PR URL, source packet link, current head/base refs, classification, proposed lane, and priority for each item.
3. **Reservation state:** exactly one item may be `active`; other items are `queued`, `deferred`, `blocked`, or `done`. Include reservation owner and expiry for the active item.
4. **Admission gate:** accept only items whose proposed lane is Phase C rehearsal candidate or autoSafe rehearsal and whose refs still match the source packet.
5. **Focused verification:** name the read-only or dry-run checks that will be used for that item. Keep live repair and provider sends disabled.
6. **Dry-run evidence:** embed a `pr-shepherd-rehearsal-dry-run-packet/v1` with gates, expected refs, command argv, operator checklist, and evidence hygiene.
7. **Evidence hygiene:** confirm no secrets, private host paths, chat ids, raw session dumps, or OpenClaw runtime/bootstrap context contents are included.
8. **Terminal decision:** close the queue window with one marker, and leave deferred items in an explicit next-state instead of implying approval.

A Phase J queue packet must be `dryRunOnly`, `supervised`, `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and `noLiveApproval=true`.

## Supervised execution loop

For each queue item, stop at the first failed gate and mark the item `blocked` or `deferred` with a short reason:

1. Re-read the source Phase H/I packet and current PR metadata; if head/base refs drifted, mark `deferred` for rerun Phase G/H or Phase I.
2. Verify the queue has no other `active` item and acquire a short reservation for the target.
3. Run `node pr-shepherd.mjs validate --config config.json`, then `node pr-shepherd.mjs status --config config.json --target <target-id>`.
4. Run at most one manual `node pr-shepherd.mjs rehearse --config config.json --target <target-id>` for the active item. `rehearse` is dry-run only and must not be run with live push flags.
5. Record the rehearsal outcome as `done`, `deferred`, or `blocked`. A successful rehearsal can support a later Phase D packet, but it is not live repair approval.
6. Release the reservation before selecting another item. Do not batch live branch mutations; Phase J never runs `repair`.

The queue item may only name a dry-run command such as:

```sh
node pr-shepherd.mjs rehearse --config <config> --target <id> --artifact-dir <artifact-dir>
```

`repair --dry-run` is acceptable as an equivalent dry-run command. Live `repair`, force-pushes, provider sends, autonomous timers, or approval config edits are out of scope.

Use the CLI form when converting an existing feedback packet into evidence without branch mutation:

```sh
node pr-shepherd.mjs rehearsal-queue --feedback path/to/review-feedback.json --pr-state path/to/current-pr.json --state path/to/state.json --output path/to/phase-j-rehearsal-queue.json
```

The queued rehearsal still requires human supervision and a later Phase D/E one-shot approval before any live repair.

## Fail-closed blockers

Close with `Block` and do not write or publish queue evidence if any blocker is present:

- Phase I feedback is blocked, stale, expired, unsupported, or not `accepted-for-rehearsal`.
- Current PR classification is not dirty, or GitHub `reviewDecision` is `CHANGES_REQUESTED`.
- Current head/base refs differ from feedback `expectedRefs`.
- More than one item would become `active`.
- The dry-run command would be replaced with live `repair` or any mutating action.
- Rehearsal evidence is contaminated, or operator input is missing.
- OpenClaw runtime/bootstrap context paths would enter the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

When blocking for runtime/bootstrap contamination, report only the exact repo-relative offending paths and reason; never paste file contents.

## Closeout markers

Close Phase J with exactly one terminal marker:

- `PR: <url>` when the queue documentation or sanitized rehearsal packet is published for review and the branch/evidence guard passed.
- `Done` when the supervised queue window was recorded and no repository patch is required.
- `Block` when queue state cannot be trusted, refs are stale, more than one item would become active, rehearsal evidence is contaminated, or operator input is missing.

Save and report the matching `prUrl`, `doneCommentUrl`, or `blockCommentUrl` alongside `startCommentUrl` when available. `Done` means the supervised dry-run packet was queued or written; it does not approve live repair.

## Fail-closed contamination guard

Before posting a `PR` marker or attaching queue/rehearsal evidence, check the branch diff, staged/unstaged/untracked files, and planned artifact paths. Fail closed if any OpenClaw runtime/bootstrap context path would be committed or attached. Report only repo-relative path names and the blocking reason.

Block on exact matches for:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Do not paste the contents of those files into the ledger, queue packet, or artifact evidence.

## Operator template

```markdown
Start: <startCommentUrl>
Queue window: <start/end/operator>
Queue mode: <intake-only|rehearsal-ready|paused|blocked>
Items:
- target=<target-id> pr=<owner/repo#pr> source=<Phase H/I URL> refs=head:<sha-or-unknown> base:<sha-or-unknown> state=<queued|active|deferred|blocked|done> priority=<reason>
Active reservation: <none|target/owner/expires-at>
Admission gate: <passed|deferred|blocked + reason>
Commands run: <validate/status/rehearse argv or none>
Dry-run packet: <pr-shepherd-rehearsal-dry-run-packet/v1 path or none>
Rehearsal outcome: <done|deferred|blocked|not-run>
Next state: <Phase D packet candidate|rerun Phase G/H|rerun Phase I|continue queue|block>
Evidence hygiene: no secrets, private paths, raw session dumps, or runtime/bootstrap context paths
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Phase J only supervises dry-run rehearsal queueing. Any later live repair still needs a fresh Phase D/E approval boundary, focused-check gate, push budget, expected-head `--force-with-lease`, and another contamination check immediately before evidence or branch publication.
