# Phase K rehearsal evidence digest

Phase K turns one completed supervised `rehearse --config config.json --target <target-id>` dry run into a short, sanitized evidence digest and a fail-closed Phase D candidate gate. It is a review step only: it does not approve live repair, does not run `repair`, does not create timers, and does not push.

## Start marker and source evidence

Post `Start` in the operator ledger before reading rehearsal output, state files, queue packets, or artifact paths. Save `startCommentUrl` when the ledger returns one.

Source evidence must include:

- the `pr-shepherd-repair-rehearsal-approval/v1` package from the dry run
- the matching `actionLedger` entry with `actionClass=repair-rehearsal`, `result=rehearsed`, and the current `repairKey`
- current target id, PR, head/base refs, head branch, classification, and focused-check gate
- planned branch diff paths and artifact evidence paths, if any

## Digest contents

Write or attach only a sanitized `pr-shepherd-rehearsal-evidence-digest/v1` summary. It should record target/PR, expected refs, current refs, repair key, dry-run-only status, check counts, approval-package summary, evidence expiry, rollback note, evidence hygiene, and terminal marker. Do not paste raw shell transcripts, secrets, private host paths, runtime/bootstrap file contents, or full session logs.

## Phase D candidate gate

The digest must include `pr-shepherd-phase-d-candidate-gate/v1`. The gate is `candidateAllowed=true` only when all of these are true:

- the rehearsal approval package exists and is dry-run-only/non-mutating
- current classification is still dirty and the target/head/base refs and `repairKey` match
- rehearsal evidence is fresh and not expired
- the action ledger contains the matching rehearsed repair entry
- focused checks are configured under the strict verify gate
- contamination guard reports no `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`

If any gate fails, close `Block` with exact repo-relative offending paths or blocked reasons. Do not carry the digest into Phase D.

## Closeout markers

Close Phase K with exactly one terminal marker:

- `Done` — the digest was recorded and the Phase D candidate gate is allowed; a separate Phase D operator packet may be prepared.
- `PR: <url>` — only for a review PR that documents the digest/runbook itself; it is not live repair approval.
- `Block` — evidence is stale, mismatched, contaminated, missing focused checks, missing rehearsal ledger, or otherwise unsafe.

Return `startCommentUrl` plus `doneCommentUrl`, `prUrl`, or `blockCommentUrl` when available. A Phase K `Done` still does not authorize live repair; Phase D/E one-shot approval, focused checks, push budget, expected-head `--force-with-lease`, and another contamination check remain required before any branch mutation.
