// Observation ledger, 24h/48h summaries, and doctor warnings.
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_OBSERVATION_LEDGER_LIMIT, OBSERVATION_SUMMARY_KINDS, OBSERVATION_WARNING_KINDS } from './policy.mjs';
import { nextActionForClassification } from './notify.mjs';

export function emptyObservationWindowSummary() {
  return {
    total: 0,
    byKind: Object.fromEntries(OBSERVATION_SUMMARY_KINDS.map((kind) => [kind, 0])),
    byActionClass: {},
    recheckSuggested: 0,
    warnings: 0,
    failedChecksMax: 0,
    pendingChecksMax: 0,
  };
}

export function summarizeObservationWindow(entries) {
  const summary = emptyObservationWindowSummary();
  for (const entry of entries) {
    const kind = OBSERVATION_SUMMARY_KINDS.includes(entry?.kind) ? entry.kind : 'unknown';
    const actionClass = entry?.actionClass || null;
    summary.total += 1;
    summary.byKind[kind] = (summary.byKind[kind] || 0) + 1;
    if (actionClass) summary.byActionClass[actionClass] = (summary.byActionClass[actionClass] || 0) + 1;
    if (actionClass === AUTOMATIC_ACTION_CLASSES.RECHECK) summary.recheckSuggested += 1;
    if (OBSERVATION_WARNING_KINDS.has(kind)) summary.warnings += 1;
    summary.failedChecksMax = Math.max(summary.failedChecksMax, Number(entry?.failedCount || 0));
    summary.pendingChecksMax = Math.max(summary.pendingChecksMax, Number(entry?.pendingCount || 0));
  }
  return summary;
}

export function summarizeObservationLedger(ledger = [], now = new Date()) {
  const entries = Array.isArray(ledger) ? ledger : [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const finiteNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const withTime = entries
    .map((entry) => ({ entry, atMs: Date.parse(entry?.at || '') }))
    .filter(({ atMs }) => Number.isFinite(atMs));
  const last24Timed = withTime.filter(({ atMs }) => finiteNowMs - atMs <= 24 * 60 * 60 * 1000);
  const last48Timed = withTime.filter(({ atMs }) => finiteNowMs - atMs <= 48 * 60 * 60 * 1000);
  const last24h = last24Timed.map(({ entry }) => entry);
  const last48h = last48Timed.map(({ entry }) => entry);
  const last = withTime.length > 0 ? withTime[withTime.length - 1].entry : null;
  const lastClean = [...last48Timed].reverse().find(({ entry }) => entry?.kind === 'clean')?.entry || null;
  const lastWarning = [...last48Timed].reverse().find(({ entry }) => OBSERVATION_WARNING_KINDS.has(entry?.kind))?.entry || null;
  return {
    schema: 'pr-shepherd-observation-summary/v1',
    entries: entries.length,
    lastRunAt: last?.at || null,
    lastCleanAt: lastClean?.at || null,
    lastWarningAt: lastWarning?.at || null,
    lastWarningKind: lastWarning?.kind || null,
    last24h: summarizeObservationWindow(last24h),
    last48h: summarizeObservationWindow(last48h),
  };
}

export function observationLedgerLimit(target = {}) {
  const limit = Number(target.observation?.ledgerLimit ?? DEFAULT_OBSERVATION_LEDGER_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_OBSERVATION_LEDGER_LIMIT;
  return Math.max(1, Math.floor(limit));
}

export function buildObservationEntry(pr, classification, plannedAction, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    schema: 'pr-shepherd-observation/v1',
    at,
    kind: classification?.kind || 'unknown',
    actionClass: plannedAction?.actionClass || null,
    headRefOid: pr?.headRefOid || null,
    baseRefOid: pr?.baseRefOid || null,
    mergeable: pr?.mergeable || null,
    mergeStateStatus: pr?.mergeStateStatus || null,
    reviewDecision: pr?.reviewDecision || null,
    failedCount: classification?.checks?.failed?.length || 0,
    pendingCount: classification?.checks?.pending?.length || 0,
  };
}

export function observationDoctorWarnings(summary) {
  const warnings = [];
  const h48 = summary?.last48h || emptyObservationWindowSummary();
  if (h48.byKind.unknown >= 3) warnings.push(`unknown observed ${h48.byKind.unknown} times in 48h; keep check-only and recheck GitHub mergeability before Phase C`);
  if (h48.byKind.failed > 0) warnings.push(`failed checks observed ${h48.byKind.failed} times in 48h; operator review required before rehearsal`);
  if (h48.byKind.dirty > 0) warnings.push(`dirty/conflicting observed ${h48.byKind.dirty} times in 48h; run one-shot rehearsal only after operator approval`);
  if (h48.total >= 3 && h48.byKind.clean === 0) warnings.push('no clean observation in the last 48h sample; do not advance to Phase C');
  return warnings;
}

export function nextRecommendedAction(target, state = {}) {
  if (state.disabled) return 'none — target disabled';
  const currentKind = state.lastKind;
  const hasDoctorWarnings = Array.isArray(state.lastDoctorWarnings) && state.lastDoctorWarnings.length > 0;
  if (currentKind === 'clean' && hasDoctorWarnings) return 'continue check-only observation; review doctor warnings before Phase C rehearsal';
  if (currentKind === 'clean') return 'continue check-only observation until 24-48h stable, then consider Phase C rehearsal criteria';
  const kind = currentKind || state.lastWarningKind;
  if (kind === 'dirty') return 'run one-shot dry-run/rehearsal, then require operator approval before any repair push';
  if (kind === 'failed') return 'operator review failed checks; keep branch mutation disabled';
  if (kind === 'unknown') return 'recheck GitHub PR state; keep observing until mergeability is stable';
  if (kind === 'unstable') return 'watch pending checks; avoid duplicate no-action reports until cadence is due';
  return nextActionForClassification({ kind: state.lastKind || 'unknown', checks: { failed: [], pending: [] } });
}

export function recordObservation(state, target, pr, classification, plannedAction, now = new Date()) {
  const entry = buildObservationEntry(pr, classification, plannedAction, now);
  const existing = Array.isArray(state.observationLedger) ? state.observationLedger : [];
  state.observationLedger = [...existing, entry].slice(-observationLedgerLimit(target));
  const summary = summarizeObservationLedger(state.observationLedger, now);
  state.observationSummary = summary;
  state.lastObservationAt = entry.at;
  if (entry.kind === 'clean') state.lastCleanAt = entry.at;
  if (OBSERVATION_WARNING_KINDS.has(entry.kind)) {
    state.lastWarningAt = entry.at;
    state.lastWarningKind = entry.kind;
  }
  state.lastDoctorWarnings = observationDoctorWarnings(summary);
  state.nextRecommendedAction = nextRecommendedAction(target, state);
  return entry;
}
