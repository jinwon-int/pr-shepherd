# Field deployment examples: Telegram/OpenClaw situation reports

This package is an installable example for the `openclaw-78261` check-only canary lane.
It is intentionally no-send by default: `notify.dryRun=true` in config and
`PR_SHEPHERD_NOTIFY_DRY_RUN=1` in the service environment.

## Files

- `openclaw-78261-notify.fragment.example.json` — copy the `notify` object into the
  target config to emit a full situation report on every scheduled check.
- `pr-shepherd-openclaw-telegram-notify.sh` — operator-owned wrapper example that
  consumes `PR_SHEPHERD_MESSAGE` and related `PR_SHEPHERD_*` metadata.
- `pr-shepherd-check-canary@.service.example` / `.timer.example` — user-systemd
  examples for a 10-minute `check-canary --target %i` schedule.
- `doctor.mjs` / `package.json` — read-only doctor package for validating these examples
  and selected check-only canary config before field rollout.
- `post-live-canary-decision.md` — ops decision record for limiting live reporting to
  the observed canary lane.
- `live-readiness-go-no-go.md` — final operator checklist for deciding GO/NO-GO before
  enabling the live check-only reporting lane.
- `phase-a-standing-ops.md` — standing operations package for the scheduled check-only Phase A lane,
  including dry-run/no-send scheduling, state/evidence rotation, 24-48h observation, and one-shot live
  reporting canary boundaries.

## Safe install sketch

```bash
install -m 0755 examples/field-deploy/pr-shepherd-openclaw-telegram-notify.sh \
  /usr/local/bin/pr-shepherd-openclaw-telegram-notify
mkdir -p ~/.config/systemd/user ~/.config/pr-shepherd
cp examples/field-deploy/pr-shepherd-check-canary@.service.example \
  ~/.config/systemd/user/pr-shepherd-check-canary@.service
cp examples/field-deploy/pr-shepherd-check-canary@.timer.example \
  ~/.config/systemd/user/pr-shepherd-check-canary@.timer
```

Edit the copied service placeholders (`<pr-shepherd-repo>`) on the operator host.
Keep the env file outside this repository, for example:

```dotenv
# ~/.config/pr-shepherd/openclaw-78261.env
PR_SHEPHERD_NOTIFY_DRY_RUN=1
PR_SHEPHERD_OPENCLAW_CHANNEL=telegram
PR_SHEPHERD_OPENCLAW_TARGET=<operator-managed-chat-or-user-target>
PR_SHEPHERD_OPENCLAW_PREFIX=[PR Shepherd]
```

Do not commit that env file. Keep routing values and any OpenClaw credentials in the operator environment, not this repository.

## Doctor and dry-run smoke

Run the read-only doctor before copying files to an operator host or publishing evidence:

```bash
npm run doctor:field-deploy
# or, from this directory after install/copy:
npm run doctor -- --config ../../config.json --target openclaw-78261
```

The doctor validates the package examples, checks that no service schedules `repair`, confirms the wrapper defaults to no-send, and reports config issues or evidence hygiene warnings without contacting GitHub or sending messages.

Then run the dry-run smoke:

```bash
node pr-shepherd.mjs validate --config config.json
PR_SHEPHERD_MESSAGE='wrapper smoke: no send' \
PR_SHEPHERD_TARGET=openclaw-78261 \
PR_SHEPHERD_PR='openclaw/openclaw#78261' \
PR_SHEPHERD_KIND=canary \
PR_SHEPHERD_KEY=manual-smoke \
examples/field-deploy/pr-shepherd-openclaw-telegram-notify.sh
node pr-shepherd.mjs canary --config config.json --target openclaw-78261
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
```

## Check-only standing operations rollout

Use this as the operator-owned Phase A runbook for moving from local validation to standing `check-canary`
operations. The default posture is no-send and reversible: keep `notify.dryRun=true`, keep
`PR_SHEPHERD_NOTIFY_DRY_RUN=1`, and schedule only `check-canary --config <pr-shepherd-repo>/config.json --target <id>`.
Do not schedule `repair`, `rehearse`, `--all`, or any wrapper that can mutate a branch.

Before scheduling:

1. Post `Start` in the operator ledger and save the comment URL.
2. Run `npm run doctor:field-deploy`, then `node pr-shepherd.mjs validate --config config.json`.
3. Run one local no-send notifier canary and one manual `check-canary --target <id>`.
4. Confirm the evidence contains only sanitized summaries: command, target id, result, and redacted log link.
   Do not attach tokens, chat ids, private host paths, raw session dumps, or runtime/bootstrap context files.

Scheduling options:

- **systemd user timer:** copy the example service/timer above, leave `PR_SHEPHERD_NOTIFY_DRY_RUN=1`, and enable
  only `pr-shepherd-check-canary@<id>.timer` for the first target.
- **OpenClaw cron or equivalent scheduler:** create one operator-owned scheduled job whose effect is the same
  argv as the systemd service: `node <pr-shepherd-repo>/pr-shepherd.mjs check-canary --config <pr-shepherd-repo>/config.json --target <id>`.
  The job should summarize the run to the operator ledger or a private ops channel, not send live Telegram reports
  unless the live check-only canary below is separately approved.

State and evidence rotation checklist:

- Capture `status --target <id>` before moving or archiving a state file.
- Rotate scheduler logs by date or run id; keep only sanitized summaries in issue/PR evidence.
- Preserve state, lock, and notification dedupe files unless an operator explicitly moves them aside for rollback.
- Re-run the contamination guard before publishing evidence. Block if any branch diff or artifact path is
  `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

Phase B 24-48h observation template:

- Target id / config revision:
- Scheduler command and cadence:
- Run window start/end:
- `status --target <id>` closeout: `recentRunAt`, `lastCleanAt`, `lastWarningAt`, `lastWarningKind`:
- `observationSummary.last24h`: total, clean, unknown, failed, dirty, recheckSuggested:
- `observationSummary.last48h`: total, clean, unknown, failed, dirty, recheckSuggested:
- Doctor warnings / next recommended action:
- Noise check: duplicate no-action notifications are suppressed until cadence is due; escalations are specific and actionable:
- Hygiene check: no secrets, chat ids, private paths, raw session dumps, or runtime/bootstrap context paths:
- Phase C rehearsal criteria: at least 24h of readable state, no unresolved doctor warnings, no duplicate/missing notifications, and an operator decision for one-shot `rehearse` only:
- Decision: `promote-check-only`, `extend-observation`, `phase-c-one-shot-rehearsal`, or `rollback`:
- Operator and ledger closeout URL:

One-shot live Telegram/OpenClaw reporting canary checklist:

1. Keep the standing timer dry-run. Live reporting is a manual one-shot check-only test, not a repair approval.
2. Record `notify.liveActivation.scope="check-only-reporting"`, `approvedAt`, and `approvedBy`; keep the live cadence
   at one hour or more.
3. Set `notify.dryRun=false` and `PR_SHEPHERD_NOTIFY_DRY_RUN=0` only for the approved one-shot wrapper environment.
4. Run one manual `check-canary --target <id>` and wait for an operator-visible receipt.
5. If the receipt is missing, duplicated, or routed incorrectly, switch back to dry-run, disable any live schedule,
   and post `Block`. A successful receipt may close as `Done` or support a review PR, but it still does not enable repair.

## Field doctor

When a copied unit, wrapper, or config change behaves unexpectedly, run the same read-only doctor sequence
manually before enabling the timer again:

```bash
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json --target openclaw-78261
node pr-shepherd.mjs canary --config config.json --target openclaw-78261
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
```

A field doctor result is healthy only when validation passes, the target state is readable or explicitly absent
for a first run, the wrapper stays no-send unless live check-only reporting was approved, and no log/evidence
contains secrets, private host paths, or OpenClaw runtime/bootstrap context paths. If any check fails, keep the
timer disabled and record `Block` with the sanitized failing command and target id.

## First live canary boundary

Live Telegram/OpenClaw delivery is a one-shot operator action, not part of tests. Delivery goes through the OpenClaw CLI so OpenClaw owns Telegram routing, allowlists, and provider credentials. After the dry-run smoke is approved, use `live-readiness-go-no-go.md` for the final GO/NO-GO package. Set config `notify.dryRun=false` only with `notify.liveActivation.scope="check-only-reporting"`, `approvedAt`, and `approvedBy`; keep live `situationReportEveryMs` at one hour or more. Set env `PR_SHEPHERD_NOTIFY_DRY_RUN=0`, confirm `PR_SHEPHERD_OPENCLAW_TARGET` is operator-managed, then run one manual `check-canary` and switch back to dry-run if the operator-visible receipt is not confirmed. This is check-only reporting approval, not repair or push approval.

Rollback is reversible:

```bash
systemctl --user disable --now pr-shepherd-check-canary@openclaw-78261.timer
systemctl --user reset-failed pr-shepherd-check-canary@openclaw-78261.service
```

Keep `repair` out of this timer. Live repair remains a separate manual approval boundary.
