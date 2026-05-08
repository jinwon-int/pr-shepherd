# Phase C one-shot rehearsal and approval operations

Phase C is an operator-run bridge from check-only observation to a single dry-run repair rehearsal, and only then to a separately approved live repair decision. It is not a standing automation lane: do not install timers, cron jobs, or broad `--all` repair jobs for Phase C.

## Entry conditions

Advance one target into Phase C only when Phase B evidence shows:

- at least 24 hours of readable `check-canary` or `check` state for the target
- `npm run doctor:field-deploy` and `node pr-shepherd.mjs validate --config config.json` pass, or every warning is documented as non-blocking
- notification noise is understood: no duplicate live receipts, missing receipts, route confusion, or lock contention remains unresolved
- the operator names one target id or `owner/repo#number`; avoid `--all` unless a later live approval explicitly names every covered target
- branch diffs and planned evidence paths are free of OpenClaw runtime/bootstrap context paths: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`

If any condition fails, stay in Phase B or rollback and close the ledger with `Block`.

## Rehearsal ledger

Post `Start` before touching the target worktree or writing artifacts. Save `startCommentUrl` when the ledger system returns one.

Use a short ledger entry like:

```text
Start
Target: <target-id> / <owner/repo#number>
Intent: Phase C one-shot repair rehearsal only
Allowed command: node pr-shepherd.mjs rehearse --config config.json --target <target-id> --artifact-dir <artifact-dir>
Operator: <name>
Evidence hygiene: branch diff and artifact path contamination check pending
```

Then run the rehearsal sequence manually:

```bash
npm run doctor:field-deploy
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json --target <target-id>
node pr-shepherd.mjs rehearse --config config.json --target <target-id> --artifact-dir <artifact-dir>
node pr-shepherd.mjs status --config config.json --target <target-id>
```

`rehearse` is dry-run only. It may write sanitized rehearsal state or artifact evidence, but it must not push. Do not pass `--allow-code-assisted-push`; the CLI rejects that flag for `rehearse`.

## Contamination guard before evidence or PR closeout

Before attaching artifacts, posting `PR: <url>`, or asking a runner to create a review PR, inspect the branch diff and planned artifact bundle paths. Fail closed if any path matches:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only repo-relative paths and the blocking reason. Do not paste file contents, raw session dumps, tokens, chat ids, or private host paths into the ledger.

## Rehearsal outcomes

Close the Phase C rehearsal with exactly one terminal marker:

- `Done` when the one-shot rehearsal completed and no reviewable patch is required.
- `PR: <url>` when the rehearsal produced a docs/code patch that should be reviewed before any operational change.
- `Block` when the rehearsal could not run safely, evidence hygiene failed, the target was not dirty, focused checks failed, or operator input is missing.

Return `startCommentUrl` plus `doneCommentUrl`, `prUrl`, or `blockCommentUrl` when the ledger system provides them.

## Separate live repair approval

A successful rehearsal is evidence, not live repair approval. Start a separate one-shot approval record before any live `repair` that can mutate a branch.

The approval must name:

- target id and PR
- approving operator and timestamp
- exact argv, normally `node pr-shepherd.mjs repair --config config.json --target <target-id>`
- allowed head branch and expected head/base refs
- matching rehearsal evidence link and maximum evidence age
- approval scope `auto-safe-repair`, `approvalId`, `approvedAt`, `approvedBy`, and `branchAllowlist`
- whether maintainer-owned head branches are explicitly allowed; default is blocked

Live repair remains fail-closed unless PR Shepherd reports an `auto-safe-repair` plan, focused checks pass, push budget remains available, the remote head still matches the fetched expected head, and the push uses the existing `--force-with-lease` path. Unsupported conflicts, stale remotes, dirty worktrees, CI failures, repeated repair failures, or contamination findings close as `Block` with sanitized evidence.
