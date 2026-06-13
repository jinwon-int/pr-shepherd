// @ts-check
// Phase P (advanced automation level L3): minor-auto post-push auto-merge gate.
//
// This lane may auto-merge ONLY a PR/branch that is provably a low-risk
// minor-auto output and still passes every final gate immediately before the
// merge. It is default-off, target-scoped, never merges semantic/risky
// changes, and fails closed on any ambiguity. Gate building is non-mutating;
// the executor recomputes the gate at the final moment and refuses to merge if
// anything changed.
import {
  AUTOMATIC_ACTION_CLASSES,
  MINOR_AUTO_MERGE_SCOPE,
  MINOR_AUTO_SAFE_REPAIR_SCOPE,
  MINOR_SAFE_RISK_CLASS,
  OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES,
  SUPPORTED_MERGE_METHODS,
  findOpenClawRuntimeContextPaths,
} from './policy.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, currentBaseOid, repairPlanKey, targetPrRef } from './approval.mjs';
import { minorAutoCircuitBreaker, minorAutoPathRiskReason, pathMatchesAnyAllowlist } from './minor-auto.mjs';
import { normalizedRepoPath } from './conflicts.mjs';
import { buildPreMutationDecision, classifyChangedPathsRisk } from './decision.mjs';

export function autoMergePolicy(target = {}) {
  return target.automaticActions?.autoMerge || {};
}

export function autoMergePaths(policy = {}) {
  return (Array.isArray(policy.pathAllowlist) ? policy.pathAllowlist : [])
    .map((item) => normalizedRepoPath(item))
    .filter(Boolean);
}

export function autoMergeResolvers(policy = {}) {
  return (Array.isArray(policy.resolverAllowlist) ? policy.resolverAllowlist : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/**
 * Recover minor-auto provenance for the current head from explicit fields or
 * recorded state. Provenance proves the branch under consideration is the
 * output of an approved minor-auto push, not an unrelated commit.
 * @param {object} [state]
 * @param {object} [fields]
 * @returns {?object}
 */
export function minorAutoProvenance(state = {}, fields = {}) {
  const provenance = fields.provenance || state.minorAutoProvenance || null;
  if (!provenance || typeof provenance !== 'object') return null;
  return {
    scope: provenance.scope || null,
    target: provenance.target || null,
    pushedHeadOid: provenance.pushedHeadOid || provenance.headRefOid || null,
    changedPaths: [...new Set((provenance.changedPaths || []).map(normalizedRepoPath).filter(Boolean))].sort(),
    resolver: provenance.resolver || null,
    resolvers: Array.isArray(provenance.resolvers) ? provenance.resolvers.map((item) => String(item).trim()).filter(Boolean) : (provenance.resolver ? [String(provenance.resolver).trim()] : []),
    riskClass: provenance.riskClass || null,
    repairKey: provenance.repairKey || null,
    at: provenance.at || null,
  };
}

/**
 * Build the fail-closed Phase P auto-merge gate report
 * (schema pr-shepherd-auto-merge-gate/v1).
 * @param {object} [target]
 * @param {object} [pr]
 * @param {object} [state]
 * @param {object} [fields]
 * @returns {object}
 */
export function buildAutoMergeGate(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const policy = autoMergePolicy(target);
  const classification = fields.classification || classifyPr(pr || {});
  const pathAllowlist = autoMergePaths(policy);
  const resolverAllowlist = autoMergeResolvers(policy);
  const requiredChecks = (Array.isArray(policy.requiredChecks) ? policy.requiredChecks : []).map((item) => String(item || '').trim()).filter(Boolean);
  const branchAllowlist = (Array.isArray(policy.branchAllowlist) ? policy.branchAllowlist : []).map((item) => String(item).trim()).filter(Boolean);
  const mergeMethod = policy.mergeMethod || null;
  const configuredTargetBranch = policy.targetBranch || null;
  const headBranch = target.headBranch || pr?.headRefName || null;
  const baseBranch = target.baseBranch || pr?.baseRefName || null;
  const baseOid = fields.baseOid || currentBaseOid(state, pr || {});
  const repairKey = fields.repairKey || repairPlanKey(pr || {}, baseOid);
  const expectedHeadOid = fields.expectedHeadOid || pr?.headRefOid || state.lastSeenHeadOid || null;
  const currentHeadOid = fields.currentHeadOid || fields.remoteHeadOid || pr?.headRefOid || null;
  const provenance = minorAutoProvenance(state, fields);
  const changedPaths = [...new Set((fields.changedPaths || provenance?.changedPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const artifactEvidencePaths = [...new Set((fields.artifactEvidencePaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const contamination = findOpenClawRuntimeContextPaths([...changedPaths, ...artifactEvidencePaths]);
  const riskSignals = [...new Set((fields.riskSignals || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const circuitBreaker = minorAutoCircuitBreaker(state);
  const verifyGate = buildVerifyGate(target);
  const riskBreakdown = classifyChangedPathsRisk(changedPaths);
  const checks = classification?.checks || { failed: [], pending: [], ignored: [] };
  const presentCheckNames = new Set([...(checks.failed || []), ...(checks.pending || []), ...(checks.ignored || [])]
    .concat(Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup.map((c) => c.name || c.context) : [])
    .map((c) => (typeof c === 'string' ? c : c?.name || c?.context)).filter(Boolean));
  const successCheckNames = new Set((Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [])
    .filter((c) => String(c.status || '').toUpperCase() === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(c.conclusion || '').toUpperCase()))
    .map((c) => c.name || c.context).filter(Boolean));
  const missingRequiredChecks = requiredChecks.filter((name) => !successCheckNames.has(name));
  const reviewRequirementsSatisfied = fields.reviewRequirementsSatisfied !== undefined
    ? fields.reviewRequirementsSatisfied === true
    : pr?.reviewDecision === 'APPROVED';

  const reasons = [];
  const gates = [];
  const gate = (name, ok, reason, details = {}) => {
    gates.push({ name, ok: Boolean(ok), reason: ok ? null : reason, ...details });
    if (!ok && reason) reasons.push(reason);
  };

  gate('auto-merge-config-enabled', policy.enabled === true, 'automaticActions.autoMerge.enabled is not true');
  gate('auto-merge-scope', policy.scope === MINOR_AUTO_MERGE_SCOPE, `automaticActions.autoMerge.scope must be ${MINOR_AUTO_MERGE_SCOPE}`);
  gate('merge-method-configured', SUPPORTED_MERGE_METHODS.includes(mergeMethod), `automaticActions.autoMerge.mergeMethod must be one of: ${SUPPORTED_MERGE_METHODS.join(', ')}`, { mergeMethod });
  gate('target-branch-configured', Boolean(configuredTargetBranch) && configuredTargetBranch === baseBranch, `automaticActions.autoMerge.targetBranch must be set and match the PR base branch (${baseBranch || 'unknown'})`, { configuredTargetBranch, baseBranch });
  gate('required-checks-configured', requiredChecks.length > 0, 'automaticActions.autoMerge.requiredChecks must be a non-empty array');
  gate('path-allowlist-configured', pathAllowlist.length > 0, 'automaticActions.autoMerge.pathAllowlist is required');
  gate('resolver-allowlist-configured', resolverAllowlist.length > 0, 'automaticActions.autoMerge.resolverAllowlist is required');
  gate('branch-allowlist', branchAllowlist.length > 0 && Boolean(headBranch) && branchAllowlist.includes(headBranch), `head branch ${headBranch || '(unknown)'} is not in automaticActions.autoMerge.branchAllowlist`, { headBranch });
  gate('minor-auto-provenance-present', Boolean(provenance), 'minor-auto provenance is required to prove the branch is a minor-auto output');
  gate('provenance-scope-match', provenance?.scope === MINOR_AUTO_SAFE_REPAIR_SCOPE, `provenance scope must be ${MINOR_AUTO_SAFE_REPAIR_SCOPE}`, { provenanceScope: provenance?.scope || null });
  gate('provenance-target-match', !provenance || !provenance.target || provenance.target === target.id, 'provenance target does not match the current target', { provenanceTarget: provenance?.target || null, target: target.id || null });
  gate('provenance-head-match', Boolean(provenance?.pushedHeadOid) && provenance.pushedHeadOid === currentHeadOid, 'provenance pushed head does not match the current head; only the proven minor-auto output may merge', { provenanceHead: provenance?.pushedHeadOid || null, currentHeadOid });
  gate('expected-head-fresh', Boolean(expectedHeadOid && currentHeadOid && expectedHeadOid === currentHeadOid), `expected head changed; refusing to merge. expected ${expectedHeadOid || '(missing)'}, got ${currentHeadOid || '(missing)'}`, { expectedHeadOid, currentHeadOid });
  gate('current-pr-clean', classification?.kind === 'clean', `current classification ${classification?.kind || 'unknown'} is not clean`, { classification: classification?.kind || null });
  gate('no-check-ambiguity', (checks.pending || []).length === 0 && (checks.failed || []).length === 0, 'pending, failed, or unknown checks block auto-merge', { pending: (checks.pending || []).length, failed: (checks.failed || []).length });
  gate('required-checks-clean', missingRequiredChecks.length === 0, `required checks are not all successful: ${missingRequiredChecks.join(', ')}`, { requiredChecks, missingRequiredChecks });
  gate('branch-protection-satisfied', fields.branchProtectionSatisfied === true, 'branch protection requirements are not confirmed satisfied', { branchProtectionSatisfied: fields.branchProtectionSatisfied === true });
  gate('review-requirements-satisfied', reviewRequirementsSatisfied, 'review requirements are not satisfied (reviewDecision must be APPROVED)', { reviewDecision: pr?.reviewDecision || null });
  gate('changed-paths-present', changedPaths.length > 0, 'exact changed paths are required to auto-merge');
  const outside = changedPaths.filter((path) => !pathMatchesAnyAllowlist(path, pathAllowlist));
  gate('changed-paths-within-allowlist', changedPaths.length === 0 || outside.length === 0, `changed paths outside automaticActions.autoMerge.pathAllowlist: ${outside.join(', ')}`, { outside });
  const risky = changedPaths.map((path) => ({ path, reason: minorAutoPathRiskReason(path) })).filter((item) => item.reason);
  gate('changed-path-risk-class', risky.length === 0 && (riskBreakdown.riskClass === null || riskBreakdown.riskClass === MINOR_SAFE_RISK_CLASS), `changed paths are not minor-safe: ${risky.map((item) => `${item.path} (${item.reason})`).join(', ') || riskBreakdown.riskClass}`, { risky, riskClass: riskBreakdown.riskClass });
  const provenanceResolvers = provenance?.resolvers || [];
  gate('resolver-within-allowlist', provenanceResolvers.length === 0 || provenanceResolvers.every((resolver) => resolverAllowlist.includes(resolver)), `provenance resolver is not in the auto-merge allowlist: ${provenanceResolvers.filter((resolver) => !resolverAllowlist.includes(resolver)).join(', ')}`, { provenanceResolvers, resolverAllowlist });
  gate('no-reviewer-objection', pr?.reviewDecision !== 'CHANGES_REQUESTED' && riskSignals.length === 0, `reviewer objection or risky label/comment/check signal present: ${pr?.reviewDecision === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : ''} ${riskSignals.join(', ')}`.trim(), { reviewDecision: pr?.reviewDecision || null, riskSignals });
  gate('circuit-breaker-closed', circuitBreaker.state !== 'open', `circuit breaker is open: ${circuitBreaker.reason || 'operator review required'}`, { circuitBreaker });
  gate('contamination-guard', contamination.length === 0, `OpenClaw runtime/bootstrap context paths would enter branch diff or merge evidence: ${contamination.join(', ')}`, { offendingPaths: contamination });

  const blockedReasons = [...new Set(reasons)];
  const mergeAllowed = blockedReasons.length === 0;
  const decision = buildPreMutationDecision({
    eligible: mergeAllowed,
    blockedReason: blockedReasons,
    provenance,
    riskClass: riskBreakdown.riskClass,
    policyId: policy.policyId || policy.approvalId || null,
    expectedHead: expectedHeadOid,
    checksSnapshot: { requiredChecks, missingRequiredChecks, pending: (checks.pending || []).length, failed: (checks.failed || []).length },
    auditPacketPath: fields.auditPacketPath || null,
  });

  return redactLedgerValue({
    schema: 'pr-shepherd-auto-merge-gate/v1',
    createdAt: now.toISOString(),
    lane: MINOR_AUTO_MERGE_SCOPE,
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    status: mergeAllowed ? 'eligible' : 'blocked',
    mergeAllowed,
    blockedReasons,
    actionClass: mergeAllowed ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    requiresOperatorApproval: !mergeAllowed,
    decision,
    gates,
    mergeMethod,
    targetBranch: configuredTargetBranch,
    expectedRefs: { headBranch, baseBranch, headRefOid: expectedHeadOid, baseRefOid: baseOid, repairKey },
    provenance,
    riskClass: riskBreakdown.riskClass,
    riskBreakdown: riskBreakdown.perPath,
    changedPaths,
    requiredChecks,
    missingRequiredChecks,
    verifyGate,
    rolloutControls: {
      defaultOff: true,
      onlyMinorAutoOutputs: true,
      noSemanticOrRiskyMerge: true,
      noMergeOnAmbiguity: true,
      recomputeGatesAtFinalMoment: true,
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
    operatorSummary: mergeAllowed
      ? `auto-merge eligible: proven minor-auto output on ${headBranch} passes every final gate; merge method ${mergeMethod}`
      : `auto-merge blocked: ${blockedReasons.join('; ')}`,
    terminalLedgerMarker: mergeAllowed ? 'Done' : 'Block',
  }, target);
}

/**
 * Execute the auto-merge lane. Fails closed unless the gate is allowed and, for
 * a live merge, the recomputed final-moment gate is still allowed. The merge
 * handler is supplied by the caller; there is no built-in merge side effect.
 * @param {object} gate Result of buildAutoMergeGate.
 * @param {(gate: object) => any} [handler]
 * @param {object} [opts] { dryRun, recompute }
 * @returns {object}
 */
export function executeAutoMergeGate(gate = {}, handler, opts = {}) {
  if (gate.mergeAllowed !== true) {
    return { status: 'blocked', merged: false, reasons: gate.blockedReasons || ['auto-merge gate denied the merge'], gate };
  }
  if (opts.dryRun === true) {
    return { status: 'planned', merged: false, dryRun: true, reasons: [gate.operatorSummary || 'auto-merge eligible (dry-run)'], gate };
  }
  if (typeof opts.recompute === 'function') {
    const fresh = opts.recompute();
    if (!fresh || fresh.mergeAllowed !== true) {
      return { status: 'blocked', merged: false, reasons: ['final-moment gate recomputation failed closed', ...((fresh && fresh.blockedReasons) || [])], gate: fresh || gate };
    }
    gate = fresh;
  }
  if (typeof handler !== 'function') {
    return { status: 'skipped', merged: false, reasons: ['no merge handler supplied'], gate };
  }
  return { status: 'merged', merged: true, mergeMethod: gate.mergeMethod, result: handler(gate), gate };
}
