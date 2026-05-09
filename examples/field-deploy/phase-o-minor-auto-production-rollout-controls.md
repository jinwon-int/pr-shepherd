# Phase O — Minor-Auto Production Rollout Controls

Phase O is the production rollout layer for the Phase N `minor-auto-safe-repair` controller. It keeps production auto-repair default-off and operator-visible while allowing one target to move through explicit rollout modes.

## Rollout modes

Configure `automaticActions.minorAutoRepair.rolloutMode` per target. Missing mode is treated as `observe-only`.

- `observe-only` — never mutates. Reports minor-auto candidates, block reasons, stale-refresh-required state, and circuit-breaker state.
- `sandbox-proof` — production branches remain untouched; use only disposable/local proof evidence.
- `minor-auto-dry-run` — runs the controller gates and focused verification without pushing.
- `minor-auto-live-limited` — permits at most one bounded minor-auto push when all Phase M/N gates, allowlists, budget, cooldown, ownership, evidence-hygiene, and expected-head `--force-with-lease` gates pass.

## Required target policy

Live-limited rollout requires all of the following, target-scoped:

- `enabled=true`, `scope="minor-auto-safe-repair"`, and `actionClass="auto-safe-repair"`.
- Non-empty `branchAllowlist`, explicit `pathAllowlist`, and explicit `resolverAllowlist`.
- Per-target `autoPushLimit24h`; optional `repoPushLimit24h` and `cooldownMs` further reduce pushes.
- Circuit breaker state closed and no previous failed or unstable post-push observation.
- Maintainer-owned head branches blocked unless `allowMaintainerOwnedBranches=true` is explicit.

## Hard safety boundaries

No auto-merge, no fix-until-green loop, no broad `--all` live mutation, no `codeAssisted`/`humanOnly` auto-push, no lockfile/dependency/security/auth/config/runtime/provider-behavior auto-push, no provider sends, no Gateway restart, and no secret/private-path/runtime-context evidence.

Major, risky, semantic, ops-impact, provider-behavior, `codeAssisted`, or `humanOnly` changes escalate to Seo Jin On approval.

## Post-push observation

After a live-limited push, record `pr-shepherd-minor-auto-post-push-observation/v1` during the configured observation window. Outcomes are:

- `post-push-clean` — status is clean; no auto-merge is allowed.
- `stale-refresh-required` — refresh PR state before any further action.
- `post-push-failed` or `post-push-unstable` — open the circuit breaker, stop further attempts, record `pr-shepherd-minor-auto-rollback-guidance/v1`, and escalate for operator approval before revert/rollback.

## Dashboard brief

The status/operator brief summarizes rollout modes, candidates, auto-repaired items, blocked-needs-approval items, stale-refresh-required items, circuit-breaker-open items, and post-push outcomes. Keep evidence sanitized and link only to safe artifacts.

## Closeout markers

Start with `Start`. Close with exactly one of `Done` or `Block`, and return `startCommentUrl` plus `doneCommentUrl` or `blockCommentUrl` when available.

Before evidence publication or PR creation, fail closed if branch diff or artifact evidence includes `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`; report only exact repo-relative offending paths.
