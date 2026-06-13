# Phase P/Q/R advanced automation lanes (operator runbook)

These lanes implement levels L3-L5 of the automation ladder (#123). They are
all default-off, target-scoped, and gated. They are gate/packet builders, not
standing automation: nothing here pushes, merges, or schedules on its own. An
operator (or a higher-level controller) consumes the gate/packet, and the
mutation itself stays a separate, explicitly approved, logged action.

Start every Phase P/Q/R operator task with a `Start` ledger marker and close
with exactly one of `PR: <url>`, `Done`, or `Block`, reporting `startCommentUrl`
plus the matching terminal URL when available. Before attaching any packet or
evidence, fail closed if the branch diff or artifact bundle would include
`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`,
or `.openclaw/**`; report only the repo-relative offending paths.

## Phase P — minor-auto post-push auto-merge gate

Use `buildAutoMergeGate` for a PR that was already pushed by the minor-auto lane
and is awaiting merge. It only reports `mergeAllowed=true` when every final gate
passes: provenance proves the branch is a minor-auto output and matches the
original target/path/resolver/risk scope, the expected head is unchanged,
required checks are clean with no pending/failed/unknown ambiguity, branch
protection and review requirements are satisfied, changed paths and resolver are
inside the allowlist, there is no reviewer objection or risky signal, the
circuit breaker is closed, and there is no contamination. The live merge path
(`executeAutoMergeGate` with `recompute`) re-evaluates the gate at the final
moment and fails closed on any change.

```json
"automaticActions": {
  "autoMerge": {
    "enabled": true,
    "scope": "minor-auto-merge",
    "mergeMethod": "squash",
    "targetBranch": "main",
    "requiredChecks": ["ci"],
    "pathAllowlist": ["CHANGELOG.md", "docs/**"],
    "resolverAllowlist": ["merge-changelog-top-entry"],
    "branchAllowlist": ["fix/telegram-outbound-visible-receipts"]
  }
}
```

## Phase Q — bounded same-scope retry controller

Use `buildBoundedRetryController` to decide whether one more bounded attempt may
run after a minor-auto attempt did not pass focused checks. It is capped at 1-2
attempts and restricted to the same target/path/resolver/risk class. A
same-scope focused-check pass or budget exhaustion is a safe stop (`Done`); any
drift, new file class, stale refs, reviewer objection, post-push instability, or
contamination opens the circuit breaker (`Block`) and routes to a human. Record
each attempt with `appendBoundedRetryAttempt` so the attempt number, original
scope, diff fingerprint, and focused-check result are auditable.

```json
"automaticActions": {
  "boundedRetry": {
    "enabled": true,
    "scope": "bounded-same-scope-retry",
    "maxAttempts": 2,
    "budgetPerDay": 4
  }
}
```

## Phase R — risky-change approval-prepared packet

Use `buildRiskyChangeApprovalPacket` to prepare a complete, non-mutating packet
for a risky change so an operator can make a one-click decision. The packet
shows the exact diff scope, risk class and why it is risky, the command argv
under consideration, expected head/lease, the one-shot approval scope and
expiry, required focused checks, a rollback/disable plan, the notification
target, and the contamination-guard result. One explicit, unexpired,
branch-scoped, head-matched approval authorizes exactly one bounded push; it
cannot become standing or widen policy. The packet never pushes.

```json
"automaticActions": {
  "riskyChangeApproval": {
    "enabled": true,
    "scope": "risky-change-approval",
    "approvalId": "risky-2026-06-13-1",
    "approvedBy": "seo-jin-on",
    "approvedAt": "2026-06-13T00:00:00Z",
    "expiresAt": "2026-06-13T02:00:00Z",
    "branchAllowlist": ["fix/telegram-outbound-visible-receipts"],
    "expectedHeadOid": "<pushed-head-oid>"
  }
}
```

## Hard boundaries

- All three lanes are default-off and require explicit per-target opt-in.
- No semantic/risky change is auto-merged; only proven minor-auto outputs.
- No open-ended fix-until-green loop; bounded retries route to a human on drift.
- No silent risky auto-push; risky changes are packet-prepared for approval.
- No provider sends, Gateway restarts, or runtime/bootstrap evidence leakage.
- Phase S (unattended risky auto-push governance, #130) stays planning-only
  until P/Q/R prove stable.
