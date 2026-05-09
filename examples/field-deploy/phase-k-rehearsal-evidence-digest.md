# Phase K — Rehearsal Evidence Digest Operations

Phase K turns one or more completed Phase J dry-run rehearsal packets into an operator-readable evidence digest. It is a summarization and hygiene phase only: it may collect links, compare refs, and record conclusions, but it must not run live `repair`, push a branch, merge a PR, create timers, or treat rehearsal success as approval for mutation.

## Start marker and admissible inputs

Post `Start` in the operator ledger before reading rehearsal artifacts, producing the digest, or attaching evidence. Save `startCommentUrl` when the ledger returns one.

Admissible inputs:

- A Phase J `pr-shepherd-supervised-rehearsal-queue/v1` packet with exactly one completed or blocked active item, or a single target-specific `pr-shepherd-rehearsal-dry-run-packet/v1` produced under Phase C/J supervision.
- The source Phase H/I packet link, current PR URL, target id, expected head/base refs, focused verification list, repair key, and terminal rehearsal outcome.
- Sanitized command evidence for dry-run commands only, such as `rehearse --target <id>` or `repair --dry-run --target <id>`.
- Current PR metadata sufficient to detect head/base drift before the digest is published.
- A clean contamination check over branch diff paths and planned artifact evidence paths.

Do not ingest raw shell transcripts, chat/provider dumps, token or environment output, private host paths, full OpenClaw session logs, or OpenClaw runtime/bootstrap context file contents.

## Digest packet

Record the digest as a small packet that lets an operator decide the next safe phase without opening every artifact:

1. **Digest identity:** schema `pr-shepherd-rehearsal-evidence-digest/v1`, target id, PR URL, operator, creation time, `startCommentUrl`, source queue/rehearsal packet links, and digest artifact path if one is written.
2. **Source refs:** expected head/base refs from the source packet and current head/base refs read for publication. Mark the digest `stale` if they differ or are unavailable.
3. **Rehearsal summary:** dry-run command argv, dry-run outcome, focused checks requested, focused checks observed, and whether the result was `candidate`, `deferred`, or `blocked`.
4. **Evidence index:** links or repo-relative artifact paths only; include a one-line purpose for each. Do not inline raw logs.
5. **Gate verdicts:** ref freshness, review-state compatibility, dirty/non-dirty state, focused-check status, push posture (`pushAllowed=false`), mutation posture (`mutatesBranch=false`), and contamination guard result.
6. **Operator recommendation:** exactly one next lane: `Phase D decision packet candidate`, `rerun Phase G/H`, `rerun Phase I`, `rerun Phase J`, `continue observation`, or `Block`.
7. **Evidence hygiene:** state that no secrets, private paths, chat ids, raw session dumps, or runtime/bootstrap context paths are included.
8. **Terminal marker:** close with one of `PR: <url>`, `Done`, or `Block`, and store the matching terminal URL.

A Phase K digest must be `dryRunEvidenceOnly=true`, `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and `noLiveApproval=true`.

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
- Current PR refs differ from source `expectedRefs`, or current refs cannot be verified.
- Rehearsal command evidence includes live `repair`, a push, provider send, timer creation, or any branch-mutating action.
- The evidence index would include secrets, private host paths, chat ids, raw session dumps, raw shell transcripts, or unsupported absolute paths.
- OpenClaw runtime/bootstrap context paths would enter the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
- Operator input is missing for the next-lane recommendation.

When blocking for runtime/bootstrap contamination, report only the exact repo-relative offending paths and reason; never paste file contents.

## Closeout markers

Close Phase K with exactly one terminal marker:

- `PR: <url>` when digest documentation or a sanitized digest packet is published for review and the branch/evidence guard passed.
- `Done` when the digest was recorded and no repository patch is required.
- `Block` when source evidence cannot be trusted, refs are stale, evidence is contaminated, or operator input is missing.

Save and report the matching `prUrl`, `doneCommentUrl`, or `blockCommentUrl` alongside `startCommentUrl` when available. `Done` means the digest was recorded; it does not approve live repair.

## Fail-closed contamination guard

Before posting a `PR` marker or attaching digest evidence, check the branch diff, staged/unstaged/untracked files, and planned artifact paths. Fail closed if any OpenClaw runtime/bootstrap context path would be committed or attached. Report only repo-relative path names and the blocking reason.

Block on exact matches for:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Do not paste the contents of those files into the ledger, digest packet, or artifact evidence.

## Operator template

```markdown
Start: <startCommentUrl>
Digest schema: pr-shepherd-rehearsal-evidence-digest/v1
Target: <target-id> <owner/repo#pr>
Source evidence: <Phase C/J URL or artifact path>
Expected refs: head=<sha-or-unknown> base=<sha-or-unknown>
Current refs: head=<sha-or-unknown> base=<sha-or-unknown>
Dry-run command evidence: <argv summary and sanitized link>
Focused checks: <requested/observed/pass-fail-unknown>
Evidence index:
- <sanitized link or repo-relative artifact path> — <purpose>
Gate verdicts: refs=<fresh|stale|unknown> review=<compatible|blocked|unknown> pushAllowed=false mutatesBranch=false hygiene=<passed|blocked>
Recommendation: <Phase D decision packet candidate|rerun Phase G/H|rerun Phase I|rerun Phase J|continue observation|Block>
Evidence hygiene: no secrets, private paths, chat ids, raw session dumps, raw transcripts, or runtime/bootstrap context paths
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Phase K summarizes rehearsal evidence only. Any later live repair still needs a fresh Phase D/E approval boundary, focused-check gate, push budget, expected-head `--force-with-lease`, and another contamination check immediately before evidence or branch publication.
