# Phase D operator decision packet

Phase D is the final human decision before one narrowly scoped live PR Shepherd repair. It converts Phase C rehearsal evidence into either a one-shot live `repair --target <id>` approval, a continued observation/rehearsal request, or a fail-closed block. It is not a standing automation lane and must not enable timers, broad `--all` repair, or unattended force-pushes.

## Entry conditions

Prepare a Phase D packet only when all of these are true:

- Phase B observation has a clean 24-48h summary for the target, or every warning is documented as non-blocking.
- Phase C ran one target-specific `rehearse` or `repair --dry-run` and produced sanitized evidence.
- `npm run doctor:field-deploy`, `node pr-shepherd.mjs validate --config config.json`, and `status --target <id>` are current enough for the operator to trust the decision.
- The target PR is still dirty and eligible for `auto-safe-repair`; clean, pending, failed, merged, disabled, unknown, or unsupported-conflict states stay out of Phase D.
- The expected head/base refs, allowed head branch, push budget, and focused verification commands are known.
- The branch diff and planned evidence bundle have passed the runtime/bootstrap contamination guard.

If any condition is missing, close the packet with `Block` or return to Phase B/C; do not infer live approval from prior observation or rehearsal.

## Decision packet template

Record the packet in the operator ledger or issue before any live repair command runs. Post `Start` first, keep it short, and link to sanitized evidence rather than pasting raw logs.

```text
Start
Phase: D operator decision packet
Target: <target-id> / <owner/repo#number>
Requested decision: GO live repair / NO-GO continue observation / NO-GO block
Operator: <name>
Prepared by: <name or automation actor>
Config revision: <commit or config hash>
Phase B summary: <url or ledger reference>
Phase C rehearsal evidence: <url or artifact reference>
Current status: dirty / other
Expected head: <sha>
Expected base: <sha>
Allowed branch: <owner>:<branch>
Live command under consideration: node pr-shepherd.mjs repair --config config.json --target <target-id>
Focused checks required before push: <commands>
Push guard: --force-with-lease=<branch>:<expected-head>
Push budget remaining: <count>/<window>
Maintainer-owned head branch allowed: no / yes, explicitly acknowledged
Evidence hygiene: pass / block
Decision deadline or expiry: <timestamp>
```

## Operator decision options

Choose exactly one outcome:

### GO: one-shot live repair

Approve only when the packet names the exact command, target, allowed branch, expected refs, approval metadata, and matching Phase C evidence. The approval scope must be `auto-safe-repair` and must expire after this one command. Live execution still fails closed if PR Shepherd reports a non-repair action class, focused checks fail, the remote head changes, the push budget is exhausted, or evidence hygiene fails.

### NO-GO: continue observation or rehearse again

Use this when the target is not clearly repairable, the rehearsal is stale, the operator wants more evidence, or notification/noise behavior is still uncertain. Record the next allowed command, usually `status`, `check-canary`, `rehearse`, or `repair --dry-run`; do not run live `repair`.

### NO-GO: block

Use this when credentials, refs, branch ownership, dirty worktree state, unsupported conflicts, CI failures, contamination findings, missing approval metadata, or unclear operator intent make live repair unsafe. Record only sanitized failing facts and the exact blocker.

## Live execution ledger

If the operator chooses GO, append an action entry before and after the command:

```text
Action
Approval scope: auto-safe-repair
Approval id: <id>
Approved by: <operator>
Approved at: <timestamp>
Command argv: node pr-shepherd.mjs repair --config config.json --target <target-id>
Expected refs: head=<sha> base=<sha>
Allowed branch: <owner>:<branch>
Result: pushed / no-op / block
Evidence: <sanitized status, checks, or PR Shepherd action ledger link>
```

The command may push only through PR Shepherd's existing expected-head and `--force-with-lease` gates. Do not bypass the CLI with manual git commands as part of Phase D.

## Contamination guard before PR or evidence closeout

Before posting `PR: <url>`, attaching artifacts, or asking a runner to create a review PR, inspect the branch diff and planned evidence bundle paths. Fail closed if any path would be committed or attached:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only repo-relative path names and the blocking reason. Do not paste file contents, raw session dumps, tokens, chat ids, private host paths, or OpenClaw runtime/bootstrap context contents into the packet.

## Closeout markers

Close Phase D with exactly one terminal marker:

- `Done` when the operator chose NO-GO continue observation/rehearsal and the packet was recorded without requiring a review PR.
- `PR: <url>` when this repository needs a reviewable docs/code change before operational use.
- `Block` when live repair or evidence publication failed closed.

Return `startCommentUrl` plus `doneCommentUrl`, `prUrl`, or `blockCommentUrl` when the ledger system provides them. A successful live repair is not a standing approval; any later target, branch, or retry starts a new Phase D packet.
