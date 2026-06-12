// Read-only GitHub PR access via the gh CLI.
import { PR_FIELDS } from './policy.mjs';
import { run } from './targets.mjs';
import { classifyPr } from './classify.mjs';

export function ghPrView(target) {
  const res = run('gh', ['pr', 'view', String(target.number), '--repo', `${target.owner}/${target.repo}`, '--json', PR_FIELDS.join(',')]);
  return JSON.parse(res.stdout);
}

export function ghPrChangedFiles(target) {
  const res = run('gh', ['api', `repos/${target.owner}/${target.repo}/pulls/${target.number}/files`, '--paginate'], { allowFailure: true });
  if (res.status !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed.flat() : [];
  } catch {
    try {
      const pages = JSON.parse(`[${res.stdout.trim().replace(/]\s*\[/g, '],[')}]`);
      return Array.isArray(pages) ? pages.flat() : [];
    } catch {
      return [];
    }
  }
}

export function sleepMs(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

export function shouldRecheckUnknown(classification) {
  return classification.kind === 'unknown'
    && classification.checks.failed.length === 0
    && classification.checks.pending.length === 0;
}

export function ghPrViewWithUnknownRecheck(target) {
  const maxRechecks = Math.max(0, Number.isFinite(Number(target.unknownRecheckAttempts)) ? Number(target.unknownRecheckAttempts) : 2);
  const delayMs = Math.max(0, Number.isFinite(Number(target.unknownRecheckDelayMs)) ? Number(target.unknownRecheckDelayMs) : 1500);
  let pr = ghPrView(target);
  let classification = classifyPr(pr);
  let rechecks = 0;
  while (rechecks < maxRechecks && shouldRecheckUnknown(classification)) {
    rechecks += 1;
    sleepMs(delayMs);
    pr = ghPrView(target);
    classification = classifyPr(pr);
  }
  return { pr, classification, rechecks };
}
