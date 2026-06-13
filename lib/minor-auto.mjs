// @ts-check
// Minor-auto repair policy helpers, gate, and execution controller (Phases M/N/O).
import { basename } from 'node:path';
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS, MINOR_AUTO_ROLLOUT_MODES, MINOR_AUTO_SAFE_REPAIR_SCOPE, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { isPlainObject } from './config.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { buildVerifyGate, currentBaseOid, repairPlanKey, targetPrRef } from './approval.mjs';
import { automaticActionExecution, explainAutomaticActionPlan, planAutomaticAction } from './plan.mjs';
import { buildPostActionAuditEntry } from './phase-e.mjs';
import { DEFAULT_HUMAN_ONLY_CONFLICTS, matchDiagnosisHintPath, normalizedRepoPath, recentAutoPushes } from './conflicts.mjs';

export function minorAutoPathRiskReason(path) {
  const normalized = normalizedRepoPath(path);
  const lower = normalized.toLowerCase();
  const name = basename(lower);
  const runtimeContextPaths = findOpenClawRuntimeContextPaths([normalized]);
  if (runtimeContextPaths.length > 0) return `OpenClaw runtime/bootstrap context path: ${runtimeContextPaths.join(', ')}`;
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return 'path must be repo-relative and must not contain ..';
  if (lower === '.github' || lower.startsWith('.github/')) return 'CI/workflow paths require approval';
  if (lower === 'package.json' || lower.endsWith('/package.json') || DEFAULT_HUMAN_ONLY_CONFLICTS.includes(name)) return 'dependency or lockfile paths require approval';
  if (/^(.+\.)?(env|npmrc|yarnrc|pypirc)$/.test(name) || /(^|\/)(config|configs|security|auth|secrets?)(\/|$)/.test(lower)) return 'security/auth/config paths require approval';
  if (/\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|fish|ps1|sql|yaml|yml|toml|json|lock)$/i.test(normalized)) return 'source, executable, config, generated metadata, or structured data paths require approval in the default minor lane';
  if (/^(changelog|changes|news|release-notes?)(\.|\/|$)/i.test(normalized)) return null;
  if (/^(docs|documentation)\//i.test(normalized) && /\.(md|mdx|txt|rst)$/i.test(normalized)) return null;
  if (/\.(md|mdx|txt|rst)$/i.test(normalized)) return null;
  return 'path is not in the built-in minor documentation/changelog-safe class';
}

export function minorAutoRepairPolicy(target = {}) {
  return target.automaticActions?.minorAutoRepair || {};
}

export function minorAutoRolloutMode(policy = {}) {
  return MINOR_AUTO_ROLLOUT_MODES.includes(policy.rolloutMode) ? policy.rolloutMode : 'observe-only';
}

export function minorAutoCircuitBreaker(state = {}) {
  const breaker = state.minorAutoCircuitBreaker || state.minorAutoRollout?.circuitBreaker || null;
  if (!isPlainObject(breaker)) return { state: 'closed', reason: null, openedAt: null };
  const breakerState = breaker.state === 'open' ? 'open' : 'closed';
  return {
    state: breakerState,
    reason: typeof breaker.reason === 'string' && breaker.reason.trim() ? breaker.reason.trim() : null,
    openedAt: typeof breaker.openedAt === 'string' ? breaker.openedAt : null,
    closedAt: typeof breaker.closedAt === 'string' ? breaker.closedAt : null,
  };
}

export function lastMinorAutoPushAt(state = {}) {
  const pushes = (state.autoPushes || [])
    .filter((push) => push?.reason === MINOR_AUTO_SAFE_REPAIR_SCOPE || push?.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE)
    .map((push) => Date.parse(push.at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return pushes[0] || null;
}

export function recentRepoMinorAutoPushes(state = {}, target = {}, now = Date.now()) {
  const repoKey = target.owner && target.repo ? `${target.owner}/${target.repo}` : null;
  return (state.autoPushes || []).filter((push) => {
    const at = Date.parse(push?.at || '');
    if (!Number.isFinite(at) || now - at >= 24 * 60 * 60 * 1000) return false;
    if (!(push?.reason === MINOR_AUTO_SAFE_REPAIR_SCOPE || push?.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE)) return false;
    if (!repoKey || !push.repo) return true;
    return push.repo === repoKey;
  });
}

export function minorAutoPostPushStopReason(state = {}) {
  const observation = state.lastMinorAutoPostPushObservation;
  if (!isPlainObject(observation)) return null;
  if (observation.rolloutStopRequired === true) {
    return observation.operatorSummary || `post-push outcome ${observation.outcome || 'unknown'} requires operator review`;
  }
  return null;
}

export function configuredMinorAutoPaths(policy = {}) {
  return (Array.isArray(policy.pathAllowlist) ? policy.pathAllowlist : (Array.isArray(policy.paths) ? policy.paths : []))
    .map((item) => normalizedRepoPath(item))
    .filter(Boolean);
}

export function configuredMinorAutoResolvers(policy = {}) {
  return (Array.isArray(policy.resolverAllowlist) ? policy.resolverAllowlist : (Array.isArray(policy.resolvers) ? policy.resolvers : []))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function pathMatchesAnyAllowlist(path, allowlist = []) {
  const normalized = normalizedRepoPath(path);
  return allowlist.some((allowed) => matchDiagnosisHintPath(allowed, normalized));
}

export function rehearsalFreshForMinorAuto(target = {}, state = {}, pr = {}, now = Date.now(), maxAgeMs = DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS) {
  const rehearsal = state.lastRepairRehearsal;
  const rehearsalAt = Date.parse(rehearsal?.at || '');
  const baseOid = currentBaseOid(state, pr);
  const expectedRepairKey = repairPlanKey(pr, baseOid);
  return Boolean(rehearsal
    && Number.isFinite(rehearsalAt)
    && now - rehearsalAt <= maxAgeMs
    && (!rehearsal.target || rehearsal.target === target.id)
    && rehearsal.headRefOid === pr?.headRefOid
    && (!rehearsal.baseOid || rehearsal.baseOid === baseOid)
    && rehearsal.repairKey === expectedRepairKey);
}

/**
 * @typedef {object} MinorAutoGateCheck
 * @property {string} name
 * @property {boolean} ok
 * @property {?string} reason
 */

/**
 * Fail-closed gate report for the bounded Phase M minor-auto lane
 * (schema pr-shepherd-minor-auto-repair-gate/v1). Key fields only; the full
 * report also carries policy, ref, budget, and evidence-hygiene details.
 * @typedef {object} MinorAutoRepairGate
 * @property {string} schema
 * @property {'auto-repaired'|'blocked-risk'|'blocked-needs-approval'} status
 * @property {string[]} blockedReasons
 * @property {boolean} [gateAllowed]
 * @property {string} [actionClass]
 * @property {boolean} [requiresOperatorApproval]
 * @property {boolean} [pushAllowed]
 * @property {boolean} [dryRunAllowed]
 * @property {MinorAutoGateCheck[]} [gates]
 * @property {object} [verifyGate]
 * @property {object} [evidenceHygiene]
 * @property {string} [operatorSummary]
 * @property {'Done'|'Block'} [terminalLedgerMarker]
 */

/**
 * @param {object} [target]
 * @param {object} [state]
 * @param {object} [pr]
 * @param {object} [classification]
 * @param {object} [fields]
 * @returns {MinorAutoRepairGate}
 */
export function buildMinorAutoRepairGate(target = {}, state = {}, pr = {}, classification = classifyPr(pr), fields = {}) {
  const now = fields.now instanceof Date ? fields.now.getTime() : (fields.now === undefined ? Date.now() : Number(fields.now));
  const policy = minorAutoRepairPolicy(target);
  const rolloutMode = minorAutoRolloutMode(policy);
  const liveLimited = rolloutMode === 'minor-auto-live-limited';
  const dryRunMode = rolloutMode === 'minor-auto-dry-run';
  const sandboxProofMode = rolloutMode === 'sandbox-proof';
  const pathAllowlist = configuredMinorAutoPaths(policy);
  const resolverAllowlist = configuredMinorAutoResolvers(policy);
  const verifyGate = buildVerifyGate(target);
  const changedPaths = [...new Set((fields.changedPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const branchAllowlist = Array.isArray(policy.branchAllowlist) ? policy.branchAllowlist.map((item) => String(item).trim()).filter(Boolean) : [];
  const headBranch = target.headBranch || pr?.headRefName || '';
  const selectedTargetCount = Number.isInteger(Number(fields.selectedTargetCount)) ? Number(fields.selectedTargetCount) : 1;
  const contamination = findOpenClawRuntimeContextPaths([...(fields.changedPaths || []), ...(fields.artifactEvidencePaths || [])]);
  const pushLimit = Number(target.autoPushLimit24h || 0);
  const recentPushCount = recentAutoPushes(state, now).length;
  const repoPushLimit = policy.repoPushLimit24h === undefined ? null : Number(policy.repoPushLimit24h);
  const repoRecentPushCount = recentRepoMinorAutoPushes(state, target, now).length;
  const cooldownMs = policy.cooldownMs === undefined ? 0 : Number(policy.cooldownMs);
  const lastPushAt = lastMinorAutoPushAt(state);
  const cooldownRemainingMs = lastPushAt && Number.isFinite(cooldownMs) ? Math.max(0, cooldownMs - (now - lastPushAt)) : 0;
  const circuitBreaker = minorAutoCircuitBreaker(state);
  const postPushStopReason = minorAutoPostPushStopReason(state);
  const maxAgeMs = policy.rehearsalMaxAgeMs === undefined ? DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS : Number(policy.rehearsalMaxAgeMs);
  const zeroRehearsalSafe = policy.zeroRehearsalSafe === true;
  const requireRecentRehearsal = !zeroRehearsalSafe && policy.requireRecentRehearsal !== false;
  const conflictEntries = Array.isArray(fields.conflictInfo?.entries) ? fields.conflictInfo.entries : [];
  const reasons = [];
  const gates = [];
  const gate = (name, ok, reason, details = {}) => {
    gates.push({ name, ok: Boolean(ok), reason: ok ? null : reason, ...details });
    if (!ok && reason) reasons.push(reason);
  };

  gate('minor-auto-config-enabled', policy.enabled === true, 'automaticActions.minorAutoRepair.enabled is not true');
  gate('minor-auto-scope', policy.scope === MINOR_AUTO_SAFE_REPAIR_SCOPE, `automaticActions.minorAutoRepair.scope must be ${MINOR_AUTO_SAFE_REPAIR_SCOPE}`);
  gate('action-class-auto-safe-repair', policy.actionClass === AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, 'automaticActions.minorAutoRepair.actionClass must be auto-safe-repair');
  gate('rollout-mode-configured', MINOR_AUTO_ROLLOUT_MODES.includes(policy.rolloutMode) || policy.rolloutMode === undefined, `automaticActions.minorAutoRepair.rolloutMode must be one of: ${MINOR_AUTO_ROLLOUT_MODES.join(', ')}`, { rolloutMode });
  gate('rollout-mode-allows-controller', liveLimited || dryRunMode, `minor-auto rolloutMode ${rolloutMode} does not permit target branch mutation${sandboxProofMode ? '; run sandbox proof only' : ''}`, { rolloutMode, pushAllowed: liveLimited });
  gate('single-target-only', selectedTargetCount === 1, 'minor-auto-safe repair may select exactly one target; broad --all mutation requires approval');
  gate('dirty-current-pr', classification?.kind === 'dirty', `current classification ${classification?.kind || 'unknown'} is not dirty`);
  gate('checks-pass-or-unrelated', (classification?.checks?.failed || []).length === 0 && (classification?.checks?.pending || []).length === 0, 'failed or pending checks block minor-auto-safe repair');
  gate('strict-verify-gate', verifyGate.status !== 'missing', verifyGate.reason || 'strict verify gate is missing', { verifyGate });
  gate('push-budget', !liveLimited || (Number.isFinite(pushLimit) && pushLimit > 0 && recentPushCount < pushLimit), '24h push budget is exhausted or not configured', { recentPushCount, pushLimit });
  gate('repo-push-budget', !liveLimited || repoPushLimit === null || (Number.isFinite(repoPushLimit) && repoRecentPushCount < repoPushLimit), '24h repo push budget is exhausted', { repoRecentPushCount, repoPushLimit });
  gate('push-cooldown', !liveLimited || cooldownRemainingMs === 0, `minor-auto push cooldown has ${cooldownRemainingMs}ms remaining`, { cooldownMs, lastPushAt: lastPushAt ? new Date(lastPushAt).toISOString() : null, cooldownRemainingMs });
  gate('circuit-breaker-closed', circuitBreaker.state !== 'open', `minor-auto circuit breaker is open: ${circuitBreaker.reason || 'operator review required'}`, { circuitBreaker });
  gate('post-push-observation-clear', !postPushStopReason, `previous minor-auto post-push observation requires stop: ${postPushStopReason}`, { lastMinorAutoPostPushObservation: state.lastMinorAutoPostPushObservation || null });
  gate('branch-allowlist', branchAllowlist.length > 0 && headBranch && branchAllowlist.includes(headBranch), `head branch ${headBranch || '(unknown)'} is not in automaticActions.minorAutoRepair.branchAllowlist`, { headBranch });
  gate('target-ownership-guard', !(target.headOwner && target.baseOwner && target.headOwner === target.baseOwner) || policy.allowMaintainerOwnedBranches === true, 'maintainer-owned head branches require automaticActions.minorAutoRepair.allowMaintainerOwnedBranches=true', { headOwner: target.headOwner || null, baseOwner: target.baseOwner || null });
  gate('path-allowlist-configured', pathAllowlist.length > 0, 'automaticActions.minorAutoRepair.pathAllowlist is required');
  gate('resolver-allowlist-configured', resolverAllowlist.length > 0, 'automaticActions.minorAutoRepair.resolverAllowlist is required');
  gate('dry-run-preview', !requireRecentRehearsal || rehearsalFreshForMinorAuto(target, state, pr, now, maxAgeMs), 'fresh dry-run/rehearsal evidence is required before minor-auto-safe repair', { zeroRehearsalSafe, maxAgeMs });
  if (fields.deferChangedPathGate === true && changedPaths.length === 0) {
    gate('changed-paths-within-allowlist', true, null, { deferred: true, pathAllowlist });
  } else {
    gate('changed-paths-present', changedPaths.length > 0, 'exact changed paths are required for minor-auto-safe repair');
    const outside = changedPaths.filter((path) => !pathMatchesAnyAllowlist(path, pathAllowlist));
    gate('changed-paths-within-allowlist', outside.length === 0, `changed paths outside automaticActions.minorAutoRepair.pathAllowlist: ${outside.join(', ')}`, { changedPaths, pathAllowlist, outside });
    const risky = changedPaths.map((path) => ({ path, reason: minorAutoPathRiskReason(path) })).filter((item) => item.reason);
    gate('changed-path-risk-class', risky.length === 0, `changed paths require approval: ${risky.map((item) => `${item.path} (${item.reason})`).join(', ')}`, { risky });
  }
  if (conflictEntries.length > 0) {
    const badResolvers = conflictEntries
      .filter((entry) => entry.tier !== 'autoSafe' || !resolverAllowlist.includes(entry.policy?.resolver))
      .map((entry) => ({ path: entry.path, tier: entry.tier, resolver: entry.policy?.resolver || null }));
    gate('resolver-identity-allowlist', badResolvers.length === 0, `conflict resolvers are not minor-auto-safe allowlisted: ${badResolvers.map((entry) => `${entry.path}:${entry.resolver || entry.tier}`).join(', ')}`, { badResolvers });
  }
  gate('contamination-guard', contamination.length === 0, `OpenClaw runtime/bootstrap context paths would enter branch diff or artifact evidence: ${contamination.join(', ')}`, { offendingPaths: contamination });

  const blockedReasons = [...new Set(reasons)];
  return redactLedgerValue({
    schema: 'pr-shepherd-minor-auto-repair-gate/v1',
    createdAt: new Date(now).toISOString(),
    lane: MINOR_AUTO_SAFE_REPAIR_SCOPE,
    rolloutMode,
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    gateAllowed: blockedReasons.length === 0,
    status: blockedReasons.length === 0 ? 'auto-repaired' : (policy.enabled === true ? 'blocked-risk' : 'blocked-needs-approval'),
    blockedReasons,
    gates,
    actionClass: blockedReasons.length === 0 ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    requiresOperatorApproval: blockedReasons.length > 0 || !liveLimited,
    pushAllowed: blockedReasons.length === 0 && liveLimited,
    dryRunAllowed: blockedReasons.length === 0 && dryRunMode,
    zeroRehearsalSafe,
    changedPaths,
    pathAllowlist,
    resolverAllowlist,
    rolloutControls: {
      mode: rolloutMode,
      liveLimited,
      dryRunMode,
      sandboxProofMode,
      circuitBreaker,
      cooldownMs: Number.isFinite(cooldownMs) ? cooldownMs : null,
      cooldownRemainingMs,
      repoPushLimit24h: repoPushLimit,
      repoRecentPushCount,
      postPushStopReason,
      noAutoMerge: true,
      noFixUntilGreenLoop: true,
    },
    verifyGate,
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      offendingRuntimeContextPaths: contamination,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    operatorSummary: blockedReasons.length === 0
      ? 'auto-repaired: bounded minor-auto-safe gates passed; push remains protected by expected-head force-with-lease'
      : `${policy.enabled === true ? 'blocked-risk' : 'blocked-needs-approval'}: ${blockedReasons.join('; ')}`,
    terminalLedgerMarker: blockedReasons.length === 0 ? 'Done' : 'Block',
  }, target);
}

export function focusedCheckExecutionPassed(fields = {}) {
  if (typeof fields.focusedChecksPassed === 'boolean') return fields.focusedChecksPassed;
  const result = fields.focusedCheckResult || fields.focusedChecksResult || null;
  if (result && typeof result === 'object') {
    if (typeof result.passed === 'boolean') return result.passed;
    if (typeof result.ok === 'boolean') return result.ok;
    if (Number.isInteger(Number(result.status))) return Number(result.status) === 0;
  }
  const results = Array.isArray(fields.focusedCheckResults) ? fields.focusedCheckResults : [];
  if (results.length > 0) {
    return results.every((item) => {
      if (item && typeof item === 'object') {
        if (typeof item.passed === 'boolean') return item.passed;
        if (typeof item.ok === 'boolean') return item.ok;
        if (Number.isInteger(Number(item.status))) return Number(item.status) === 0;
      }
      return item === true;
    });
  }
  return false;
}

/**
 * Execution contract for the Phase N minor-auto controller
 * (schema pr-shepherd-minor-auto-execution-controller/v1). Dispatch must read
 * executionAllowed/pushAllowed from this plan, never from raw PR state.
 * @typedef {object} MinorAutoExecutionController
 * @property {string} schema
 * @property {boolean} executionAllowed
 * @property {boolean} pushAllowed
 * @property {string[]} blockedReasons
 * @property {boolean} [dryRun]
 * @property {object} [plan]
 * @property {MinorAutoRepairGate} [gatePreview]
 * @property {string} [operatorSummary]
 */

/**
 * @param {object} [target]
 * @param {object} [pr]
 * @param {object} [state]
 * @param {object} [fields]
 * @returns {MinorAutoExecutionController}
 */
export function buildMinorAutoExecutionController(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const classification = fields.classification || classifyPr(pr || {});
  const baseOid = fields.baseOid || currentBaseOid(state, pr || {});
  const repairKey = fields.repairKey || repairPlanKey(pr || {}, baseOid);
  const plan = fields.plan || planAutomaticAction(target, state, pr, classification, {
    dryRun: false,
    now: now.getTime(),
    selectedTargetCount: fields.selectedTargetCount,
  });
  const changedPaths = [...new Set((fields.changedPaths || fields.branchDiffPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const artifactEvidencePaths = [...new Set((fields.artifactEvidencePaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const minorAutoRepairGate = fields.minorAutoRepairGate || buildMinorAutoRepairGate(target, state, { ...pr, baseRefOid: baseOid }, classification, {
    now,
    changedPaths,
    artifactEvidencePaths,
    conflictInfo: fields.conflictInfo,
    selectedTargetCount: fields.selectedTargetCount,
  });
  const expectedRemoteHeadOid = fields.expectedRemoteHeadOid || fields.expectedHeadOid || plan?.headRefOid || pr?.headRefOid || state.lastSeenHeadOid || null;
  const currentRemoteHeadOid = fields.currentRemoteHeadOid || fields.remoteHeadOid || fields.prePushRemoteHeadOid || fields.prePushHeadOid || null;
  const headBranch = target.headBranch || pr?.headRefName || plan?.headBranch || null;
  const rolloutMode = minorAutoRepairGate.rolloutMode || plan?.rolloutMode || minorAutoRolloutMode(minorAutoRepairPolicy(target));
  const liveLimited = rolloutMode === 'minor-auto-live-limited';
  const dryRunMode = rolloutMode === 'minor-auto-dry-run' || plan?.dryRun === true || fields.dryRun === true;
  const pushLimit = Number(target.autoPushLimit24h || 0);
  const recentPushCount = recentAutoPushes(state, now.getTime()).length;
  const verifyGate = buildVerifyGate(target);
  const focusedChecksPassed = focusedCheckExecutionPassed(fields);
  const contamination = findOpenClawRuntimeContextPaths([...changedPaths, ...artifactEvidencePaths]);

  const reasons = [];
  const gates = [];
  const gate = (name, ok, reason, details = {}) => {
    gates.push({ name, ok: Boolean(ok), reason: ok ? null : reason, ...details });
    if (!ok && reason) reasons.push(reason);
  };

  gate('plan-lane-minor-auto-safe-repair', plan?.lane === MINOR_AUTO_SAFE_REPAIR_SCOPE, `planned lane must be ${MINOR_AUTO_SAFE_REPAIR_SCOPE}`, { lane: plan?.lane || null });
  gate('plan-action-class-auto-safe-repair', plan?.actionClass === AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, 'planned actionClass must be auto-safe-repair', { actionClass: plan?.actionClass || null });
  gate('plan-allowed', plan?.allowed === true, `planned action is blocked: ${(plan?.reasons || []).join('; ') || 'policy denied'}`);
  gate('plan-push-contract', liveLimited
    ? plan?.pushAllowed === true && plan?.mutatesBranch === true && plan?.writesArtifact !== true && plan?.requiresOperatorApproval !== true
    : dryRunMode && plan?.pushAllowed !== true && plan?.mutatesBranch !== true && plan?.writesArtifact !== true && plan?.requiresOperatorApproval !== true,
    liveLimited
      ? 'minor-auto live execution requires pushAllowed=true, mutatesBranch=true, writesArtifact=false, and requiresOperatorApproval=false'
      : 'minor-auto dry-run rollout requires pushAllowed=false, mutatesBranch=false, writesArtifact=false, and requiresOperatorApproval=false', {
      rolloutMode,
      pushAllowed: Boolean(plan?.pushAllowed),
      mutatesBranch: Boolean(plan?.mutatesBranch),
      writesArtifact: Boolean(plan?.writesArtifact),
      requiresOperatorApproval: Boolean(plan?.requiresOperatorApproval),
    });
  gate('minor-auto-repair-gate', minorAutoRepairGate.gateAllowed === true, `minor-auto gate blocked: ${(minorAutoRepairGate.blockedReasons || []).join('; ') || 'gateAllowed is not true'}`, { minorAutoRepairGate });
  gate('focused-checks-passed', verifyGate.status !== 'missing' && focusedChecksPassed, focusedChecksPassed ? (verifyGate.reason || 'strict verify gate is missing') : 'focused checks must pass immediately before minor-auto push', { verifyGate, focusedChecksPassed });
  gate('push-budget', !liveLimited || (Number.isFinite(pushLimit) && pushLimit > 0 && recentPushCount < pushLimit), '24h push budget is exhausted or not configured', { recentPushCount, pushLimit });
  gate('circuit-breaker', state.lastRepairFailureKey !== repairKey, `repair already failed for current head/base state: ${repairKey}`, { repairKey });
  gate('pre-push-remote-head-present', !liveLimited || Boolean(currentRemoteHeadOid), 'fresh pre-push remote head is required before minor-auto push', { currentRemoteHeadOid });
  gate('expected-head-force-with-lease', !liveLimited || Boolean(headBranch && expectedRemoteHeadOid && currentRemoteHeadOid && currentRemoteHeadOid === expectedRemoteHeadOid),
    `pre-push remote head changed or is incomplete; refusing force-with-lease. expected ${expectedRemoteHeadOid || '(missing)'}, got ${currentRemoteHeadOid || '(missing)'}`, {
      headBranch,
      expectedRemoteHeadOid,
      currentRemoteHeadOid,
      forceWithLease: headBranch && expectedRemoteHeadOid ? `${headBranch}:${expectedRemoteHeadOid}` : null,
    });
  gate('contamination-guard', contamination.length === 0, `OpenClaw runtime/bootstrap context paths would enter branch diff or artifact evidence: ${contamination.join(', ')}`, { offendingPaths: contamination });

  const blockedReasons = [...new Set([...reasons, ...(minorAutoRepairGate.gateAllowed ? [] : minorAutoRepairGate.blockedReasons || [])])];
  const executionAllowed = blockedReasons.length === 0;
  return redactLedgerValue({
    schema: 'pr-shepherd-minor-auto-execution-controller/v1',
    createdAt: now.toISOString(),
    lane: MINOR_AUTO_SAFE_REPAIR_SCOPE,
    rolloutMode,
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    status: executionAllowed ? 'ready' : 'blocked',
    executionAllowed,
    actionClass: executionAllowed ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    pushAllowed: executionAllowed && liveLimited,
    mutatesBranch: executionAllowed && liveLimited,
    dryRun: executionAllowed && dryRunMode,
    writesArtifact: false,
    requiresOperatorApproval: false,
    productionMutation: executionAllowed && liveLimited,
    blockedReasons,
    gates,
    plan: explainAutomaticActionPlan(plan || {}),
    minorAutoRepairGate,
    expectedRefs: {
      headBranch,
      baseBranch: target.baseBranch || pr?.baseRefName || null,
      headRefOid: expectedRemoteHeadOid,
      baseRefOid: baseOid || null,
      repairKey,
    },
    rolloutControls: {
      mode: rolloutMode,
      liveLimited,
      dryRunMode,
      noAutoMerge: true,
      noFixUntilGreenLoop: true,
      noBroadAllLiveMutation: true,
      escalation: 'Seo Jin On approval required for major, risky, semantic, ops-impact, codeAssisted, or humanOnly changes',
    },
    pushGuard: {
      expectedRemoteHeadOid,
      currentRemoteHeadOid,
      forceWithLease: headBranch && expectedRemoteHeadOid ? `${headBranch}:${expectedRemoteHeadOid}` : null,
      remoteHeadFresh: Boolean(currentRemoteHeadOid && expectedRemoteHeadOid && currentRemoteHeadOid === expectedRemoteHeadOid),
    },
    focusedChecks: {
      verifyGate,
      passed: focusedChecksPassed,
      commands: verifyGate.commands || [],
    },
    pushBudget: {
      limit24h: Number.isFinite(pushLimit) ? pushLimit : null,
      used24h: recentPushCount,
      remaining24h: Number.isFinite(pushLimit) && pushLimit > 0 ? Math.max(0, pushLimit - recentPushCount) : 0,
    },
    circuitBreaker: {
      lastRepairFailureKey: state.lastRepairFailureKey || null,
      repairKey,
      blocked: state.lastRepairFailureKey === repairKey,
    },
    postActionAudit: {
      pushed: buildPostActionAuditEntry(target, { ...pr, baseRefOid: baseOid }, 'pushed', {
        state,
        repairKey,
        baseOid,
        beforeHeadOid: expectedRemoteHeadOid,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        operatorSummary: `${targetPrRef(target) || target.pr || 'target'} auto-repaired minor-auto-safe changes with force-with-lease; verify PR/CI state.`,
      }),
      block: buildPostActionAuditEntry(target, { ...pr, baseRefOid: baseOid }, 'block', {
        state,
        repairKey,
        baseOid,
        actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK,
        blockReason: blockedReasons.join('; ') || null,
        operatorSummary: `${targetPrRef(target) || target.pr || 'target'} minor-auto-safe repair blocked before push.`,
      }),
    },
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
    operatorSummary: executionAllowed
      ? (liveLimited
        ? 'minor-auto execution ready: exact path/resolver gates, focused checks, push budget, contamination guard, and expected-head force-with-lease passed'
        : 'minor-auto dry-run controller ready: exact gates and focused checks passed; push remains disabled')
      : `minor-auto execution blocked: ${blockedReasons.join('; ')}`,
    terminalLedgerMarker: executionAllowed ? 'Done' : 'Block',
  }, target);
}

export function executeMinorAutoExecutionController(controller = {}, handlers = {}, opts = {}) {
  if (controller.executionAllowed !== true) {
    const execution = automaticActionExecution({
      actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK,
      allowed: false,
      pushAllowed: false,
      mutatesBranch: false,
      writesArtifact: false,
      requiresOperatorApproval: false,
      reasons: controller.blockedReasons || ['minor-auto execution controller denied the action'],
    }, 'blocked', { result: controller });
    if (opts.throwOnBlocked === false) return execution;
    const err = /** @type {Error & { execution?: object }} */ (new Error(`minor-auto execution blocked: ${execution.reasons.join('; ')}`));
    err.execution = execution;
    throw err;
  }
  if (opts.dryRun || controller.dryRun === true || controller.pushAllowed !== true) {
    return automaticActionExecution({
      actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
      allowed: true,
      pushAllowed: false,
      mutatesBranch: false,
      writesArtifact: false,
      requiresOperatorApproval: false,
      reasons: [controller.operatorSummary || 'minor-auto dry-run execution ready'],
    }, 'planned', { dryRun: true, result: controller });
  }
  const handler = typeof handlers === 'function' ? handlers : handlers[AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR];
  if (!handler) return automaticActionExecution(controller.plan || { actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, allowed: true }, 'skipped', { result: controller });
  return automaticActionExecution(controller.plan || { actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, allowed: true }, 'executed', { result: handler(controller) });
}
