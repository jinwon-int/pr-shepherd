# Sandbox repair proof operating procedure

Use this runbook before promoting any PR Shepherd repair path from read-only monitoring or dry-run evidence to a live repair approval. The proof must run against a disposable sandbox target only; it must not mutate `openclaw/openclaw` branches or any production OpenClaw PR branch.

## Scope and safety boundary

The sandbox proof is allowed to exercise the same mechanics that a live repair would use:

- dirty/`autoSafe` PR classification
- expected-head fetch and stale-head refusal
- deterministic conflict resolution for configured safe paths
- focused verification commands
- `git push --force-with-lease=<branch>:<expected-head>`
- sanitized artifact and log capture

The proof is not allowed to use production branches, provider sends, Gateway restarts, secrets, private host paths, or raw OpenClaw session dumps. Evidence must also exclude OpenClaw runtime/bootstrap context files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`.

## Preconditions

1. Create or reset a disposable sandbox repository, bare remote, worktree, and state/artifact directory. Keep all paths temporary and operator-owned.
2. Configure a sandbox target with its own `id`, `worktreePath`, `statePath`, `lockPath`, `artifactDir`, `headBranch`, `baseBranch`, `conflictPolicy.autoSafe`, and focused checks.
3. Keep notifier mode at `stdout` or dry-run only.
4. Confirm `config.json` or the temporary proof config contains no tokens, credentialed URLs, chat ids, or host-specific private paths.
5. Confirm the branch under proof is sandbox-only and is not an OpenClaw production PR branch.

## Proof steps

1. Validate configuration:

   ```bash
   node pr-shepherd.mjs validate --config <sandbox-config.json>
   ```

2. Capture baseline status and state:

   ```bash
   node pr-shepherd.mjs status --config <sandbox-config.json> --target <sandbox-target-id>
   ```

3. Rehearse the repair without mutation and save sanitized artifacts outside the repository or under an ignored temporary proof directory:

   ```bash
   node pr-shepherd.mjs rehearse --config <sandbox-config.json> --target <sandbox-target-id> --artifact-dir <tmp-artifacts>
   ```

4. Inspect the rehearsal evidence. It must show the target, expected head/base, action class, focused checks, and whether a push would be blocked or allowed. It must not include secrets, private paths, runtime/bootstrap context files, or unrelated branch diffs.
5. If the rehearsal is clean and the operator has explicitly approved the sandbox mutation, run the live sandbox repair against the sandbox branch only:

   ```bash
   node pr-shepherd.mjs repair --config <sandbox-config.json> --target <sandbox-target-id> --artifact-dir <tmp-artifacts>
   ```

6. Verify the remote sandbox branch changed only through `--force-with-lease` from the fetched expected head. Re-run status and focused checks, then capture sanitized final evidence.
7. Before opening or updating any PR for this repository, fail closed if branch changes or artifact evidence include OpenClaw runtime/bootstrap context paths:

   ```bash
   { git diff --name-only --cached; git diff --name-only; git ls-files --others --exclude-standard; } \
     | sort -u \
     | grep -E '^(AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw(/|$))'
   ```

   If the command prints any path, stop and report the exact repo-relative paths instead of creating a PR or publishing evidence.

## Go/no-go criteria

### Go

Proceed to a narrowly scoped operator decision for live repair only when all of the following are true:

- `npm run ci`, `git diff --check`, and `node pr-shepherd.mjs validate --config config.json` pass in this repository.
- The sandbox proof command sequence passes end-to-end against a disposable target.
- Rehearsal evidence matches the live sandbox repair head/base and is recent enough for the configured policy.
- Focused checks pass before any push.
- The sandbox remote head is unchanged between fetch and push except for the expected `--force-with-lease` update.
- Evidence is sanitized and contains no secrets, private paths, runtime/bootstrap context files, or production branch mutation.
- The operator names the exact target, branch, approval time, and approval scope.

### No-go

Do not promote or run live repair if any of the following are true:

- The target is production, ambiguous, stale, merged, pending, failed, disabled, or outside `autoSafe` policy.
- The worktree is dirty, the remote head changed unexpectedly, focused checks fail, or the push budget is exhausted.
- The proof requires provider sends, Gateway restarts, production OpenClaw PR mutation, or maintainer-owned branch mutation without explicit acknowledgment.
- Artifact or branch evidence would include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
- Any evidence contains secrets, chat ids, raw session dumps, or host-specific private paths.

A no-go outcome is a successful safety result: record the blocker, keep repair disabled, and require human follow-up before another attempt.
