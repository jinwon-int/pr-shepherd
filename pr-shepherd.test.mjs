import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { classifyChecks, classifyPr, notificationKey, recentAutoPushes, redact, worktreeReadiness } from './pr-shepherd.mjs';

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

test('redact removes GitHub tokens and secret values', () => {
  const text = 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 secret:supersecret password=hunter2';
  const redacted = redact(text);
  assert.doesNotMatch(redacted, /ghp_|supersecret|hunter2/);
  assert.match(redacted, /\[REDACTED/);
});

test('recentAutoPushes keeps only pushes from the last 24 hours', () => {
  const now = Date.parse('2026-05-07T12:00:00Z');
  const pushes = recentAutoPushes({
    autoPushes: [
      { at: '2026-05-07T11:00:00Z' },
      { at: '2026-05-06T11:59:59Z' },
    ],
  }, now);
  assert.equal(pushes.length, 1);
});

test('worktreeReadiness reports a missing worktree as not ready', () => {
  const result = worktreeReadiness({
    worktreePath: join(tmpdir(), 'definitely-missing-pr-shepherd-worktree'),
    autoPushLimit24h: 5,
    remotes: {},
    knownSafeConflicts: { changelog: { path: 'CHANGELOG.md', knownPrLineNeedle: 'entry' } },
    focusedChecks: ['npm test'],
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'worktree-exists').ok, false);
});

test('worktreeReadiness accepts a clean worktree with matching remotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-ready-'));
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 0, `${args.join(' ')}\n${res.stdout}${res.stderr}`);
  };
  git(['init']);
  git(['remote', 'add', 'origin', 'https://github.com/example/fork.git']);
  git(['remote', 'add', 'upstream', 'https://github.com/example/upstream.git']);

  const result = worktreeReadiness({
    worktreePath: dir,
    lockPath: join(dir, 'lock'),
    staleLockMs: 1000,
    autoPushLimit24h: 5,
    remotes: {
      origin: 'https://github.com/example/fork.git',
      upstream: 'https://github.com/example/upstream.git',
    },
    knownSafeConflicts: { changelog: { path: 'CHANGELOG.md', knownPrLineNeedle: 'entry' } },
    focusedChecks: ['npm test'],
  }, {});

  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
});
