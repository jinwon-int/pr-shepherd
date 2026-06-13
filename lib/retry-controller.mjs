// @ts-check
// Phase Q (advanced automation level L4): bounded same-scope retry controller.
//
// This is NOT an open-ended "fix until green" loop. It is a constrained retry
// lane: default-off, a configured maximum of 1-2 attempts, restricted to the
// same target/branch/path/resolver/risk class, with a circuit breaker that
// opens (and routes to a human) on any drift, new file class, stale refs,
// reviewer objection, contamination, post-push instability, or budget
// exhaustion. Safe stopping is a valid, non-error outcome.
import { createHash } from 'node:crypto';
import {
  AUTOMATIC_ACTION_CLASSES,
  BOUNDED_RETRY_SCOPE,
  MAX_BOUNDED_RETRY_ATTEMPTS,
  MINOR_SAFE_RISK_CLASS,
  OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES,
  findOpenClawRuntimeContextPaths,
} from './policy.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { classifyPr } from './classify.mjs';
import { currentBaseOid, targetPrRef } from './approval.mjs';
import { normalizedRepoPath } from './conflicts.mjs';
import { buildPreMutationDecision, classifyChangedPathsRisk } from './decision.mjs';

export function boundedRetryPolicy(target = {}) {
  return target.automaticActions?.boundedRetry || {};
}

export function configuredMaxAttempts(policy = {}) {
  const value = Number(policy.maxAttempts);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_BOUNDED_RETRY_ATTEMPTS);
}

export function diffFingerprint(changedPaths = []) {
  const normalized = [...new Set(changedPaths.map(normalizedRepoPath).filter(Boolean))].sort();
  return `sha256:${createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 32)}`;
}

function scopeOf(changedPaths, resolvers, headBranch) {
  const paths = [...new Set(changedPaths.map(normalizedRepoPath).filter(Boolean))].sort();
  return {
    paths,
    resolvers: [...new Set(resolvers.map((item) => String(item || '').trim()).filter(Boolean))].sort(),
    riskClass: classifyChangedPathsRisk(paths).riskClass,
    headBranch: headBranch || null,
    fingerprint: diffFingerprint(paths),
  };
}

function sameArray(a = [], b = []) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function recordedRetryAttempts(state = {}) {
  return Array.isArray(state.boundedRetry?.attempts) ? state.boundedRetry.attempts : [];
}

/**
 * Append one recorded attempt to the bounded-retry state. Records attempt
 * number, scope, diff fingerprint, focused-check result, and timestamp.
 * @param {object} state
 * @param {object} [fields]
 * @param {Date|number|string} [now]
 * @returns {object} the appended attempt entry
 */
export function appendBoundedRetryAttempt(state, fields = {}, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const attempts = recordedRetryAttempts(state).slice();
  const scope = scopeOf(fields.changedPaths || [], fields.resolvers || (fields.resolver ? [fields.resolver] : []), fields.headBranch);
  const entry = {
    attempt: attempts.length + 1,
    at,
    scope,
    diffFingerprint: scope.fingerprint,
    focusedChecksPassed: fields.focusedChecksPassed === true,
  };
  state.boundedRetry = {
    ...(state.boundedRetry || {}),
    originalScope: state.boundedRetry?.originalScope || scope,
    attempts: [...attempts, entry],
  };
  return entry;
}

/**
 * Build the fail-closed Phase Q bounded retry controller report
 * (schema pr-shepherd-bounded-retry-controller/v1). Answers whether one more
 * bounded same-scope attempt may run now.
 * @param {object} [target]
 * @param {object} [pr]
 * @param {object} [state]
 * @param {object} [fields]
 * @returns {object}
 */
export function buildBoundedRetryController(target = {}, pr = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const policy = boundedRetryPolicy(target);
  const classification = fields.classification || classifyPr(pr || {});
  const maxAttempts = configuredMaxAttempts(policy);
  const budgetPerDay = policy.budgetPerDay === undefined ? null : Number(policy.budgetPerDay);
  const changedPaths = [...new Set((fields.changedPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const artifactEvidencePaths = [...new Set((fields.artifactEvidencePaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const resolvers = fields.resolvers || (fields.resolver ? [fields.resolver] : []);
  const headBranch = target.headBranch || pr?.headRefName || fields.headBranch || null;
  const currentScope = scopeOf(changedPaths, resolvers, headBranch);
  const recorded = recordedRetryAttempts(state);
  const originalScope = state.boundedRetry?.originalScope || (recorded[0]?.scope) || currentScope;
  const attemptsUsed = recorded.length;
  const attemptNumber = attemptsUsed + 1;
  const focusedChecksPassed = fields.focusedChecksPassed === true;
  const expectedHeadOid = fields.expectedHeadOid || state.lastSeenHeadOid || pr?.headRefOid || null;
  const currentHeadOid = fields.currentHeadOid || pr?.headRefOid || null;
  const expectedBaseOid = fields.expectedBaseOid || currentBaseOid(state, pr || {});
  const currentBase = fields.currentBaseOid || pr?.baseRefOid || null;
  const riskSignals = [...new Set((fields.riskSignals || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const contamination = findOpenClawRuntimeContextPaths([...changedPaths, ...artifactEvidencePaths]);

  // Config preconditions (a failure here is a block, not a retry).
  const configReasons = [];
  if (policy.enabled !== true) configReasons.push('automaticActions.boundedRetry.enabled is not true');
  if (policy.scope !== BOUNDED_RETRY_SCOPE) configReasons.push(`automaticActions.boundedRetry.scope must be ${BOUNDED_RETRY_SCOPE}`);
  if (maxAttempts === null) configReasons.push('automaticActions.boundedRetry.maxAttempts must be an integer between 1 and 2');
  if (budgetPerDay === null || !Number.isFinite(budgetPerDay) || budgetPerDay <= 0) configReasons.push('automaticActions.boundedRetry.budgetPerDay must be a positive number');

  // Circuit breaker (risk) conditions: any one opens the breaker and routes to a human.
  const breakerReasons = [];
  if (changedPaths.length > 0 && currentScope.riskClass !== MINOR_SAFE_RISK_CLASS) breakerReasons.push(`new file class / risky change introduced (risk class ${currentScope.riskClass})`);
  if (attemptsUsed > 0 && !sameArray(currentScope.paths, originalScope.paths)) breakerReasons.push('semantic/scope drift: changed path set differs from the original attempt');
  if (attemptsUsed > 0 && !sameArray(currentScope.resolvers, originalScope.resolvers)) breakerReasons.push('scope drift: resolver set differs from the original attempt');
  if (attemptsUsed > 0 && originalScope.riskClass && currentScope.riskClass && currentScope.riskClass !== originalScope.riskClass) breakerReasons.push('changed risk class from the original attempt');
  if (attemptsUsed > 0 && originalScope.headBranch && currentScope.headBranch && currentScope.headBranch !== originalScope.headBranch) breakerReasons.push('scope drift: head branch differs from the original attempt');
  if (expectedHeadOid && currentHeadOid && expectedHeadOid !== currentHeadOid) breakerReasons.push(`stale refs: head ${expectedHeadOid} no longer matches ${currentHeadOid}`);
  if (expectedBaseOid && currentBase && expectedBaseOid !== currentBase) breakerReasons.push(`stale refs: base ${expectedBaseOid} no longer matches ${currentBase}`);
  if (pr?.reviewDecision === 'CHANGES_REQUESTED') breakerReasons.push('reviewer objection: reviewDecision is CHANGES_REQUESTED');
  if (riskSignals.length > 0) breakerReasons.push(`risky label/comment/check signal: ${riskSignals.join(', ')}`);
  if (fields.postPushUnstable === true) breakerReasons.push('post-push instability observed');
  if (contamination.length > 0) breakerReasons.push(`evidence contamination: ${contamination.join(', ')}`);

  let status;
  let stopReason = null;
  let safeStop = false;
  const circuitOpen = configReasons.length === 0 && breakerReasons.length > 0;
  if (configReasons.length > 0) {
    status = 'blocked-config';
    stopReason = configReasons.join('; ');
  } else if (breakerReasons.length > 0) {
    status = 'circuit-open';
    stopReason = breakerReasons.join('; ');
  } else if (focusedChecksPassed) {
    status = 'stopped-safe';
    safeStop = true;
    stopReason = 'same-scope focused checks passed; no further retry needed';
  } else if (attemptsUsed >= /** @type {number} */ (maxAttempts)) {
    status = 'stopped-safe';
    safeStop = true;
    stopReason = `bounded retry budget exhausted after ${attemptsUsed}/${maxAttempts} attempt(s); route to human review`;
  } else {
    status = 'retry-allowed';
  }
  const retryAllowed = status === 'retry-allowed';
  const terminalLedgerMarker = (status === 'blocked-config' || status === 'circuit-open') ? 'Block' : 'Done';

  const decision = buildPreMutationDecision({
    eligible: retryAllowed,
    blockedReason: retryAllowed ? [] : [...configReasons, ...breakerReasons, ...(safeStop && stopReason ? [stopReason] : [])],
    provenance: { originalScope },
    riskClass: currentScope.riskClass,
    policyId: policy.policyId || null,
    expectedHead: expectedHeadOid,
    checksSnapshot: { focusedChecksPassed, failed: (classification?.checks?.failed || []).length, pending: (classification?.checks?.pending || []).length },
    auditPacketPath: fields.auditPacketPath || null,
  });

  return redactLedgerValue({
    schema: 'pr-shepherd-bounded-retry-controller/v1',
    createdAt: now.toISOString(),
    lane: BOUNDED_RETRY_SCOPE,
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    status,
    retryAllowed,
    safeStop,
    circuitBreaker: { open: circuitOpen, reasons: breakerReasons },
    stopReason,
    attemptNumber: retryAllowed ? attemptNumber : attemptsUsed,
    attemptsUsed,
    maxAttempts,
    attemptsRemaining: maxAttempts === null ? null : Math.max(0, maxAttempts - attemptsUsed),
    budgetPerDay,
    actionClass: retryAllowed ? AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR : AUTOMATIC_ACTION_CLASSES.BLOCK,
    decision,
    originalScope,
    currentScope,
    diffFingerprint: currentScope.fingerprint,
    attempts: recorded,
    blockedConfigReasons: configReasons,
    rolloutControls: {
      defaultOff: true,
      sameScopeOnly: true,
      maxAttemptsCap: MAX_BOUNDED_RETRY_ATTEMPTS,
      noOpenEndedLoop: true,
      routeToHumanOnCircuitOpen: true,
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
    operatorSummary: retryAllowed
      ? `bounded retry attempt ${attemptNumber}/${maxAttempts} permitted: same target/path/resolver/risk scope, fresh refs, no objection or contamination`
      : (safeStop ? `bounded retry stopped safely: ${stopReason}` : `bounded retry blocked: ${stopReason}`),
    terminalLedgerMarker,
  }, target);
}
