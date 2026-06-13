// Review-state feedback and supervised rehearsal queue packets (Phases I/J).
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_ACTION_LEDGER_LIMIT, DEFAULT_SUPERVISED_REHEARSAL_QUEUE_MAX_AGE_MS, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, REVIEW_DECISION_OUTCOMES, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { isPlainObject } from './config.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { renderedCommand, repairPlanKey, targetPrRef } from './approval.mjs';
import { nextActionForClassification } from './notify.mjs';

export function normalizedDecisionOutcome(outcome) {
  const value = String(outcome || '').trim();
  if (!REVIEW_DECISION_OUTCOMES.includes(value)) {
    throw new Error(`unsupported review decision outcome: ${value || '(empty)'}`);
  }
  return value;
}

export function compactStrings(items = []) {
  return [...new Set((Array.isArray(items) ? items : [items])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

export function currentRefState(currentPr = {}, state = {}) {
  return {
    headRefOid: currentPr?.headRefOid || state.lastSeenHeadOid || null,
    baseRefOid: currentPr?.baseRefOid || state.lastSeenBaseOid || null,
    mergeable: currentPr?.mergeable || state.lastMergeable || null,
    mergeStateStatus: currentPr?.mergeStateStatus || state.lastMergeStateStatus || null,
    reviewDecision: currentPr?.reviewDecision || state.lastReviewDecision || null,
  };
}

export function handoffPrState(handoff = {}) {
  return handoff.prState || handoff.evidence?.prState || handoff.source?.prState || {};
}

export function checkCountFromHandoff(checks = {}, key) {
  const countKey = `${key}Count`;
  if (Number.isInteger(checks[countKey])) return checks[countKey];
  if (Array.isArray(checks[key])) return checks[key].length;
  return null;
}

export function handoffFocusedChecks(handoff = {}) {
  const artifactHints = Array.isArray(handoff.reviewArtifacts)
    ? handoff.reviewArtifacts.flatMap((artifact) => artifact?.focusedCommandHints || [])
    : [];
  return compactStrings([
    ...(handoff.focusedCommandHints || []),
    ...(handoff.evidence?.focusedCommandHints || []),
    ...artifactHints,
  ]);
}

export function staleReviewEvidenceReasons(handoff = {}, currentPr = {}, state = {}, classification = {}) {
  const expectedRefs = handoff.expectedRefs || {};
  const expectedPrState = handoffPrState(handoff);
  const currentRefs = currentRefState(currentPr, state);
  const reasons = [];
  if (!currentRefs.headRefOid) reasons.push('current headRefOid unavailable; refresh PR state before recording decision');
  else if (expectedRefs.headRefOid && expectedRefs.headRefOid !== currentRefs.headRefOid) reasons.push(`headRefOid differs from handoff: expected ${expectedRefs.headRefOid}, current ${currentRefs.headRefOid}`);
  if (expectedRefs.baseRefOid) {
    if (!currentRefs.baseRefOid) reasons.push('current baseRefOid unavailable; refresh base evidence before recording decision');
    else if (expectedRefs.baseRefOid !== currentRefs.baseRefOid) reasons.push(`baseRefOid differs from handoff: expected ${expectedRefs.baseRefOid}, current ${currentRefs.baseRefOid}`);
  }
  const expectedKind = expectedPrState.classification || handoff.decision?.classification || null;
  if (expectedKind && classification?.kind && expectedKind !== classification.kind) reasons.push(`classification differs from handoff: expected ${expectedKind}, current ${classification.kind}`);
  const expectedFailed = checkCountFromHandoff(expectedPrState.checks, 'failed');
  const expectedPending = checkCountFromHandoff(expectedPrState.checks, 'pending');
  const failedCount = classification?.checks?.failed?.length || 0;
  const pendingCount = classification?.checks?.pending?.length || 0;
  if (Number.isInteger(expectedFailed) && expectedFailed !== failedCount) reasons.push(`failed check count differs from handoff: expected ${expectedFailed}, current ${failedCount}`);
  if (Number.isInteger(expectedPending) && expectedPending !== pendingCount) reasons.push(`pending check count differs from handoff: expected ${expectedPending}, current ${pendingCount}`);
  return reasons;
}

export function handoffAllowsOutcome(handoff = {}, outcome, classification = {}, currentPr = {}) {
  const decisionKind = String(handoff.decision?.kind || '').toLowerCase();
  const actionClass = handoff.decision?.actionClass || handoff.actionPlan?.actionClass || null;
  const reviewDecision = String(currentPr?.reviewDecision || '').toUpperCase();
  if (outcome === 'blocked-stale' || outcome === 'blocked-risk') return { allowed: true, reasons: [] };
  const reasons = [];
  let allowed = false;
  if (outcome === 'accepted-for-rehearsal') {
    allowed = actionClass === AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL || decisionKind.includes('auto-safe') || decisionKind.includes('rehearsal');
    if (reviewDecision === 'CHANGES_REQUESTED') reasons.push('GitHub reviewDecision is CHANGES_REQUESTED; rehearse only after reviewer feedback is resolved or explicitly re-routed');
    if (classification?.kind && classification.kind !== 'dirty') reasons.push(`current classification ${classification.kind} is not dirty; rehearsal acceptance is not safe`);
  } else if (outcome === 'route-code-assisted') {
    allowed = actionClass === AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT || decisionKind.includes('code-assisted');
  } else if (outcome === 'human-only') {
    allowed = decisionKind.includes('human') || decisionKind.includes('maintainer');
  } else if (outcome === 'wait-recheck') {
    allowed = actionClass === AUTOMATIC_ACTION_CLASSES.RECHECK || decisionKind.includes('wait') || decisionKind.includes('recheck') || decisionKind.includes('refresh') || ['unknown', 'unstable', 'failed'].includes(classification?.kind);
  } else if (outcome === 'no-op-clean') {
    allowed = decisionKind.includes('no-op') || classification?.kind === 'clean' || classification?.kind === 'merged';
  }
  if (!allowed) reasons.push(`handoff decision ${handoff.decision?.kind || '(unknown)'} does not support outcome ${outcome}`);
  return { allowed: allowed && reasons.length === 0, reasons };
}

export function reviewDecisionRiskFlags(currentPr = {}, outcome) {
  const reviewDecision = String(currentPr?.reviewDecision || '').toUpperCase();
  const flags = [];
  if (reviewDecision === 'CHANGES_REQUESTED') flags.push('github-review-changes-requested');
  if (reviewDecision === 'REVIEW_REQUIRED') flags.push('github-review-required');
  if (reviewDecision === 'APPROVED' && ['route-code-assisted', 'human-only', 'blocked-risk'].includes(outcome)) flags.push('github-approved-but-operator-review-still-required');
  return flags;
}

export function decisionIdForFeedback(feedback = {}) {
  const refs = feedback.staleEvidence?.currentRefs || feedback.expectedRefs || {};
  return [
    'decision',
    feedback.target || 'target',
    feedback.sourceHandoff?.createdAt || feedback.sourceHandoff?.decisionKind || 'handoff',
    feedback.requestedOutcome || feedback.outcome || 'outcome',
    refs.headRefOid || 'no-head',
    refs.baseRefOid || 'no-base',
  ].join(':');
}

export function buildReviewStateFeedback(handoff = {}, currentPr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const target = fields.target || {};
  const requestedOutcome = normalizedDecisionOutcome(fields.decision || fields.outcome || 'wait-recheck');
  const classification = fields.classification || classifyPr(currentPr || {});
  const staleReasons = staleReviewEvidenceReasons(handoff, currentPr, state, classification);
  const transition = handoffAllowsOutcome(handoff, requestedOutcome, classification, currentPr);
  const riskFlags = compactStrings([
    ...(fields.riskFlags || []),
    ...reviewDecisionRiskFlags(currentPr, requestedOutcome),
    ...(staleReasons.length > 0 ? ['stale-evidence'] : []),
    ...(!transition.allowed ? ['unsupported-transition'] : []),
    requestedOutcome === 'route-code-assisted' ? ['code-assisted-review-only'] : [],
    requestedOutcome === 'human-only' ? ['human-only-review-only'] : [],
  ]);
  let outcome = requestedOutcome;
  let status = 'recorded';
  let terminalLedgerMarker = 'Done';
  const blockedReasons = [];
  if (staleReasons.length > 0 && requestedOutcome !== 'blocked-stale') {
    outcome = 'blocked-stale';
    status = 'blocked';
    terminalLedgerMarker = 'Block';
    blockedReasons.push(...staleReasons);
  } else if (!transition.allowed && requestedOutcome !== 'blocked-risk') {
    outcome = 'blocked-risk';
    status = 'blocked';
    terminalLedgerMarker = 'Block';
    blockedReasons.push(...transition.reasons);
  } else if (requestedOutcome === 'blocked-stale' || requestedOutcome === 'blocked-risk') {
    status = 'blocked';
    terminalLedgerMarker = 'Block';
    blockedReasons.push(...(requestedOutcome === 'blocked-stale' ? staleReasons : transition.reasons));
  }
  const refreshAfter = new Date(now.getTime() + Number(fields.refreshAfterMs || 60 * 60 * 1000)).toISOString();
  const expiresAt = new Date(now.getTime() + Number(fields.expiresAfterMs || 6 * 60 * 60 * 1000)).toISOString();
  const feedback = {
    schema: 'pr-shepherd-review-state-feedback/v1',
    decisionId: null,
    createdAt: now.toISOString(),
    target: target.id || handoff.target || null,
    pr: targetPrRef(target) || target.pr || handoff.pr || null,
    url: target.url || handoff.url || currentPr?.url || null,
    productionMutation: false,
    mutatesBranch: false,
    pushAllowed: false,
    noLiveApproval: true,
    requestedOutcome,
    outcome,
    status,
    decisionAllowed: status !== 'blocked',
    blockedReasons,
    sourceHandoff: {
      schema: handoff.schema || null,
      createdAt: handoff.createdAt || null,
      decisionKind: handoff.decision?.kind || null,
      actionClass: handoff.decision?.actionClass || handoff.actionPlan?.actionClass || null,
      terminalLedgerMarker: handoff.terminalLedgerMarker || null,
    },
    expectedRefs: handoff.expectedRefs || {},
    reviewState: {
      classification: classification?.kind || 'unknown',
      mergeable: currentPr?.mergeable || state.lastMergeable || null,
      mergeStateStatus: currentPr?.mergeStateStatus || state.lastMergeStateStatus || null,
      reviewDecision: currentPr?.reviewDecision || state.lastReviewDecision || null,
      failedCount: classification?.checks?.failed?.length || 0,
      pendingCount: classification?.checks?.pending?.length || 0,
    },
    staleEvidence: {
      stale: staleReasons.length > 0,
      reasons: staleReasons,
      currentRefs: currentRefState(currentPr, state),
      refreshRequired: staleReasons.length > 0,
    },
    reviewerOperatorSummary: fields.summary || fields.operatorSummary || null,
    operator: fields.operator || fields.reviewer || null,
    requestedNextOwner: fields.nextOwner || null,
    requestedWorkstream: fields.workstream || null,
    focusedChecks: compactStrings(fields.focusedChecks?.length ? fields.focusedChecks : handoffFocusedChecks(handoff)),
    riskFlags,
    refreshAfter,
    expiresAt,
    terminalLedgerMarker,
    nextStep: status === 'blocked'
      ? 'refresh evidence or record an explicit blocked-risk/blocked-stale operator decision; do not mutate branches'
      : nextActionForClassification(classification),
  };
  feedback.decisionId = fields.id || decisionIdForFeedback(feedback);
  return redactLedgerValue(feedback, target);
}

export function appendOperatorDecisionLedgerEntry(state, target = {}, feedback = {}, now = new Date()) {
  const ledger = Array.isArray(state.operatorDecisionLedger) ? state.operatorDecisionLedger.slice() : [];
  const entry = redactLedgerValue({
    schema: 'pr-shepherd-operator-decision-ledger/v1',
    at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    id: feedback.decisionId || decisionIdForFeedback(feedback),
    target: target.id || feedback.target || null,
    pr: targetPrRef(target) || target.pr || feedback.pr || null,
    outcome: feedback.outcome || null,
    requestedOutcome: feedback.requestedOutcome || null,
    status: feedback.status || null,
    operator: feedback.operator || null,
    reviewerOperatorSummary: feedback.reviewerOperatorSummary || null,
    requestedNextOwner: feedback.requestedNextOwner || null,
    requestedWorkstream: feedback.requestedWorkstream || null,
    focusedChecks: feedback.focusedChecks || [],
    riskFlags: feedback.riskFlags || [],
    staleEvidence: feedback.staleEvidence || null,
    noLiveApproval: feedback.noLiveApproval !== false,
    terminalLedgerMarker: feedback.terminalLedgerMarker || null,
  }, target);
  if (ledger.some((item) => item?.id === entry.id)) {
    state.operatorDecisionLedger = ledger;
    return false;
  }
  state.operatorDecisionLedger = [...ledger, entry].slice(-DEFAULT_ACTION_LEDGER_LIMIT);
  state.lastOperatorDecisionFeedback = feedback;
  return true;
}

export function feedbackAgeReasons(feedback = {}, now, maxAgeMs) {
  const reasons = [];
  const createdAtMs = Date.parse(feedback.createdAt || '');
  const expiresAtMs = Date.parse(feedback.expiresAt || '');
  if (!Number.isFinite(createdAtMs)) reasons.push('review-state feedback createdAt is missing or invalid');
  else if (createdAtMs - now.getTime() > 5 * 60 * 1000) reasons.push('review-state feedback createdAt is in the future');
  else if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now.getTime() - createdAtMs > maxAgeMs) reasons.push(`review-state feedback is older than ${maxAgeMs}ms`);
  if (!Number.isFinite(expiresAtMs)) reasons.push('review-state feedback expiresAt is missing or invalid');
  else if (now.getTime() > expiresAtMs) reasons.push('review-state feedback has expired');
  return reasons;
}

export function rehearsalQueueRefReasons(feedback = {}, currentPr = {}, state = {}) {
  const expectedRefs = feedback.expectedRefs || {};
  const currentRefs = currentRefState(currentPr, state);
  const reasons = [];
  if (expectedRefs.headRefOid) {
    if (!currentRefs.headRefOid) reasons.push('current headRefOid unavailable; refresh PR state before queueing rehearsal');
    else if (expectedRefs.headRefOid !== currentRefs.headRefOid) reasons.push(`headRefOid differs from feedback: expected ${expectedRefs.headRefOid}, current ${currentRefs.headRefOid}`);
  }
  if (expectedRefs.baseRefOid) {
    if (!currentRefs.baseRefOid) reasons.push('current baseRefOid unavailable; refresh base evidence before queueing rehearsal');
    else if (expectedRefs.baseRefOid !== currentRefs.baseRefOid) reasons.push(`baseRefOid differs from feedback: expected ${expectedRefs.baseRefOid}, current ${currentRefs.baseRefOid}`);
  }
  return reasons;
}

export function rehearsalQueueId(packet = {}) {
  const refs = packet.expectedRefs || {};
  return [
    'rehearsal-queue',
    packet.target || 'target',
    packet.sourceFeedback?.decisionId || packet.sourceFeedback?.createdAt || 'feedback',
    refs.headRefOid || 'no-head',
    refs.baseRefOid || 'no-base',
  ].join(':');
}

export function buildSupervisedRehearsalQueuePacket(feedback = {}, currentPr = {}, state = {}, fields = {}) {
  if (!isPlainObject(feedback) || feedback.schema !== 'pr-shepherd-review-state-feedback/v1') {
    throw new Error('supervised rehearsal queue requires a pr-shepherd-review-state-feedback/v1 packet');
  }
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const target = fields.target || {};
  const classification = fields.classification || classifyPr(currentPr || {});
  const maxAgeMs = fields.maxAgeMs === undefined ? DEFAULT_SUPERVISED_REHEARSAL_QUEUE_MAX_AGE_MS : Number(fields.maxAgeMs);
  const branchDiffPaths = Array.isArray(fields.branchDiffPaths) ? fields.branchDiffPaths : [];
  const artifactEvidencePaths = Array.isArray(fields.artifactEvidencePaths) ? fields.artifactEvidencePaths : [];
  const feedbackEvidencePaths = [
    ...(Array.isArray(feedback.evidenceHygiene?.offendingRuntimeContextPaths) ? feedback.evidenceHygiene.offendingRuntimeContextPaths : []),
    ...(Array.isArray(feedback.evidenceHygiene?.plannedArtifactEvidencePaths) ? feedback.evidenceHygiene.plannedArtifactEvidencePaths : []),
  ];
  const contamination = findOpenClawRuntimeContextPaths([...branchDiffPaths, ...artifactEvidencePaths, ...feedbackEvidencePaths]);
  const expectedRefs = {
    headBranch: target.headBranch || feedback.expectedRefs?.headBranch || currentPr?.headRefName || null,
    baseBranch: target.baseBranch || feedback.expectedRefs?.baseBranch || currentPr?.baseRefName || null,
    headRefOid: currentPr?.headRefOid || state.lastSeenHeadOid || feedback.expectedRefs?.headRefOid || null,
    baseRefOid: currentPr?.baseRefOid || state.lastSeenBaseOid || feedback.expectedRefs?.baseRefOid || null,
  };
  const repairKey = fields.repairKey || feedback.expectedRefs?.repairKey || repairPlanKey({
    headRefOid: expectedRefs.headRefOid,
    baseRefName: expectedRefs.baseBranch,
    mergeable: currentPr?.mergeable || state.lastMergeable || feedback.reviewState?.mergeable,
    mergeStateStatus: currentPr?.mergeStateStatus || state.lastMergeStateStatus || feedback.reviewState?.mergeStateStatus,
  }, expectedRefs.baseRefOid);
  expectedRefs.repairKey = repairKey;

  const blockedReasons = [];
  if (feedback.status !== 'recorded' || feedback.decisionAllowed !== true) blockedReasons.push('review-state feedback is not a recorded allowed decision');
  if (feedback.outcome !== 'accepted-for-rehearsal') blockedReasons.push(`review-state feedback outcome ${feedback.outcome || '(missing)'} is not accepted-for-rehearsal`);
  if (feedback.noLiveApproval === false) blockedReasons.push('review-state feedback must not grant or carry live repair approval');
  if (feedback.terminalLedgerMarker === 'Block') blockedReasons.push('review-state feedback is blocked');
  if (feedback.staleEvidence?.stale) blockedReasons.push('review-state feedback already marked evidence stale');
  if (classification?.kind !== 'dirty') blockedReasons.push(`current classification ${classification?.kind || 'unknown'} is not dirty; rehearsal queue is dry-run only for dirty PRs`);
  if (String(currentPr?.reviewDecision || feedback.reviewState?.reviewDecision || '').toUpperCase() === 'CHANGES_REQUESTED') {
    blockedReasons.push('GitHub reviewDecision is CHANGES_REQUESTED; do not queue rehearsal until feedback is resolved or re-routed');
  }
  blockedReasons.push(...feedbackAgeReasons(feedback, now, maxAgeMs));
  blockedReasons.push(...rehearsalQueueRefReasons(feedback, currentPr, state));
  if (contamination.length > 0) blockedReasons.push(`OpenClaw runtime/bootstrap context paths would enter rehearsal queue evidence: ${contamination.join(', ')}`);

  const dryRunCommand = renderedCommand('rehearse', target, fields);
  const queueAllowed = blockedReasons.length === 0;
  const dryRunPacket = {
    schema: 'pr-shepherd-rehearsal-dry-run-packet/v1',
    createdAt: now.toISOString(),
    target: target.id || feedback.target || null,
    pr: targetPrRef(target) || target.pr || feedback.pr || null,
    url: target.url || feedback.url || currentPr?.url || null,
    dryRunOnly: true,
    productionMutation: false,
    pushAllowed: false,
    mutatesBranch: false,
    noLiveApproval: true,
    command: dryRunCommand,
    alternateCommand: ['node', 'pr-shepherd.mjs', 'repair', '--config', '<config>', '--target', target.id || feedback.target || '<target-id>', '--dry-run'],
    expectedRefs,
    gates: [
      { name: 'feedback-accepted-for-rehearsal', ok: feedback.status === 'recorded' && feedback.decisionAllowed === true && feedback.outcome === 'accepted-for-rehearsal' },
      { name: 'dirty-pr-only', ok: classification?.kind === 'dirty', classification: classification?.kind || 'unknown' },
      { name: 'fresh-feedback', ok: feedbackAgeReasons(feedback, now, maxAgeMs).length === 0, maxAgeMs },
      { name: 'refs-match-feedback', ok: rehearsalQueueRefReasons(feedback, currentPr, state).length === 0 },
      { name: 'contamination-guard', ok: contamination.length === 0, offendingPaths: contamination },
    ],
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      plannedBranchDiffPaths: branchDiffPaths.slice().sort(),
      plannedArtifactEvidencePaths: artifactEvidencePaths.slice().sort(),
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    operatorChecklist: [
      'Confirm Start marker exists before running this queued dry-run.',
      'Run only the listed rehearse/repair --dry-run command; do not run live repair from this packet.',
      'Verify target id, PR, head/base refs, and repairKey still match immediately before execution.',
      'Inspect the generated Phase D approval package; require a separate one-shot approval before any live repair.',
      'Close the ledger with Done after a successful dry-run packet, or Block with exact offending paths/reasons.',
    ],
    terminalLedgerMarker: queueAllowed ? 'Done' : 'Block',
  };
  const packet = {
    schema: 'pr-shepherd-supervised-rehearsal-queue/v1',
    createdAt: now.toISOString(),
    queueName: fields.queueName || 'supervised-rehearsal',
    queueAllowed,
    status: queueAllowed ? 'queued' : 'blocked',
    blockedReasons,
    target: target.id || feedback.target || null,
    pr: targetPrRef(target) || target.pr || feedback.pr || null,
    url: target.url || feedback.url || currentPr?.url || null,
    productionMutation: false,
    supervised: true,
    requiresOperatorSupervision: true,
    dryRunOnly: true,
    pushAllowed: false,
    mutatesBranch: false,
    noLiveApproval: true,
    sourceFeedback: {
      schema: feedback.schema,
      decisionId: feedback.decisionId || null,
      createdAt: feedback.createdAt || null,
      outcome: feedback.outcome || null,
      terminalLedgerMarker: feedback.terminalLedgerMarker || null,
    },
    expectedRefs,
    queueItem: {
      id: null,
      priority: fields.priority || 'normal',
      actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL,
      status: queueAllowed ? 'ready-for-supervised-dry-run' : 'blocked',
      command: dryRunCommand,
      dryRunPacketSchema: dryRunPacket.schema,
      supervisionRequired: true,
      liveRepairApprovalRequiredSeparately: true,
    },
    dryRunPacket,
    evidenceHygiene: dryRunPacket.evidenceHygiene,
    terminalLedgerMarker: queueAllowed ? 'Done' : 'Block',
  };
  packet.queueItem.id = fields.id || rehearsalQueueId(packet);
  return redactLedgerValue(packet, target);
}

export function appendSupervisedRehearsalQueueLedgerEntry(state, target = {}, packet = {}, now = new Date()) {
  const ledger = Array.isArray(state.supervisedRehearsalQueueLedger) ? state.supervisedRehearsalQueueLedger.slice() : [];
  const entry = redactLedgerValue({
    schema: 'pr-shepherd-supervised-rehearsal-queue-ledger/v1',
    at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    id: packet.queueItem?.id || rehearsalQueueId(packet),
    target: target.id || packet.target || null,
    pr: targetPrRef(target) || target.pr || packet.pr || null,
    status: packet.status || null,
    queueAllowed: packet.queueAllowed === true,
    actionClass: packet.queueItem?.actionClass || AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL,
    dryRunOnly: packet.dryRunOnly !== false,
    noLiveApproval: packet.noLiveApproval !== false,
    blockedReasons: packet.blockedReasons || [],
    expectedRefs: packet.expectedRefs || {},
    terminalLedgerMarker: packet.terminalLedgerMarker || null,
  }, target);
  if (ledger.some((item) => item?.id === entry.id)) {
    state.supervisedRehearsalQueueLedger = ledger;
    return false;
  }
  state.supervisedRehearsalQueueLedger = [...ledger, entry].slice(-DEFAULT_ACTION_LEDGER_LIMIT);
  state.lastSupervisedRehearsalQueuePacket = packet;
  return true;
}

export function summarizeOperatorDecisionLedger(ledger = [], limit = 3) {
  const entries = Array.isArray(ledger) ? ledger : [];
  return {
    count: entries.length,
    recent: entries.slice(-limit).map((entry) => ({
      at: entry.at || null,
      target: entry.target || null,
      outcome: entry.outcome || null,
      status: entry.status || null,
      operator: entry.operator || null,
      requestedNextOwner: entry.requestedNextOwner || null,
      requestedWorkstream: entry.requestedWorkstream || null,
      riskFlags: entry.riskFlags || [],
      stale: Boolean(entry.staleEvidence?.stale),
      noLiveApproval: entry.noLiveApproval !== false,
      terminalLedgerMarker: entry.terminalLedgerMarker || null,
    })),
  };
}
