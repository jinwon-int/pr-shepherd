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
- `post-live-canary-decision.md` — ops decision record for limiting live reporting to
  the observed canary lane.

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

## Dry-run smoke

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

## First live canary boundary

Live Telegram/OpenClaw delivery is a one-shot operator action, not part of tests. Delivery goes through the OpenClaw CLI so OpenClaw owns Telegram routing, allowlists, and provider credentials. After the dry-run smoke is approved, set config `notify.dryRun=false` only with `notify.liveActivation.scope="check-only-reporting"`, `approvedAt`, and `approvedBy`; keep live `situationReportEveryMs` at one hour or more. Set env `PR_SHEPHERD_NOTIFY_DRY_RUN=0`, confirm `PR_SHEPHERD_OPENCLAW_TARGET` is operator-managed, then run one manual `check-canary` and switch back to dry-run if the operator-visible receipt is not confirmed. This is check-only reporting approval, not repair or push approval.

Rollback is reversible:

```bash
systemctl --user disable --now pr-shepherd-check-canary@openclaw-78261.timer
systemctl --user reset-failed pr-shepherd-check-canary@openclaw-78261.service
```

Keep `repair` out of this timer. Live repair remains a separate manual approval boundary.
