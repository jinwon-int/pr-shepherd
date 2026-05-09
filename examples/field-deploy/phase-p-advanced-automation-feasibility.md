# Phase P — Advanced Automation Feasibility Review

Phase P records the implementation posture for the advanced automation ladder after Phase O. The ladder is feasible only as separate, user-selectable, default-off policy lanes; it must not become one escalating automation flag.

## Feasibility verdict

- **L3 minor-auto post-push auto-merge: feasible as the next narrow implementation lane.** Merge only branches that have already passed the Phase N/O minor-auto push path and still prove minor-auto provenance at merge time.
- **L4 bounded fix-until-green: feasible later as a constrained retry controller.** It is not an exploratory repair loop; each retry must stay within the same target, path allowlist, resolver allowlist, risk class, attempt budget, and focused-check plan.
- **L5 risky auto-push: feasible first as approval-prepared evidence.** Shepherd may prepare a packet for one-click approval, but risky mutation remains human-approved unless a separate fleet-governed unattended lane is explicitly selected.
- **Unattended risky auto-push: defer.** Treat it as a Phase S governance topic after L3/L4/approval-prepared evidence has proven stable.

## Phase P auto-merge admission gates

A post-push auto-merge candidate is eligible only when every gate is true immediately before merge:

1. Target policy explicitly enables minor-auto auto-merge for the target, branch, path scope, resolver, merge method, and base branch.
2. The PR branch has minor-auto provenance from the current Phase N/O controller run, including expected head, changed paths, resolver identity, audit packet, and post-push observation.
3. Current head/base refs are fresh; the candidate is not stale and no pending, failed, skipped-required, or unknown required check remains.
4. Branch protection and review requirements are satisfied according to the current GitHub state.
5. Changed paths and resolver identity still match the original minor-auto allowlists.
6. No risky labels, review objections, blocking comments, source/lockfile/dependency/CI/security/config/provider/runtime file classes, or `codeAssisted`/`humanOnly` policy outcomes are present.
7. The runtime/bootstrap contamination guard passes for branch diff paths and planned evidence paths.

Any ambiguity blocks closed and routes to operator approval.

## Shared decision object

Use one reusable decision record before any mutation-capable lane:

```json
{
  "eligible": false,
  "blockedReason": [],
  "provenance": "minor-auto|approval-prepared|none",
  "riskClass": "minor|bounded-retry|risky",
  "policyId": "target-scoped-policy-id",
  "expectedHead": "head-sha",
  "checksSnapshot": [],
  "auditPacketPath": "sanitized/repo-relative/path"
}
```

Dry-run/report, auto-merge, bounded retry, and approval-prepared risky push should share the same gate evaluator so their `Done`, `PR: <url>`, and `Block` evidence remains explainable.

## Later-lane constraints

### L4 bounded fix-until-green

- Default off; max attempts must be configured and capped at 1–2.
- Retry state must record original target, branch, path scope, resolver, risk class, diff fingerprint, focused-check result, and stop reason.
- Circuit-break on semantic drift, new file class, allowlist drift, stale refs, failed precondition, reviewer objection, post-push instability, or budget exhaustion.
- Each attempt needs fresh focused checks and a sanitized audit packet.

### L5 approval-prepared risky push

- Default off for mutation; packet generation may be enabled independently.
- Approval packet must include exact diff scope, command argv, expected head/lease, approval scope and expiry, focused checks, rollback/disable plan, notification target, risk class, and contamination guard result.
- One-click approval authorizes one bounded push only; it does not create standing approval or widen policy.

## Closeout and evidence hygiene

Phase P review work starts with `Start` and closes with exactly one terminal marker: `PR: <url>`, `Done`, or `Block`. Return `startCommentUrl` plus `prUrl`, `doneCommentUrl`, or `blockCommentUrl` when available.

Before PR creation or evidence publication, fail closed if branch diff paths or planned artifact evidence paths include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`. Report only the exact repo-relative offending paths; do not include file contents, secrets, private host paths, raw shell transcripts, or raw session dumps.
