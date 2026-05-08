# Phase B observation and noise-control rollout

Phase B keeps PR Shepherd in check-only standing operations while improving what operators can observe and how often they are interrupted. It may run `validate`, `status`, `canary`, `check`, and `check-canary`; it must not schedule `repair`, run live repair, mutate watched branches, or write conflict artifacts.

## Start posture

1. Post `Start` in the operator ledger and save the comment URL.
2. Confirm `notify.dryRun=true` or an already approved check-only live reporting activation. Live reporting approval does not approve repair.
3. Run `npm run doctor:field-deploy`, then `node pr-shepherd.mjs validate --config config.json`.
4. Run one manual `node pr-shepherd.mjs check-canary --config config.json --target <id>` and save only sanitized summary evidence.
5. Enable one check-only timer for one target. Add more targets only after the first target completes the observation window without duplicate reports, lock contention, or unsafe evidence.

## Observation ledger

Append one compact entry per scheduled run or per summarized batch. Do not paste raw shell transcripts. A ledger entry should include:

- timestamp or run id
- target id and repo/PR
- command class: `validate`, `status`, `canary`, `check`, or `check-canary`
- classification: `clean`, `unknown`, `recheck`, `failed`, `dirty`, `merged`, or `disabled`
- notification key and whether a report was sent, deduplicated, or suppressed by cadence
- lock/state result and any doctor warnings
- next action: `none`, `observe`, `recheck`, `operator-investigate`, `rollback`, or `phase-c-candidate`

## 24-48 hour summary template

Use this summary before adding targets, changing cadence, enabling live check-only reporting, or proposing Phase C.

```text
Window:
Target(s):
Config revision:
Scheduler command and cadence:
Run count:
Classification counts: clean= unknown= recheck= failed= dirty= merged= disabled=
Last run:
Last clean:
Last warning or failed doctor check:
Reports sent:
Reports suppressed by duplicate/no-action cadence:
Operator escalations:
Noise assessment: acceptable / too noisy / too quiet
Evidence hygiene: pass / block
Recommended next action: continue-observation / adjust-cadence / rollback / phase-c-candidate
Ledger closeout URL:
```

## Noise-control rules

- Send the first observed situation for a target, then suppress repeats until `notify.situationReportEveryMs` elapses unless the situation key changes.
- Treat clean/no-action repeats as summary material, not chat interrupts. The concise operator-facing line should say there is no current action and link or point to detailed evidence elsewhere.
- Send immediately on transitions to or from `failed`, `dirty`, `unknown`, `merged`, or `disabled`, but keep the message focused on the required operator action.
- Keep detailed evidence in state, logs, or the ledger summary; Telegram/OpenClaw messages should contain target, classification, failed/pending counts, last notable warning, and next action only.
- If duplicate messages, missing receipts, or route confusion appear, return the target to dry-run or disable the timer before continuing observation.

## Status review cadence

During Phase B, review `status --all` at least once per observation window and after any warning. The status-style summary should be sufficient for an operator to answer:

- What ran most recently for each target?
- When was the last clean observation?
- What was the last warning, failed doctor check, or unknown classification?
- Is there a pending recheck or escalation?
- What is the next recommended action?

If status output cannot answer those questions from sanitized state, extend Phase B and update docs/code before Phase C.

## Rollback / disable

Rollback is non-destructive:

1. Disable the check-only timer or scheduler for the target.
2. Run `node pr-shepherd.mjs status --config config.json --target <id>` and save the sanitized final summary.
3. Leave state and lock files in place for audit unless an operator explicitly moves them aside.
4. Post `Done` if rollback completed cleanly, or `Block` with the sanitized failing command and target id.

Rollback must not run `repair`, rebase a worktree, push a branch, or attach raw logs.

## Phase C one-shot rehearsal criteria

A target may be proposed for Phase C only when all of these are true:

- at least 24-48 hours of Phase B observation are summarized
- validation, doctor, and check-canary evidence are passing or have documented non-blocking warnings
- duplicate/no-action reporting is under control and operator messages are concise
- no secrets, chat ids, private host paths, raw session dumps, or OpenClaw runtime/bootstrap context files appear in branch diffs or evidence bundles
- the proposed Phase C action is a one-shot `rehearse` or `repair --dry-run`, not live repair
- an operator ledger contains the Start marker, summary, next action, and terminal `Done` or `Block` marker
