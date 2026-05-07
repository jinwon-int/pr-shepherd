import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChecks, classifyPr, notificationKey, parseArgs, recentAutoPushes, redact } from './pr-shepherd.mjs';

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

test('repair requires explicit live-push approval flag', () => {
  assert.deepEqual(parseArgs(['repair', '--config', 'config.json']), {
    cmd: 'repair',
    config: 'config.json',
    dryRun: false,
    approveLivePush: false,
  });
  assert.equal(parseArgs(['repair', '--config', 'config.json', '--approve-live-push']).approveLivePush, true);
});

test('recentAutoPushes keeps only pushes inside the rolling 24h window', () => {
  const now = Date.parse('2026-05-07T12:00:00Z');
  const pushes = recentAutoPushes({
    autoPushes: [
      { at: '2026-05-06T11:59:59Z' },
      { at: '2026-05-06T12:00:01Z' },
    ],
  }, now);
  assert.deepEqual(pushes, [{ at: '2026-05-06T12:00:01Z' }]);
});

test('redact removes common secrets from logs and notifications', () => {
  const text = redact('token=ghp_abcdefghijklmnopqrstuvwxyzABCDE password:supersecret');
  assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwxyzABCDE'), false);
  assert.equal(text.includes('supersecret'), false);
  assert.match(text, /\[REDACTED/);
});
