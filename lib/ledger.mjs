// @ts-check
// Redaction and the sanitized action ledger.
import { dirname } from 'node:path';
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_ACTION_LEDGER_LIMIT } from './policy.mjs';
import { isPlainObject } from './config.mjs';
import { liveRepairPolicy } from './approval.mjs';

export function redact(text) {
  return String(text ?? '')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(token|secret|password|authorization)([=:]\s*)[^\s]+/ig, '$1$2[REDACTED]');
}

export function configuredPrivatePathLabels(target = {}) {
  const privatePaths = Array.isArray(target.privatePaths)
    ? target.privatePaths.map((value, index) => [`<private-path-${index + 1}>`, value])
    : [];
  const candidates = [
    ['<worktree-root>', target.worktreePath],
    ['<state-file>', target.statePath],
    ['<state-root>', target.statePath && dirname(target.statePath)],
    ['<lock-file>', target.lockPath],
    ['<lock-root>', target.lockPath && dirname(target.lockPath)],
    ['<artifact-root>', target.artifactDir],
    ...privatePaths,
  ];
  return candidates
    .filter(([, value]) => typeof value === 'string' && value.trim().startsWith('/'))
    .sort((a, b) => b[1].length - a[1].length);
}

export function replaceAllLiteral(text, search, replacement) {
  return String(text).split(search).join(replacement);
}

export function redactForLedgerString(value, target = {}) {
  let out = redact(value)
    .replace(/https?:\/\/([^\/\s:@]+):([^@\s]+)@/ig, 'https://$1:[REDACTED]@');
  for (const [label, privatePath] of configuredPrivatePathLabels(target)) {
    out = replaceAllLiteral(out, privatePath, label);
  }
  return out;
}

export function redactLedgerValue(value, target = {}) {
  if (typeof value === 'string') return redactForLedgerString(value, target);
  if (Array.isArray(value)) return value.map((item) => redactLedgerValue(item, target));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, redactLedgerValue(item, target)]));
  }
  return value;
}

export function approvalMetadata(target = {}) {
  const policy = liveRepairPolicy(target);
  if (!policy.approvalId && !policy.approvedBy && !policy.approvedAt && !policy.scope) return null;
  return {
    id: policy.approvalId || null,
    approvedBy: policy.approvedBy || null,
    approvedAt: policy.approvedAt || null,
    scope: policy.scope || null,
  };
}

export function ledgerEntryId(entry) {
  return [
    entry.actionClass || 'action',
    entry.target || 'target',
    entry.repairKey || entry.conflictKey || entry.expectedHeadOid || 'no-ref',
    entry.result || 'recorded',
  ].join(':');
}

/**
 * @typedef {object} ActionLedgerApproval
 * @property {?string} id
 * @property {?string} approvedBy
 * @property {?string} approvedAt
 * @property {?string} scope
 */

/**
 * One sanitized, append-only action ledger entry.
 * @typedef {object} ActionLedgerEntry
 * @property {string} [id] Stable dedupe id; derived from class/target/refs when omitted.
 * @property {string} [schema]
 * @property {string} [at] ISO timestamp.
 * @property {?string} [target]
 * @property {?string} [pr]
 * @property {string} [actionClass]
 * @property {string} [result]
 * @property {?ActionLedgerApproval} [approval]
 * @property {?string} [expectedHeadOid]
 * @property {?string} [expectedBaseOid]
 * @property {?string} [repairKey]
 * @property {?string} [conflictKey]
 * @property {boolean} [pushAllowed]
 * @property {boolean} [mutatesBranch]
 * @property {boolean} [writesArtifact]
 * @property {boolean} [requiresOperatorApproval]
 * @property {string[]} [reasons]
 * @property {?string} [rollbackNote]
 * @property {?string} [disableNote]
 * @property {?object} [details]
 */

/**
 * @param {object} state Mutable target state; actionLedger is replaced, never appended in place.
 * @param {object} [target]
 * @param {ActionLedgerEntry} [entry]
 * @param {Date|number|string} [now]
 * @returns {boolean} false when an entry with the same id was already recorded.
 */
export function appendActionLedgerEntry(state, target = {}, entry = {}, now = new Date()) {
  const ledger = Array.isArray(state.actionLedger) ? state.actionLedger.slice() : [];
  /** @type {ActionLedgerEntry} */
  const baseEntry = {
    schema: 'pr-shepherd-action-ledger/v1',
    at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    target: target.id || entry.target || null,
    pr: target.pr || entry.pr || null,
    ...entry,
  };
  if (!baseEntry.id) baseEntry.id = ledgerEntryId(baseEntry);
  const sanitized = redactLedgerValue(baseEntry, target);
  if (ledger.some((item) => item?.id === sanitized.id)) {
    state.actionLedger = ledger;
    return false;
  }
  state.actionLedger = [...ledger, sanitized].slice(-DEFAULT_ACTION_LEDGER_LIMIT);
  return true;
}

export function appendPlanLedgerEntry(state, target, plan, result, fields = {}) {
  return appendActionLedgerEntry(state, target, {
    actionClass: plan?.actionClass || fields.actionClass || AUTOMATIC_ACTION_CLASSES.BLOCK,
    result,
    approval: approvalMetadata(target),
    expectedHeadOid: fields.expectedHeadOid || plan?.headRefOid || null,
    expectedBaseOid: fields.expectedBaseOid || plan?.baseRefOid || null,
    repairKey: fields.repairKey || null,
    conflictKey: fields.conflictKey || null,
    pushAllowed: Boolean(plan?.pushAllowed),
    mutatesBranch: Boolean(plan?.mutatesBranch),
    writesArtifact: Boolean(plan?.writesArtifact),
    requiresOperatorApproval: Boolean(plan?.requiresOperatorApproval),
    reasons: plan?.reasons || [],
    rollbackNote: fields.rollbackNote || null,
    disableNote: fields.disableNote || null,
    details: fields.details || null,
  }, fields.now || new Date());
}

export function summarizeActionLedger(ledger = [], limit = 3) {
  const entries = Array.isArray(ledger) ? ledger : [];
  return {
    count: entries.length,
    recent: entries.slice(-limit).map((entry) => ({
      at: entry.at || null,
      actionClass: entry.actionClass || null,
      result: entry.result || null,
      approvalId: entry.approval?.id || null,
      approvedBy: entry.approval?.approvedBy || null,
      scope: entry.approval?.scope || null,
      target: entry.target || null,
      expectedHeadOid: entry.expectedHeadOid || null,
      expectedBaseOid: entry.expectedBaseOid || null,
      repairKey: entry.repairKey || null,
      rollbackNote: entry.rollbackNote || null,
      disableNote: entry.disableNote || null,
    })),
  };
}
