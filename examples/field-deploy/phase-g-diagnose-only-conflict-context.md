# Phase G diagnose-only operations and conflict context workflow

Phase G adds a non-mutating diagnosis lane before any rehearsal or live repair path. Its job is to give an operator or worker enough sanitized, source-backed context to choose the next safe class of action: `autoSafe`, `codeAssisted`, `humanOnly`, no-op, or wait/recheck. It does not approve repair, push branches, contact live providers, or create standing automation.

## Scope and entry conditions

Enter Phase G when a target is dirty, conflicting, failed, unknown, or noisy enough that ordinary `check`/`status` output is not enough to decide the next step.

Before starting:

- Post `Start` in the operator ledger and save `startCommentUrl` when available.
- Name one target id and PR; avoid fleet-wide diagnosis unless every target is listed and the command remains non-mutating.
- Confirm the intended action class is diagnose-only: no live `repair`, no live `--force-with-lease`, no provider sends, no Gateway restart, and no OpenClaw PR branch mutation.
- Decide where sanitized artifacts may be written. Prefer an operator-owned artifact directory outside any public branch unless a review PR explicitly needs the documentation or fixture.
- Run the runtime/bootstrap contamination guard on branch diff and planned artifact paths before closeout.

If any condition is missing, close with `Block` and report only the missing control or offending repo-relative path.

## Diagnose-only action lane

Treat `diagnose` as a read-only or sandbox-only action class:

- **Allowed:** fetch PR metadata, read state, summarize mergeability/checks, inspect configured conflict policy, collect changed-file names and safe summaries, run explicitly allowed read-only commands, and write sanitized operator summaries or artifacts.
- **Sandbox-only:** generate conflict context by rebasing or merging only in a disposable local worktree or rehearsal sandbox that is not the watched production worktree.
- **Forbidden:** pushing, force-with-lease, editing the watched worktree, committing, posting live provider reports, reading secrets, expanding GitHub scopes, auto-merging, or retrying until green.
- **Valid outcomes:** `autoSafe` candidate, `codeAssisted` candidate, `humanOnly`, no-op, wait/recheck, or `Block`.

A diagnose-only result can support a later Phase C rehearsal or Phase D/E repair decision, but it never carries approval forward by itself.

## Conflict context bundle

A useful Phase G bundle is small, reproducible, and source-backed. Include these sections when available:

1. **Target identity:** target id, repo, PR number/url, head branch, base branch, head owner, base owner, last seen head/base evidence, and current action class.
2. **PR state:** mergeability, merge state status, review decision, updated time, merged/disabled state, and a concise check summary with failed, pending, ignored, or unknown checks.
3. **Conflict paths:** repo-relative file paths from conflict policy, sandbox conflict output, or changed-file overlap. Classify each as `autoSafe`, `codeAssisted`, `humanOnly`, or unclassified.
4. **Changed-file summaries:** path, status, additions/deletions when available, and why the path matters. Do not paste full diffs by default.
5. **Conflict context:** minimal zdiff3-style hunks or equivalent local sandbox excerpts only when they are needed to explain the conflict. Trim unrelated lines and redact secrets.
6. **Focused command hints:** read-only validation or focused checks that an operator may run later, with the source of each hint and whether it is repo-owned, config-owned, or operator-owned.
7. **Recommended next action:** one of wait/recheck, no-op, autoSafe rehearsal, code-assisted artifact review, human-only handoff, or block, plus the reason.
8. **Evidence hygiene:** contamination guard result, artifact paths, redactions applied, and confirmation that no private host paths, tokens, chat ids, raw provider payloads, raw session dumps, or runtime/bootstrap context file contents are included.

Keep raw logs private. Publish summaries or links only after the hygiene check passes.

## Conflict context workflow

Use this order so diagnosis cannot drift into repair:

1. Run `node pr-shepherd.mjs status --config config.json --target <id>` to capture local state without contacting GitHub.
2. Run `node pr-shepherd.mjs check --config config.json --target <id>` or `check-canary` only when a fresh GitHub classification is needed and notifications remain dry-run or separately approved for check-only reporting.
3. Collect PR metadata with supported fields only. Do not reintroduce unsupported `gh pr view --json` fields such as `baseRefOid`.
4. Compare changed-file paths against the target `conflictPolicy` and the runtime/bootstrap denylist.
5. If deeper conflict context is needed, create or reuse a disposable sandbox/rehearsal worktree, enable merge conflict style such as `zdiff3` there, and discard the sandbox after extracting sanitized snippets.
6. Build the bundle from sanitized data. Replace private absolute paths with stable labels such as `<worktree-root>` or `<artifact-root>`.
7. Re-run the contamination guard against both branch diff and planned artifact paths before posting a terminal marker.

Stop immediately if diagnosis requires mutating the watched worktree, reading secrets, widening credentials, or attaching denied paths.

## Optional per-repo diagnosis hints

Repositories may define diagnosis hints for operator guidance only. These hints must not grant mutation authority.

Recommended shape:

```json
{
  "diagnosisHints": {
    "paths": [
      {
        "path": "src/example.js",
        "owner": "team-or-component",
        "summary": "Why this path is usually sensitive",
        "checks": [
          { "argv": ["npm", "test", "--", "example"], "reason": "focused read-only signal" }
        ],
        "notes": ["Prefer human review when generated files and source files both change."]
      }
    ]
  }
}
```

Fail closed when a hint contains:

- absolute paths, `..`, private host paths, or runtime/bootstrap context paths
- shell metacharacters, chained commands, command substitution, pipes, redirection, or inline environment reads
- commands that mutate files, install dependencies, push, publish, call live providers, or write network state
- secret-looking values, token/env var reads, credentialed URLs, chat ids, or provider payloads
- path globs so broad that they hide the affected subsystem

Allowed commands should be argv arrays from a small allowlist, run only when an operator explicitly asks, and remain evidence hints rather than automated repair gates.

## Operator next-action map

- **wait/recheck:** GitHub data is unknown, pending, or stale; run a later check-only refresh.
- **no-op:** PR is clean, merged, disabled, or the warning was already resolved.
- **autoSafe rehearsal:** conflict paths match deterministic `autoSafe` policy, focused checks are available, and no hygiene guard blocks evidence.
- **code-assisted review:** PR-owned/source conflicts need a human or worker to inspect sanitized artifacts before any patch proposal.
- **humanOnly:** lockfiles, security-sensitive files, generated broad changes, maintainer-owned branch risk, or unclassified subsystem conflicts are present.
- **Block:** evidence hygiene, approval scope, target identity, branch/head, or command safety fails closed.

## Closeout markers

Close Phase G with exactly one terminal marker:

- `Done` when diagnosis completed and no repository patch or review artifact is needed.
- `PR: <url>` when documentation, config validation, or fixture changes should be reviewed.
- `Block` when diagnosis cannot proceed safely or the contamination guard finds denied paths.

Before posting `PR` or attaching evidence, fail closed if any branch diff or artifact path would include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`. Report the exact repo-relative offending paths only; do not include file contents.
