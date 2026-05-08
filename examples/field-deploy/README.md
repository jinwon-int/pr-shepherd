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
PR_SHEPHERD_TELEGRAM_BOT_TOKEN_FILE=/path/managed-by-operator/token-file
PR_SHEPHERD_TELEGRAM_CHAT_ID_FILE=/path/managed-by-operator/chat-file
PR_SHEPHERD_TELEGRAM_PREFIX=[PR Shepherd]
```

Do not commit that env file or the referenced token/routing files.

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

Live Telegram delivery is a one-shot operator action, not part of tests. After the
dry-run smoke is approved, set both config `notify.dryRun=false` and env
`PR_SHEPHERD_NOTIFY_DRY_RUN=0`, then run one manual `check-canary` and switch back
to dry-run if the operator-visible receipt is not confirmed.

Rollback is reversible:

```bash
systemctl --user disable --now pr-shepherd-check-canary@openclaw-78261.timer
systemctl --user reset-failed pr-shepherd-check-canary@openclaw-78261.service
```

Keep `repair` out of this timer. Live repair remains a separate manual approval boundary.
