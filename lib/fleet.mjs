// Fleet tiers, incident summaries, operator brief, and status rows.
import { existsSync } from 'node:fs';
import { DEFAULT_INCIDENT_BLOCK_THRESHOLD, FLEET_TARGET_STATE_TIERS, MINOR_AUTO_ROLLOUT_MODES } from './policy.mjs';
import { isEnabledTarget, loadJson } from './config.mjs';
import { minorAutoCircuitBreaker, minorAutoRepairPolicy, minorAutoRolloutMode } from './minor-auto.mjs';
import { summarizeActionLedger } from './ledger.mjs';
import { summarizeOperatorDecisionLedger } from './review-feedback.mjs';
import { nextRecommendedAction, summarizeObservationLedger } from './observation.mjs';
import { defaultState } from './targets.mjs';
import { buildVerifyGate, liveRepairApprovalState } from './approval.mjs';
import { explainAutomaticActionPlan } from './plan.mjs';
import { recentAutoPushes } from './conflicts.mjs';

export function targetStateTier(target = {}, state = {}, now = Date.now()) {
  const approval = liveRepairApprovalState(target, state, {}, now);
  if (approval.state === 'unused') return 'live-approved-once';
  if (state.lastRehearsalEvidenceDigest?.schema === 'pr-shepherd-rehearsal-evidence-digest/v1'
    && state.lastRehearsalEvidenceDigest?.phaseDCandidateGate?.candidateAllowed === true) return 'phase-d-ready';
  if (state.lastRepairRehearsal?.approvalPackage?.schema === 'pr-shepherd-repair-rehearsal-approval/v1') return 'rehearsal-ready';
  if (state.lastKind === 'dirty' || state.lastWarningKind === 'dirty') return 'rehearsal-ready';
  return 'check-only';
}

export function buildTargetIncidentSummary(target = {}, state = {}, observationSummary = null) {
  const ledger = Array.isArray(state.actionLedger) ? state.actionLedger : [];
  const recentBlocks = ledger.slice(-DEFAULT_INCIDENT_BLOCK_THRESHOLD).filter((entry) => ['blocked', 'failed'].includes(entry?.result));
  const unknownCount = observationSummary?.last48h?.byKind?.unknown || 0;
  const failedCount = observationSummary?.last48h?.byKind?.failed || 0;
  const affectedTargets = [target.id || state.target].filter(Boolean);
  if (recentBlocks.length >= DEFAULT_INCIDENT_BLOCK_THRESHOLD) {
    return {
      schema: 'pr-shepherd-incident-summary/v1',
      incidentKind: 'repeated-repair-block',
      severity: 'block',
      affectedTargets,
      repeatedCount: recentBlocks.length,
      recommendedOperatorAction: 'keep target check-only; review approval, verify gate, expected refs, and last block reason before retrying repair',
      safeRollbackOrDisableNote: 'disable automaticActions.liveRepair or let the one-shot approval expire; keep status/check paths enabled for visibility',
      lastBlockReason: recentBlocks.at(-1)?.reasons?.[0] || recentBlocks.at(-1)?.details?.error || null,
    };
  }
  if (unknownCount >= 3 || failedCount >= 3) {
    return {
      schema: 'pr-shepherd-incident-summary/v1',
      incidentKind: unknownCount >= 3 ? 'repeated-unknown' : 'repeated-failed-checks',
      severity: 'warning',
      affectedTargets,
      repeatedCount: Math.max(unknownCount, failedCount),
      recommendedOperatorAction: unknownCount >= 3 ? 'recheck GitHub mergeability and keep repair disabled' : 'review failing checks before any rehearsal or approval',
      safeRollbackOrDisableNote: 'no rollback needed; check/status remains read-only and branch mutation stays disabled',
      lastBlockReason: null,
    };
  }
  return null;
}

export function buildFleetOperatorBrief(rows = []) {
  const counts = Object.fromEntries(FLEET_TARGET_STATE_TIERS.map((tier) => [tier, 0]));
  const rolloutModes = Object.fromEntries(MINOR_AUTO_ROLLOUT_MODES.map((mode) => [mode, 0]));
  const rolloutOutcomes = {};
  const dashboard = { candidates: 0, autoRepaired: 0, blockedNeedsApproval: 0, staleRefreshRequired: 0, circuitBreakerOpen: 0, postPushOutcomes: rolloutOutcomes };
  const byKind = {};
  const affectedTargets = [];
  for (const row of rows) {
    const tier = FLEET_TARGET_STATE_TIERS.includes(row?.targetTier) ? row.targetTier : 'check-only';
    counts[tier] += 1;
    const kind = row?.lastKind || row?.kind || 'unknown';
    byKind[kind] = (byKind[kind] || 0) + 1;
    const rolloutMode = row?.minorAutoRollout?.mode || 'observe-only';
    if (rolloutModes[rolloutMode] !== undefined) rolloutModes[rolloutMode] += 1;
    const rolloutStatus = row?.minorAutoRollout?.status || null;
    if (rolloutStatus === 'candidate') dashboard.candidates += 1;
    if (rolloutStatus === 'auto-repaired') dashboard.autoRepaired += 1;
    if (rolloutStatus === 'blocked-needs-approval') dashboard.blockedNeedsApproval += 1;
    if (rolloutStatus === 'stale-refresh-required') dashboard.staleRefreshRequired += 1;
    if (row?.minorAutoRollout?.circuitBreaker?.state === 'open') dashboard.circuitBreakerOpen += 1;
    const postPushOutcome = row?.minorAutoRollout?.lastPostPushOutcome || null;
    if (postPushOutcome) rolloutOutcomes[postPushOutcome] = (rolloutOutcomes[postPushOutcome] || 0) + 1;
    if (row?.incident) affectedTargets.push(row.target);
  }
  const blockedCount = rows.filter((row) => row?.automaticAction?.status === 'blocked' || row?.incident?.severity === 'block').length;
  const warningCount = rows.filter((row) => (Array.isArray(row?.doctorWarnings) && row.doctorWarnings.length > 0) || row?.incident?.severity === 'warning').length;
  return {
    schema: 'pr-shepherd-fleet-operator-brief/v1',
    targets: rows.length,
    tiers: counts,
    minorAutoRolloutModes: rolloutModes,
    minorAutoDashboard: dashboard,
    byKind,
    cleanCount: byKind.clean || 0,
    warningCount,
    blockedCount,
    approvalReadyCount: counts['phase-d-ready'],
    liveApprovedOnceCount: counts['live-approved-once'],
    affectedTargets,
    liveSendsDefault: 'disabled-or-dry-run',
  };
}

export function buildStatusRows(targets, now = Date.now()) {
  const summaryNow = new Date(now);
  return targets.map((target) => {
    const stateFile = target.statePath && existsSync(target.statePath) ? loadJson(target.statePath, {}) : {};
    const state = { ...defaultState(target), ...stateFile };
    const observationSummary = state.observationSummary || summarizeObservationLedger(state.observationLedger || [], summaryNow);
    const incident = buildTargetIncidentSummary(target, state, observationSummary);
    const targetTier = targetStateTier(target, state, Number(summaryNow));
    const minorPolicy = minorAutoRepairPolicy(target);
    const minorGate = state.lastMinorAutoRepairGate || null;
    const minorPostPush = state.lastMinorAutoPostPushObservation || null;
    const minorAutoRollout = {
      mode: minorAutoRolloutMode(minorPolicy),
      enabled: minorPolicy.enabled === true,
      circuitBreaker: minorAutoCircuitBreaker(state),
      lastGateAllowed: minorGate?.gateAllowed ?? null,
      lastPostPushOutcome: minorPostPush?.outcome || null,
      status: minorPostPush?.outcome === 'stale-refresh-required'
        ? 'stale-refresh-required'
        : (minorPostPush?.outcome || (minorGate?.gateAllowed === true ? 'candidate' : (minorGate?.status || 'observe-only'))),
      pushBudgetRemaining24h: Math.max(0, Number(target.autoPushLimit24h || 0) - recentAutoPushes(state, now).length),
      noAutoMerge: true,
      escalation: 'Seo Jin On approval required for major/risky/semantic/ops-impact changes',
    };
    return {
      target: target.id,
      pr: target.pr,
      targetTier,
      verifyGate: buildVerifyGate(target),
      liveRepairApprovalState: liveRepairApprovalState(target, state, {}, Number(summaryNow)),
      minorAutoRollout,
      incident,
      statePath: target.statePath || null,
      stateExists: Boolean(target.statePath && existsSync(target.statePath)),
      configEnabled: isEnabledTarget(target),
      disabled: Boolean(state.disabled),
      lastKind: state.lastKind || null,
      lastMergeable: state.lastMergeable || null,
      lastMergeStateStatus: state.lastMergeStateStatus || null,
      lastReviewDecision: state.lastReviewDecision || null,
      lastSeenHeadOid: state.lastSeenHeadOid || null,
      lastSeenBaseOid: state.lastSeenBaseOid || null,
      lastFailureNames: state.lastFailureNames || [],
      lastPendingCount: state.lastPendingCount || 0,
      recentAutoPushCount: recentAutoPushes(state, now).length,
      lastNotificationKey: state.lastNotificationKey || null,
      automaticAction: state.lastAutomaticActionExecution || (state.lastAutomaticActionPlan ? explainAutomaticActionPlan(state.lastAutomaticActionPlan) : null),
      actionLedger: summarizeActionLedger(state.actionLedger || []),
      operatorDecisionLedger: summarizeOperatorDecisionLedger(state.operatorDecisionLedger || []),
      lastOperatorDecisionFeedback: state.lastOperatorDecisionFeedback || null,
      observationSummary,
      recentRunAt: state.lastObservationAt || observationSummary.lastRunAt || state.lastRunAt || null,
      lastRunAt: state.lastRunAt || null,
      lastOkAt: state.lastOkAt || null,
      lastCleanAt: state.lastCleanAt || observationSummary.lastCleanAt || state.lastOkAt || null,
      lastWarningAt: state.lastWarningAt || null,
      lastWarningKind: state.lastWarningKind || null,
      doctorWarnings: state.lastDoctorWarnings || [],
      nextRecommendedAction: state.nextRecommendedAction || nextRecommendedAction(target, state),
    };
  });
}
