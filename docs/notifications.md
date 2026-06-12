# Notification integration

MVP default is `notify.mode=stdout` so OpenClaw cron/systemd can capture output and route summaries.
Set `notify.mode=none` to keep only the final JSON status output.

Every `check`/`check-canary` run can emit a concise PR situation report suitable for Telegram/OpenClaw
routing. Reports include the target id, repo/PR, classification, mergeable and merge-state values,
failed/pending check counts, the most recent repair/rehearsal summary when recorded, and a clear next
action. Healthy reports explicitly say `현재 조치할 것 없음 / no action needed`; dirty/failed/unknown
states highlight the operator action or approval boundary instead of implying that automation pushed.

Noise control is per target. `notify.situationReportEveryMs` defaults to six hours, sends the first
observed situation immediately, and still sends immediate reports when the situation key changes (for
example clean → failed or failed → clean). Set it to `0` for every scheduled check to produce a report;
use a larger value for quieter periodic summaries.

Before enabling a hook in a timer, run `canary --config config.json --target <id>` to exercise the
configured notifier without contacting GitHub, writing state, touching a worktree, or mutating a branch.
Then run `check-canary --config config.json --target <id>` once manually to exercise the real read-only
GitHub/state/notification path before scheduler installation.

For generic notifier hooks, set `notify.mode=command` and provide an argv array:

```json
"notify": {
  "mode": "command",
  "command": ["/usr/local/bin/pr-shepherd-notify", "--channel", "ops"],
  "situationReportEveryMs": 21600000
}
```

For OpenClaw/Telegram operations, prefer `notify.mode=openclaw`. It is a dry run unless `dryRun` is
explicitly set to `false`; live mode still only executes an operator-owned argv wrapper and never stores
Telegram bot tokens, Gateway tokens, chat ids, or recipient routing in `config.json`:

```json
"notify": {
  "mode": "openclaw",
  "dryRun": true,
  "situationReportEveryMs": 0
}
```

After the canary and wrapper are approved by the operator, switch to a live host wrapper that reads all
credentials and Telegram/OpenClaw routing from the service environment, not this repository:

```json
"notify": {
  "mode": "openclaw",
  "dryRun": false,
  "command": ["/usr/local/bin/pr-shepherd-openclaw-notify"],
  "situationReportEveryMs": 21600000
}
```

The formatted notification line is passed in the `PR_SHEPHERD_MESSAGE` environment variable. Hooks also
receive `PR_SHEPHERD_TARGET`, `PR_SHEPHERD_PR`, `PR_SHEPHERD_URL`, `PR_SHEPHERD_KIND`,
`PR_SHEPHERD_KEY`, and `PR_SHEPHERD_NOTIFY_MODE` for routing/idempotency. The notifier hook receives no
stdin from PR Shepherd, and its configured argv is executed directly without a shell. Hook failures are
allowed so a flaky notifier cannot block state updates; use the process logs or your notifier's own
telemetry to alert on delivery problems.

Notifier hook requirements:

- Treat hooks as notification-only; they must not run `repair`, mutate branches, or push code.
- Keep output concise and free of secrets, private worktree paths, and OpenClaw runtime/bootstrap
  context such as `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
  `.openclaw/**`.
- Make delivery idempotent. PR Shepherd deduplicates by notification key in the target state file, but
  operators may still replay timers or rerun checks manually.
- Prefer a small wrapper script when routing to chat/email/webhooks so credentials stay outside
  `config.json` and can be managed by the host service environment.
