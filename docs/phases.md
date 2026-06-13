# Phase runbook index (A-O)

Phase summaries for the staged automation lanes. The full operator runbooks live
in [`examples/field-deploy/`](../examples/field-deploy/README.md). Phases A-D are
operational procedures documented in the runbooks; the sections below summarize
the phases with in-repo helpers and CLI lanes.

## Phase E execution readiness and post-action audit harness

Phase E is still readiness-only in this repository. `buildLiveRepairExecutionHarness` assembles the
final pre-execution gate report for a separately approved, target-specific, one-shot live repair: Phase D
packet, approval id/scope/expiry, expected target/head/base/repair key, allowed branch, fresh dry-run
evidence, `auto-safe-repair` action class, push budget, focused-check checkpoint, and runtime-context
contamination guard. `buildPostActionAuditEntry` defines the sanitized no-op/pushed/block closeout shape
with status/CI follow-up, terminal ledger marker, rollback/disable note, and evidence-hygiene fields.
These helpers describe readiness and audit evidence; they do not grant approval or perform production
branch mutation.

## Phase F fleet-safe controls and limited autonomy guardrails

Phase F keeps automation broad for observation and narrow for mutation. It lets operators scale check-only
reporting, dry-run evidence, and one-shot repair governance across a small fleet while preserving per-target locks,
state, notification dedupe, approval expiry, focused checks, push budgets, and the runtime/bootstrap contamination
guard. Status/check summaries expose a fleet operator brief with target tiers (`check-only`, `rehearsal-ready`,
`phase-d-ready`, `live-approved-once`), warning/block counts, affected targets, and dry-run/default-no-live-send
posture.

Live repair approvals are target-scoped to owner/repo, PR number, target id, branch, expected head/base, action
class, and expiry; consumed, expired, or head-invalidated approvals fail closed. The strict verify gate is required
by default for live repair: a target must define at least one focused check before any branch mutation path can
proceed, and operator approval cannot override a missing verify gate. If an approval is present but the current PR is
clean, pending, failed, unknown, merged, or disabled, Shepherd records a no-op/block audit, consumes or invalidates
the one-shot approval, and stops before worktree access. Repeated blocks/unknowns or failed checks produce concise
incident summaries with affected targets, operator action, and safe rollback/disable notes; status/check remains
available for visibility.

The limited autonomy lane is therefore: check/status and diagnosis are non-mutating, artifacts/rehearsal prepare
evidence only, and the only push lane remains `auto-safe-repair` with an unexpired one-shot approval, fresh Phase D/E
record for one target and exact argv, strict verification, contamination guard, push budget, and exact
`--force-with-lease` expected head. F4 is explicitly prohibited for standing live repair timers, aggregate live
`repair --all`, unattended force-pushes, or automatic expansion from one target to a fleet. `gh pr view --json` fetch
fields intentionally exclude unsupported fields such as `baseRefOid`; base OIDs stay internal state/evidence values
only.

## Phase G diagnose-only conflict bundles

Phase G strengthens diagnosis before repair. Use
[`phase-g-diagnose-only-conflict-context.md`](../examples/field-deploy/phase-g-diagnose-only-conflict-context.md) or the
`diagnose` lane when an operator or worker needs more context before deciding between `autoSafe`, `codeAssisted`,
`humanOnly`, no-op, or wait/recheck. `diagnose` runs the same read-only PR check path, fetches read-only
changed-file summaries, and writes `<target>-conflict-diagnosis.json` under the configured artifact dir.

A Phase G bundle should identify target/PR metadata and refs, summarize head/base evidence and mergeability/check
state, include known conflict paths from state or sandbox evidence, classify paths against policy, include relevant
changed-file summaries, attach only trimmed sandbox conflict context when needed, list focused command hints, record
evidence hygiene, and recommend wait/recheck, no-op, autoSafe rehearsal, code-assisted review, humanOnly handoff, or
block. It never pushes and does not edit the watched worktree.

The diagnose-only lane is non-mutating. It may write sanitized operator summaries or artifacts and may inspect a
disposable sandbox/rehearsal worktree, but it must not push, edit the watched worktree, send live provider messages,
read secrets, or carry approval forward into live repair. Re-run the contamination guard before posting PRs or
attaching artifacts.

## Phase H repair-plan handoff

Phase H turns a Phase G diagnose-only bundle into an operator-readable, non-mutating
`pr-shepherd-repair-plan-handoff/v1` package. Use
[`phase-h-repair-plan-handoff.md`](../examples/field-deploy/phase-h-repair-plan-handoff.md) when a worker needs to hand
off the next safe lane without mutating a branch: wait/recheck, no-op, autoSafe rehearsal, code-assisted artifact
review, humanOnly handoff, or block.

The handoff is source-backed by the bundle target/PR/head/base/check evidence and carries conflict classification,
changed-file summaries, diagnosis hints, focused check suggestions, stale-diagnosis detection, risks, blockers,
review artifact pointers for `codeAssisted`/`humanOnly` paths, and the exact later approval phase required before any
live repair. It never authorizes a push: autoSafe paths hand off to rehearsal, code-assisted paths hand off to
explicit review, human-only paths hand off to maintainers, and stale or runtime-context contaminated evidence blocks
closed with exact offending repo-relative paths.

`diagnose` embeds the repair-plan handoff in its JSON output. To derive one from an existing bundle without contacting
GitHub or mutating a branch, run:

```sh
node pr-shepherd.mjs repair-plan --diagnose-bundle path/to/target-conflict-diagnosis.json --output path/to/repair-plan-handoff.json
```

Phase H preserves the same ledger and evidence rules as earlier phases: post `Start` before analysis, close with
exactly one of `PR: <url>`, `Done`, or `Block`, and report `startCommentUrl` plus the matching terminal URL when
available. It must not run `repair`, push, create timers, paste raw transcripts, disclose secrets/private paths, or
carry approval forward into Phase D/E. Before posting a `PR` marker or attaching plan evidence, fail closed if the
branch diff or artifact bundle would include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
`IDENTITY.md`, or `.openclaw/**`.

Targets may provide diagnosis-only hints for repo-owned paths:

```json
"diagnosisHints": [
  {
    "path": "extensions/telegram/src/**",
    "summary": "Review outbound receipt and adapter mapping before choosing a resolver.",
    "commands": ["pnpm test extensions/telegram/src/outbound-adapter.test.ts"]
  }
]
```

Hint commands are suggestions only. Validation accepts path-specific notes and argv-array focused checks with a narrow
read-only allowlist (`npm/pnpm/yarn test|run`, `node --check|--test`, and safe `git diff --check`/`git grep`/`git show
--stat`/`git log --oneline`). It fails closed for shell metacharacters, mutation commands, network/write tools,
token/env reads, private absolute paths, broad globs, or OpenClaw runtime/bootstrap context evidence.

## Phase I review-state feedback

Phase I turns GitHub review state into an operator-safe feedback packet after a reviewable PR, Phase H handoff, or
operator issue receives reviewer feedback. Use
[`phase-i-review-state-feedback.md`](../examples/field-deploy/phase-i-review-state-feedback.md) to read `reviewDecision`,
latest reviews, comments, check state, mergeability, current head/base refs, and requested changes without mutating a
branch or treating a GitHub approval as live repair approval.

The feedback packet classifies the state as approved-no-op, changes-requested, comments-only, stale-review,
wait/recheck, or block, then names one safe next lane: continue observation, follow-up PR, rerun Phase G/H, Phase C
rehearsal candidate, human maintainer review, or block. `APPROVED` can close a docs/config review or support a review
PR marker, but it never bypasses failed/pending checks and never carries into Phase D/E. `CHANGES_REQUESTED`, stale
reviews, unavailable review state, contradictory CI, or unsafe requested actions keep mutation disabled until a human
records a separate safe plan.

Phase I keeps the same ledger and evidence boundaries as the earlier phases: post `Start` before collecting feedback,
close with exactly one of `PR: <url>`, `Done`, or `Block`, and report `startCommentUrl` plus the matching terminal URL
when available. Before posting a PR marker or attaching the feedback packet, fail closed if the branch diff or planned
artifact evidence would include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
`.openclaw/**`; report only repo-relative offending paths, not file contents.

## Phase J supervised rehearsal queue

Phase J turns a recorded Phase I `accepted-for-rehearsal` decision into a supervised, dry-run-only queue packet. Use
[`phase-j-supervised-rehearsal-queue.md`](../examples/field-deploy/phase-j-supervised-rehearsal-queue.md) or
`rehearsal-queue` when an operator wants the next safe action queued without branch mutation:

```sh
node pr-shepherd.mjs rehearsal-queue --feedback path/to/review-feedback.json --pr-state path/to/current-pr.json --state path/to/state.json --output path/to/phase-j-rehearsal-queue.json
```

The packet schema is `pr-shepherd-supervised-rehearsal-queue/v1` and embeds a
`pr-shepherd-rehearsal-dry-run-packet/v1` with the exact `rehearse` argv, expected head/base refs, repair key,
operator checklist, freshness/ref gates, and runtime-context contamination guard. It is always `dryRunOnly`,
`supervised`, `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and `noLiveApproval=true`.
`CHANGES_REQUESTED`, stale or expired feedback, non-dirty PR state, mismatched refs, unsupported outcomes, or
runtime/bootstrap evidence (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
`.openclaw/**`) block the queue with exact offending repo-relative paths. Phase J may queue a dry-run rehearsal, but
it never runs live `repair`, creates standing timers, pushes, or carries approval into Phase D/E.

## Phase K rehearsal evidence digest

Phase K turns completed Phase C/J dry-run rehearsal evidence into a compact, operator-readable digest and a
fail-closed `pr-shepherd-phase-d-candidate-gate/v1`. Use
[`phase-k-rehearsal-evidence-digest.md`](../examples/field-deploy/phase-k-rehearsal-evidence-digest.md) when the source
rehearsal packet is already recorded, after `rehearse --target <id>`, and before preparing any Phase D operator
packet. The digest schema is `pr-shepherd-rehearsal-evidence-digest/v1` and records only sanitized target, PR,
expected/current refs, repair key, source evidence links, dry-run command summary, focused-check verdicts, check
counts, approval-package summary, freshness, rollback note, gate outcomes, and evidence hygiene.

It always remains evidence-only: `dryRunEvidenceOnly=true`, `productionMutation=false`, `pushAllowed=false`,
`mutatesBranch=false`, and `noLiveApproval=true`. `candidateAllowed=true` means the rehearsal is eligible to become
Phase D input; it is not live repair approval and still cannot bypass Phase D/E one-shot metadata, focused checks, push
budget, expected-head `--force-with-lease`, or a fresh contamination check. Missing rehearsal package/ledger entries,
non-dirty current PR state, stale or mismatched refs, expired evidence, missing strict focused checks, or
runtime/bootstrap evidence (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
`.openclaw/**`) close as `Block` with exact repo-relative offending paths or blocked reasons.

Phase K preserves the same ledger and contamination boundaries as earlier phases: post `Start` before reading or
publishing digest evidence, close with exactly one of `PR: <url>`, `Done`, or `Block`, report `startCommentUrl` plus the
matching terminal URL when available, and never approve live `repair`, create timers, push, or carry approval into
Phase D/E.

## Phase L Phase D operator packet assembler

Phase L turns an allowed, fresh Phase K candidate into a sanitized `pr-shepherd-phase-d-operator-packet/v1` for a
human GO/NO-GO/Block decision. Use
[`phase-l-phase-d-operator-packet-workflow.md`](../examples/field-deploy/phase-l-phase-d-operator-packet-workflow.md) or
`node pr-shepherd.mjs phase-d-packet --config config.json --target <id>` after the Phase K digest records
`candidateAllowed=true`, rehearsal evidence is in state, and before any operator records one-shot Phase D/E approval
metadata. Phase L re-reads current PR refs and dirty classification, confirms the candidate gate, focused-check gate,
repair key, exact live argv under consideration, allowed branch, push budget, rollback note, abort criteria, approval
config template, closeout markers, and fail-closed gates, then publishes a short sanitized packet for review.

It is approval preparation only: `productionMutation=false`, `pushAllowed=false`, `mutatesBranch=false`, and
`noLiveApproval=true`; live `repair` is not run, pushes are not attempted, timers are not created, approval config is not
edited on the operator's behalf, and Phase K candidacy is not treated as live repair approval. Phase L keeps the same
ledger boundary as earlier phases: post `Start` before packet assembly, close with exactly one of `PR: <url>`, `Done`,
or `Block`, and report `startCommentUrl` plus the matching terminal URL when available. Before posting a PR marker,
attaching packet evidence, or letting a runner create a review PR, `--branch-diff-path` and `--artifact-evidence-path`
inputs plus branch diff paths and planned artifact evidence are checked against the runtime/bootstrap denylist; fail
closed on `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`, reporting
only exact repo-relative offending paths.

## Phase M bounded auto-safe minor repair operations

Phase M is the narrow, supervised lane for one reviewable minor repair after prior evidence or an operator issue has
reduced the work to a deterministic patch. Use
[`phase-m-bounded-auto-safe-minor-repair.md`](../examples/field-deploy/phase-m-bounded-auto-safe-minor-repair.md) only
when the operator provides a bounded scope, approved path set, diff budget, source evidence, and verification plan. It
is intended for documentation/runbook clarifications, example text, small test expectation fixes that match documented
behavior, formatting, spelling, or link corrections.

It is not standing automation: `autoSafeMinor=true`, `productionMutation=false`, `liveRepair=false`,
`pushAllowed=false`, and `timers=false`. Phase M starts with `Start`, closes with exactly one of `PR: <url>`, `Done`, or
`Block`, and reports `startCommentUrl` plus the matching terminal URL when available. Before editing, before attaching
evidence, and again before PR creation, the final diff and planned evidence paths are checked against the
runtime/bootstrap denylist; fail closed on `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
`IDENTITY.md`, or `.openclaw/**`, reporting only exact repo-relative offending paths.

## Phase N minor-auto execution controller operations

Phase N documents the built-in controller path for a preconfigured `automaticActions.minorAutoRepair` target. Use
[`phase-n-minor-auto-execution-controller.md`](../examples/field-deploy/phase-n-minor-auto-execution-controller.md) when
one selected dirty PR has `scope="minor-auto-safe-repair"`, `actionClass="auto-safe-repair"`, branch/path/resolver
allowlists, focused verification, push budget, and fresh rehearsal evidence or explicit `zeroRehearsalSafe=true`.

The controller plans first, then dispatches only the minor-auto `auto-safe-repair` lane, runs focused checks, computes
exact changed paths and resolver identities, re-runs the minor-auto gate immediately before push, blocks on any
allowlist/risk/evidence contamination failure, verifies the expected remote head, and pushes only with
`--force-with-lease`. Phase N starts with `Start`, closes with `Done` or `Block`, and records sanitized gate/audit
evidence. It does not permit multi-target mutation, failed or pending CI repair, allowlist widening during execution,
broad live repair, or retries after drift without a fresh Start marker and fresh gates.

## Phase O minor-auto production rollout controls

Phase O adds the default-off rollout layer for the Phase N controller. Use
[`phase-o-minor-auto-production-rollout-controls.md`](../examples/field-deploy/phase-o-minor-auto-production-rollout-controls.md)
for rollout mode policy and post-push controls, and
[`phase-o-minor-auto-rollout-operations.md`](../examples/field-deploy/phase-o-minor-auto-rollout-operations.md) for the
operator ledger/runbook sequence. Move one target by one tier at a time through `observe-only`, `sandbox-proof`,
`minor-auto-dry-run`, `minor-auto-live-limited`, pause, or rollback. The rollout packet records source-backed Phase N
evidence, exact policy shape, focused verification, push budget/cooldown, rollback owner/triggers, branch diff paths,
planned evidence paths, and the runtime/bootstrap contamination guard result.

Live-limited rollout requires explicit target/path/resolver policy, a branch allowlist, ownership guard, push budget,
cooldown/circuit-breaker checks, clean evidence hygiene, post-push CI observation, rollback/revert guidance on failed
or unstable outcomes, and dashboard summaries for candidates, auto-repaired, blocked-needs-approval,
stale-refresh-required, circuit-breaker-open, and post-push states. Phase O starts with `Start`, closes with exactly one
of `PR: <url>`, `Done`, or `Block`, and reports `startCommentUrl` plus the matching terminal URL when available. A
successful rollout step does not approve broad minor-auto repair, multi-target mutation, allowlist widening during
execution, auto-merge, fix-until-green loops, provider sends, Gateway restarts, raw runtime/bootstrap evidence, or any
future branch push; every live repair still needs a fresh Phase N controller run and final gates, and
major/risky/semantic/ops-impact changes escalate to Seo Jin On approval.
