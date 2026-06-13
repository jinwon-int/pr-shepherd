// @ts-check
// Phase R (advanced automation level L5): risky-change approval-prepared packet.
//
// Risky auto-push is technically possible but never default-automatic. This
// module only PREPARES a complete operator packet for a risky change; it never
// mutates anything. A single explicit, unexpired, scoped approval authorizes
// exactly one bounded push and cannot become a standing privilege or widen
// policy. Operators see the exact diff scope, risk class and why it is risky,
// the command argv under consideration, expected head/lease, required checks,
// rollback/disable plan, notification target, and a contamination-guard result
// before approving.
import {
  AUTOMATIC_ACTION_CLASSES,
  OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES,
  RISKY_CHANGE_APPROVAL_SCOPE,
  findOpenClawRuntimeContextPaths,
} from './policy.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, consumedApprovalIds, currentBaseOid, renderedCommand, repairPlanKey, targetPrRef } from './approval.mjs';
import { normalizedRepoPath } from './conflicts.mjs';
import { buildPreMutationDecision, classifyChangedPathsRisk } from './decision.mjs';

const RISK_CLASS_REASON = {
  'runtime-bootstrap-context': 'OpenClaw runtime/bootstrap context must never be auto-pushed',
  'security-auth-config': 'security, auth, or config change requires human review',
  'ci-workflow': 'CI/workflow change can alter how checks run',
  'dependency-lockfile': 'dependency or lockfile change can shift transitive behavior',
  'semantic-source': 'semantic source change can alter runtime behavior',
  'structured-data': 'structured data/config change can alter behavior',
  'unclassified': 'path is outside the known minor-safe class and is treated as risky',
  'docs-or-text': 'documentation/text change',
};

export function riskyChangeApprovalPolicy(target = {}) {
  return target.automaticActions?.riskyChangeApproval || {};
}

/**
 * Resolve the one-shot approval state for the risky-change lane.
 * @param {object} policy
 * @param {object} state
 * @param {object} fields { currentHeadOid, headBranch, now }
 * @returns {{ state: string, reason: ?string, approvalId: ?string, expiresAt: ?string }}
 */
export function riskyApprovalState(policy = {}, state = {}, fields = {}) {
  const approvalId = typeof policy.approvalId === 'string' ? policy.approvalId.trim() : '';
  if (policy.enabled !== true) return { state: 'disabled', reason: 'automaticActions.riskyChangeApproval.enabled is not true', approvalId: null, expiresAt: null };
  if (!approvalId) return { state: 'missing', reason: 'approvalId is missing', approvalId: null, expiresAt: null };
  if (consumedApprovalIds(state).has(approvalId)) return { state: 'reused', reason: `approval ${approvalId} was already consumed; one approval authorizes exactly one push`, approvalId, expiresAt: policy.expiresAt || null };
  const expiresAt = Date.parse(policy.expiresAt || '');
  const now = fields.now instanceof Date ? fields.now.getTime() : Number(fields.now || Date.now());
  if (!Number.isFinite(expiresAt)) return { state: 'invalid', reason: 'expiresAt is missing or not a timestamp', approvalId, expiresAt: null };
  if (expiresAt <= now) return { state: 'expired', reason: `approval expired at ${policy.expiresAt}`, approvalId, expiresAt: policy.expiresAt };
  const branchAllowlist = (Array.isArray(policy.branchAllowlist) ? policy.branchAllowlist : []).map((item) => String(item).trim()).filter(Boolean);
  if (branchAllowlist.length === 0 || !fields.headBranch || !branchAllowlist.includes(fields.headBranch)) {
    return { state: 'branch-not-allowed', reason: `head branch ${fields.headBranch || '(unknown)'} is not in the approval branchAllowlist`, approvalId, expiresAt: policy.expiresAt };
  }
  if (policy.expectedHeadOid && fields.currentHeadOid && policy.expectedHeadOid !== fields.currentHeadOid) {
    return { state: 'head-mismatch', reason: `approval expected head ${policy.expectedHeadOid} but current head is ${fields.currentHeadOid}`, approvalId, expiresAt: policy.expiresAt };
  }
  return { state: 'ready', reason: null, approvalId, expiresAt: policy.expiresAt };
}

/**
 * Build the non-mutating Phase R risky-change approval packet
 * (schema pr-shepherd-risky-change-approval-packet/v1).
 * @param {object} [target]
 * @param {object} [pr]
 * @param {object} [state]
 * @param {object} [fields]
 * @returns {object}
 */
export function buildRiskyChangeApprovalPacket(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const policy = riskyChangeApprovalPolicy(target);
  const classification = fields.classification || classifyPr(pr || {});
  const headBranch = target.headBranch || pr?.headRefName || null;
  const baseBranch = target.baseBranch || pr?.baseRefName || null;
  const baseOid = fields.baseOid || currentBaseOid(state, pr || {});
  const repairKey = fields.repairKey || repairPlanKey(pr || {}, baseOid);
  const expectedHeadOid = policy.expectedHeadOid || fields.expectedHeadOid || pr?.headRefOid || state.lastSeenHeadOid || null;
  const currentHeadOid = fields.currentHeadOid || pr?.headRefOid || null;
  const changedPaths = [...new Set((fields.changedPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const artifactEvidencePaths = [...new Set((fields.artifactEvidencePaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const contamination = findOpenClawRuntimeContextPaths([...changedPaths, ...artifactEvidencePaths]);
  const riskBreakdown = classifyChangedPathsRisk(changedPaths);
  const verifyGate = buildVerifyGate(target);
  const requiredChecks = [...new Set([
    ...verifyGate.commands,
    ...((Array.isArray(policy.requiredChecks) ? policy.requiredChecks : []).map((item) => String(item || '').trim()).filter(Boolean)),
  ])];
  const approval = riskyApprovalState(policy, state, { currentHeadOid, headBranch, now });
  const riskReasons = riskBreakdown.perPath.map((item) => ({ path: item.path, riskClass: item.riskClass, why: RISK_CLASS_REASON[item.riskClass] || 'risky change' }));
  const notificationTarget = fields.notificationTarget || target.notify?.mode || null;

  const blockedReasons = [];
  if (approval.state !== 'ready') blockedReasons.push(approval.reason || `approval state is ${approval.state}`);
  if (changedPaths.length === 0) blockedReasons.push('exact changed paths are required to prepare a risky-change packet');
  if (contamination.length > 0) blockedReasons.push(`OpenClaw runtime/bootstrap context paths would enter the packet: ${contamination.join(', ')}`);
  if (verifyGate.status === 'missing') blockedReasons.push(verifyGate.reason || 'strict verify gate is missing');

  // The packet is always generated (non-mutating). Contamination is the only
  // condition that blocks attaching/publishing it.
  const packetAllowed = contamination.length === 0;
  const pushAuthorized = packetAllowed && blockedReasons.length === 0;
  const forceWithLease = headBranch && expectedHeadOid ? `${headBranch}:${expectedHeadOid}` : null;
  const commandUnderConsideration = renderedCommand('repair', target, fields);

  const decision = buildPreMutationDecision({
    eligible: pushAuthorized,
    blockedReason: blockedReasons,
    provenance: { approvalId: approval.approvalId, approvedBy: policy.approvedBy || null, approvedAt: policy.approvedAt || null },
    riskClass: riskBreakdown.riskClass,
    policyId: policy.approvalId || policy.policyId || null,
    expectedHead: expectedHeadOid,
    checksSnapshot: { requiredChecks, classification: classification?.kind || null },
    auditPacketPath: fields.auditPacketPath || null,
  });

  return redactLedgerValue({
    schema: 'pr-shepherd-risky-change-approval-packet/v1',
    createdAt: now.toISOString(),
    lane: RISKY_CHANGE_APPROVAL_SCOPE,
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    status: !packetAllowed ? 'blocked' : (pushAuthorized ? 'approved-one-shot' : 'prepared-needs-approval'),
    packetAllowed,
    pushAuthorized,
    productionMutation: false,
    mutatesBranch: false,
    oneShot: true,
    widensPolicy: false,
    blockedReasons,
    approval: {
      state: approval.state,
      approvalId: approval.approvalId,
      approvedBy: policy.approvedBy || null,
      approvedAt: policy.approvedAt || null,
      scope: policy.scope || null,
      expiresAt: approval.expiresAt,
      reason: approval.reason,
    },
    decision,
    diffScope: {
      changedPaths,
      branchDiffPaths: changedPaths,
      fileCount: changedPaths.length,
    },
    riskClass: riskBreakdown.riskClass,
    riskReasons,
    commandUnderConsideration,
    pushGuard: {
      expectedHeadOid,
      currentHeadOid,
      forceWithLease,
      remoteHeadFresh: Boolean(expectedHeadOid && currentHeadOid && expectedHeadOid === currentHeadOid),
    },
    expectedRefs: { headBranch, baseBranch, headRefOid: expectedHeadOid, baseRefOid: baseOid, repairKey },
    requiredFocusedChecks: requiredChecks,
    rollbackPlan: fields.rollbackPlan || [
      'Disable automaticActions.riskyChangeApproval after this one-shot run.',
      'Revert the pushed commit on the head branch and re-run check-canary.',
      'Keep the consumed approvalId recorded so it cannot be reused.',
    ],
    notificationTarget,
    operatorChecklist: [
      'Post Start before recording the risky-change decision, and close with exactly one PR, Done, or Block marker.',
      'Confirm the exact diff scope, risk class, and command argv before approving.',
      'One approval authorizes exactly one bounded push and must not widen policy.',
      'Fail closed if expected head/lease, branch, checks, or contamination state change.',
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
      plannedBranchDiffPaths: changedPaths,
      plannedArtifactEvidencePaths: artifactEvidencePaths,
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    operatorSummary: !packetAllowed
      ? `risky-change packet blocked: ${blockedReasons.join('; ')}`
      : (pushAuthorized
        ? `risky-change packet approved for exactly one bounded push (risk class ${riskBreakdown.riskClass}); approval ${approval.approvalId} expires ${approval.expiresAt}`
        : `risky-change packet prepared for operator review (risk class ${riskBreakdown.riskClass}); ${blockedReasons.join('; ')}`),
    terminalLedgerMarker: packetAllowed ? (pushAuthorized ? 'Done' : 'Block') : 'Block',
  }, target);
}
