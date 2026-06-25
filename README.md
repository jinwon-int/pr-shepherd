# OpenClaw PR Shepherd MVP

Small operational CLI to watch and conservatively repair upstream PR drift, built
around fail-closed gates: read-only observation is automated, while every
branch-mutating action stays a separate, logged, one-shot operator approval.

## Quickstart

```bash
cp config.example.json config.json   # keep config.json untracked; fill in operator-local paths
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json --all
node pr-shepherd.mjs canary --config config.json --target openclaw-78261
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
```

Promotion beyond check-only monitoring (rehearsal, diagnosis, live repair) is an
explicit operator decision; see the [operations manual](docs/operations.md).

## Commands

```bash
node pr-shepherd.mjs validate --config config.json
node pr-shepherd.mjs status --config config.json
node pr-shepherd.mjs status --config config.json --all
node pr-shepherd.mjs canary --config config.json --target openclaw-78261
node pr-shepherd.mjs check --config config.json
node pr-shepherd.mjs check --config config.json --target openclaw-78261
node pr-shepherd.mjs check --config config.json --all
node pr-shepherd.mjs check-canary --config config.json --target openclaw-78261
node pr-shepherd.mjs diagnose --config config.json --target openclaw-78261 --artifact-dir ./artifacts
node pr-shepherd.mjs rehearsal-queue --feedback ./artifacts/review-feedback.json --pr-state ./artifacts/current-pr.json --state ./state/openclaw-78261.json --output ./artifacts/phase-j-rehearsal-queue.json
node pr-shepherd.mjs rehearse --config config.json --target openclaw-78261
node pr-shepherd.mjs repair --config config.json --dry-run
node pr-shepherd.mjs repair --config config.json --target openclaw-78261 --dry-run
node pr-shepherd.mjs repair --config config.json --all --dry-run
node pr-shepherd.mjs repair --config config.json
node pr-shepherd.mjs repair --config config.json --artifact-dir ./artifacts --no-keep-failed-rebase-worktree
npm run doctor:field-deploy
npm run proof:sandbox
```

For backward compatibility, omitting both `--target` and `--all` runs the first configured target.
Prefer explicit target selection in automation so operator logs show whether the run was single-target
or all-target.

## Safety defaults

- For backward compatibility, omitting both `--target` and `--all` runs only the first configured target and emits a warning when multiple targets exist.
- Use `--target <id>` or `--target owner/repo#number` to narrow a run; use `--all` to process every configured target serially.
- Each target keeps its own state file and lock file, so one repo/PR cannot share repair state with another.
- Duplicate runs for the same target are blocked by that target's exclusive lock.
- Auto pushes are limited to 5 per rolling 24h.
- Push uses only `git push --force-with-lease=<branch>:<expected-remote-head>`.
- The CLI refuses to push if the remote head changed after fetch.
- CI failures are reported, never auto-fixed.
- Complex conflicts are escalated.
- Conflict handling is tiered by target `conflictPolicy`:
  - `autoSafe`: deterministic resolvers only; focused checks must pass before the existing `--force-with-lease` push path runs.
  - `codeAssisted`: PR-owned/source conflicts are diagnosed and written to an artifact, but push is blocked by default unless an operator explicitly approves assisted follow-up.
  - `humanOnly`: lockfiles, broad generated/security-sensitive files, unlisted paths, or unrelated subsystems stop immediately for manual handling.
- Merged PRs mark state as `disabled`.

## Status classification

- `merged`: `mergedAt` exists or state is `MERGED`; notify once and disable.
- `clean`: mergeable `MERGEABLE`, merge state `CLEAN`, no failed/pending checks.
- `unstable`: mergeable `MERGEABLE`, merge state `UNSTABLE`, pending checks and no failures; no repeat notification until pending exceeds configured duration.
- `failed`: one or more failed checks; report failed check names/details; no repair.
- `dirty`: mergeable `CONFLICTING` or merge state `DIRTY`; repair candidate.

## Documentation

- [Operations manual](docs/operations.md): operating model, approval and ledger
  procedures, sandbox proof, field deployment, rollback, doctor, check-only
  rollout, focused verification, and scheduling.
- [Phase runbook index](docs/phases.md): Phase E-O summaries with links to the
  full [field-deploy runbooks](examples/field-deploy/README.md).
- [Multi-target and worktree operations](docs/multi-target.md).
- [Notification integration](docs/notifications.md): stdout/command/OpenClaw
  notifier wiring and Telegram canary noise control.
- [Runtime-context contamination policy](docs/runtime-context-policy.md):
  generated from `lib/policy.mjs`; `npm run docs:policy:check` fails CI when any
  document drifts from the enforced denylist.
- [Event-driven check triggers](examples/event-triggers/README.md): optional
  latency reduction on top of polling timers.

## Repository packaging

This repository is intentionally dependency-light. Runtime requirements:

- Node.js 20+
- `git`
- GitHub CLI `gh` authenticated with read access to the watched PR and write access only when live repair/push is explicitly approved
- `pnpm` only inside the watched OpenClaw worktree for focused verification

### GitHub access providers

Read-only GitHub access goes through a provider selected per target via `github.provider` (or the
`PR_SHEPHERD_GITHUB_PROVIDER` environment variable):

- `gh` (default): shells out to the authenticated `gh` CLI exactly as before.
- `rest`: talks to the GitHub API directly using `GITHUB_TOKEN`/`GH_TOKEN` from the environment. PR state uses
  the GraphQL endpoint so classifications match `gh pr view --json` field-for-field; changed-file summaries use
  the paginated REST endpoint and stay best-effort. Transient 5xx errors are retried with backoff
  (`github.retryDelaysMs` to tune), rate limits fail closed immediately with the reset time, and
  `github.apiBaseUrl` supports GitHub Enterprise hosts.

Both lanes are read-only; pushes never go through a provider and keep the existing `--force-with-lease` path.

CI in this repository only runs syntax and unit fixture tests. It does not access GitHub PR state or push branches.

## Public source visibility boundary

This repository is being prepared for possible public source visibility. A
public repository setting would be source-only: it would not approve release or
tag creation, package/image publication, production deploy/restart/reload,
database mutation, provider or Telegram sends, credential movement, history
rewrite, or any other live operation.

Runtime credentials and private operational data must stay outside the
repository. Example configuration must use placeholders only.
