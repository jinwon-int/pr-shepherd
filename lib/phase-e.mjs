// Phase E execution-readiness harness, post-action audit, and minor-auto post-push helpers.
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS, DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, PHASE_E_POST_ACTION_OUTCOMES, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { minorAutoRepairPolicy, minorAutoRolloutMode } from './minor-auto.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, currentBaseOid, hasLiveRepairApproval, liveRepairPolicy, renderedCommand, repairPlanKey, targetPrRef } from './approval.mjs';
import { explainAutomaticActionPlan, liveRepairGateFailures, planAutomaticAction } from './plan.mjs';
import { recentAutoPushes } from './conflicts.mjs';

export function phaseEGate(name, ok, details = {}, blocking = true) {
  return {
    name,
    ok: Boolean(ok),
    blocking: Boolean(blocking),
    ...details,
  };
}

export function phaseEBlockedReasons(gates, plan) {
  const gateReasons = gates
    .filter((gate) => gate.blocking && !gate.ok)
    .map((gate) => gate.reason || `${gate.name} failed`);
  return [...new Set([...gateReasons, ...(Array.isArray(plan?.reasons) ? plan.reasons : [])])];
}

export function buildPostActionAuditEntry(target = {}, pr = {}, outcome = 'block', fields = {}) {
  if (!PHASE_E_POST_ACTION_OUTCOMES.includes(outcome)) throw new Error(`unsupported Phase E post-action outcome: ${outcome}`);
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const baseOid = fields.baseOid || currentBaseOid(fields.state || {}, pr);
  const repairKey = fields.repairKey || repairPlanKey(pr, baseOid);
  const audit = {
    schema: 'pr-shepherd-post-action-audit/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr.url || null,
    outcome,
    result: fields.result || outcome,
    executionOutcome: fields.executionOutcome || outcome,
    approvalPresent: fields.approvalPresent === undefined ? hasLiveRepairApproval(target) : Boolean(fields.approvalPresent),
    blockReason: fields.blockReason || null,
    actionClass: fields.actionClass || AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
    mutatesBranch: outcome === 'pushed',
    terminalLedgerMarker: outcome === 'block' ? 'Block' : 'Done',
    expectedRefs: {
      headBranch: target.headBranch || pr.headRefName || null,
      baseBranch: target.baseBranch || pr.baseRefName || null,
      beforeHeadOid: fields.beforeHeadOid || pr.headRefOid || null,
      afterHeadOid: fields.afterHeadOid || null,
      baseRefOid: baseOid || null,
      repairKey,
    },
    prStateFollowUp: {
      required: true,
      command: renderedCommand('status', target),
      expected: outcome === 'pushed' ? 'PR should leave dirty state after GitHub recalculates mergeability and CI completes.' : 'Record current PR state without mutation.',
    },
    ciFollowUp: {
      required: outcome === 'pushed',
      note: outcome === 'pushed' ? 'Re-run status/check-canary after GitHub updates checks; do not push again under this one-shot approval.' : 'No CI follow-up beyond status evidence unless operator asks.',
    },
    rollbackDisableNote: fields.rollbackDisableNote || 'Disable automaticActions.liveRepair after this one-shot run; keep state/actionLedger for audit.',
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    operatorSummary: fields.operatorSummary || `${target.id || 'target'} ${outcome}; see actionLedger and status follow-up for evidence.`,
  };
  return redactLedgerValue(audit, target);
}

export function buildMinorAutoRollbackGuidance(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const observation = fields.observation || state.lastMinorAutoPostPushObservation || null;
  const from = fields.from || observation?.expectedRefs?.beforeHeadOid || null;
  const to = fields.to || observation?.expectedRefs?.afterHeadOid || pr?.headRefOid || null;
  const reason = fields.reason || observation?.operatorSummary || 'post-push CI failed or became unstable';
  return redactLedgerValue({
    schema: 'pr-shepherd-minor-auto-rollback-guidance/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    reason,
    autoMergeAllowed: false,
    retryLoopAllowed: false,
    furtherMinorAutoAttemptsBlocked: true,
    circuitBreaker: {
      state: 'open',
      reason,
      openedAt: now.toISOString(),
    },
    revertGuidance: {
      preferred: 'ask Seo Jin On for approval before reverting or force-pushing any production branch',
      candidateCommand: to ? `git revert ${to}` : null,
      alternative: from ? `restore the branch to ${from} only with explicit operator approval and force-with-lease` : null,
    },
    escalation: 'Seo Jin On approval required for failed/unstable post-push CI, semantic changes, risky paths, ops-impact changes, or any revert/rollback',
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
  }, target);
}

export function buildMinorAutoPostPushObservation(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const classification = fields.classification || classifyPr(pr || {});
  const policy = minorAutoRepairPolicy(target);
  const observationWindowMs = policy.postPushObservationWindowMs === undefined
    ? DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS
    : Number(policy.postPushObservationWindowMs);
  const failed = classification?.checks?.failed || [];
  const pending = classification?.checks?.pending || [];
  const kind = classification?.kind || 'unknown';
  const outcome = failed.length > 0 || kind === 'failed'
    ? 'post-push-failed'
    : (kind === 'unknown' || pending.length > 0 ? 'post-push-unstable' : (kind === 'dirty' ? 'stale-refresh-required' : 'post-push-clean'));
  const rolloutStopRequired = outcome === 'post-push-failed' || outcome === 'post-push-unstable';
  const reason = rolloutStopRequired
    ? `minor-auto post-push observation is ${outcome}; stop further attempts and escalate`
    : (outcome === 'stale-refresh-required' ? 'PR remains dirty after push; refresh status before any further action' : 'post-push observation is clean');
  const packet = {
    schema: 'pr-shepherd-minor-auto-post-push-observation/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    rolloutMode: minorAutoRolloutMode(policy),
    observationWindowMs: Number.isFinite(observationWindowMs) ? observationWindowMs : DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS,
    outcome,
    rolloutStopRequired,
    autoMergeAllowed: false,
    retryLoopAllowed: false,
    classification: kind,
    failedChecks: failed.map((check) => check.name || check.workflowName || check.context || 'unknown'),
    pendingChecks: pending.map((check) => check.name || check.workflowName || check.context || 'unknown'),
    expectedRefs: {
      beforeHeadOid: fields.beforeHeadOid || state.lastPostActionAudit?.expectedRefs?.beforeHeadOid || null,
      afterHeadOid: fields.afterHeadOid || pr?.headRefOid || state.lastPostActionAudit?.expectedRefs?.afterHeadOid || null,
      baseRefOid: fields.baseOid || currentBaseOid(state, pr) || null,
    },
    rollbackGuidance: null,
    circuitBreakerTransition: rolloutStopRequired ? { state: 'open', reason, openedAt: now.toISOString() } : { state: 'closed', reason: null },
    operatorSummary: reason,
    terminalLedgerMarker: rolloutStopRequired ? 'Block' : 'Done',
  };
  if (rolloutStopRequired) packet.rollbackGuidance = buildMinorAutoRollbackGuidance(target, pr, state, { now, observation: packet, reason });
  return redactLedgerValue(packet, target);
}

export function buildLiveRepairExecutionHarness(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const classification = fields.classification || classifyPr(pr);
  const baseOid = fields.baseOid || currentBaseOid(state, pr);
  const repairKey = fields.repairKey || repairPlanKey(pr, baseOid);
  const prWithBase = { ...pr, baseRefOid: baseOid || pr.baseRefOid };
  const plan = fields.plan || planAutomaticAction(target, state, prWithBase, classification, { dryRun: false, now: now.getTime() });
  const policy = liveRepairPolicy(target);
  const rehearsal = state.lastRepairRehearsal;
  const approvalPackage = rehearsal?.approvalPackage;
  const rehearsalAt = Date.parse(rehearsal?.at || '');
  const rehearsalMaxAgeMs = policy.rehearsalMaxAgeMs === undefined ? DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS : Number(policy.rehearsalMaxAgeMs);
  const approvalExpiresAt = Date.parse(policy.expiresAt || '');
  const branchDiffPaths = Array.isArray(fields.branchDiffPaths) ? fields.branchDiffPaths : [];
  const artifactEvidencePaths = Array.isArray(fields.artifactEvidencePaths) ? fields.artifactEvidencePaths : [];
  const contamination = findOpenClawRuntimeContextPaths([...branchDiffPaths, ...artifactEvidencePaths]);
  const verifyGate = buildVerifyGate(target);
  const pushLimit = Number(target.autoPushLimit24h || 0);
  const recentPushCount = recentAutoPushes(state, now.getTime()).length;
  const liveGateFailures = liveRepairGateFailures(target, state, prWithBase, now.getTime());
  const gates = [
    phaseEGate('phase-d-packet-present', approvalPackage?.schema === 'pr-shepherd-repair-rehearsal-approval/v1', {
      reason: 'Phase D rehearsal approval package is missing',
      schema: approvalPackage?.schema || null,
    }),
    phaseEGate('one-shot-approval-metadata', policy.enabled === true
      && policy.scope === 'auto-safe-repair'
      && typeof policy.approvalId === 'string' && policy.approvalId.trim() !== ''
      && typeof policy.approvedBy === 'string' && policy.approvedBy.trim() !== ''
      && typeof policy.approvedAt === 'string' && !Number.isNaN(Date.parse(policy.approvedAt)), {
      reason: 'one-shot approval id/scope/approvedAt/approvedBy are incomplete',
      approvalId: policy.approvalId || null,
      scope: policy.scope || null,
    }),
    phaseEGate('approval-expiry', Number.isFinite(approvalExpiresAt) && now.getTime() <= approvalExpiresAt, {
      reason: 'one-shot approval expiry is missing or expired',
      expiresAt: policy.expiresAt || null,
    }),
    phaseEGate('target-and-refs-match', policy.targetId === (target.id || null)
      && policy.pr === (targetPrRef(target) || null)
      && policy.headRefOid === (pr.headRefOid || null)
      && policy.baseRefOid === (baseOid || null)
      && policy.repairKey === repairKey, {
      reason: 'target, PR, expected head/base, or repairKey does not match current state',
      expectedHeadOid: pr.headRefOid || null,
      expectedBaseOid: baseOid || null,
      repairKey,
    }),
    phaseEGate('allowed-branch', Array.isArray(policy.branchAllowlist) && policy.branchAllowlist.includes(target.headBranch || pr.headRefName), {
      reason: 'head branch is not allowed by the one-shot approval',
      headBranch: target.headBranch || pr.headRefName || null,
    }),
    phaseEGate('dry-run-evidence-fresh', policy.requireRecentRehearsal === false || (Number.isFinite(rehearsalAt)
      && now.getTime() - rehearsalAt <= rehearsalMaxAgeMs
      && rehearsal?.repairKey === repairKey
      && rehearsal?.headRefOid === pr.headRefOid
      && rehearsal?.baseOid === baseOid), {
      reason: 'dry-run rehearsal evidence is missing, stale, or for different refs',
      rehearsalAt: rehearsal?.at || null,
      rehearsalMaxAgeMs,
    }),
    phaseEGate('action-class-auto-safe-repair', plan.allowed === true
      && plan.actionClass === AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR
      && plan.pushAllowed === true
      && plan.mutatesBranch === true, {
      reason: `planned action is not executable auto-safe-repair (${plan.actionClass || 'missing'})`,
      plannedAction: explainAutomaticActionPlan(plan),
    }),
    phaseEGate('push-budget', Number.isFinite(pushLimit) && pushLimit > 0 && recentPushCount < pushLimit, {
      reason: '24h push budget is exhausted or not configured',
      recentPushCount,
      pushLimit,
    }),
    phaseEGate('strict-verify-gate', verifyGate.status !== 'missing', {
      reason: verifyGate.reason || 'strict verify gate is satisfied',
      verifyGate,
    }),
    phaseEGate('focused-checks-before-push', true, {
      blocking: false,
      note: 'Focused checks run during execution immediately before the contamination guard and push.',
      commands: verifyGate.commands,
    }, false),
    phaseEGate('contamination-guard', contamination.length === 0, {
      reason: `OpenClaw runtime/bootstrap context paths would enter branch diff or artifact evidence: ${contamination.join(', ')}`,
      offendingPaths: contamination,
    }),
  ];
  const blockedReasons = phaseEBlockedReasons(gates, {
    ...plan,
    reasons: liveGateFailures.length > 0 || !plan.allowed ? (liveGateFailures.length > 0 ? liveGateFailures : plan.reasons) : [],
  });
  const harness = {
    schema: 'pr-shepherd-live-repair-execution-harness/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr.url || null,
    productionMutation: false,
    executionAllowed: blockedReasons.length === 0,
    blockedReasons,
    commandTemplates: {
      liveRepair: renderedCommand('repair', target, fields),
      statusFollowUp: renderedCommand('status', target),
      checkCanaryFollowUp: renderedCommand('check-canary', target),
    },
    expectedRefs: {
      headBranch: target.headBranch || pr.headRefName || null,
      baseBranch: target.baseBranch || pr.baseRefName || null,
      headRefOid: pr.headRefOid || null,
      baseRefOid: baseOid || null,
      repairKey,
    },
    gates,
    postActionAudit: Object.fromEntries(PHASE_E_POST_ACTION_OUTCOMES.map((outcome) => [
      outcome,
      buildPostActionAuditEntry(target, prWithBase, outcome, { ...fields, state, baseOid, repairKey }),
    ])),
    evidenceHygiene: {
      plannedBranchDiffPaths: branchDiffPaths.slice().sort(),
      plannedArtifactEvidencePaths: artifactEvidencePaths.slice().sort(),
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    verifyGate,
  };
  return redactLedgerValue(harness, target);
}
