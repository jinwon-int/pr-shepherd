#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATIC_ACTION_CLASSES, MINOR_AUTO_SAFE_REPAIR_SCOPE, assertNoOpenClawRuntimeContextPaths, findOpenClawRuntimeContextPaths } from './lib/policy.mjs';
import { parseArgs } from './lib/cli-args.mjs';
import { loadJson, saveJson, validateConfigObject } from './lib/config.mjs';
import { buildMinorAutoExecutionController, minorAutoCircuitBreaker } from './lib/minor-auto.mjs';
import { appendActionLedgerEntry, appendPlanLedgerEntry, approvalMetadata, redact, redactForLedgerString } from './lib/ledger.mjs';
import { appendOperatorDecisionLedgerEntry, appendSupervisedRehearsalQueueLedgerEntry, buildReviewStateFeedback, buildSupervisedRehearsalQueuePacket, summarizeOperatorDecisionLedger } from './lib/review-feedback.mjs';
import { nextRecommendedAction, recordObservation, summarizeObservationLedger } from './lib/observation.mjs';
import { acquireLock, assertMultiTargetLiveRepairAllowed, defaultState, loadConfig, run, runShell, selectTargets } from './lib/targets.mjs';
import { buildFleetOperatorBrief, buildStatusRows, buildTargetIncidentSummary, targetStateTier } from './lib/fleet.mjs';
import { ghPrChangedFiles, ghPrViewWithUnknownRecheck } from './lib/github.mjs';
import { classifyPr } from './lib/classify.mjs';
import { buildRepairRehearsalApprovalPackage, buildVerifyGate, consumeLiveRepairApproval, currentBaseOid, hasLiveRepairApproval } from './lib/approval.mjs';
import { buildPhaseDOperatorPacket, buildRehearsalEvidenceDigest } from './lib/packets.mjs';
import { automaticActionExecution, buildAutomaticActionPlan, executeAutomaticActionPlan, explainAutomaticActionPlan, planAutomaticAction, planConflictAutomaticAction } from './lib/plan.mjs';
import { buildLiveRepairExecutionHarness, buildMinorAutoPostPushObservation, buildPostActionAuditEntry } from './lib/phase-e.mjs';
import { handleCanary, lastActionSummary, maybeNotifySituationReport, notify, sendSituationReport, updateStateFromPr } from './lib/notify.mjs';
import { assertNoOpenClawRuntimeContextInBranch, buildConflictDiagnosisBundle, buildRepairPlanHandoffFromDiagnosisBundle, classifyConflictSet, conflictSetKey, ensureWorktree, nonRepairableBlockReason, normalizedRepoPath, recentAutoPushes, repairAttemptKey, resolveAutoSafeConflicts, runFocusedChecks, writeConflictArtifact, writeConflictDiagnosisBundle } from './lib/conflicts.mjs';

// Public API re-exported for tests and embedders; implementation lives in lib/.
export { PR_FIELDS, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, DEFAULT_SITUATION_REPORT_EVERY_MS, MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS, MINOR_AUTO_SAFE_REPAIR_SCOPE, SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS, MINOR_AUTO_ROLLOUT_MODES, DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS, AUTOMATIC_ACTION_CLASSES, FLEET_TARGET_STATE_TIERS, DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS, DEFAULT_REPAIR_PLAN_HANDOFF_MAX_AGE_MS, DEFAULT_SUPERVISED_REHEARSAL_QUEUE_MAX_AGE_MS, DEFAULT_REHEARSAL_EVIDENCE_DIGEST_MAX_AGE_MS, DEFAULT_ACTION_LEDGER_LIMIT, DEFAULT_OBSERVATION_LEDGER_LIMIT, DEFAULT_STRICT_VERIFY_REQUIRED, DEFAULT_INCIDENT_BLOCK_THRESHOLD, PHASE_E_POST_ACTION_OUTCOMES, REVIEW_DECISION_OUTCOMES, findOpenClawRuntimeContextPaths } from './lib/policy.mjs';
export { isSafeDiagnosisHintCommand, validateConfigObject } from './lib/config.mjs';
export { buildMinorAutoRepairGate, buildMinorAutoExecutionController, executeMinorAutoExecutionController } from './lib/minor-auto.mjs';
export { redactLedgerValue, appendActionLedgerEntry, summarizeActionLedger } from './lib/ledger.mjs';
export { buildReviewStateFeedback, appendOperatorDecisionLedgerEntry, buildSupervisedRehearsalQueuePacket, appendSupervisedRehearsalQueueLedgerEntry, summarizeOperatorDecisionLedger } from './lib/review-feedback.mjs';
export { summarizeObservationLedger } from './lib/observation.mjs';
export { selectTargets, multiTargetLiveRepairGateFailures } from './lib/targets.mjs';
export { targetStateTier, buildTargetIncidentSummary, buildFleetOperatorBrief, buildStatusRows } from './lib/fleet.mjs';
export { classifyChecks, classifyPr, notificationKey } from './lib/classify.mjs';
export { buildVerifyGate, liveRepairApprovalState, buildRepairRehearsalApprovalPackage } from './lib/approval.mjs';
export { buildPhaseDCandidateGate, buildRehearsalEvidenceDigest, buildPhaseDOperatorPacket } from './lib/packets.mjs';
export { planAutomaticAction, planConflictAutomaticAction, explainAutomaticActionPlan, executeAutomaticActionPlan } from './lib/plan.mjs';
export { buildPostActionAuditEntry, buildMinorAutoRollbackGuidance, buildMinorAutoPostPushObservation, buildLiveRepairExecutionHarness } from './lib/phase-e.mjs';
export { buildCanaryNotificationLine, buildSituationReportLine } from './lib/notify.mjs';
export { classifyConflictPath, classifyConflictSet, buildRepairPlanHandoffFromDiagnosisBundle, buildConflictDiagnosisBundle, conflictSetKey, buildConflictArtifactPayload, resolveChangelogConflict } from './lib/conflicts.mjs';

function handleCheck(target, opts = {}) {
  const state = { ...defaultState(target), ...loadJson(target.statePath, {}) };
  if (state.disabled) {
    const classification = { kind: 'disabled', checks: { failed: [], pending: [] } };
    const now = new Date();
    const plannedAction = explainAutomaticActionPlan(planAutomaticAction(target, state, {}, classification, { dryRun: true, now: now.getTime() }));
    recordObservation(state, target, null, classification, plannedAction, now);
    maybeNotifySituationReport(target, state, null, classification, now);
    saveJson(target.statePath, state);
    const summary = { target: target.id, kind: 'disabled', disabled: true, plannedAction };
    if (opts.print !== false) console.log(JSON.stringify(summary, null, 2));
    return { target, state, pr: null, classification, summary };
  }
  const { pr, classification, rechecks } = ghPrViewWithUnknownRecheck(target);
  const wasDisabled = Boolean(state.disabled);
  updateStateFromPr(state, pr, classification);
  if (!wasDisabled && state.disabled) {
    appendActionLedgerEntry(state, target, {
      actionClass: AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE,
      result: 'disabled',
      expectedHeadOid: pr.headRefOid || null,
      expectedBaseOid: currentBaseOid(state, pr),
      disableNote: 'PR merged; target disabled',
    });
  }
  state.lastKind = classification.kind;
  state.lastUnknownRecheckCount = rechecks;

  if (classification.kind === 'unstable') {
    const pendingSince = state.pendingSince || new Date().toISOString();
    state.pendingSince = pendingSince;
  } else {
    delete state.pendingSince;
  }

  const now = new Date();
  const lastMinorAutoPush = [...(state.autoPushes || [])]
    .reverse()
    .find((push) => push?.reason === MINOR_AUTO_SAFE_REPAIR_SCOPE || push?.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE);
  if (lastMinorAutoPush) {
    const previousObservedHead = state.lastMinorAutoPostPushObservation?.expectedRefs?.afterHeadOid || null;
    const pushedHead = lastMinorAutoPush.to || state.lastPostActionAudit?.expectedRefs?.afterHeadOid || pr.headRefOid || null;
    if (previousObservedHead !== pushedHead || ['failed', 'unstable', 'unknown', 'dirty'].includes(classification.kind)) {
      const observation = buildMinorAutoPostPushObservation(target, pr, state, {
        now,
        beforeHeadOid: lastMinorAutoPush.from || state.lastPostActionAudit?.expectedRefs?.beforeHeadOid || null,
        afterHeadOid: pushedHead,
      });
      state.lastMinorAutoPostPushObservation = observation;
      if (observation.rolloutStopRequired) state.minorAutoCircuitBreaker = observation.circuitBreakerTransition;
    }
  }
  const plannedAction = explainAutomaticActionPlan(planAutomaticAction(target, state, pr, classification, { dryRun: true, now: now.getTime() }));
  recordObservation(state, target, pr, classification, plannedAction, now);
  maybeNotifySituationReport(target, state, pr, classification, now);

  saveJson(target.statePath, state);
  const summary = { target: target.id, kind: classification.kind, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, reviewDecision: pr.reviewDecision || null, failed: classification.checks.failed.length, pending: classification.checks.pending.length, rechecks, disabled: state.disabled, plannedAction, observationSummary: state.observationSummary, doctorWarnings: state.lastDoctorWarnings || [], nextRecommendedAction: state.nextRecommendedAction || null };
  if (opts.print !== false) console.log(JSON.stringify(summary, null, 2));
  return { target, state, pr, classification, summary };
}

function handleDiagnose(target, args = {}) {
  const outcome = handleCheck(target, { print: false });
  const state = { ...outcome.state };
  const pr = outcome.pr || {};
  const classification = outcome.classification || { kind: state.lastKind || 'unknown', checks: { failed: [], pending: [] } };
  const changedFiles = outcome.pr ? ghPrChangedFiles(target) : [];
  const conflicts = Array.isArray(state.lastConflictPaths) ? state.lastConflictPaths : [];
  const conflictInfo = classifyConflictSet(conflicts, target);
  const plan = buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY, {
    target: target.id,
    pr: target.pr,
    classification: classification.kind,
    writesArtifact: true,
    requiresOperatorApproval: false,
    conflicts: conflicts.slice().sort(),
    reasons: ['diagnose-only command writes a sanitized bundle, never pushes, and does not edit the watched worktree'],
  });
  const now = new Date();
  const bundle = buildConflictDiagnosisBundle(target, pr, classification, state, {
    now,
    changedFiles,
    conflicts,
    conflictInfo,
    plan,
    baseOid: currentBaseOid(state, pr),
  });
  const artifactPath = writeConflictDiagnosisBundle(target, bundle, args.artifactDir);
  state.lastAutomaticActionPlan = plan;
  state.lastAutomaticActionExecution = automaticActionExecution(plan, 'executed', { result: basename(artifactPath) });
  state.lastConflictDiagnosisBundle = {
    at: now.toISOString(),
    artifact: basename(artifactPath),
    conflictKey: bundle.expectedRefs.conflictKey,
    classification: bundle.prState.classification,
    conflictTier: bundle.conflictPolicy.tier,
  };
  state.lastActionSummary = `diagnose-only bundle written: ${basename(artifactPath)}`;
  appendPlanLedgerEntry(state, target, plan, 'diagnosed', {
    conflictKey: bundle.expectedRefs.conflictKey,
    expectedHeadOid: bundle.expectedRefs.headRefOid,
    expectedBaseOid: bundle.expectedRefs.baseRefOid,
    rollbackNote: 'diagnosis only; no branch mutation and no watched worktree edits',
    details: { artifact: basename(artifactPath), conflictTier: bundle.conflictPolicy.tier },
    now,
  });
  saveJson(target.statePath, state);
  const summary = { target: target.id, ok: true, kind: classification.kind, actionClass: plan.actionClass, artifact: artifactPath, bundle };
  console.log(JSON.stringify(summary, null, 2));
  return { target, state, pr, classification, summary };
}

function handleRepairPlan(args = {}) {
  const bundle = loadJson(resolve(args.diagnoseBundle), null);
  const handoff = buildRepairPlanHandoffFromDiagnosisBundle(bundle);
  if (args.output) {
    assertNoOpenClawRuntimeContextPaths([normalizedRepoPath(args.output)], 'repair-plan handoff artifact');
    saveJson(resolve(args.output), handoff);
  }
  console.log(JSON.stringify(handoff, null, 2));
  if (handoff.terminalLedgerMarker === 'Block') process.exitCode = 1;
  return handoff;
}

function targetFromHandoff(handoff = {}, target = {}) {
  return {
    id: target.id || handoff.target || null,
    pr: target.pr || handoff.pr || null,
    url: target.url || handoff.url || null,
    owner: target.owner || null,
    repo: target.repo || null,
    number: target.number || null,
    headBranch: target.headBranch || handoff.expectedRefs?.headBranch || null,
    baseBranch: target.baseBranch || handoff.expectedRefs?.baseBranch || null,
    privatePaths: target.privatePaths || [],
  };
}

function targetFromFeedback(feedback = {}, target = {}) {
  return {
    id: target.id || feedback.target || null,
    pr: target.pr || feedback.pr || null,
    url: target.url || feedback.url || null,
    owner: target.owner || null,
    repo: target.repo || null,
    number: target.number || null,
    headBranch: target.headBranch || feedback.expectedRefs?.headBranch || null,
    baseBranch: target.baseBranch || feedback.expectedRefs?.baseBranch || null,
    privatePaths: target.privatePaths || [],
  };
}

function handleDecisionLedger(args = {}) {
  const handoff = loadJson(resolve(args.handoff), null);
  let target = targetFromHandoff(handoff);
  let statePath = args.statePath || null;
  let state = statePath ? loadJson(resolve(statePath), {}) : {};
  let currentPr = args.prState ? loadJson(resolve(args.prState), {}) : null;
  let classification = null;
  if (args.config) {
    const cfg = loadConfig(args.config);
    const selected = selectTargets(cfg, args.targetSelectors, false);
    if (selected.length !== 1) throw new Error('decision-ledger requires exactly one selected target when --config is used');
    target = targetFromHandoff(handoff, selected[0]);
    statePath = statePath || selected[0].statePath || null;
    state = statePath ? { ...loadJson(resolve(statePath), {}) } : {};
    if (!currentPr) {
      const refreshed = ghPrViewWithUnknownRecheck(selected[0]);
      currentPr = refreshed.pr;
      classification = refreshed.classification;
    }
  }
  if (!currentPr) currentPr = {};
  classification = classification || classifyPr(currentPr);
  const feedback = buildReviewStateFeedback(handoff, currentPr, state, {
    target,
    classification,
    decision: args.decision,
    operator: args.operator,
    summary: args.summary,
    nextOwner: args.nextOwner,
    workstream: args.workstream,
    focusedChecks: args.focusedChecks,
    riskFlags: args.riskFlags,
  });
  appendOperatorDecisionLedgerEntry(state, target, feedback, new Date(feedback.createdAt));
  if (statePath) saveJson(resolve(statePath), state);
  if (args.output) {
    assertNoOpenClawRuntimeContextPaths([normalizedRepoPath(args.output)], 'decision-ledger feedback artifact');
    saveJson(resolve(args.output), feedback);
  }
  console.log(JSON.stringify({ ok: feedback.status !== 'blocked', feedback, operatorDecisionLedger: summarizeOperatorDecisionLedger(state.operatorDecisionLedger || []) }, null, 2));
  if (feedback.terminalLedgerMarker === 'Block') process.exitCode = 1;
  return feedback;
}

function handlePhaseDOperatorPacket(args = {}) {
  const cfg = loadConfig(args.config);
  const selected = selectTargets(cfg, args.targetSelectors, false);
  if (selected.length !== 1) throw new Error('phase-d-packet requires exactly one selected target');
  const target = selected[0];
  const statePath = args.statePath || target.statePath || null;
  const state = statePath ? { ...loadJson(resolve(statePath), {}) } : {};
  let currentPr = args.prState ? loadJson(resolve(args.prState), {}) : null;
  let classification = null;
  if (!currentPr) {
    const refreshed = ghPrViewWithUnknownRecheck(target);
    currentPr = refreshed.pr;
    classification = refreshed.classification;
  }
  classification = classification || classifyPr(currentPr || {});
  const packet = buildPhaseDOperatorPacket(target, currentPr || {}, state, {
    classification,
    operator: args.operator,
    preparedBy: args.preparedBy,
    configRevision: args.configRevision,
    phaseBSummary: args.phaseBSummary,
    phaseCRehearsalEvidence: args.phaseCRehearsalEvidence,
    decisionDeadline: args.decisionDeadline,
    branchDiffPaths: args.branchDiffPaths,
    artifactEvidencePaths: args.artifactEvidencePaths,
  });
  state.lastPhaseDOperatorPacket = packet;
  if (statePath) saveJson(resolve(statePath), state);
  if (args.output) {
    assertNoOpenClawRuntimeContextPaths([normalizedRepoPath(args.output)], 'Phase D operator packet artifact');
    saveJson(resolve(args.output), packet);
  }
  console.log(JSON.stringify({ ok: packet.packetAllowed, packet }, null, 2));
  if (packet.terminalLedgerMarker === 'Block') process.exitCode = 1;
  return packet;
}

function handleRehearsalQueue(args = {}) {
  const feedback = loadJson(resolve(args.feedback), null);
  let target = targetFromFeedback(feedback);
  let statePath = args.statePath || null;
  let state = statePath ? loadJson(resolve(statePath), {}) : {};
  let currentPr = args.prState ? loadJson(resolve(args.prState), {}) : null;
  let classification = null;
  if (args.config) {
    const cfg = loadConfig(args.config);
    const selected = selectTargets(cfg, args.targetSelectors, false);
    if (selected.length !== 1) throw new Error('rehearsal-queue requires exactly one selected target when --config is used');
    target = targetFromFeedback(feedback, selected[0]);
    statePath = statePath || selected[0].statePath || null;
    state = statePath ? { ...loadJson(resolve(statePath), {}) } : {};
    if (!currentPr) {
      const refreshed = ghPrViewWithUnknownRecheck(selected[0]);
      currentPr = refreshed.pr;
      classification = refreshed.classification;
    }
  }
  if (!currentPr) currentPr = {};
  classification = classification || classifyPr(currentPr);
  const packet = buildSupervisedRehearsalQueuePacket(feedback, currentPr, state, {
    target,
    classification,
    queueName: args.queueName,
    priority: args.priority,
  });
  appendSupervisedRehearsalQueueLedgerEntry(state, target, packet, new Date(packet.createdAt));
  if (statePath) saveJson(resolve(statePath), state);
  if (args.output) {
    assertNoOpenClawRuntimeContextPaths([normalizedRepoPath(args.output)], 'rehearsal queue artifact');
    saveJson(resolve(args.output), packet);
  }
  console.log(JSON.stringify({ ok: packet.queueAllowed, packet }, null, 2));
  if (packet.terminalLedgerMarker === 'Block') process.exitCode = 1;
  return packet;
}

function handleRepair(target, dryRun, opts = {}) {
  const unlock = acquireLock(target.lockPath, target.staleLockMs || 0);
  try {
    const { state, pr, classification } = handleCheck(target);
    if (state.disabled && classification.kind === 'disabled' && !hasLiveRepairApproval(target)) return;
    if (classification.kind !== 'dirty') {
      const blockReason = nonRepairableBlockReason(classification.kind);
      if (!dryRun && hasLiveRepairApproval(target)) {
        const outcome = classification.kind === 'clean' ? 'no-op' : 'block';
        const plan = buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.BLOCK, {
          target: target.id,
          pr: target.pr,
          classification: classification.kind,
          allowed: false,
          requiresOperatorApproval: true,
          reasons: [`approval present but target is not repairable: ${blockReason}`],
        });
        state.lastAutomaticActionPlan = plan;
        state.lastAutomaticActionExecution = executeAutomaticActionPlan(plan, {}, { throwOnBlocked: false });
        state.lastPostActionAudit = buildPostActionAuditEntry(target, pr || {}, outcome, {
          state,
          result: blockReason,
          executionOutcome: outcome,
          approvalPresent: true,
          blockReason,
          actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK,
          operatorSummary: `${target.pr} live repair ${outcome}: approval present but current target state is ${classification.kind}; no branch mutation.`,
        });
        consumeLiveRepairApproval(state, target, outcome, blockReason);
        state.lastActionSummary = `live repair ${outcome}: ${blockReason}; no branch mutation`;
        appendPlanLedgerEntry(state, target, plan, outcome, {
          repairKey: repairAttemptKey(pr || {}, state.lastSeenBaseOid),
          expectedHeadOid: pr?.headRefOid || null,
          expectedBaseOid: currentBaseOid(state, pr || {}),
          rollbackNote: 'no branch mutation; one-shot approval consumed or invalidated by non-repairable state',
          details: { blockReason, approvalPresent: true, classification: classification.kind },
        });
        notify(target, state, `repair-noop:${classification.kind}:${pr?.headRefOid || 'no-head'}`, `${target.pr} live repair ${outcome}: ${blockReason}; no branch mutation`, true);
        saveJson(target.statePath, state);
      }
      console.log(`[pr-shepherd:${target.id}] no repair needed for ${classification.kind}`);
      return;
    }

    const preRepairKey = repairAttemptKey(pr, state.lastSeenBaseOid);
    if (state.lastRepairFailureKey === preRepairKey) {
      notify(target, state, `repeat-failure:${preRepairKey}`, `${target.pr} repair already failed for this head/base state; human intervention needed`, true);
      saveJson(target.statePath, state);
      return;
    }

    const pushes24h = recentAutoPushes(state);
    if (pushes24h.length >= target.autoPushLimit24h) {
      notify(target, state, `push-limit:${new Date().toISOString().slice(0, 10)}`, `${target.pr} auto-push limit reached (${pushes24h.length}/${target.autoPushLimit24h})`, true);
      saveJson(target.statePath, state);
      return;
    }

    notify(target, state, `repair-start:${preRepairKey}`, `${target.pr} DIRTY/CONFLICTING; starting ${dryRun ? 'dry-run ' : ''}repair`, true);
    const automaticPlan = planAutomaticAction(target, state, pr, classification, { dryRun, now: Date.now() });
    state.lastAutomaticActionPlan = automaticPlan;
    if (dryRun) {
      const execution = executeAutomaticActionPlan(automaticPlan, {}, { dryRun: true });
      state.lastAutomaticActionExecution = execution;
      const now = new Date();
      const approvalPackage = buildRepairRehearsalApprovalPackage(target, pr, state, automaticPlan, {
        now,
        repairKey: preRepairKey,
        baseOid: currentBaseOid(state, pr),
        classification: classification.kind,
        artifactDir: opts.artifactDir,
      });
      state.lastRepairRehearsal = {
        at: now.toISOString(),
        target: target.id,
        repairKey: preRepairKey,
        headRefOid: pr.headRefOid || null,
        baseOid: currentBaseOid(state, pr),
        classification: classification.kind,
        approvalPackage,
      };
      state.lastActionSummary = `dry-run/rehearsal package ready at ${now.toISOString()}; no git mutation`;
      appendPlanLedgerEntry(state, target, automaticPlan, 'rehearsed', {
        repairKey: preRepairKey,
        expectedHeadOid: pr.headRefOid || null,
        expectedBaseOid: currentBaseOid(state, pr),
        rollbackNote: approvalPackage.rollbackNote,
        details: {
          approvalPackageSchema: approvalPackage.schema,
          approvalText: approvalPackage.approvalText,
          abortCriteria: approvalPackage.abortCriteria,
          expectedRefs: approvalPackage.expectedRefs,
        },
        now,
      });
      state.lastRehearsalEvidenceDigest = buildRehearsalEvidenceDigest(target, pr, state, {
        now,
        rehearsal: state.lastRepairRehearsal,
        classification,
        artifactEvidencePaths: opts.artifactDir ? [normalizedRepoPath(opts.artifactDir)] : [],
      });
      state.lastRepairRehearsal.evidenceDigest = state.lastRehearsalEvidenceDigest;
      sendSituationReport(target, state, pr, classification, `situation:dry-run:${preRepairKey}`);
      saveJson(target.statePath, state);
      console.log(`[pr-shepherd:${target.id}] action ${execution.status}: ${execution.actionClass}; ${execution.reasons.join('; ')}`);
      console.log(`[pr-shepherd:${target.id}] dry-run stops before git mutation`);
      console.log(JSON.stringify({
        schema: approvalPackage.schema,
        target: approvalPackage.target,
        repairKey: approvalPackage.expectedRefs.repairKey,
        approvalText: approvalPackage.approvalText,
        abortCriteria: approvalPackage.abortCriteria,
        rollbackNote: approvalPackage.rollbackNote,
        rehearsalEvidenceDigest: {
          schema: state.lastRehearsalEvidenceDigest.schema,
          digestId: state.lastRehearsalEvidenceDigest.digestId,
          phaseDCandidateAllowed: state.lastRehearsalEvidenceDigest.phaseDCandidateGate.candidateAllowed,
          blockedReasons: state.lastRehearsalEvidenceDigest.phaseDCandidateGate.blockedReasons,
        },
      }, null, 2));
      return;
    }
    state.lastExecutionReadinessHarness = buildLiveRepairExecutionHarness(target, pr, state, {
      classification,
      plan: automaticPlan,
      repairKey: preRepairKey,
      baseOid: currentBaseOid(state, pr),
      artifactDir: opts.artifactDir,
    });
    if (!automaticPlan.allowed) {
      const execution = executeAutomaticActionPlan(automaticPlan, {}, { throwOnBlocked: false });
      state.lastAutomaticActionExecution = execution;
      state.lastPostActionAudit = buildPostActionAuditEntry(target, pr, 'block', {
        state,
        result: 'policy-block',
        repairKey: preRepairKey,
        baseOid: currentBaseOid(state, pr),
        operatorSummary: `${target.pr} live repair blocked before worktree access: ${automaticPlan.reasons.join('; ')}`,
      });
      state.lastActionSummary = `live repair blocked: ${automaticPlan.reasons.join('; ')}`;
      appendPlanLedgerEntry(state, target, automaticPlan, 'blocked', {
        repairKey: preRepairKey,
        expectedHeadOid: pr.headRefOid || null,
        expectedBaseOid: currentBaseOid(state, pr),
        rollbackNote: 'blocked before worktree access; no branch mutation',
      });
      notify(target, state, `repair-policy-block:${preRepairKey}`, `${target.pr} live repair blocked by automatic action policy: ${automaticPlan.reasons.join('; ')}`, true);
      saveJson(target.statePath, state);
      executeAutomaticActionPlan(automaticPlan);
    }
    state.lastAutomaticActionExecution = executeAutomaticActionPlan(automaticPlan);

    ensureWorktree(target);
    run('git', ['fetch', 'upstream', target.baseBranch], { cwd: target.worktreePath });
    const baseOid = run('git', ['rev-parse', `upstream/${target.baseBranch}`], { cwd: target.worktreePath }).stdout.trim();
    state.lastSeenBaseOid = baseOid;
    const repairKey = repairAttemptKey(pr, baseOid);
    const postFetchPlan = planAutomaticAction(target, state, { ...pr, baseRefOid: baseOid }, classification, { dryRun: false, now: Date.now() });
    state.lastAutomaticActionPlan = postFetchPlan;
    state.lastExecutionReadinessHarness = buildLiveRepairExecutionHarness(target, { ...pr, baseRefOid: baseOid }, state, {
      classification,
      plan: postFetchPlan,
      repairKey,
      baseOid,
      artifactDir: opts.artifactDir,
    });
    if (!postFetchPlan.allowed) {
      const execution = executeAutomaticActionPlan(postFetchPlan, {}, { throwOnBlocked: false });
      state.lastAutomaticActionExecution = execution;
      state.lastPostActionAudit = buildPostActionAuditEntry(target, { ...pr, baseRefOid: baseOid }, 'block', {
        state,
        result: 'post-fetch-policy-block',
        repairKey,
        baseOid,
        operatorSummary: `${target.pr} live repair blocked after fetch: ${postFetchPlan.reasons.join('; ')}`,
      });
      state.lastActionSummary = `live repair blocked after fetch: ${postFetchPlan.reasons.join('; ')}`;
      appendPlanLedgerEntry(state, target, postFetchPlan, 'blocked', {
        repairKey,
        expectedHeadOid: pr.headRefOid || null,
        expectedBaseOid: baseOid,
        rollbackNote: 'blocked after fetch; no branch mutation pushed',
      });
      notify(target, state, `repair-policy-block:${repairKey}`, `${target.pr} live repair blocked after fetch by automatic action policy: ${postFetchPlan.reasons.join('; ')}`, true);
      saveJson(target.statePath, state);
      executeAutomaticActionPlan(postFetchPlan);
    }
    state.lastAutomaticActionExecution = executeAutomaticActionPlan(postFetchPlan);
    if (state.lastRepairFailureKey === repairKey) {
      notify(target, state, `repeat-failure:${repairKey}`, `${target.pr} repair already failed for this head/base state; human intervention needed`, true);
      saveJson(target.statePath, state);
      return;
    }

    run('git', ['fetch', 'origin', `${target.headBranch}:${target.headBranch}`], { cwd: target.worktreePath, allowFailure: true });
    run('git', ['fetch', 'origin', target.headBranch], { cwd: target.worktreePath });
    const remoteHead = run('git', ['rev-parse', `origin/${target.headBranch}`], { cwd: target.worktreePath }).stdout.trim();
    run('git', ['checkout', '-B', target.headBranch, `origin/${target.headBranch}`], { cwd: target.worktreePath });
    let resolvedConflictInfo = null;
    const rebase = run('git', ['rebase', `upstream/${target.baseBranch}`], { cwd: target.worktreePath, allowFailure: true });
    if (rebase.status !== 0) {
      const conflicts = runShell('git diff --name-only --diff-filter=U', target.worktreePath, { allowFailure: true }).stdout.trim().split('\n').filter(Boolean);
      const contextConflicts = findOpenClawRuntimeContextPaths(conflicts);
      const conflictInfo = classifyConflictSet(conflicts, target);
      const conflictPlan = planConflictAutomaticAction(conflictInfo, conflicts);
      state.lastAutomaticActionPlan = conflictPlan;
      state.lastAutomaticActionExecution = executeAutomaticActionPlan(conflictPlan, {}, { dryRun: true });
      const conflictKey = conflictSetKey(pr, baseOid, conflicts);
      if (contextConflicts.length > 0) {
        run('git', ['rebase', '--abort'], { cwd: target.worktreePath, allowFailure: true });
        state.lastRepairFailureKey = repairKey;
        state.lastConflictSetKey = conflictKey;
        state.lastConflictTier = 'runtimeContext';
        state.lastConflictPaths = contextConflicts;
        state.lastActionSummary = `repair stopped: runtime context conflicts ${contextConflicts.join(', ')}`;
        appendPlanLedgerEntry(state, target, conflictPlan, 'blocked', {
          repairKey,
          conflictKey,
          expectedHeadOid: pr.headRefOid || null,
          expectedBaseOid: baseOid,
          rollbackNote: 'rebase aborted; runtime context conflict evidence blocked',
          details: { offendingPaths: contextConflicts },
        });
        notify(target, state, `runtime-context-conflict:${conflictKey}`, `${target.pr} repair stopped: OpenClaw runtime/bootstrap context paths would enter artifact evidence; refusing: ${contextConflicts.join(', ')}`, true);
        sendSituationReport(target, state, pr, classification, `situation:runtime-context-conflict:${conflictKey}`);
        saveJson(target.statePath, state);
        return;
      }
      const canResolveAutomatically = conflictPlan.actionClass === AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR && executeAutomaticActionPlan(conflictPlan, {
        [AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR]: () => resolveAutoSafeConflicts(target, conflictInfo),
      }).result;
      if (canResolveAutomatically) state.lastAutomaticActionExecution = automaticActionExecution(conflictPlan, 'executed', { result: true });
      if (canResolveAutomatically) {
        resolvedConflictInfo = conflictInfo;
        run('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: target.worktreePath });
      } else {
        const diagnosisBundle = () => buildConflictDiagnosisBundle(target, { ...pr, baseRefOid: baseOid }, classification, state, {
          conflicts,
          conflictInfo,
          conflictKey,
          baseOid,
        });
        const artifactExecution = executeAutomaticActionPlan(conflictPlan, {
          [AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT]: () => writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir),
          [AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY]: () => writeConflictDiagnosisBundle(target, diagnosisBundle(), opts.artifactDir),
          [AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE]: () => writeConflictDiagnosisBundle(target, diagnosisBundle(), opts.artifactDir),
        });
        let artifactPath = artifactExecution.result;
        if (!artifactPath) {
          const fallbackBundle = diagnosisBundle();
          artifactPath = conflictPlan.actionClass === AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT
            ? writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir)
            : writeConflictDiagnosisBundle(target, fallbackBundle, opts.artifactDir);
          state.lastAutomaticActionExecution = automaticActionExecution(conflictPlan, 'skipped', { result: artifactPath });
        } else {
          state.lastAutomaticActionExecution = artifactExecution;
        }
        const keepWorktree = conflictInfo.tier === 'codeAssisted'
          && target.keepFailedRebaseWorktree !== false
          && opts.keepFailedRebaseWorktree !== false;
        if (!keepWorktree) run('git', ['rebase', '--abort'], { cwd: target.worktreePath, allowFailure: true });
        state.lastRepairFailureKey = repairKey;
        state.lastConflictSetKey = conflictKey;
        state.lastConflictTier = conflictInfo.tier;
        state.lastConflictPaths = conflicts.slice().sort();
        state.lastActionSummary = `repair stopped: ${conflictInfo.tier} conflicts ${conflicts.join(', ') || '(unknown)'}`;
        appendPlanLedgerEntry(state, target, conflictPlan, 'conflict-artifact', {
          repairKey,
          conflictKey,
          expectedHeadOid: pr.headRefOid || null,
          expectedBaseOid: baseOid,
          rollbackNote: keepWorktree ? 'failed rebase worktree kept for code-assisted review; push not attempted' : 'rebase aborted; push not attempted',
          details: { conflictTier: conflictInfo.tier, conflicts, artifact: basename(artifactPath) },
        });
        const pushNote = conflictInfo.tier === 'codeAssisted' && !opts.allowCodeAssistedPush
          ? '; push blocked pending explicit code-assisted approval'
          : '; no automatic resolver available, push not attempted';
        notify(target, state, `repair-conflict:${conflictKey}`, `${target.pr} repair stopped: ${conflictInfo.tier} conflicts ${conflicts.join(', ') || '(unknown)'}${pushNote}; artifact ${basename(artifactPath)}`, true);
        sendSituationReport(target, state, pr, classification, `situation:repair-conflict:${conflictKey}`);
        saveJson(target.statePath, state);
        return;
      }
    }

    runFocusedChecks(target);
    const changedPaths = run('git', ['diff', '--name-only', `upstream/${target.baseBranch}...HEAD`], { cwd: target.worktreePath }).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    assertNoOpenClawRuntimeContextInBranch(target, `upstream/${target.baseBranch}`);

    const ls = run('git', ['ls-remote', 'origin', `refs/heads/${target.headBranch}`], { cwd: target.worktreePath }).stdout.trim().split(/\s+/)[0];
    if (postFetchPlan.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE) {
      const controller = buildMinorAutoExecutionController(target, { ...pr, baseRefOid: baseOid }, state, {
        now: Date.now(),
        plan: postFetchPlan,
        classification,
        repairKey,
        baseOid,
        changedPaths,
        conflictInfo: resolvedConflictInfo,
        focusedChecksPassed: true,
        expectedRemoteHeadOid: remoteHead,
        currentRemoteHeadOid: ls,
        artifactEvidencePaths: opts.artifactDir ? [normalizedRepoPath(opts.artifactDir)] : [],
      });
      state.lastMinorAutoExecutionController = controller;
      state.lastMinorAutoRepairGate = controller.minorAutoRepairGate;
      state.lastMinorAutoRepairPreview = controller.minorAutoRepairGate;
      if (!controller.executionAllowed) {
        state.lastPostActionAudit = controller.postActionAudit.block;
        state.lastActionSummary = controller.operatorSummary;
        appendPlanLedgerEntry(state, target, postFetchPlan, 'blocked', {
          repairKey,
          expectedHeadOid: pr.headRefOid || null,
          expectedBaseOid: baseOid,
          rollbackNote: 'minor-auto-safe execution controller blocked before push; no branch mutation pushed',
          details: { minorAutoExecutionController: controller },
        });
        notify(target, state, `minor-auto-block:${repairKey}`, `${target.pr} ${controller.operatorSummary}`, true);
        saveJson(target.statePath, state);
        throw new Error(`minor-auto-safe execution blocked: ${controller.blockedReasons.join('; ')}`);
      }
      if (controller.pushAllowed !== true) {
        state.lastPostActionAudit = controller.postActionAudit.block;
        state.lastActionSummary = controller.operatorSummary;
        appendPlanLedgerEntry(state, target, postFetchPlan, 'planned', {
          repairKey,
          expectedHeadOid: pr.headRefOid || null,
          expectedBaseOid: baseOid,
          rollbackNote: 'minor-auto dry-run rollout completed; push disabled and no branch mutation attempted',
          details: { minorAutoExecutionController: controller },
        });
        notify(target, state, `minor-auto-dry-run:${repairKey}`, `${target.pr} ${controller.operatorSummary}`, true);
        saveJson(target.statePath, state);
        return;
      }
    }
    if (ls !== remoteHead) throw new Error(`remote head changed; refusing push. expected ${remoteHead}, got ${ls}`);
    run('git', ['push', `--force-with-lease=${target.headBranch}:${remoteHead}`, 'origin', `HEAD:${target.headBranch}`], { cwd: target.worktreePath });
    const newHead = run('git', ['rev-parse', 'HEAD'], { cwd: target.worktreePath }).stdout.trim();
    const pushedAt = new Date();
    const minorAutoLane = postFetchPlan.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE;
    state.autoPushes = [...pushes24h, { at: pushedAt.toISOString(), from: remoteHead, to: newHead, reason: minorAutoLane ? MINOR_AUTO_SAFE_REPAIR_SCOPE : 'dirty-rebase', lane: minorAutoLane ? MINOR_AUTO_SAFE_REPAIR_SCOPE : 'approval-required-auto-safe-repair', repo: target.owner && target.repo ? `${target.owner}/${target.repo}` : null }];
    consumeLiveRepairApproval(state, target, 'pushed', 'auto-safe-repair pushed', pushedAt);
    state.lastPostActionAudit = buildPostActionAuditEntry(target, { ...pr, baseRefOid: baseOid }, 'pushed', {
      state,
      repairKey,
      baseOid,
      beforeHeadOid: remoteHead,
      afterHeadOid: newHead,
      operatorSummary: minorAutoLane
        ? `${target.pr} auto-repaired minor-auto-safe changes with force-with-lease; verify PR/CI state.`
        : `${target.pr} repair pushed with force-with-lease; disable one-shot approval and verify PR/CI state.`,
    });
    state.lastActionSummary = minorAutoLane
      ? `auto-repaired minor-auto-safe changes with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`
      : `repair pushed with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`;
    appendPlanLedgerEntry(state, target, postFetchPlan, 'pushed', {
      repairKey,
      expectedHeadOid: pr.headRefOid || null,
      expectedBaseOid: baseOid,
      details: { from: remoteHead, to: newHead, push: 'force-with-lease', lane: postFetchPlan.lane || 'approval-required-auto-safe-repair' },
    });
    delete state.lastRepairFailureKey;
    delete state.lastConflictSetKey;
    notify(target, state, `repair-success:${remoteHead}:${newHead}`, `${target.pr} ${minorAutoLane ? 'auto-repaired minor-auto-safe changes' : 'repair pushed'} with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`, true);
    saveJson(target.statePath, state);
    handleCheck(target);
  } catch (err) {
    const state = { ...defaultState(target), ...loadJson(target.statePath, {}) };
    state.lastActionSummary = `repair failed: ${redact(err.message).slice(0, 300)}`;
    appendActionLedgerEntry(state, target, {
      id: `repair-error:${target.id}:${state.lastAutomaticActionPlan?.actionClass || 'unknown'}:${redactForLedgerString(err.message, target).slice(0, 120)}`,
      actionClass: state.lastAutomaticActionPlan?.actionClass || AUTOMATIC_ACTION_CLASSES.BLOCK,
      result: 'failed',
      approval: approvalMetadata(target),
      expectedHeadOid: state.lastAutomaticActionPlan?.headRefOid || state.lastSeenHeadOid || null,
      expectedBaseOid: state.lastAutomaticActionPlan?.baseRefOid || state.lastSeenBaseOid || null,
      repairKey: state.lastRepairFailureKey || null,
      rollbackNote: 'repair failed closed; no successful push recorded by this ledger entry',
      details: { error: err.message },
    });
    notify(target, state, `repair-error:${String(err.message).slice(0, 160)}`, `${target.pr} repair failed: ${redact(err.message).slice(0, 1200)}`, true);
    saveJson(target.statePath, state);
    throw err;
  } finally {
    unlock();
  }
}

function handleTargetCommand(target, args, opts = {}) {
  if (args.cmd === 'check' || args.cmd === 'check-canary') return handleCheck(target, { print: opts.printCheckSummary });
  if (args.cmd === 'diagnose') return handleDiagnose(target, args);
  return handleRepair(target, args.dryRun, args);
}

function summarizeTargetResult(target, outcome) {
  const state = outcome?.state || {};
  const observationSummary = state.observationSummary || summarizeObservationLedger(state.observationLedger || [], new Date());
  const fleetFields = {
    targetTier: targetStateTier(target, state, Date.now()),
    verifyGate: buildVerifyGate(target),
    incident: buildTargetIncidentSummary(target, state, observationSummary),
  };
  if (outcome?.summary) return { ok: true, ...fleetFields, ...outcome.summary };
  if (outcome?.classification) {
    return {
      target: target.id,
      ok: true,
      kind: outcome.classification.kind,
      disabled: Boolean(outcome.state?.disabled),
      plannedAction: explainAutomaticActionPlan(planAutomaticAction(target, outcome.state || {}, outcome.pr || {}, outcome.classification, { dryRun: true, now: Date.now() })),
      ...fleetFields,
    };
  }
  return { target: target.id, ok: true, ...fleetFields };
}

export function orchestrateTargets(targets, args) {
  const results = [];
  const printCheckSummary = targets.length <= 1;
  for (const target of targets) {
    try {
      const outcome = handleTargetCommand(target, args, { printCheckSummary });
      results.push(summarizeTargetResult(target, outcome));
    } catch (err) {
      results.push({ target: target.id, ok: false, error: redact(err.message) });
      console.error(`[pr-shepherd:${target.id}] ${redact(err.message).slice(0, 8000)}`);
    }
  }
  if (targets.length > 1) console.log(JSON.stringify({ command: args.cmd, fleetBrief: buildFleetOperatorBrief(results), targets: results }, null, 2));
  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) throw new Error(`${failures.length}/${results.length} target(s) failed`);
  return results;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.cmd === 'validate') {
    const report = validateConfigObject(loadJson(resolve(args.config), null), args.config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  if (args.cmd === 'repair-plan') return handleRepairPlan(args);
  if (args.cmd === 'decision-ledger') return handleDecisionLedger(args);
  if (args.cmd === 'rehearsal-queue') return handleRehearsalQueue(args);
  if (args.cmd === 'phase-d-packet') return handlePhaseDOperatorPacket(args);

  const cfg = loadConfig(args.config);
  if (!args.allTargets && args.targetSelectors.length === 0 && cfg.targets.length > 1) {
    console.error('Warning: no --target or --all supplied; processing first configured target for backward compatibility. Use --all to process every target.');
  }
  const targets = selectTargets(cfg, args.targetSelectors, args.allTargets);
  if (args.cmd === 'status') {
    const rows = buildStatusRows(targets);
    console.log(JSON.stringify(targets.length === 1 ? rows[0] : { command: 'status', fleetBrief: buildFleetOperatorBrief(rows), targets: rows }, null, 2));
    return rows;
  }
  if (args.cmd === 'canary') {
    for (const target of targets) handleCanary(target);
    return targets;
  }
  assertMultiTargetLiveRepairAllowed(cfg, targets, args);
  orchestrateTargets(targets, args);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(redact(err.message));
    process.exitCode = 1;
  }
}
