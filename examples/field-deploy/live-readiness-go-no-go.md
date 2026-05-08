# PR Shepherd live-readiness go/no-go package

Use this package for the final operator decision before promoting PR Shepherd from dry-run/check-only
field validation to a live, operator-visible check-only reporting lane. It does not approve `repair`,
rebases, conflict artifact publication, or branch pushes.

## Decision scope

- Target lane: one named `check-canary --target <id>` timer.
- Allowed live effect: one deduplicated operator situation report per configured cadence.
- Disallowed effects: `repair`, `repair --dry-run` from the timer, worktree mutation, branch mutation,
  conflict artifact attachment, credential capture, or aggregate/all-target promotion.
- Approval record: append-only operator ledger with `Start` before work and exactly one terminal marker:
  `PR: <url>`, `Done`, or `Block`.

## Go criteria

All items must be true before the operator may mark `GO`:

1. `node pr-shepherd.mjs validate --config config.json` exits 0 for the exact config revision being deployed.
2. `node pr-shepherd.mjs status --config config.json --target <id>` reads the target state or reports an
   expected first-run missing state without unsafe findings.
3. `node pr-shepherd.mjs canary --config config.json --target <id>` renders the final notification safely.
4. One manual `node pr-shepherd.mjs check-canary --config config.json --target <id>` completes with the
   expected read-only GitHub/state behavior and no duplicate notification.
5. The copied scheduler command is exactly check-only for the approved target; no service, cron, or wrapper path
   schedules `repair`, `rehearse`, `--all`, or another target.
6. Live OpenClaw/Telegram delivery, if enabled, has `notify.liveActivation.scope="check-only-reporting"`,
   `approvedAt`, `approvedBy`, `notify.dryRun=false`, and a cadence of at least one hour.
7. Evidence is sanitized: no secrets, chat ids, private host paths, raw OpenClaw session dumps, or OpenClaw
   runtime/bootstrap context files are included.
8. Rollback has been rehearsed or reviewed and is non-destructive.

## No-go / block criteria

Mark `NO-GO` and post `Block` if any item below is true:

- Any readiness command exits non-zero or produces an ambiguous target/config result.
- A notification is missing, duplicated unexpectedly, misleading, or delivered to the wrong operator target.
- The scheduler or wrapper can run `repair`, `rehearse`, `--all`, a different target, or any shell-expanded
  unapproved command.
- The evidence bundle or branch diff would include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`,
  `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
- Evidence contains credentials, tokens, chat ids, private host paths, or raw session dumps.
- Rollback would require a rebase, push, artifact write, or deletion of audit state.

When blocked for runtime/bootstrap contamination, report only the repo-relative offending paths and the reason;
do not paste file contents.

## Final operator run sheet

1. Post `Start` in the operator ledger and save `startCommentUrl`.
2. Record target id, config revision, actor, and intended live effect: check-only reporting.
3. Run the four readiness commands from the go criteria and save sanitized summaries only.
4. Verify the copied service/timer/wrapper command lines match the approved check-only target.
5. Run the contamination guard against the planned branch diff and evidence bundle before posting a PR or Done:

   ```bash
   offending_paths="$(git diff --name-only "${BASE_REF:-main}...HEAD" -- \
     | grep -E '^(AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw(/|$))' \
     || true)"
   if [ -n "$offending_paths" ]; then
     printf 'Block: runtime/bootstrap context path in branch diff\n%s\n' "$offending_paths"
     exit 2
   fi
   ```

   Also inspect the artifact manifest by path before attaching any evidence.
6. If every go criterion holds, record `GO`, the exact target id, cadence, activation timestamp, and rollback
   command. Otherwise record `NO-GO` with the first blocking reason.
7. Post exactly one terminal marker:
   - `PR: <url>` if a reviewable branch is created.
   - `Done` if no repository change is needed.
   - `Block` if any criterion fails or human input is required.

## Rollback package

Rollback is the default response to unsafe or noisy live reporting:

```bash
systemctl --user disable --now pr-shepherd-check-canary@<id>.timer
systemctl --user reset-failed pr-shepherd-check-canary@<id>.service
node pr-shepherd.mjs status --config config.json --target <id>
```

Keep the target state file for audit unless an operator explicitly moves it aside. Rollback must not rebase,
push, publish conflict artifacts, or delete evidence needed to explain the decision.
