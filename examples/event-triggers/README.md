# Event-driven check triggers

Polling timers stay the reliability backstop for PR Shepherd. The pieces in
this directory only reduce detection latency by running one extra read-only
`check-canary --target <id>` when GitHub reports PR activity. Events never
replace timers, never carry approval, and can never start a mutation lane.

## Pieces

- `webhook-check-receiver.mjs`: dependency-free HTTP receiver for the operator
  host. Authenticated `POST /trigger` requests run one one-shot read-only
  `check-canary` against the operator-local config/state for an allowlisted
  target id, with per-target debouncing. The spawned command is fixed; there is
  no code path to `rehearse` or `repair`.
- `check-on-pr-events.yml.example`: GitHub Actions workflow for the repository
  hosting the watched PR branch. On PR or check-suite activity it pings the
  receiver with a shared secret. It runs nothing else on the runner.

## Rollout

1. Start the receiver on the operator host with the secret, config path, and
   target allowlist in the service environment (never in argv or config):

   ```bash
   PR_SHEPHERD_EVENT_SECRET=<random-32-chars> \
   PR_SHEPHERD_EVENT_CONFIG=/path/to/config.json \
   PR_SHEPHERD_EVENT_TARGETS=openclaw-78261 \
   node examples/event-triggers/webhook-check-receiver.mjs
   ```

2. Confirm `GET /healthz` answers and an authenticated manual `POST /trigger`
   produces exactly one `check-canary` run and one deduplicated notification.
3. Install the workflow in the watched repository with the
   `PR_SHEPHERD_EVENT_URL` and `PR_SHEPHERD_EVENT_SECRET` repository secrets.
4. Keep the existing check timer enabled. The receiver's debounce plus the
   per-target state-file notification dedupe keep duplicate timer/event runs
   quiet.

## Security posture

- Bind the receiver to `127.0.0.1` behind a reverse proxy or tunnel, or
  firewall the port to GitHub-originated traffic only.
- The shared secret is compared in constant time; rotate it by restarting the
  receiver and updating the repository secret.
- Unknown targets, bad secrets, and oversized bodies are rejected; the
  receiver triggers only the read-only check lane for allowlisted ids, so a
  compromised secret cannot push, rehearse, repair, or change configuration.

## Rollback

Delete the workflow file (or remove its secrets) and stop the receiver
process. The polling timer keeps observing; no state or worktree cleanup is
needed because events only ever ran the same read-only check lane.
