# Phase M — Bounded Auto-Safe Minor Repair Operations

Phase M is the narrow lane for a supervised, reviewable minor repair after earlier PR Shepherd evidence has reduced the work to a deterministic and low-risk patch. It is not a standing automation mode and it is not permission to run broad code-assisted edits. Use it only when the operator asks for one bounded repair and the expected diff can be described before work begins.

Phase M may prepare a small review PR or record that no change was needed. It must not run live upstream `repair`, force-push a watched branch, create timers, edit approval config on behalf of the operator, send provider messages except ledger markers, or treat Phase D/E live-repair approval as reusable approval for a repository patch.

## Start marker and inputs

Post `Start` in the operator ledger before reading evidence, touching files, running tests, or preparing a branch diff. Save `startCommentUrl` when the ledger returns one.

Required inputs:

- The operator request naming Phase M and the repository or target being repaired.
- A short repair scope statement that identifies the allowed path set, expected change class, and why the change is minor.
- A prior evidence link or source note from Phase G/H/I/J/K/L, a review comment, CI output, or an operator issue that justifies the repair.
- A bounded patch budget, normally one topic, one branch, no more than a few files, and a small line delta.
- The exact verification commands to run, or a reason verification is not available.
- Planned branch diff paths and planned artifact evidence paths for PR creation or ledger closeout.

Do not ingest raw shell transcripts, OpenClaw session dumps, provider/chat exports, secrets, token or environment output, private host paths, or OpenClaw runtime/bootstrap context file contents.

## Allowed repair classes

Phase M is `autoSafeMinor=true` only when every planned edit is deterministic, reviewable, and easy to revert:

- Documentation or runbook clarifications that do not change production behavior.
- Example comments, templates, or fixture text that keep the same safety posture.
- Small test expectation updates that match an already-documented behavior.
- Formatting, spelling, or link corrections inside the approved path set.

The lane is blocked for production code rewrites, dependency upgrades, generated bundle refreshes, security-sensitive files, credential/routing configuration, broad refactors, unexplained test snapshot churn, lockfiles, binary files, hidden files, or any path outside the operator-approved scope.

## Workflow

Stop at the first failed gate and close with `Block` using sanitized reasons only:

1. Record `Start` and save `startCommentUrl`.
2. Confirm the request is a single minor repair with an explicit path allowlist and a bounded diff budget.
3. Check the worktree state and planned evidence. Existing ignored local runtime files are allowed only if they are not staged, committed, attached, or pasted.
4. Run the runtime/bootstrap contamination guard over staged, unstaged, untracked, and planned artifact evidence paths before editing.
5. Apply the smallest patch that satisfies the request. Do not broaden scope to opportunistic cleanup.
6. Run the agreed verification commands. If they fail for unrelated reasons, record the failing command and sanitized summary; do not hide the failure.
7. Re-run the contamination guard over the final branch diff and any planned evidence bundle.
8. Close with exactly one terminal marker and return `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available.

## Repair packet shape

A Phase M closeout packet should be short and auditable:

```markdown
Start: <startCommentUrl>
Phase: M bounded auto-safe minor repair
Target: <repo-or-target-id>
Source evidence: <issue|review|artifact url>
Repair class: docs|examples|tests|formatting
Allowed paths: <path list or glob list>
Diff budget: <file-count/line-count bound>
Verification: <command list and result>
Branch diff paths: <repo-relative paths>
Artifact evidence paths: <repo-relative paths or none>
Contamination guard: passed|blocked <paths>
Safety flags: autoSafeMinor=true productionMutation=false liveRepair=false pushAllowed=false timers=false
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

Do not include raw logs, secrets, private host paths, chat ids, raw session dumps, or runtime/bootstrap file contents in the packet. Link to sanitized artifacts when needed.

## Runtime/bootstrap contamination guard

Before posting `PR: <url>`, attaching evidence, or letting a runner create a review PR, fail closed if any branch diff or planned artifact evidence path would include:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Report only the exact repo-relative offending paths and the reason. Never paste the file contents. If the only occurrence is an ignored local file that is not staged, committed, or attached, note that the guard passed and leave the file alone.

## Closeout markers

Close Phase M with exactly one terminal marker:

- `PR: <url>` — a sanitized minor repair PR was created and the final branch/evidence guard passed.
- `Done` — no repository change was required after the bounded repair check, and the reason is recorded.
- `Block` — the repair was not minor, the scope or approval was unclear, verification failed in a way that needs human review, or branch/artifact evidence was contaminated.

A successful Phase M closeout means only that one bounded minor repair was completed or proposed for review. It does not enable standing repair automation, live upstream repair, provider sends, timers, or future patches without a new `Start` marker and a fresh bounded scope.
