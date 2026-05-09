# Phase H repair-plan handoff operations

Phase H converts a Phase G diagnose-only bundle into an operator-reviewable repair plan. It is a handoff phase: it may summarize evidence, choose the next safe lane, and prepare review text, but it must not run live `repair`, push a branch, create a standing timer, or imply approval for later mutation.

## Preconditions

- A Phase G diagnose-only bundle exists for the target and names the PR, head/base refs, mergeability or conflict state, focused command hints, and evidence hygiene result.
- The operator ledger has a `Start` marker for this handoff, with `startCommentUrl` saved before analysis begins.
- The target worktree and any sandbox/rehearsal worktree are treated as evidence sources only. Do not edit the watched worktree or push.
- The artifact destination is known and can be checked before anything is attached to an issue, PR, or chat thread.

## Repair-plan packet

Create a concise packet that an operator or follow-up worker can use without raw transcripts:

1. **Target and refs:** target id, PR URL, head branch, expected head SHA, base branch/SHA when known, and the Phase G bundle link.
2. **Current state:** clean, dirty, conflicted, failed, unknown, or blocked, plus the source of that classification.
3. **Conflict/path summary:** affected repo-owned paths, policy classification, generated/security-sensitive/lockfile notes, and why the paths are or are not eligible for `autoSafe` repair.
4. **Proposed lane:** exactly one of wait/recheck, no-op, autoSafe rehearsal, code-assisted artifact review, humanOnly handoff, or block.
5. **Focused verification:** suggested argv-array checks from config or Phase G hints. Keep them read-only until a later approved repair phase validates them again.
6. **Risks and blockers:** stale refs, failing CI, missing focused checks, unsupported GitHub fields, unsafe hint commands, dirty worktrees, missing approvals, or evidence contamination.
7. **Next approval needed:** the exact later phase required before mutation, usually Phase C rehearsal, Phase D one-shot live approval, or manual maintainer work.

Do not include secrets, private host paths, chat ids, raw session dumps, or OpenClaw runtime/bootstrap context file contents. Summaries should link to sanitized artifacts rather than paste long logs.

## Handoff outcomes

Close Phase H with exactly one terminal marker:

- `PR: <url>` only when this documentation or plan packet itself is published as a reviewable PR and the branch/evidence guard passed.
- `Done` when the repair plan was handed to the operator and no repository change is required.
- `Block` when the packet cannot be safely produced or the next action is unsafe/unclear.

Save and report the matching `prUrl`, `doneCommentUrl`, or `blockCommentUrl` alongside the original `startCommentUrl` when available.

## Fail-closed contamination guard

Before posting a `PR` marker or attaching the repair-plan packet, check the branch diff and planned artifact bundle for OpenClaw runtime/bootstrap context paths. If any would be committed or attached, stop and post `Block` with only the repo-relative path names and reason.

Block on exact matches for:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Do not paste the contents of those files into the ledger or evidence. Path names are sufficient for the operator to remove contaminated artifacts and restart from a clean handoff.

## Operator template

```markdown
Start: <startCommentUrl>
Target: <target-id> / <owner/repo#pr>
Phase G bundle: <sanitized-link>
Expected refs: head=<sha-or-unknown>, base=<sha-or-unknown>
Current state: <clean|dirty|conflicted|failed|unknown|blocked>
Affected paths: <repo-owned-paths-or-none>
Proposed lane: <wait/recheck|no-op|autoSafe rehearsal|code-assisted artifact review|humanOnly handoff|block>
Focused verification: <argv-array checks or "none configured">
Risks/blockers: <short list>
Evidence hygiene: no secrets, private paths, raw session dumps, or runtime/bootstrap context paths
Terminal marker: <PR: url|Done|Block>
Closeout URL: <prUrl|doneCommentUrl|blockCommentUrl>
```

A Phase H handoff is not approval to mutate. Any later live repair still needs a fresh Phase D/E approval boundary, focused-check gate, push budget, expected-head `--force-with-lease`, and another contamination check immediately before evidence or branch publication.
