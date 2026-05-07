import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildConflictArtifactPayload,
  buildStatusRows,
  classifyChecks,
  classifyConflictSet,
  classifyPr,
  conflictSetKey,
  findOpenClawRuntimeContextPaths,
  notificationKey,
  resolveChangelogConflict,
  selectTargets,
  validateConfigObject,
} from './pr-shepherd.mjs';

const base = {
  number: 78261,
  state: 'OPEN',
  mergedAt: null,
  headRefOid: 'abc123',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
};

function validationTarget(overrides = {}) {
  return {
    id: 'target-1',
    owner: 'owner',
    repo: 'repo',
    number: 1,
    headBranch: 'feature',
    baseBranch: 'main',
    worktreePath: '/tmp/pr-shepherd/worktree-1',
    statePath: '/tmp/pr-shepherd/state-1.json',
    lockPath: '/tmp/pr-shepherd/lock-1.lock',
    autoPushLimit24h: 5,
    conflictPolicy: {
      autoSafe: [{ path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Release note' }],
      codeAssisted: ['src/example.ts'],
      humanOnly: ['pnpm-lock.yaml'],
    },
    notify: { mode: 'stdout' },
    ...overrides,
  };
}

test('selectTargets preserves first-target default and supports explicit all-target orchestration', () => {
  const cfg = {
    targets: [
      { id: 'repo-a-1', owner: 'owner-a', repo: 'repo-a', number: 1, pr: 'owner-a/repo-a#1', url: 'https://github.com/owner-a/repo-a/pull/1' },
      { id: 'repo-b-1', owner: 'owner-b', repo: 'repo-b', number: 1, pr: 'owner-b/repo-b#1', url: 'https://github.com/owner-b/repo-b/pull/1' },
    ],
  };
  assert.deepEqual(selectTargets(cfg).map((target) => target.id), ['repo-a-1']);
  assert.deepEqual(selectTargets(cfg, [], true).map((target) => target.id), ['repo-a-1', 'repo-b-1']);
  assert.deepEqual(selectTargets(cfg, ['owner-b/repo-b#1']).map((target) => target.id), ['repo-b-1']);
  assert.throws(() => selectTargets(cfg, ['1']), /ambiguous target selector/);
  assert.throws(() => selectTargets(cfg, ['repo-a-1'], true), /--all cannot be combined with --target/);
});

test('findOpenClawRuntimeContextPaths reports only root runtime context paths', () => {
  assert.deepEqual(findOpenClawRuntimeContextPaths([
    './AGENTS.md',
    '.openclaw/workspace-state.json',
    'docs/AGENTS.md',
    'src/HEARTBEAT.md',
    'TOOLS.md',
  ]), ['.openclaw/workspace-state.json', 'AGENTS.md', 'TOOLS.md']);
});

test('validateConfigObject accepts a production-ready target config', () => {
  const report = validateConfigObject({ targets: [validationTarget()] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test('validateConfigObject rejects missing required fields, invalid push limits, and secrets', () => {
  const report = validateConfigObject({
    targets: [validationTarget({
      headBranch: '',
      autoPushLimit24h: 0,
      remotes: { origin: 'https://x-access-token:ghp_12345678901234567890@github.com/owner/repo.git' },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /targets\[0\]\.headBranch is required/);
  assert.match(report.errors.join('\n'), /autoPushLimit24h must be a positive number/);
  assert.match(report.errors.join('\n'), /secret-looking value in config\.targets\[0\]\.remotes\.origin/);
});

test('validateConfigObject rejects duplicate target ids and enabled state or lock paths', () => {
  const report = validateConfigObject({
    targets: [
      validationTarget(),
      validationTarget({ id: 'target-1', number: 2, worktreePath: '/tmp/pr-shepherd/worktree-2' }),
    ],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /duplicate target id target-1/);
  assert.match(report.errors.join('\n'), /duplicate enabled target statePath/);
  assert.match(report.errors.join('\n'), /duplicate enabled target lockPath/);
});

test('validateConfigObject rejects duplicate conflict paths across policy tiers', () => {
  const report = validateConfigObject({
    targets: [validationTarget({
      conflictPolicy: {
        autoSafe: [{ path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Release note' }],
        codeAssisted: ['CHANGELOG.md'],
        humanOnly: [],
      },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /duplicates CHANGELOG\.md across tiers: autoSafe, codeAssisted/);
});

test('status command reads state files without network access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-status-'));
  try {
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    writeFileSync(statePath, JSON.stringify({
      disabled: false,
      lastKind: 'failed',
      lastMergeable: 'MERGEABLE',
      lastMergeStateStatus: 'UNSTABLE',
      lastSeenHeadOid: 'head-a',
      lastSeenBaseOid: 'base-a',
      lastFailureNames: ['lint'],
      lastPendingCount: 1,
      lastNotificationKey: 'failed:head-a:lint',
      autoPushes: [{ at: new Date().toISOString(), from: 'old', to: 'new' }],
    }));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({ statePath, lockPath: join(dir, 'lock'), worktreePath: join(dir, 'worktree') })],
    }));
    assert.equal(buildStatusRows([validationTarget({ statePath })])[0].lastKind, 'failed');

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'status', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.target, 'target-1');
    assert.equal(status.lastKind, 'failed');
    assert.deepEqual(status.lastFailureNames, ['lint']);
    assert.equal(status.recentAutoPushCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canary command exercises command notifier hook without GitHub or state mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-canary-'));
  try {
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const hookPath = join(dir, 'hook.mjs');
    const hookOutPath = join(dir, 'hook-output.json');
    writeFileSync(hookPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], JSON.stringify({",
      '  message: process.env.PR_SHEPHERD_MESSAGE,',
      '  target: process.env.PR_SHEPHERD_TARGET,',
      '  pr: process.env.PR_SHEPHERD_PR,',
      '  url: process.env.PR_SHEPHERD_URL,',
      '  kind: process.env.PR_SHEPHERD_KIND,',
      '  key: process.env.PR_SHEPHERD_KEY,',
      '}));',
      '',
    ].join('\n'));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: join(dir, 'worktree'),
        notify: { mode: 'command', command: [process.execPath, hookPath, hookOutPath] },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'canary', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(statePath), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.kind, 'canary');
    assert.equal(summary.notifyMode, 'command');
    const hookOutput = JSON.parse(readFileSync(hookOutPath, 'utf8'));
    assert.match(hookOutput.message, /\[pr-shepherd:target-1\] owner\/repo#1 notifier canary/);
    assert.equal(hookOutput.target, 'target-1');
    assert.equal(hookOutput.pr, 'owner/repo#1');
    assert.equal(hookOutput.url, 'https://github.com/owner/repo/pull/1');
    assert.equal(hookOutput.kind, 'canary');
    assert.equal(hookOutput.key, 'canary:target-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifies clean PR', () => {
  assert.equal(classifyPr(base).kind, 'clean');
});

test('classifies dirty/conflicting PR', () => {
  assert.equal(classifyPr({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).kind, 'dirty');
});

test('classifies unstable pending PR without failures', () => {
  const pr = { ...base, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] };
  const c = classifyPr(pr);
  assert.equal(c.kind, 'unstable');
  assert.equal(c.checks.pending.length, 1);
});

test('classifies failed checks', () => {
  const pr = { ...base, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.invalid' }] };
  const c = classifyPr(pr);
  assert.equal(c.kind, 'failed');
  assert.equal(c.checks.failed[0].name, 'lint');
});

test('merged disables before check failures', () => {
  assert.equal(classifyPr({ ...base, state: 'MERGED', mergedAt: '2026-05-07T00:00:00Z', statusCheckRollup: [{ name: 'old', status: 'COMPLETED', conclusion: 'FAILURE' }] }).kind, 'merged');
});

test('notification key is stable for same failed checks', () => {
  const pr = { ...base, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  const c = classifyPr(pr);
  assert.equal(notificationKey('failed', pr, c.checks), notificationKey('failed', pr, c.checks));
});

test('classifyChecks treats success/skipped/neutral as non-failures', () => {
  const c = classifyChecks([
    { name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'neutral', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ]);
  assert.equal(c.failed.length, 0);
  assert.equal(c.pending.length, 0);
});

const conflictPolicyTarget = {
  id: 'openclaw-78261',
  pr: 'openclaw/openclaw#78261',
  url: 'https://github.com/openclaw/openclaw/pull/78261',
  baseBranch: 'main',
  remotes: {
    origin: 'https://x-access-token:TOKEN_EXAMPLE_REDACT_ME@github.com/example/private.git',
  },
  conflictPolicy: {
    autoSafe: [
      { path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Telegram/Plugin SDK: expose delivery.providerAccepted' },
    ],
    codeAssisted: [
      'extensions/telegram/src/outbound-adapter.ts',
      'extensions/telegram/src/send.ts',
    ],
    humanOnly: ['pnpm-lock.yaml'],
  },
};

test('classifies autoSafe CHANGELOG conflict', () => {
  const c = classifyConflictSet(['CHANGELOG.md'], conflictPolicyTarget);
  assert.equal(c.tier, 'autoSafe');
  assert.equal(c.autoPushAllowed, true);
  assert.equal(c.pushBlocked, false);
});

test('classifies codeAssisted TypeScript conflict with push blocked by default', () => {
  const c = classifyConflictSet(['extensions/telegram/src/outbound-adapter.ts'], conflictPolicyTarget);
  assert.equal(c.tier, 'codeAssisted');
  assert.equal(c.requiresApproval, true);
  assert.equal(c.pushBlocked, true);
});

test('classifies lockfile conflict as humanOnly', () => {
  const c = classifyConflictSet(['pnpm-lock.yaml'], conflictPolicyTarget);
  assert.equal(c.tier, 'humanOnly');
  assert.equal(c.pushBlocked, true);
});

test('unlisted conflict paths escalate to humanOnly', () => {
  const c = classifyConflictSet(['src/auth/permissions.ts'], conflictPolicyTarget);
  assert.equal(c.tier, 'humanOnly');
  assert.equal(c.entries[0].reason, 'unlisted');
});

test('conflict set key includes head, base, and sorted conflict paths', () => {
  const pr = { headRefOid: 'head-a', baseRefName: 'main' };
  assert.equal(
    conflictSetKey(pr, 'base-a', ['b.ts', 'a.ts']),
    conflictSetKey(pr, 'base-a', ['a.ts', 'b.ts']),
  );
  assert.notEqual(conflictSetKey(pr, 'base-a', ['a.ts']), conflictSetKey(pr, 'base-b', ['a.ts']));
});

test('source never uses plain force push', () => {
  const source = readFileSync(new URL('./pr-shepherd.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("'--force'"), false);
  assert.match(source, /--force-with-lease=/);
});

test('conflict artifacts omit secrets and private worktree details', () => {
  const payload = buildConflictArtifactPayload(
    { ...conflictPolicyTarget, worktreePath: '/private/worktree', statePath: '/private/state.json' },
    { headRefOid: 'head-a', url: 'https://github.com/openclaw/openclaw/pull/78261' },
    classifyConflictSet(['extensions/telegram/src/outbound-adapter.ts'], conflictPolicyTarget),
    ['extensions/telegram/src/outbound-adapter.ts'],
    'conflict:head-a:base-a:extensions/telegram/src/outbound-adapter.ts',
  );
  const json = JSON.stringify(payload);
  assert.equal(json.includes('TOKEN_EXAMPLE_REDACT_ME'), false);
  assert.equal(json.includes('/private/'), false);
});

test('autoSafe CHANGELOG resolver preserves both sides and removes conflict markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-changelog-'));
  try {
    spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'CHANGELOG.md'), [
      '<<<<<<< HEAD',
      '- Telegram/Plugin SDK: expose delivery.providerAccepted',
      '=======',
      '- Upstream release note',
      '>>>>>>> upstream/main',
      '',
    ].join('\n'));
    assert.equal(resolveChangelogConflict({ worktreePath: dir }, {
      path: 'CHANGELOG.md',
      resolver: 'merge-changelog-top-entry',
      needle: 'Telegram/Plugin SDK: expose delivery.providerAccepted',
    }), true);
    const resolved = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(resolved, /Telegram\/Plugin SDK: expose delivery\.providerAccepted/);
    assert.match(resolved, /Upstream release note/);
    assert.equal(resolved.includes('<<<<<<<'), false);
    assert.equal(resolved.includes('======='), false);
    assert.equal(resolved.includes('>>>>>>>'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
