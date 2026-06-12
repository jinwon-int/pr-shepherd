// Automatic action planning, gating, and plan execution dispatch.
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS, MINOR_AUTO_SAFE_REPAIR_SCOPE } from './policy.mjs';
import { isPlainObject } from './config.mjs';
import { buildMinorAutoRepairGate, minorAutoRepairPolicy, minorAutoRolloutMode } from './minor-auto.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, currentBaseOid, liveRepairApprovalState, liveRepairPolicy, repairPlanKey, targetPrRef } from './approval.mjs';

export function buildAutomaticActionPlan(actionClass, fields = {}) {
  const plan = {
    actionClass,
    pushAllowed: false,
    mutatesBranch: false,
    writesArtifact: false,
    requiresOperatorApproval: false,
    reasons: [],
    ...fields,
  };
  plan.allowed = fields.allowed !== false && actionClass !== AUTOMATIC_ACTION_CLASSES.BLOCK;
  return plan;
}

export function liveRepairGateFailures(target, state, pr, now = Date.now()) {
  const policy = liveRepairPolicy(target);
  const failures = [];
  const headBranch = target.headBranch || pr?.headRefName || '';
  const baseOid = currentBaseOid(state, pr);
  const expectedRepairKey = repairPlanKey(pr, baseOid);
  const verifyGate = buildVerifyGate(target);
  const approvalState = liveRepairApprovalState(target, state, pr, now);
  if (policy.enabled !== true) failures.push('automaticActions.liveRepair.enabled is not true');
  if (policy.scope !== 'auto-safe-repair') failures.push('automaticActions.liveRepair.scope must be auto-safe-repair');
  if (policy.actionClass !== AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR) failures.push('automaticActions.liveRepair.actionClass must be auto-safe-repair');
  if (verifyGate.status === 'missing') failures.push(verifyGate.reason);
  if (approvalState.state === 'consumed') failures.push('automaticActions.liveRepair.approvalId was already consumed');
  if (approvalState.state === 'invalidated-by-head-change') failures.push('automaticActions.liveRepair.approvalId invalidated by head change');
  if (typeof policy.approvalId !== 'string' || policy.approvalId.trim() === '') failures.push('automaticActions.liveRepair.approvalId is required');
  if (typeof policy.approvedAt !== 'string' || Number.isNaN(Date.parse(policy.approvedAt))) failures.push('automaticActions.liveRepair.approvedAt is missing or invalid');
  if (typeof policy.expiresAt !== 'string' || Number.isNaN(Date.parse(policy.expiresAt))) failures.push('automaticActions.liveRepair.expiresAt is required');
  else if (now > Date.parse(policy.expiresAt)) failures.push('automaticActions.liveRepair.expiresAt has expired');
  if (typeof policy.approvedBy !== 'string' || policy.approvedBy.trim() === '') failures.push('automaticActions.liveRepair.approvedBy is required');

  const expectedTargetId = target.id || null;
  const expectedPr = targetPrRef(target);
  if (typeof policy.targetId !== 'string' || policy.targetId.trim() === '') failures.push('automaticActions.liveRepair.targetId is required');
  else if (expectedTargetId && policy.targetId !== expectedTargetId) failures.push(`automaticActions.liveRepair.targetId must match selected target ${expectedTargetId}`);
  if (typeof policy.owner !== 'string' || policy.owner.trim() === '') failures.push('automaticActions.liveRepair.owner is required');
  else if (target.owner && policy.owner !== target.owner) failures.push(`automaticActions.liveRepair.owner must match selected owner ${target.owner}`);
  if (typeof policy.repo !== 'string' || policy.repo.trim() === '') failures.push('automaticActions.liveRepair.repo is required');
  else if (target.repo && policy.repo !== target.repo) failures.push(`automaticActions.liveRepair.repo must match selected repo ${target.repo}`);
  if (!Number.isInteger(Number(policy.number)) || Number(policy.number) <= 0) failures.push('automaticActions.liveRepair.number is required');
  else if (Number.isInteger(Number(target.number)) && Number(policy.number) !== Number(target.number)) failures.push(`automaticActions.liveRepair.number must match selected PR number ${Number(target.number)}`);
  if (typeof policy.pr !== 'string' || policy.pr.trim() === '') failures.push('automaticActions.liveRepair.pr is required');
  else if (expectedPr && policy.pr !== expectedPr) failures.push(`automaticActions.liveRepair.pr must match selected PR ${expectedPr}`);
  if (typeof policy.headRefOid !== 'string' || policy.headRefOid.trim() === '') failures.push('automaticActions.liveRepair.headRefOid is required');
  else if (pr?.headRefOid && policy.headRefOid !== pr.headRefOid) failures.push('automaticActions.liveRepair.headRefOid does not match current PR head');
  if (typeof policy.baseRefOid !== 'string' || policy.baseRefOid.trim() === '') failures.push('automaticActions.liveRepair.baseRefOid is required');
  else if (baseOid && policy.baseRefOid !== baseOid) failures.push('automaticActions.liveRepair.baseRefOid does not match current base');
  if (typeof policy.repairKey !== 'string' || policy.repairKey.trim() === '') failures.push('automaticActions.liveRepair.repairKey is required');
  else if (policy.repairKey !== expectedRepairKey) failures.push('automaticActions.liveRepair.repairKey does not match current PR state');
  if (typeof policy.rollbackNote !== 'string' || policy.rollbackNote.trim() === '') failures.push('automaticActions.liveRepair.rollbackNote is required');

  const allowlist = Array.isArray(policy.branchAllowlist) ? policy.branchAllowlist.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!headBranch || !allowlist.includes(headBranch)) failures.push(`head branch ${headBranch || '(unknown)'} is not in automaticActions.liveRepair.branchAllowlist`);
  if (target.headOwner && target.baseOwner && target.headOwner === target.baseOwner && policy.allowMaintainerOwnedBranches !== true) {
    failures.push('maintainer-owned head branches require automaticActions.liveRepair.allowMaintainerOwnedBranches=true');
  }
  if (policy.requireRecentRehearsal !== false) {
    const rehearsal = state.lastRepairRehearsal;
    const rehearsalAt = Date.parse(rehearsal?.at || '');
    const maxAgeMs = policy.rehearsalMaxAgeMs === undefined ? DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS : Number(policy.rehearsalMaxAgeMs);
    if (!rehearsal || !Number.isFinite(rehearsalAt)) failures.push('recent repair rehearsal evidence is required');
    else if (now - rehearsalAt > maxAgeMs) failures.push('repair rehearsal evidence is too old');
    if (rehearsal && rehearsal.target && rehearsal.target !== target.id) failures.push('repair rehearsal target does not match');
    if (rehearsal && rehearsal.headRefOid !== pr?.headRefOid) failures.push('repair rehearsal headRefOid does not match');
    if (rehearsal && (rehearsal.baseOid || baseOid) && rehearsal.baseOid !== baseOid) failures.push('repair rehearsal baseRefOid does not match');
    if (rehearsal && rehearsal.repairKey !== expectedRepairKey) failures.push('repair rehearsal key does not match current PR state');
    if (rehearsal) {
      const approvalPackage = rehearsal.approvalPackage;
      if (!isPlainObject(approvalPackage) || approvalPackage.schema !== 'pr-shepherd-repair-rehearsal-approval/v1') failures.push('repair rehearsal approvalPackage is required for Phase D activation');
      else {
        const expectedRefs = approvalPackage.expectedRefs || {};
        if (expectedRefs.headRefOid !== pr?.headRefOid) failures.push('repair rehearsal approvalPackage expected head does not match current PR head');
        if (expectedRefs.baseRefOid !== baseOid) failures.push('repair rehearsal approvalPackage expected base does not match current base');
        if (expectedRefs.repairKey !== expectedRepairKey) failures.push('repair rehearsal approvalPackage repairKey does not match current PR state');
        if (!Array.isArray(approvalPackage.abortCriteria) || approvalPackage.abortCriteria.length === 0) failures.push('repair rehearsal approvalPackage abortCriteria are required');
        if (typeof approvalPackage.rollbackNote !== 'string' || approvalPackage.rollbackNote.trim() === '') failures.push('repair rehearsal approvalPackage rollbackNote is required');
        const phaseDExpiresAt = Date.parse(policy.phaseDPacketExpiresAt || approvalPackage.evidenceBundle?.evidenceExpiresAt || '');
        if (!Number.isFinite(phaseDExpiresAt)) failures.push('Phase D approval packet expiry is required');
        else if (now > phaseDExpiresAt) failures.push('Phase D approval packet evidence has expired');
      }
      const digest = state.lastRehearsalEvidenceDigest || rehearsal.evidenceDigest;
      const candidateGate = digest?.phaseDCandidateGate || rehearsal.phaseDCandidateGate;
      if (!isPlainObject(digest) || digest.schema !== 'pr-shepherd-rehearsal-evidence-digest/v1') failures.push('Phase K rehearsal evidence digest is required for Phase D activation');
      else {
        if (digest.target && digest.target !== target.id) failures.push('Phase K rehearsal evidence digest target does not match');
        if (digest.sourceRehearsal?.repairKey && digest.sourceRehearsal.repairKey !== expectedRepairKey) failures.push('Phase K rehearsal evidence digest repairKey does not match current PR state');
      }
      if (!isPlainObject(candidateGate) || candidateGate.schema !== 'pr-shepherd-phase-d-candidate-gate/v1') failures.push('Phase D candidate gate is required for live repair activation');
      else if (candidateGate.candidateAllowed !== true) failures.push(`Phase D candidate gate is blocked: ${(candidateGate.blockedReasons || []).join('; ') || 'candidateAllowed is not true'}`);
      const ledger = Array.isArray(state.actionLedger) ? state.actionLedger : [];
      const hasRehearsalLedgerEntry = ledger.some((entry) => entry?.actionClass === AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL
        && entry?.result === 'rehearsed'
        && entry?.repairKey === expectedRepairKey);
      if (!hasRehearsalLedgerEntry) failures.push('actionLedger must include a rehearsed repair entry for the current repairKey');
    }
  }
  return failures;
}

export function planAutomaticAction(target, state = {}, pr = {}, classification = classifyPr(pr), opts = {}) {
  const kind = classification?.kind || 'unknown';
  const base = {
    target: target.id,
    pr: target.pr,
    classification: kind,
    headBranch: target.headBranch || pr?.headRefName || null,
    headRefOid: pr?.headRefOid || state.lastSeenHeadOid || null,
    baseRefOid: currentBaseOid(state, pr),
  };
  if (kind === 'dirty') {
    if (opts.dryRun !== false) {
      const verifyGate = buildVerifyGate(target);
      return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, {
        ...base,
        verifyGate,
        reasons: [
          'dirty PR requires rehearsal before live branch mutation',
          ...(verifyGate.status === 'missing' ? [verifyGate.reason] : []),
        ],
      });
    }
    const now = opts.now === undefined ? Date.now() : opts.now;
    const gateFailures = liveRepairGateFailures(target, state, pr, now);
    if (gateFailures.length === 0) {
      return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, {
        ...base,
        lane: 'approval-required-auto-safe-repair',
        pushAllowed: true,
        mutatesBranch: true,
        requiresOperatorApproval: true,
        reasons: ['all live auto-safe repair gates passed'],
      });
    }
    const minorGate = buildMinorAutoRepairGate(target, state, pr, classification, {
      now,
      deferChangedPathGate: true,
      selectedTargetCount: opts.selectedTargetCount,
    });
    if (minorGate.gateAllowed) {
      const rolloutMode = minorGate.rolloutMode || minorAutoRolloutMode(minorAutoRepairPolicy(target));
      const liveLimited = rolloutMode === 'minor-auto-live-limited';
      return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, {
        ...base,
        lane: MINOR_AUTO_SAFE_REPAIR_SCOPE,
        rolloutMode,
        pushAllowed: liveLimited,
        mutatesBranch: liveLimited,
        dryRun: !liveLimited,
        requiresOperatorApproval: false,
        minorAutoRepairGate: minorGate,
        reasons: [liveLimited
          ? 'all minor-auto-safe repair gates passed; exact changed-path guard deferred until immediately before push'
          : 'minor-auto dry-run rollout gates passed; controller may run without pushing'],
      });
    }
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.BLOCK, {
      ...base,
      allowed: false,
      requiresOperatorApproval: true,
      minorAutoRepairGate: minorGate,
      reasons: [...gateFailures, ...minorGate.blockedReasons],
    });
  }
  if (kind === 'unknown') {
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.RECHECK, {
      ...base,
      reasons: ['ambiguous GitHub PR state; recheck or human review required'],
    });
  }
  if (kind === 'failed') {
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE, {
      ...base,
      reasons: ['failed checks require human review unless a safe repair is explicitly classified'],
    });
  }
  if (kind === 'merged' || kind === 'disabled') {
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE, {
      ...base,
      reasons: ['PR is no longer an automatic repair target'],
    });
  }
  return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.RECHECK, {
    ...base,
    reasons: ['safe check/state refresh only'],
  });
}

export function planConflictAutomaticAction(conflictInfo, conflicts = []) {
  if (conflictInfo.tier === 'autoSafe') {
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, {
      pushAllowed: true,
      mutatesBranch: true,
      conflicts: conflicts.slice().sort(),
      reasons: ['all conflicts are covered by deterministic autoSafe resolvers'],
    });
  }
  if (conflictInfo.tier === 'codeAssisted') {
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT, {
      writesArtifact: true,
      requiresOperatorApproval: true,
      conflicts: conflicts.slice().sort(),
      reasons: ['code-assisted conflicts produce evidence but do not push automatically'],
    });
  }
  return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY, {
    writesArtifact: true,
    requiresOperatorApproval: false,
    conflicts: conflicts.slice().sort(),
    reasons: ['human-only, unlisted, or unknown conflicts require diagnose-only bundle and manual review'],
  });
}

export function explainAutomaticActionPlan(plan, fields = {}) {
  const allowed = Boolean(plan?.allowed);
  return {
    status: allowed ? 'planned' : 'blocked',
    actionClass: plan?.actionClass || AUTOMATIC_ACTION_CLASSES.BLOCK,
    allowed,
    pushAllowed: Boolean(plan?.pushAllowed),
    mutatesBranch: Boolean(plan?.mutatesBranch),
    writesArtifact: Boolean(plan?.writesArtifact),
    requiresOperatorApproval: Boolean(plan?.requiresOperatorApproval),
    reasons: Array.isArray(plan?.reasons) ? plan.reasons.slice() : [],
    ...fields,
  };
}

export function automaticActionExecution(plan, status, fields = {}) {
  return explainAutomaticActionPlan(plan, {
    status,
    blocked: status === 'blocked',
    executed: status === 'executed',
    skipped: status === 'skipped' || Boolean(fields.dryRun),
    dryRun: Boolean(fields.dryRun),
    result: fields.result === undefined ? null : fields.result,
  });
}

export function executeAutomaticActionPlan(plan, handlers = {}, opts = {}) {
  if (!plan?.allowed) {
    const execution = automaticActionExecution(plan, 'blocked');
    if (opts.throwOnBlocked === false) return execution;
    const err = new Error(`automatic action blocked: ${(plan?.reasons || ['policy denied']).join('; ')}`);
    err.execution = execution;
    throw err;
  }
  if (opts.dryRun) {
    return automaticActionExecution(plan, 'planned', { dryRun: true });
  }
  const handler = handlers[plan.actionClass];
  if (!handler) return automaticActionExecution(plan, 'skipped');
  return automaticActionExecution(plan, 'executed', { result: handler(plan) });
}
