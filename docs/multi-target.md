# Multi-target and worktree operations

## Worktree requirement

`config.json` should point each live repair target at a dedicated prepared worktree, for example:

```text
<worktree-root>/openclaw-pr-78261
```

Before live repair, prepare the worktree with remotes:

```bash
git clone git@github.com:jinon86/openclaw.git <worktree-root>/openclaw-pr-78261
cd <worktree-root>/openclaw-pr-78261
git remote add upstream https://github.com/openclaw/openclaw.git || true
git fetch origin fix/telegram-outbound-visible-receipts
git fetch upstream main
```

The CLI requires a clean worktree before mutation. For multiple targets, configure separate
`worktreePath`, `statePath`, and `lockPath` values per PR.

## Multi-target operations

PR Shepherd can watch multiple repositories and PRs from one config by adding one object per PR to
`targets[]`. Treat every target as an isolated unit: give it a stable `id`, its own worktree, state
file, lock file, push budget, notification dedupe state, conflict policy, and focused checks.

Example shape for a second target:

```json
{
  "id": "owner-repo-123",
  "pr": "owner/repo#123",
  "owner": "owner",
  "repo": "repo",
  "number": 123,
  "headBranch": "feature/example",
  "baseBranch": "main",
  "worktreePath": "<worktree-root>/owner-repo-123",
  "statePath": "<state-root>/owner-repo-123.json",
  "lockPath": "<lock-root>/owner-repo-123.lock",
  "autoPushLimit24h": 5,
  "conflictPolicy": {
    "autoSafe": [],
    "codeAssisted": [],
    "humanOnly": ["package-lock.json"]
  },
  "focusedChecks": ["npm test"],
  "notify": { "mode": "stdout" }
}
```

Operational rules:

- Use `--target <id>` for one PR when approving a repair or investigating a specific notification.
- Use `--all` for routine checks across all enabled targets; all-target repair should normally start
  with `--dry-run` and only move to a live run after explicit operator approval.
- All-target runs are serial. A failure in one target should be reported in the aggregate result and
  must not hide later target results.
- State, lock, artifact, and notification paths must be unique per target. Do not share a state file
  or lock file between repositories or PR numbers.
- Keep `artifact-dir` outside the watched worktrees, and review artifacts before attaching them to
  issues or PRs. They must not contain secrets, private worktree paths, or OpenClaw runtime/bootstrap
  context files.
- A force push is only allowed through the existing per-target `--force-with-lease=<branch>:<head>`
  guard after the target's focused checks pass and the remote head is revalidated.

Hardening checklist for fleet operators:

- Treat `autoPushLimit24h`, recent repair failure keys, and notification cadence as per-target budgets.
  A noisy or exhausted target should not suppress checks, summaries, or notifications for another PR.
- Configure `staleLockMs` only after confirming the scheduler cannot leave legitimate long-running
  repairs behind; stale-lock cleanup must be scoped to that target's lock file.
- Rotate or archive state one target at a time. Before moving a state file, capture `status --target <id>`
  so cooldowns, dedupe keys, and action-ledger entries are not lost accidentally.
- Use `status --all` as the operator summary for mixed fleets: it should show each target's current
  kind, failed/pending check counts, recent push budget, notification key, and action-ledger summary.
- Keep live repair target-specific by default. If an operator approves a rare all-target live repair,
  the approval record must name every covered target and branch before the command starts.

### Multi-target systemd patterns

For one timer per PR, instantiate the included template with the target id:

```bash
systemctl enable --now pr-shepherd@openclaw-78261.timer
systemctl enable --now pr-shepherd@owner-repo-123.timer
```

For a single aggregate checker, use a dedicated non-template unit whose command runs all targets:

```ini
[Service]
Type=oneshot
WorkingDirectory=<pr-shepherd-repo>
ExecStart=/usr/bin/node <pr-shepherd-repo>/pr-shepherd.mjs check --config <pr-shepherd-repo>/config.json --all
```

Keep live repair units disabled by default. When a repair is approved, prefer a one-shot command with
`--target <id>` so the operator approval, logs, state update, and force-with-lease guard are scoped to
one PR.
