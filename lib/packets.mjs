// Phase D candidate gate, rehearsal evidence digest, and operator packet (Phases D/K/L).
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_REHEARSAL_EVIDENCE_DIGEST_MAX_AGE_MS, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, currentBaseOid, renderedCommand, repairPlanKey, targetPrRef } from './approval.mjs';
import { phaseEBlockedReasons, phaseEGate } from './phase-e.mjs';
import { normalizedRepoPath, recentAutoPushes } from './conflicts.mjs';

export function rehearsalDigestId(digest = {}) {
  const refs = digest.expectedRefs || {};
  return [
    'rehearsal-digest',
    digest.target || 'target',
    digest.sourceRehearsal?.at || digest.createdAt || 'rehearsal',
    refs.repairKey || 'repair-key',
  ].join(':');
}

export function phaseDCandidateGateReasons({ target = {}, pr = {}, state = {}, rehearsal = {}, classification = {}, now, maxAgeMs, branchDiffPaths = [], artifactEvidencePaths = [] }) {
  const approvalPackage = rehearsal?.approvalPackage;
  const expectedRefs = approvalPackage?.expectedRefs || {};
  const baseOid = currentBaseOid(state, pr);
  const repairKey = rehearsal?.repairKey || expectedRefs.repairKey || repairPlanKey(pr, baseOid);
  const verifyGate = buildVerifyGate(target);
  const contamination = findOpenClawRuntimeContextPaths([...branchDiffPaths, ...artifactEvidencePaths]);
  const reasons = [];
  const gates = [];
  const gate = (name, ok, reason, details = {}) => {
    gates.push({ name, ok: Boolean(ok), reason: ok ? null : reason, ...details });
    if (!ok && reason) reasons.push(reason);
  };

  gate('rehearsal-approval-package', approvalPackage?.schema === 'pr-shepherd-repair-rehearsal-approval/v1', 'repair rehearsal approvalPackage is required for Phase D candidacy', { schema: approvalPackage?.schema || null });
  gate('dry-run-only', rehearsal && approvalPackage?.dryRunOnly !== false && approvalPackage?.productionMutation !== true, 'Phase D candidate evidence must be dry-run only and non-mutating');
  gate('dirty-current-pr', classification?.kind === 'dirty', `current classification ${classification?.kind || 'unknown'} is not dirty; Phase D candidate gate only admits dirty repair rehearsals`, { classification: classification?.kind || 'unknown' });

  const rehearsalAt = Date.parse(rehearsal?.at || '');
  gate('fresh-rehearsal', Number.isFinite(rehearsalAt) && rehearsalAt <= now.getTime() + 5 * 60 * 1000 && now.getTime() - rehearsalAt <= maxAgeMs, 'repair rehearsal evidence is missing, in the future, or too old for Phase D candidacy', { rehearsalAt: rehearsal?.at || null, maxAgeMs });

  const evidenceExpiresAt = Date.parse(approvalPackage?.evidenceBundle?.evidenceExpiresAt || '');
  gate('evidence-not-expired', Number.isFinite(evidenceExpiresAt) && now.getTime() <= evidenceExpiresAt, 'repair rehearsal evidence bundle expiry is missing or expired', { evidenceExpiresAt: approvalPackage?.evidenceBundle?.evidenceExpiresAt || null });

  gate('target-and-refs-match', (!rehearsal?.target || rehearsal.target === target.id)
    && (!expectedRefs.headRefOid || expectedRefs.headRefOid === (pr.headRefOid || state.lastSeenHeadOid || null))
    && (!expectedRefs.baseRefOid || expectedRefs.baseRefOid === (baseOid || null))
    && (!expectedRefs.repairKey || expectedRefs.repairKey === repairKey), 'target, expected head/base refs, or repairKey do not match current rehearsal evidence', {
    target: target.id || null,
    expectedRefs,
    currentRefs: {
      headRefOid: pr.headRefOid || state.lastSeenHeadOid || null,
      baseRefOid: baseOid || null,
      repairKey,
    },
  });

  const ledger = Array.isArray(state.actionLedger) ? state.actionLedger : [];
  gate('action-ledger-rehearsed', ledger.some((entry) => entry?.actionClass === AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL
    && entry?.result === 'rehearsed'
    && entry?.repairKey === repairKey), 'actionLedger must include a rehearsed repair entry for the current repairKey', { repairKey });
  gate('strict-verify-gate', verifyGate.status !== 'missing', verifyGate.reason || 'strict verify gate is missing', { verifyGate });
  gate('contamination-guard', contamination.length === 0, `OpenClaw runtime/bootstrap context paths would enter rehearsal digest evidence: ${contamination.join(', ')}`, { offendingPaths: contamination });

  return { reasons: [...new Set(reasons)], gates, contamination, repairKey, baseOid, verifyGate };
}

export function buildPhaseDCandidateGate(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const rehearsal = fields.rehearsal || state.lastRepairRehearsal || {};
  const maxAgeMs = fields.maxAgeMs === undefined ? DEFAULT_REHEARSAL_EVIDENCE_DIGEST_MAX_AGE_MS : Number(fields.maxAgeMs);
  const classification = fields.classification || classifyPr(pr || {});
  const branchDiffPaths = Array.isArray(fields.branchDiffPaths) ? fields.branchDiffPaths : [];
  const artifactEvidencePaths = Array.isArray(fields.artifactEvidencePaths) ? fields.artifactEvidencePaths : [];
  const { reasons, gates, contamination, repairKey, baseOid, verifyGate } = phaseDCandidateGateReasons({
    target,
    pr,
    state,
    rehearsal,
    classification,
    now,
    maxAgeMs,
    branchDiffPaths,
    artifactEvidencePaths,
  });
  return redactLedgerValue({
    schema: 'pr-shepherd-phase-d-candidate-gate/v1',
    createdAt: now.toISOString(),
    target: target.id || rehearsal.target || null,
    pr: targetPrRef(target) || target.pr || null,
    candidateAllowed: reasons.length === 0,
    status: reasons.length === 0 ? 'candidate' : 'blocked',
    blockedReasons: reasons,
    actionClass: reasons.length === 0 ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    requiredNextApproval: 'Phase D one-shot auto-safe-repair approval',
    noLiveApproval: true,
    productionMutation: false,
    gates,
    expectedRefs: {
      ...(rehearsal.approvalPackage?.expectedRefs || {}),
      repairKey,
      baseRefOid: baseOid || rehearsal.approvalPackage?.expectedRefs?.baseRefOid || null,
    },
    verifyGate,
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      plannedBranchDiffPaths: branchDiffPaths.slice().sort(),
      plannedArtifactEvidencePaths: artifactEvidencePaths.slice().sort(),
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    terminalLedgerMarker: reasons.length === 0 ? 'Done' : 'Block',
  }, target);
}

export function buildRehearsalEvidenceDigest(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const rehearsal = fields.rehearsal || state.lastRepairRehearsal || {};
  const classification = fields.classification || classifyPr(pr || {});
  const phaseDCandidateGate = fields.phaseDCandidateGate || buildPhaseDCandidateGate(target, pr, state, { ...fields, now, rehearsal, classification });
  const approvalPackage = rehearsal?.approvalPackage || {};
  const expectedRefs = phaseDCandidateGate.expectedRefs || approvalPackage.expectedRefs || {};
  const digest = {
    schema: 'pr-shepherd-rehearsal-evidence-digest/v1',
    digestId: null,
    createdAt: now.toISOString(),
    target: target.id || rehearsal.target || null,
    pr: targetPrRef(target) || target.pr || approvalPackage.pr || null,
    url: target.url || approvalPackage.url || pr.url || null,
    dryRunOnly: true,
    productionMutation: false,
    mutatesBranch: false,
    pushAllowed: false,
    noLiveApproval: true,
    sourceRehearsal: {
      at: rehearsal.at || null,
      repairKey: rehearsal.repairKey || expectedRefs.repairKey || null,
      approvalPackageSchema: approvalPackage.schema || null,
    },
    expectedRefs,
    currentRefs: {
      headBranch: target.headBranch || pr.headRefName || expectedRefs.headBranch || null,
      baseBranch: target.baseBranch || pr.baseRefName || expectedRefs.baseBranch || null,
      headRefOid: pr.headRefOid || state.lastSeenHeadOid || null,
      baseRefOid: currentBaseOid(state, pr) || null,
      repairKey: expectedRefs.repairKey || null,
    },
    classification: classification?.kind || 'unknown',
    checkSummary: {
      failedCount: classification?.checks?.failed?.length || 0,
      pendingCount: classification?.checks?.pending?.length || 0,
    },
    approvalPackageSummary: {
      approvalText: approvalPackage.approvalText || null,
      abortCriteriaCount: Array.isArray(approvalPackage.abortCriteria) ? approvalPackage.abortCriteria.length : 0,
      rollbackNote: approvalPackage.rollbackNote || null,
      evidenceExpiresAt: approvalPackage.evidenceBundle?.evidenceExpiresAt || null,
    },
    phaseDCandidateGate,
    evidenceHygiene: phaseDCandidateGate.evidenceHygiene,
    terminalLedgerMarker: phaseDCandidateGate.terminalLedgerMarker,
    nextStep: phaseDCandidateGate.candidateAllowed
      ? 'Prepare a separate Phase D operator packet; do not run live repair until one-shot approval metadata is recorded and Phase E gates pass.'
      : 'Refresh rehearsal evidence or close Block with the candidate-gate reasons; do not carry this digest into Phase D.',
  };
  digest.digestId = fields.id || rehearsalDigestId(digest);
  return redactLedgerValue(digest, target);
}

export function phaseDOperatorPacketId(packet = {}) {
  const refs = packet.expectedRefs || {};
  return [
    'phase-d-packet',
    packet.target || 'target',
    packet.sourceDigest?.digestId || packet.createdAt || 'digest',
    refs.repairKey || 'repair-key',
  ].join(':');
}

export function buildPhaseDOperatorPacket(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const classification = fields.classification || classifyPr(pr || {});
  const rehearsal = fields.rehearsal || state.lastRepairRehearsal || {};
  const digest = fields.rehearsalEvidenceDigest || state.lastRehearsalEvidenceDigest || rehearsal.evidenceDigest || null;
  const phaseDCandidateGate = fields.phaseDCandidateGate || digest?.phaseDCandidateGate || buildPhaseDCandidateGate(target, pr, state, { ...fields, now, rehearsal, classification });
  const approvalPackage = fields.approvalPackage || rehearsal.approvalPackage || {};
  const baseOid = fields.baseOid || currentBaseOid(state, pr);
  const expectedRefs = {
    ...(approvalPackage.expectedRefs || {}),
    ...(digest?.expectedRefs || {}),
    ...(phaseDCandidateGate.expectedRefs || {}),
  };
  const repairKey = expectedRefs.repairKey || rehearsal.repairKey || repairPlanKey(pr, baseOid);
  const headBranch = target.headBranch || pr.headRefName || expectedRefs.headBranch || null;
  const verifyGate = buildVerifyGate(target);
  const branchDiffPaths = Array.isArray(fields.branchDiffPaths) ? fields.branchDiffPaths.map(normalizedRepoPath).filter(Boolean) : [];
  const artifactEvidencePaths = Array.isArray(fields.artifactEvidencePaths) ? fields.artifactEvidencePaths.map(normalizedRepoPath).filter(Boolean) : [];
  const contamination = findOpenClawRuntimeContextPaths([
    ...branchDiffPaths,
    ...artifactEvidencePaths,
    ...(digest?.evidenceHygiene?.offendingRuntimeContextPaths || []),
    ...(phaseDCandidateGate?.evidenceHygiene?.offendingRuntimeContextPaths || []),
  ]);
  const pushLimit = Number(target.autoPushLimit24h || 0);
  const recentPushCount = recentAutoPushes(state, now.getTime()).length;
  const gates = [
    phaseEGate('phase-k-rehearsal-evidence-digest', digest?.schema === 'pr-shepherd-rehearsal-evidence-digest/v1', {
      reason: 'Phase K rehearsal evidence digest is required before assembling a Phase D operator packet',
      schema: digest?.schema || null,
    }),
    phaseEGate('phase-d-candidate-gate', phaseDCandidateGate?.schema === 'pr-shepherd-phase-d-candidate-gate/v1' && phaseDCandidateGate.candidateAllowed === true, {
      reason: `Phase D candidate gate is blocked: ${(phaseDCandidateGate?.blockedReasons || []).join('; ') || 'candidateAllowed is not true'}`,
      candidateAllowed: phaseDCandidateGate?.candidateAllowed === true,
    }),
    phaseEGate('current-pr-dirty', classification?.kind === 'dirty', {
      reason: `current classification ${classification?.kind || 'unknown'} is not dirty; Phase D packets only request live repair for dirty auto-safe candidates`,
      classification: classification?.kind || 'unknown',
    }),
    phaseEGate('rehearsal-approval-package', approvalPackage?.schema === 'pr-shepherd-repair-rehearsal-approval/v1', {
      reason: 'repair rehearsal approval package is required for the Phase D packet approval template',
      schema: approvalPackage?.schema || null,
    }),
    phaseEGate('target-and-refs-match', (!digest?.target || !target.id || digest.target === target.id)
      && (!expectedRefs.headRefOid || expectedRefs.headRefOid === (pr.headRefOid || state.lastSeenHeadOid || null))
      && (!expectedRefs.baseRefOid || expectedRefs.baseRefOid === (baseOid || null))
      && (!expectedRefs.repairKey || expectedRefs.repairKey === repairKey), {
      reason: 'target, expected head/base refs, or repairKey do not match current PR state',
      expectedRefs,
      currentRefs: {
        headRefOid: pr.headRefOid || state.lastSeenHeadOid || null,
        baseRefOid: baseOid || null,
        repairKey,
      },
    }),
    phaseEGate('strict-verify-gate', verifyGate.status !== 'missing', {
      reason: verifyGate.reason || 'strict verify gate is satisfied',
      verifyGate,
    }),
    phaseEGate('push-budget-known', Number.isFinite(pushLimit) && pushLimit > 0 && recentPushCount < pushLimit, {
      reason: '24h push budget is exhausted or not configured',
      recentPushCount,
      pushLimit,
    }),
    phaseEGate('contamination-guard', contamination.length === 0, {
      reason: `OpenClaw runtime/bootstrap context paths would enter Phase D packet branch diff or artifact evidence: ${contamination.join(', ')}`,
      offendingPaths: contamination,
    }),
  ];
  const blockedReasons = phaseEBlockedReasons(gates, null);
  const liveRepairCommand = approvalPackage.liveRepairCommand || renderedCommand('repair', target, fields);
  const packet = {
    schema: 'pr-shepherd-phase-d-operator-packet/v1',
    packetId: null,
    createdAt: now.toISOString(),
    phase: 'D',
    target: target.id || digest?.target || null,
    pr: targetPrRef(target) || target.pr || digest?.pr || null,
    url: target.url || digest?.url || pr.url || null,
    requestedDecision: 'GO live repair / NO-GO continue observation / NO-GO block',
    status: blockedReasons.length === 0 ? 'ready-for-operator' : 'blocked',
    packetAllowed: blockedReasons.length === 0,
    blockedReasons,
    actionClass: blockedReasons.length === 0 ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    dryRunEvidenceOnly: true,
    productionMutation: false,
    mutatesBranch: false,
    pushAllowed: false,
    noLiveApproval: true,
    preparedBy: fields.preparedBy || null,
    operator: fields.operator || null,
    configRevision: fields.configRevision || null,
    phaseBSummary: fields.phaseBSummary || null,
    phaseCRehearsalEvidence: fields.phaseCRehearsalEvidence || digest?.digestId || null,
    currentStatus: classification?.kind || 'unknown',
    expectedRefs: {
      ...expectedRefs,
      headBranch,
      baseBranch: target.baseBranch || pr.baseRefName || expectedRefs.baseBranch || null,
      headRefOid: expectedRefs.headRefOid || pr.headRefOid || state.lastSeenHeadOid || null,
      baseRefOid: expectedRefs.baseRefOid || baseOid || null,
      repairKey,
    },
    allowedBranch: headBranch ? (target.headOwner ? `${target.headOwner}:${headBranch}` : headBranch) : null,
    liveCommandUnderConsideration: liveRepairCommand,
    focusedChecksRequiredBeforePush: verifyGate.commands,
    pushGuard: {
      forceWithLease: headBranch && (expectedRefs.headRefOid || pr.headRefOid) ? `${headBranch}:${expectedRefs.headRefOid || pr.headRefOid}` : null,
      expectedHeadOid: expectedRefs.headRefOid || pr.headRefOid || null,
    },
    pushBudgetRemaining: Number.isFinite(pushLimit) && pushLimit > 0 ? Math.max(0, pushLimit - recentPushCount) : 0,
    decisionDeadline: fields.decisionDeadline || approvalPackage.evidenceBundle?.evidenceExpiresAt || null,
    gates,
    sourceDigest: digest ? {
      schema: digest.schema || null,
      digestId: digest.digestId || null,
      createdAt: digest.createdAt || null,
      terminalLedgerMarker: digest.terminalLedgerMarker || null,
    } : null,
    approvalConfigTemplate: approvalPackage.approvalConfigTemplate || null,
    operatorChecklist: [
      'Post Start before recording the Phase D decision packet, and close with exactly one PR, Done, or Block marker.',
      'Choose exactly one decision: GO live repair, NO-GO continue observation/rehearsal, or NO-GO block.',
      'If GO, record target-specific one-shot auto-safe-repair approval metadata before running the listed live command.',
      'Do not run broad --all repair, standing timers, manual git push, or any command outside liveCommandUnderConsideration.',
      'Fail closed if expected refs, target, branch, focused checks, push budget, or contamination gates change.',
    ],
    closeout: {
      startMarker: 'Start',
      terminalMarkers: ['PR: <url>', 'Done', 'Block'],
      returnFields: ['startCommentUrl', 'prUrl', 'doneCommentUrl', 'blockCommentUrl'],
    },
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      plannedBranchDiffPaths: branchDiffPaths.slice().sort(),
      plannedArtifactEvidencePaths: artifactEvidencePaths.slice().sort(),
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    terminalLedgerMarker: blockedReasons.length === 0 ? 'Done' : 'Block',
  };
  packet.packetId = fields.id || phaseDOperatorPacketId(packet);
  return redactLedgerValue(packet, target);
}
