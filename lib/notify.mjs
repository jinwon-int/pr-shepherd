// Notifier delivery, dedupe, canary line, and situation reports.
import { DEFAULT_SITUATION_REPORT_EVERY_MS } from './policy.mjs';
import { run } from './targets.mjs';
import { notificationKey } from './classify.mjs';

export function notificationEnv(target, line, meta = {}) {
  return {
    PR_SHEPHERD_MESSAGE: line,
    PR_SHEPHERD_TARGET: String(target.id || ''),
    PR_SHEPHERD_PR: String(target.pr || ''),
    PR_SHEPHERD_URL: String(target.url || ''),
    PR_SHEPHERD_KIND: String(meta.kind || ''),
    PR_SHEPHERD_KEY: String(meta.key || ''),
    PR_SHEPHERD_NOTIFY_MODE: String(target.notify?.mode || 'stdout'),
  };
}

export function deliverCommandNotification(target, line, meta = {}) {
  const [cmd, ...args] = target.notify.command;
  run(cmd, args, {
    env: notificationEnv(target, line, meta),
    allowFailure: true,
  });
}

export function deliverOpenClawNotification(target, line, meta = {}) {
  const dryRun = target.notify?.dryRun !== false;
  if (dryRun || !Array.isArray(target.notify?.command)) {
    console.log(`[pr-shepherd:${target.id}] OpenClaw notify dry-run: ${line}`);
    return true;
  }
  deliverCommandNotification(target, line, { ...meta, openclaw: true });
  return true;
}

export function deliverNotification(target, line, meta = {}) {
  const mode = target.notify?.mode || 'stdout';
  if (mode === 'none') return true;
  if (mode === 'command' && Array.isArray(target.notify.command)) deliverCommandNotification(target, line, meta);
  else if (mode === 'openclaw') deliverOpenClawNotification(target, line, meta);
  else console.log(line);
  return true;
}

export function notify(target, state, key, message, force = false) {
  if (!force && state.lastNotificationKey === key) return false;
  state.lastNotificationKey = key;
  const line = `[pr-shepherd:${target.id}] ${message}`;
  return deliverNotification(target, line, { kind: String(key).split(':')[0] || 'notification', key });
}

export function buildCanaryNotificationLine(target, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return `[pr-shepherd:${target.id}] ${target.pr} notifier canary at ${at}; no PR state changed`;
}

export function handleCanary(target) {
  const line = buildCanaryNotificationLine(target);
  deliverNotification(target, line, { kind: 'canary', key: `canary:${target.id}` });
  console.log(JSON.stringify({
    target: target.id,
    pr: target.pr,
    kind: 'canary',
    notifyMode: target.notify?.mode || 'stdout',
    delivered: target.notify?.mode !== 'none',
  }, null, 2));
}

export function updateStateFromPr(state, pr, classification) {
  state.lastRunAt = new Date().toISOString();
  state.lastSeenHeadOid = pr.headRefOid || state.lastSeenHeadOid;
  state.lastSeenBaseOid = pr.baseRefOid || state.lastSeenBaseOid;
  state.lastMergeable = pr.mergeable || null;
  state.lastMergeStateStatus = pr.mergeStateStatus || null;
  state.lastReviewDecision = pr.reviewDecision || null;
  state.lastFailureNames = classification.checks.failed.map((c) => c.name);
  state.lastPendingCount = classification.checks.pending.length;
  if (classification.kind === 'clean') state.lastOkAt = state.lastRunAt;
  if (classification.kind === 'merged') state.disabled = true;
}

export function summarizeFailed(checks) {
  return checks.failed.map((c) => `${c.name}${c.conclusion ? `=${c.conclusion}` : ''}${c.detailsUrl ? ` ${c.detailsUrl}` : ''}`).join('; ');
}

export function summarizePending(checks) {
  return checks.pending.map((c) => `${c.name}${c.status ? `=${c.status}` : ''}${c.detailsUrl ? ` ${c.detailsUrl}` : ''}`).join('; ');
}

export function situationReportEveryMs(target) {
  if (target.notify?.situationReportEveryMs !== undefined) return Number(target.notify.situationReportEveryMs);
  return DEFAULT_SITUATION_REPORT_EVERY_MS;
}

export function lastActionSummary(state) {
  if (state.lastActionSummary) return state.lastActionSummary;
  if (state.lastConflictTier) {
    const paths = Array.isArray(state.lastConflictPaths) && state.lastConflictPaths.length > 0
      ? ` (${state.lastConflictPaths.join(', ')})`
      : '';
    return `last conflict=${state.lastConflictTier}${paths}`;
  }
  const pushes = Array.isArray(state.autoPushes) ? state.autoPushes : [];
  const lastPush = pushes[pushes.length - 1];
  if (lastPush) return `last auto-push ${String(lastPush.from || '').slice(0, 8)}..${String(lastPush.to || '').slice(0, 8)} at ${lastPush.at}`;
  return 'none recorded';
}

export function nextActionForClassification(classification) {
  switch (classification.kind) {
    case 'clean': return 'none — 현재 조치할 것 없음 / no action needed';
    case 'merged': return 'none — PR merged; target disabled';
    case 'failed': return 'operator review failed checks; no repair attempted';
    case 'dirty': return 'run dry-run/rehearsal, then operator approval needed before any repair push';
    case 'unstable': return 'watch pending checks';
    case 'disabled': return 'none — target disabled';
    default: return 'operator review needed';
  }
}

export function actionNeededForClassification(classification) {
  return ['clean', 'dirty', 'failed', 'merged', 'unknown'].includes(classification.kind);
}

export function buildSituationReportLine(target, state, pr, classification) {
  const failedCount = classification.checks?.failed?.length || 0;
  const pendingCount = classification.checks?.pending?.length || 0;
  const prRef = target.pr || `${target.owner}/${target.repo}#${target.number}`;
  const url = target.url || pr?.url || null;
  const observation = state.observationSummary?.last48h;
  const observationPart = observation && observation.total > 0
    ? `observation48h total=${observation.total} clean=${observation.byKind.clean || 0} unknown=${observation.byKind.unknown || 0} failed=${observation.byKind.failed || 0} dirty=${observation.byKind.dirty || 0} recheck=${observation.recheckSuggested || 0}`
    : null;
  const parts = [
    `${prRef} situation report`,
    `target=${target.id}`,
    `repo=${target.owner}/${target.repo}`,
    `classification=${classification.kind}`,
    `mergeable=${pr?.mergeable || state.lastMergeable || 'n/a'}`,
    `mergeStateStatus=${pr?.mergeStateStatus || state.lastMergeStateStatus || 'n/a'}`,
    `checks failed=${failedCount} pending=${pendingCount}`,
    observationPart,
    failedCount > 0 ? `failedChecks=${summarizeFailed(classification.checks)}` : null,
    pendingCount > 0 ? `pendingChecks=${summarizePending(classification.checks)}` : null,
    `lastAction=${lastActionSummary(state)}`,
    `nextAction=${nextActionForClassification(classification)}`,
  ];
  if (url) parts.push(`url=${url}`);
  return parts.filter(Boolean).join('; ');
}

export function situationReportKey(pr, classification) {
  return `situation:${classification.kind}:${notificationKey(classification.kind, pr || {}, classification.checks || { failed: [], pending: [] })}`;
}

export function sendSituationReport(target, state, pr, classification, key, now = new Date()) {
  state.lastSituationReportKey = key;
  state.lastSituationReportAt = now.toISOString();
  state.lastNotificationKey = key;
  const line = `[pr-shepherd:${target.id}] ${buildSituationReportLine(target, state, pr, classification)}`;
  return deliverNotification(target, line, { kind: 'situation', key });
}

export function maybeNotifySituationReport(target, state, pr, classification, now = new Date()) {
  const key = situationReportKey(pr, classification);
  const cadenceMs = situationReportEveryMs(target);
  const lastAtMs = Date.parse(state.lastSituationReportAt || '');
  const cadenceDue = cadenceMs === 0 || !Number.isFinite(lastAtMs) || now.getTime() - lastAtMs >= cadenceMs;
  const immediateDue = actionNeededForClassification(classification) && state.lastSituationReportKey !== key;
  if (!immediateDue && !cadenceDue) return false;
  return sendSituationReport(target, state, pr, classification, key, now);
}
