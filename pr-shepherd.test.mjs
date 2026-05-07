import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildConflictArtifactPayload,
  classifyChecks,
  classifyConflictSet,
  classifyPr,
  conflictSetKey,
  notificationKey,
  resolveChangelogConflict,
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
