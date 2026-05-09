# Phase K — Rehearsal Evidence Digest and Phase D Candidate Gate

Phase K turns one completed supervised Phase C/J dry-run rehearsal into a short, sanitized evidence digest and a fail-closed Phase D candidate gate. It is a summarization and hygiene phase only: it may collect links, compare refs, record conclusions, and say whether a separate Phase D operator packet may be prepared. It must not approve live repair, must not run live `repair`, push a branch, merge a PR, create timers, or treat rehearsal success as approval for mutation.

## Start marker and admissible inputs

Post `Start` in the operator ledger before reading rehearsal output, state files, queue packets, artifact paths, producing the digest, or attaching evidence. Save `startCommentUrl` when the ledger returns one.

Admissible inputs:

- A Phase J `pr-shepherd-supervised-rehearsal-queue/v1` packet with exactly one completed or blocked active item, or a single target-specific `pr-shepherd-rehearsal-dry-run-packet/v1` produced under Phase C/J supervision.
- The `pr-shepherd-repair-rehearsal-approval/v1` package from the dry run.
- The matching `actionLedger` entry with `actionClass=repair-rehearsal`, `result=rehearsed`, and the current `repairKey`.
- The source Phase H/I packet link, current PR URL, target id, expected head/base refs, focused verification list, repair key, and terminal rehearsal outcome.
- Sanitized command evidence for dry-run commands only, such as `rehearse --target <id>` or `repair --dry-run --target <id>`.
- Current target id, PR, head/base refs, head branch, classification, and focused-check gate sufficient to detect drift before publication.
- Planned branch diff paths and artifact evidence paths, if any.
- A clean contamination check over branch diff paths and planned artifact evidence paths.

Do not ingest raw shell transcripts, chat/provider dumps, token or environment output, private host paths, full OpenClaw session logs, or OpenClaw runtime/bootstrap context file contents.

## Digest contents

Record the digest as a small packet that lets an operator decide the next safe phase without opening every artifact.

The digest schema is `pr-shepherd-rehearsal-evidence-digest/v1` and should include:

1. **Digest identity:** target id, PR URL, operator, creation time, `startCommentUrl`, source queue/rehearsal packet links, and digest artifact path if one is written.
2. **Source refs:** expected head/base refs from the source packet and current head/base refs read for publication. Mark the digest `stale` if they differ or are unavailable.
3. **Rehearsal summary:** dry-run command argv, dry-run-only status, dry-run outcome, focused checks requested, focused checks observed, check counts, rollback note, and whether the result was `candidate`, `deferred`, or `blocked`.
4. **Evidence index:** links or repo-relative artifact paths only; include a one-line purpose for each. Do not inline raw logs.
5. **Gate verdicts:** ref freshness, review-state compatibility, dirty/non-dirty state, focused-check status, push posture (`pushAllowed=false`), mutation posture (`mutatesBranch=false`), and contamination guard result.
6. **Operator recommendation:** exactly one next lane: `Phase D decision packet candidate`, `rerun Phase G/H`, `rerun Phase I`, `rerun Phase J`, `continue observation`, or `Block`.
7. **Evidence hygiene:** state that no secrets, private paths, chat ids, raw session dumps, raw transcripts, or runtime/bootstrap context paths are included.
8. **Terminal marker:** close with one of `PR: <url>`, `Done`, or `Block`, and store the matching terminal URL.

A Phase K digest must be `dryRunEvidenceOnly=true`, `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and `noLiveApproval=true`.

## Phase D candidate gate

The digest must include `pr-shepherd-phase-d-candidate-gate/v1`. The gate is `candidateAllowed=true` only when all of these are true:

- the rehearsal approval package exists and is dry-run-only/non-mutating
- current classification is still dirty and the target/head/base refs and `repairKey` match
- rehearsal evidence is fresh and not expired
- the action ledger contains the matching rehearsed repair entry
- focused checks are configured under the strict verify gate
- contamination guard reports no `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`

`candidateAllowed=true` only means that a separate Phase D operator packet may be prepared. It does not approve live repair and cannot bypass Phase D/E one-shot metadata, focused checks, push budget, expected-head `--force-with-lease`, or a fresh contamination check.

If any gate fails, close `Block` or record a deferred lane with exact repo-relative offending paths or blocked reasons. Do not carry a blocked digest into Phase D.

## Operating loop

Stop at the first failed gate and close with `Block` or a documented deferred lane:

1. Verify the source Phase J/C rehearsal evidence exists, names one target, and was produced by a dry-run command.
2. Re-read current PR metadata before publishing. If head/base refs changed, mark the digest stale and recommend rerunning Phase G/H/I/J instead of Phase D.
3. Build the evidence index from sanitized summaries and artifact links. Exclude raw transcripts and any file contents that are not needed for the operator decision.
4. Run the contamination guard against branch diff, staged/unstaged/untracked paths, and planned artifact evidence paths.
5. Record gate verdicts and a single next-lane recommendation. A successful digest can support a later Phase D packet, but it is not approval to run live `repair`.
6. Post exactly one terminal marker and report `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available.

Allowed command evidence is limited to dry-run forms, for example:

```sh
node pr-shepherd.mjs rehearse --config config.json --target <target-id> --artifact-dir <artifact-dir>
node pr-shepherd.mjs repair --config config.json --target <target-id> --dry-run --artifact-dir <artifact-dir>
```

Live `repair`, `repair --all`, force-pushes, provider sends, timer creation, approval config edits, or any command that mutates the watched worktree are out of scope for Phase K.

## Fail-closed blockers

Close with `Block` and do not publish digest evidence if any blocker is present:

- Source evidence is missing, not Phase C/J dry-run evidence, names multiple targets without a per-target digest, or has no terminal outcome.
- Rehearsal approval package or matching rehearsal ledger entry is missing.
- Current PR refs differ from source `expectedRefs`, or current refs cannot be verified.
- Current PR classification is no longer dirty.
- Focused checks are missing under the strict verify gate.
- Evidence is stale, mismatched, expired, or missing required dry-run/focused-check evidence.
- Rehearsal command evidence includes live `repair`, a push, provider send, timer creation, or any branch-mutating action.
- The evidence index would include secrets, private host paths, chat ids, raw session dumps, raw shell transcripts, or unsupported absolute paths.
- OpenClaw runtime/bootstrap context paths would enter the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
- Operator input is missing for the next-lane recommendation.

When blocking for runtime/bootstrap contamination, report only the exact repo-relative offending paths and reason; never paste file contents.

## Closeout markers

Close Phase K with exactly one terminal marker:

- `Done` — the digest was recorded and the Phase D candidate gate is allowed; a separate Phase D operator packet may be prepared.
- `PR: <url>` — digest documentation or a sanitized digest packet is published for review and the branch/evidence guard passed. This is not live repair approval.
- `Block` — evidence is stale, mismatched, contaminated, missing focused checks, missing rehearsal ledger, or otherwise unsafe.

Return `startCommentUrl` plus `doneCommentUrl`, `prUrl`, or `blockCommentUrl` when available. A Phase K `Done` still does not authorize live repair; Phase D/E one-shot approval, focused checks, push budget, expected-head `--force-with-lease`, and another contamination check remain required before any branch mutation.

## Operator template

```markdown
Start: <startCommentUrl>
Digest schema: pr-shepherd-rehearsal-evidence-digest/v1
Candidate gate schema: pr-shepherd-phase-d-candidate-gate/v1
Target: <target-id> <owner/repo#pr>
Source evidence: <Phase C/J URL or artifact path>
Expected refs: head=<sha-or-unknown> base=<sha-or-unknown>
Current refs: head=<sha-or-unknown> base=<sha-or-unknown>
Dry-run command evidence: <argv summary and sanitized link>
Focused checks: <requested/observed/pass-fail-unknown>
Evidence index:
- <sanitized link or repo-relative artifact path> — <purpose>
Gate verdicts: refs=<fresh|stale|unknown> review=<compatible|blocked|unknown> pushAllowed=false mutatesBranch=false hygiene=<passed|blocked>
Candidate allowed: <true|false + reason>
Recommendation: <Phase D decision packet candidate|rerun Phase G/H|rerun Phase I|rerun Phase J|continue observation|Block>
Evidence hygiene: no secrets, private paths, chat ids, raw session dumps, raw transcripts, or runtime/bootstrap context paths
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Phase K summarizes rehearsal evidence only. Any later live repair still needs a fresh Phase D/E approval boundary, focused-check gate, push budget, expected-head `--force-with-lease`, and another contamination check immediately before evidence or branch publication.
