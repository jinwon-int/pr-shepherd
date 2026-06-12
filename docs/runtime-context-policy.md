<!-- GENERATED FILE - do not edit by hand. Source: lib/policy.mjs. Regenerate with: npm run docs:policy -->

# Runtime-context contamination policy

This document is generated from the constants in `lib/policy.mjs` so the
documented policy can never drift from the enforced policy. Every gate that
writes evidence, attaches artifacts, or pushes a branch fails closed when one
of these repo-relative paths would be included.

## Denylisted OpenClaw runtime/bootstrap context paths

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Block reports must name only the offending repo-relative paths, never the file
contents.

## Automatic action classes

- `recheck`
- `diagnose`
- `diagnose-only`
- `notify-escalate`
- `repair-rehearsal`
- `conflict-artifact`
- `auto-safe-repair`
- `block`

## Minor-auto rollout modes

- `observe-only`
- `sandbox-proof`
- `minor-auto-dry-run`
- `minor-auto-live-limited`

## Fleet target state tiers

- `check-only`
- `rehearsal-ready`
- `phase-d-ready`
- `live-approved-once`

## Key defaults

| Constant | Value |
| --- | --- |
| `DEFAULT_ACTION_LEDGER_LIMIT` | 50 entries |
| `DEFAULT_OBSERVATION_LEDGER_LIMIT` | 288 entries |
| `DEFAULT_SITUATION_REPORT_EVERY_MS` | 6h |
| `MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS` | 1h |
| `DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS` | 6h |
| `DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS` | 1h |
