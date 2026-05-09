#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PR_FIELDS = [
  'number', 'state', 'mergeable', 'mergeStateStatus', 'mergedAt', 'headRefOid',
  'headRefName', 'baseRefName', 'updatedAt', 'statusCheckRollup', 'reviewDecision', 'url'
];

export const OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];

export const DEFAULT_SITUATION_REPORT_EVERY_MS = 6 * 60 * 60 * 1000;
export const MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS = 60 * 60 * 1000;

export const AUTOMATIC_ACTION_CLASSES = Object.freeze({
  RECHECK: 'recheck',
  DIAGNOSE: 'diagnose',
  DIAGNOSE_ONLY: 'diagnose-only',
  NOTIFY_ESCALATE: 'notify-escalate',
  REPAIR_REHEARSAL: 'repair-rehearsal',
  CONFLICT_ARTIFACT: 'conflict-artifact',
  AUTO_SAFE_REPAIR: 'auto-safe-repair',
  BLOCK: 'block',
});

export const FLEET_TARGET_STATE_TIERS = Object.freeze([
  'check-only',
  'rehearsal-ready',
  'phase-d-ready',
  'live-approved-once',
]);

export const DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REPAIR_PLAN_HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_SUPERVISED_REHEARSAL_QUEUE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_ACTION_LEDGER_LIMIT = 50;
export const DEFAULT_OBSERVATION_LEDGER_LIMIT = 288; // 48h at a 10-minute standing-ops cadence.
export const DEFAULT_STRICT_VERIFY_REQUIRED = true;
export const DEFAULT_INCIDENT_BLOCK_THRESHOLD = 3;
export const PHASE_E_POST_ACTION_OUTCOMES = ['no-op', 'pushed', 'block'];
export const REVIEW_DECISION_OUTCOMES = Object.freeze([
  'accepted-for-rehearsal',
  'route-code-assisted',
  'human-only',
  'wait-recheck',
  'no-op-clean',
  'blocked-stale',
  'blocked-risk',
]);

const OBSERVATION_WARNING_KINDS = new Set(['dirty', 'failed', 'unknown']);
const OBSERVATION_SUMMARY_KINDS = ['clean', 'unstable', 'unknown', 'failed', 'dirty', 'merged', 'disabled'];

export function findOpenClawRuntimeContextPaths(paths = []) {
  const rootFiles = new Set(OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES);
  const offending = [];
  const seen = new Set();
  for (const rawPath of paths) {
    const path = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    if (rootFiles.has(path) || path === '.openclaw' || path.startsWith('.openclaw/')) {
      offending.push(path);
      seen.add(path);
    }
  }
  return offending.sort();
}

function assertNoOpenClawRuntimeContextPaths(paths, evidenceKind) {
  const offending = findOpenClawRuntimeContextPaths(paths);
  if (offending.length > 0) {
    throw new Error(`OpenClaw runtime/bootstrap context paths would enter ${evidenceKind}; refusing: ${offending.join(', ')}`);
  }
}

function usage(exitCode = 1) {
  console.error(`Usage:\n  node pr-shepherd.mjs validate --config config.json\n  node pr-shepherd.mjs status --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check-canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs diagnose --config config.json [--target id|owner/repo#number] [--all] [--artifact-dir path]\n  node pr-shepherd.mjs repair-plan --diagnose-bundle path [--output path]\n  node pr-shepherd.mjs decision-ledger --handoff path --decision outcome [--config config.json --target id|owner/repo#number | --pr-state path] [--state path] [--output path]\n  node pr-shepherd.mjs rehearsal-queue --feedback path [--config config.json --target id|owner/repo#number | --pr-state path] [--state path] [--output path]\n  node pr-shepherd.mjs rehearse --config config.json [--target id|owner/repo#number] [--all] [--artifact-dir path] [--no-keep-failed-rebase-worktree]\n  node pr-shepherd.mjs repair --config config.json [--target id|owner/repo#number] [--all] [--dry-run] [--artifact-dir path] [--allow-code-assisted-push] [--no-keep-failed-rebase-worktree]\n\nFor backward compatibility, omitting both --target and --all processes only the first configured target for status/check/check-canary/diagnose/repair/rehearse.`);
  process.exit(exitCode);
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !['validate', 'status', 'canary', 'check', 'check-canary', 'diagnose', 'repair-plan', 'decision-ledger', 'rehearsal-queue', 'repair', 'rehearse'].includes(cmd)) usage();
  const args = {
    cmd,
    dryRun: false,
    allowCodeAssistedPush: false,
    keepFailedRebaseWorktree: true,
    artifactDir: null,
    diagnoseBundle: null,
    handoff: null,
    feedback: null,
    prState: null,
    statePath: null,
    output: null,
    decision: null,
    operator: null,
    summary: null,
    nextOwner: null,
    workstream: null,
    queueName: null,
    priority: null,
    focusedChecks: [],
    riskFlags: [],
    targetSelectors: [],
    allTargets: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--config') args.config = requireValue(a, rest[++i]);
    else if (a === '--target') {
      const value = requireValue(a, rest[++i]);
      args.targetSelectors.push(...value.split(',').map((part) => part.trim()).filter(Boolean));
    } else if (a === '--all') args.allTargets = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-code-assisted-push') args.allowCodeAssistedPush = true;
    else if (a === '--keep-failed-rebase-worktree') args.keepFailedRebaseWorktree = true;
    else if (a === '--no-keep-failed-rebase-worktree') args.keepFailedRebaseWorktree = false;
    else if (a === '--artifact-dir') args.artifactDir = requireValue(a, rest[++i]);
    else if (a === '--diagnose-bundle') args.diagnoseBundle = requireValue(a, rest[++i]);
    else if (a === '--handoff' || a === '--repair-plan-handoff') args.handoff = requireValue(a, rest[++i]);
    else if (a === '--feedback' || a === '--review-feedback') args.feedback = requireValue(a, rest[++i]);
    else if (a === '--pr-state') args.prState = requireValue(a, rest[++i]);
    else if (a === '--state') args.statePath = requireValue(a, rest[++i]);
    else if (a === '--decision') args.decision = requireValue(a, rest[++i]);
    else if (a === '--operator' || a === '--reviewer') args.operator = requireValue(a, rest[++i]);
    else if (a === '--summary') args.summary = requireValue(a, rest[++i]);
    else if (a === '--next-owner') args.nextOwner = requireValue(a, rest[++i]);
    else if (a === '--workstream') args.workstream = requireValue(a, rest[++i]);
    else if (a === '--queue-name') args.queueName = requireValue(a, rest[++i]);
    else if (a === '--priority') args.priority = requireValue(a, rest[++i]);
    else if (a === '--focused-check') args.focusedChecks.push(requireValue(a, rest[++i]));
    else if (a === '--risk') args.riskFlags.push(requireValue(a, rest[++i]));
    else if (a === '--output') args.output = requireValue(a, rest[++i]);
    else if (a === '--help' || a === '-h') usage(0);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.cmd === 'repair-plan') {
    if (!args.diagnoseBundle) usage();
  } else if (args.cmd === 'decision-ledger') {
    if (!args.handoff || !args.decision) usage();
    if (args.allTargets) throw new Error('decision-ledger records one operator decision at a time; --all is not supported');
    if (!REVIEW_DECISION_OUTCOMES.includes(args.decision)) throw new Error(`--decision must be one of: ${REVIEW_DECISION_OUTCOMES.join(', ')}`);
  } else if (args.cmd === 'rehearsal-queue') {
    if (!args.feedback) usage();
    if (args.allTargets) throw new Error('rehearsal-queue records one supervised dry-run packet at a time; --all is not supported');
  } else if (!args.config) usage();
  if (args.cmd === 'rehearse') {
    args.dryRun = true;
    if (args.allowCodeAssistedPush) throw new Error('rehearse is dry-run only; --allow-code-assisted-push is not allowed');
  }
  if (args.allTargets && args.targetSelectors.length > 0) throw new Error('--all cannot be combined with --target');
  return args;
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnabledTarget(target) {
  return target?.enabled !== false;
}

function configPathPrefix(path, key) {
  return path ? `${path}.${key}` : key;
}

function normalizeConfigPath(baseDir, value) {
  return resolve(baseDir, String(value));
}

function validateRequiredString(errors, target, targetPath, field) {
  if (typeof target[field] !== 'string' || target[field].trim() === '') {
    errors.push(`${targetPath}.${field} is required`);
  }
}

function validatePositiveNumber(errors, target, targetPath, field) {
  if (target[field] !== undefined && (!Number.isFinite(Number(target[field])) || Number(target[field]) <= 0)) {
    errors.push(`${targetPath}.${field} must be a positive number`);
  }
}

function secretLookingValues(value, path = 'config', out = []) {
  if (typeof value === 'string') {
    const lowerPath = path.toLowerCase();
    const hasSecretKey = /(^|[.\[\]_-])(token|secret|password|authorization|credential|api[_-]?key)($|[.\[\]_-])/i.test(lowerPath);
    const looksLikeSecret = /gh[pousr]_[A-Za-z0-9_]{20,}/.test(value)
      || /https?:\/\/[^/\s:@]+:[^@\s]+@/i.test(value)
      || /x-access-token:/i.test(value)
      || (hasSecretKey && value.trim() !== '' && !/^(env:|\$\{|<|redacted|\[redacted\]|example|changeme)/i.test(value.trim()));
    if (looksLikeSecret) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretLookingValues(item, `${path}[${index}]`, out));
    return out;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) secretLookingValues(item, configPathPrefix(path, key), out);
  }
  return out;
}

function validateConflictPolicyPath(errors, entryPath, rawPath) {
  const path = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!path) {
    errors.push(`${entryPath} must not be empty`);
    return null;
  }
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('..')) {
    errors.push(`${entryPath} must be repo-relative and must not contain ..`);
  }
  const runtimeContextPaths = findOpenClawRuntimeContextPaths([path]);
  if (runtimeContextPaths.length > 0) {
    errors.push(`${entryPath} must not reference OpenClaw runtime/bootstrap context paths: ${runtimeContextPaths.join(', ')}`);
  }
  return path;
}

function validatePolicyEntry(errors, targetPath, tier, entry, index) {
  const entryPath = `${targetPath}.conflictPolicy.${tier}[${index}]`;
  if (typeof entry === 'string') {
    const path = validateConflictPolicyPath(errors, entryPath, entry);
    if (tier === 'autoSafe') errors.push(`${entryPath} must be an object with a deterministic resolver`);
    return path ? { path, entryPath, resolver: null } : null;
  }
  if (!isPlainObject(entry)) {
    errors.push(`${entryPath} must be a path string or object with path`);
    return null;
  }
  if (typeof entry.path !== 'string' || entry.path.trim() === '') {
    errors.push(`${entryPath}.path is required`);
    return null;
  }
  const path = validateConflictPolicyPath(errors, `${entryPath}.path`, entry.path);
  if (tier === 'autoSafe') {
    if (entry.resolver !== 'merge-changelog-top-entry') errors.push(`${entryPath}.resolver must be merge-changelog-top-entry for autoSafe entries`);
    if (entry.resolver === 'merge-changelog-top-entry' && typeof entry.needle !== 'string') errors.push(`${entryPath}.needle is required for merge-changelog-top-entry`);
  }
  return path ? { path, entryPath, resolver: entry.resolver || null } : null;
}

function validateConflictPolicy(errors, target, targetPath) {
  const policy = target.conflictPolicy;
  if (policy === undefined) return;
  if (!isPlainObject(policy)) {
    errors.push(`${targetPath}.conflictPolicy must be an object`);
    return;
  }
  const allowedTiers = ['autoSafe', 'codeAssisted', 'humanOnly'];
  for (const key of Object.keys(policy)) {
    if (!allowedTiers.includes(key)) errors.push(`${targetPath}.conflictPolicy.${key} is not a supported tier`);
  }
  const pathsByTier = new Map();
  for (const tier of allowedTiers) {
    if (policy[tier] === undefined) continue;
    if (!Array.isArray(policy[tier])) {
      errors.push(`${targetPath}.conflictPolicy.${tier} must be an array`);
      continue;
    }
    policy[tier].forEach((entry, index) => {
      const normalized = validatePolicyEntry(errors, targetPath, tier, entry, index);
      if (!normalized) return;
      const existing = pathsByTier.get(normalized.path) || [];
      existing.push({ tier, entryPath: normalized.entryPath });
      pathsByTier.set(normalized.path, existing);
    });
  }
  for (const [conflictPath, occurrences] of pathsByTier.entries()) {
    const tiers = [...new Set(occurrences.map((entry) => entry.tier))];
    if (tiers.length > 1) {
      errors.push(`${targetPath}.conflictPolicy duplicates ${conflictPath} across tiers: ${tiers.join(', ')}`);
    }
  }
}

export function isSafeDiagnosisHintCommand(command) {
  const value = String(command || '').trim();
  if (!value) return false;
  if (/[\n\r;&|<>`$\\]/.test(value)) return false;
  if (/\b(env|printenv|set|export|curl|wget|nc|scp|ssh|rsync)\b/i.test(value)) return false;
  if (/\b(rm|mv|cp|chmod|chown|touch|tee)\b/i.test(value)) return false;
  if (/\b(git\s+(push|checkout|switch|reset|rebase|merge|commit|clean|apply|am|cherry-pick))\b/i.test(value)) return false;
  if (/\b(npm|pnpm|yarn)\s+(install|add|remove|publish|version)\b/i.test(value)) return false;
  if (/\bgh\b.*\b(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i.test(value)) return false;
  if (/(^|\s)(\/(root|home|tmp|var|etc)\/|~\/)/.test(value)) return false;
  return /^(npm|pnpm|yarn)\s+(test|run)\b/.test(value)
    || /^node\s+(--check|--test)\b/.test(value)
    || /^git\s+(diff\s+--check|grep\b|show\s+--stat\b|log\s+--oneline\b)/.test(value);
}

function normalizeDiagnosisHintEntry(entry) {
  if (!isPlainObject(entry)) return null;
  return {
    path: typeof entry.path === 'string' ? entry.path.trim().replace(/\\/g, '/') : '',
    summary: typeof entry.summary === 'string' ? entry.summary.trim() : '',
    commands: Array.isArray(entry.commands) ? entry.commands.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
  };
}

function validateDiagnosisHints(errors, target, targetPath) {
  if (target.diagnosisHints === undefined) return;
  if (!Array.isArray(target.diagnosisHints)) {
    errors.push(`${targetPath}.diagnosisHints must be an array`);
    return;
  }
  target.diagnosisHints.forEach((entry, index) => {
    const entryPath = `${targetPath}.diagnosisHints[${index}]`;
    const normalized = normalizeDiagnosisHintEntry(entry);
    if (!normalized) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    validateConflictPolicyPath(errors, `${entryPath}.path`, normalized.path);
    if (entry.summary !== undefined && typeof entry.summary !== 'string') errors.push(`${entryPath}.summary must be a string`);
    if (entry.commands !== undefined && !Array.isArray(entry.commands)) errors.push(`${entryPath}.commands must be a string array`);
    normalized.commands.forEach((command, commandIndex) => {
      if (!isSafeDiagnosisHintCommand(command)) {
        errors.push(`${entryPath}.commands[${commandIndex}] is not an allowed diagnose-only hint command`);
      }
    });
  });
}

function validateLiveOpenClawActivation(errors, notify, targetPath) {
  const notifyPath = `${targetPath}.notify`;
  const cadenceMs = notify.situationReportEveryMs === undefined
    ? DEFAULT_SITUATION_REPORT_EVERY_MS
    : Number(notify.situationReportEveryMs);
  if (Number.isFinite(cadenceMs) && cadenceMs < MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS) {
    errors.push(`${notifyPath}.situationReportEveryMs must be at least ${MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS} when notify.mode is openclaw and dryRun is false; use canary for one-shot sends and keep live reports rate-limited`);
  }

  const activation = notify.liveActivation;
  if (!isPlainObject(activation)) {
    errors.push(`${notifyPath}.liveActivation is required when notify.mode is openclaw and dryRun is false`);
    return;
  }
  if (activation.scope !== 'check-only-reporting') {
    errors.push(`${notifyPath}.liveActivation.scope must be check-only-reporting`);
  }
  if (typeof activation.approvedAt !== 'string' || Number.isNaN(Date.parse(activation.approvedAt))) {
    errors.push(`${notifyPath}.liveActivation.approvedAt must be an ISO-8601 timestamp`);
  }
  if (typeof activation.approvedBy !== 'string' || activation.approvedBy.trim() === '') {
    errors.push(`${notifyPath}.liveActivation.approvedBy is required`);
  }
}

function validateObservationConfig(errors, target, targetPath) {
  if (target.observation === undefined) return;
  if (!isPlainObject(target.observation)) {
    errors.push(`${targetPath}.observation must be an object`);
    return;
  }
  if (target.observation.ledgerLimit !== undefined) {
    const limit = Number(target.observation.ledgerLimit);
    if (!Number.isInteger(limit) || limit <= 0) errors.push(`${targetPath}.observation.ledgerLimit must be a positive integer`);
  }
}

function validateAutomaticActions(errors, target, targetPath) {
  if (target.automaticActions === undefined) return;
  if (!isPlainObject(target.automaticActions)) {
    errors.push(`${targetPath}.automaticActions must be an object`);
    return;
  }
  const liveRepair = target.automaticActions.liveRepair;
  if (liveRepair === undefined) return;
  const livePath = `${targetPath}.automaticActions.liveRepair`;
  if (!isPlainObject(liveRepair)) {
    errors.push(`${livePath} must be an object`);
    return;
  }
  if (liveRepair.enabled !== undefined && typeof liveRepair.enabled !== 'boolean') errors.push(`${livePath}.enabled must be a boolean`);
  if (liveRepair.scope !== undefined && liveRepair.scope !== 'auto-safe-repair') errors.push(`${livePath}.scope must be auto-safe-repair`);
  if (liveRepair.enabled === true) {
    if (liveRepair.scope !== 'auto-safe-repair') errors.push(`${livePath}.scope must be auto-safe-repair when enabled`);
    if (typeof liveRepair.approvalId !== 'string' || liveRepair.approvalId.trim() === '') errors.push(`${livePath}.approvalId is required when enabled`);
    if (typeof liveRepair.approvedAt !== 'string' || Number.isNaN(Date.parse(liveRepair.approvedAt))) errors.push(`${livePath}.approvedAt must be an ISO-8601 timestamp when enabled`);
    if (typeof liveRepair.expiresAt !== 'string' || Number.isNaN(Date.parse(liveRepair.expiresAt))) errors.push(`${livePath}.expiresAt must be an ISO-8601 timestamp when enabled`);
    if (typeof liveRepair.approvedBy !== 'string' || liveRepair.approvedBy.trim() === '') errors.push(`${livePath}.approvedBy is required when enabled`);
    if (!Array.isArray(liveRepair.branchAllowlist) || liveRepair.branchAllowlist.length === 0 || !liveRepair.branchAllowlist.every((item) => typeof item === 'string' && item.trim() !== '')) {
      errors.push(`${livePath}.branchAllowlist must be a non-empty string array when enabled`);
    }
  }
  if (liveRepair.approvalId !== undefined && (typeof liveRepair.approvalId !== 'string' || liveRepair.approvalId.trim() === '')) errors.push(`${livePath}.approvalId must be a non-empty string`);
  if (liveRepair.approvedAt !== undefined && (typeof liveRepair.approvedAt !== 'string' || Number.isNaN(Date.parse(liveRepair.approvedAt)))) errors.push(`${livePath}.approvedAt must be an ISO-8601 timestamp`);
  if (liveRepair.expiresAt !== undefined && (typeof liveRepair.expiresAt !== 'string' || Number.isNaN(Date.parse(liveRepair.expiresAt)))) errors.push(`${livePath}.expiresAt must be an ISO-8601 timestamp`);
  if (liveRepair.approvedBy !== undefined && (typeof liveRepair.approvedBy !== 'string' || liveRepair.approvedBy.trim() === '')) errors.push(`${livePath}.approvedBy must be a non-empty string`);
  if (liveRepair.branchAllowlist !== undefined && (!Array.isArray(liveRepair.branchAllowlist) || !liveRepair.branchAllowlist.every((item) => typeof item === 'string' && item.trim() !== ''))) {
    errors.push(`${livePath}.branchAllowlist must be a string array`);
  }
  if (liveRepair.requireRecentRehearsal !== undefined && typeof liveRepair.requireRecentRehearsal !== 'boolean') errors.push(`${livePath}.requireRecentRehearsal must be a boolean`);
  if (liveRepair.rehearsalMaxAgeMs !== undefined && (!Number.isFinite(Number(liveRepair.rehearsalMaxAgeMs)) || Number(liveRepair.rehearsalMaxAgeMs) <= 0)) errors.push(`${livePath}.rehearsalMaxAgeMs must be a positive number`);
  if (liveRepair.strictVerifyRequired !== undefined && typeof liveRepair.strictVerifyRequired !== 'boolean') errors.push(`${livePath}.strictVerifyRequired must be a boolean`);
  if (liveRepair.allowMaintainerOwnedBranches !== undefined && typeof liveRepair.allowMaintainerOwnedBranches !== 'boolean') errors.push(`${livePath}.allowMaintainerOwnedBranches must be a boolean`);
}

function validateMultiTargetLiveRepair(errors, cfg) {
  const approval = cfg?.automaticActions?.multiTargetLiveRepair;
  if (approval === undefined) return;
  const approvalPath = 'config.automaticActions.multiTargetLiveRepair';
  if (!isPlainObject(approval)) {
    errors.push(`${approvalPath} must be an object`);
    return;
  }
  if (approval.enabled !== undefined && typeof approval.enabled !== 'boolean') errors.push(`${approvalPath}.enabled must be a boolean`);
  if (approval.scope !== undefined && approval.scope !== 'multi-target-auto-safe-repair') errors.push(`${approvalPath}.scope must be multi-target-auto-safe-repair`);
  if (approval.enabled === true) {
    if (approval.scope !== 'multi-target-auto-safe-repair') errors.push(`${approvalPath}.scope must be multi-target-auto-safe-repair when enabled`);
    if (typeof approval.approvalId !== 'string' || approval.approvalId.trim() === '') errors.push(`${approvalPath}.approvalId is required when enabled`);
    if (typeof approval.approvedAt !== 'string' || Number.isNaN(Date.parse(approval.approvedAt))) errors.push(`${approvalPath}.approvedAt must be an ISO-8601 timestamp when enabled`);
    if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') errors.push(`${approvalPath}.approvedBy is required when enabled`);
    if (!Array.isArray(approval.targetIds) || approval.targetIds.map((item) => String(item).trim()).filter(Boolean).length === 0) {
      errors.push(`${approvalPath}.targetIds must be a non-empty string array when enabled`);
    }
  }
  if (approval.approvalId !== undefined && (typeof approval.approvalId !== 'string' || approval.approvalId.trim() === '')) errors.push(`${approvalPath}.approvalId must be a non-empty string`);
  if (approval.approvedAt !== undefined && (typeof approval.approvedAt !== 'string' || Number.isNaN(Date.parse(approval.approvedAt)))) errors.push(`${approvalPath}.approvedAt must be an ISO-8601 timestamp`);
  if (approval.approvedBy !== undefined && (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '')) errors.push(`${approvalPath}.approvedBy must be a non-empty string`);
  if (approval.targetIds !== undefined && (!Array.isArray(approval.targetIds) || approval.targetIds.some((item) => typeof item !== 'string' || item.trim() === ''))) {
    errors.push(`${approvalPath}.targetIds must be a string array`);
  }
}

export function validateConfigObject(cfg, configPath = null) {
  const errors = [];
  const warnings = [];
  const configDir = configPath ? dirname(resolve(configPath)) : process.cwd();
  if (!isPlainObject(cfg) || !Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    errors.push('config must contain non-empty targets[]');
    return { ok: false, errors, warnings };
  }
  validateMultiTargetLiveRepair(errors, cfg);

  const ids = new Map();
  const enabledStatePaths = new Map();
  const enabledLockPaths = new Map();
  cfg.targets.forEach((target, index) => {
    const targetPath = `targets[${index}]`;
    if (!isPlainObject(target)) {
      errors.push(`${targetPath} must be an object`);
      return;
    }
    if (typeof target.id !== 'string' || target.id.trim() === '') errors.push(`${targetPath}.id is required`);
    else {
      const existing = ids.get(target.id) || [];
      existing.push(targetPath);
      ids.set(target.id, existing);
    }

    const parsed = parsePrRef(target.pr);
    if (!target.owner && !parsed?.owner) errors.push(`${targetPath}.owner is required`);
    if (!target.repo && !parsed?.repo) errors.push(`${targetPath}.repo is required`);
    const number = Number(target.number || parsed?.number);
    if (!Number.isInteger(number) || number <= 0) errors.push(`${targetPath}.number is required and must be a positive integer`);

    if (isEnabledTarget(target)) {
      validateRequiredString(errors, target, targetPath, 'headBranch');
      validateRequiredString(errors, target, targetPath, 'baseBranch');
      validateRequiredString(errors, target, targetPath, 'worktreePath');
      validateRequiredString(errors, target, targetPath, 'statePath');
      validateRequiredString(errors, target, targetPath, 'lockPath');
      if (typeof target.statePath === 'string' && target.statePath.trim()) {
        const key = normalizeConfigPath(configDir, target.statePath);
        const existing = enabledStatePaths.get(key) || [];
        existing.push(targetPath);
        enabledStatePaths.set(key, existing);
      }
      if (typeof target.lockPath === 'string' && target.lockPath.trim()) {
        const key = normalizeConfigPath(configDir, target.lockPath);
        const existing = enabledLockPaths.get(key) || [];
        existing.push(targetPath);
        enabledLockPaths.set(key, existing);
      }
    }

    validatePositiveNumber(errors, target, targetPath, 'autoPushLimit24h');
    validateConflictPolicy(errors, target, targetPath);
    validateDiagnosisHints(errors, target, targetPath);
    validateObservationConfig(errors, target, targetPath);
    validateAutomaticActions(errors, target, targetPath);

    if (target.notify !== undefined) {
      if (!isPlainObject(target.notify)) errors.push(`${targetPath}.notify must be an object`);
      else {
        const notifyMode = target.notify.mode;
        const hasCommand = Array.isArray(target.notify.command)
          && target.notify.command.length > 0
          && target.notify.command.every((item) => typeof item === 'string' && item.length > 0);
        if (notifyMode !== undefined && !['stdout', 'none', 'command', 'openclaw'].includes(notifyMode)) errors.push(`${targetPath}.notify.mode must be stdout, none, command, or openclaw`);
        if (target.notify.command !== undefined && !hasCommand) errors.push(`${targetPath}.notify.command must be a non-empty string array`);
        if (notifyMode === 'command' && !hasCommand) errors.push(`${targetPath}.notify.command must be a non-empty string array`);
        if (target.notify.situationReportEveryMs !== undefined
          && (!Number.isFinite(Number(target.notify.situationReportEveryMs)) || Number(target.notify.situationReportEveryMs) < 0)) {
          errors.push(`${targetPath}.notify.situationReportEveryMs must be a non-negative number`);
        }
        if (notifyMode === 'openclaw') {
          if (target.notify.dryRun !== undefined && typeof target.notify.dryRun !== 'boolean') errors.push(`${targetPath}.notify.dryRun must be a boolean`);
          if (target.notify.dryRun === false && !hasCommand) errors.push(`${targetPath}.notify.command is required when notify.mode is openclaw and dryRun is false`);
          if (target.notify.dryRun === false) validateLiveOpenClawActivation(errors, target.notify, targetPath);
          for (const forbidden of ['token', 'botToken', 'gatewayToken', 'chatId', 'chatID', 'chat', 'to']) {
            if (target.notify[forbidden] !== undefined) errors.push(`${targetPath}.notify.${forbidden} must not be stored in config; keep OpenClaw/Telegram routing and credentials in the operator environment`);
          }
        }
      }
    }
  });

  for (const [id, occurrences] of ids.entries()) {
    if (occurrences.length > 1) errors.push(`duplicate target id ${id}: ${occurrences.join(', ')}`);
  }
  for (const [statePath, occurrences] of enabledStatePaths.entries()) {
    if (occurrences.length > 1) errors.push(`duplicate enabled target statePath ${statePath}: ${occurrences.join(', ')}`);
  }
  for (const [lockPath, occurrences] of enabledLockPaths.entries()) {
    if (occurrences.length > 1) errors.push(`duplicate enabled target lockPath ${lockPath}: ${occurrences.join(', ')}`);
  }

  const secretPaths = secretLookingValues(cfg);
  for (const path of secretPaths) errors.push(`secret-looking value in ${path}; use environment/auth tooling instead of config`);

  return { ok: errors.length === 0, errors, warnings };
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function redact(text) {
  return String(text ?? '')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(token|secret|password|authorization)([=:]\s*)[^\s]+/ig, '$1$2[REDACTED]');
}

function configuredPrivatePathLabels(target = {}) {
  const candidates = [
    ['<worktree-root>', target.worktreePath],
    ['<state-file>', target.statePath],
    ['<state-root>', target.statePath && dirname(target.statePath)],
    ['<lock-file>', target.lockPath],
    ['<lock-root>', target.lockPath && dirname(target.lockPath)],
    ['<artifact-root>', target.artifactDir],
  ];
  return candidates
    .filter(([, value]) => typeof value === 'string' && value.trim().startsWith('/'))
    .sort((a, b) => b[1].length - a[1].length);
}

function replaceAllLiteral(text, search, replacement) {
  return String(text).split(search).join(replacement);
}

function redactForLedgerString(value, target = {}) {
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

function approvalMetadata(target = {}) {
  const policy = liveRepairPolicy(target);
  if (!policy.approvalId && !policy.approvedBy && !policy.approvedAt && !policy.scope) return null;
  return {
    id: policy.approvalId || null,
    approvedBy: policy.approvedBy || null,
    approvedAt: policy.approvedAt || null,
    scope: policy.scope || null,
  };
}

function ledgerEntryId(entry) {
  return [
    entry.actionClass || 'action',
    entry.target || 'target',
    entry.repairKey || entry.conflictKey || entry.expectedHeadOid || 'no-ref',
    entry.result || 'recorded',
  ].join(':');
}

export function appendActionLedgerEntry(state, target = {}, entry = {}, now = new Date()) {
  const ledger = Array.isArray(state.actionLedger) ? state.actionLedger.slice() : [];
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

function appendPlanLedgerEntry(state, target, plan, result, fields = {}) {
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

function normalizedDecisionOutcome(outcome) {
  const value = String(outcome || '').trim();
  if (!REVIEW_DECISION_OUTCOMES.includes(value)) {
    throw new Error(`unsupported review decision outcome: ${value || '(empty)'}`);
  }
  return value;
}

function compactStrings(items = []) {
  return [...new Set((Array.isArray(items) ? items : [items])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function currentRefState(currentPr = {}, state = {}) {
  return {
    headRefOid: currentPr?.headRefOid || state.lastSeenHeadOid || null,
    baseRefOid: currentPr?.baseRefOid || state.lastSeenBaseOid || null,
    mergeable: currentPr?.mergeable || state.lastMergeable || null,
    mergeStateStatus: currentPr?.mergeStateStatus || state.lastMergeStateStatus || null,
    reviewDecision: currentPr?.reviewDecision || state.lastReviewDecision || null,
  };
}

function handoffPrState(handoff = {}) {
  return handoff.prState || handoff.evidence?.prState || handoff.source?.prState || {};
}

function checkCountFromHandoff(checks = {}, key) {
  const countKey = `${key}Count`;
  if (Number.isInteger(checks[countKey])) return checks[countKey];
  if (Array.isArray(checks[key])) return checks[key].length;
  return null;
}

function handoffFocusedChecks(handoff = {}) {
  const artifactHints = Array.isArray(handoff.reviewArtifacts)
    ? handoff.reviewArtifacts.flatMap((artifact) => artifact?.focusedCommandHints || [])
    : [];
  return compactStrings([
    ...(handoff.focusedCommandHints || []),
    ...(handoff.evidence?.focusedCommandHints || []),
    ...artifactHints,
  ]);
}

function staleReviewEvidenceReasons(handoff = {}, currentPr = {}, state = {}, classification = {}) {
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

function handoffAllowsOutcome(handoff = {}, outcome, classification = {}, currentPr = {}) {
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

function reviewDecisionRiskFlags(currentPr = {}, outcome) {
  const reviewDecision = String(currentPr?.reviewDecision || '').toUpperCase();
  const flags = [];
  if (reviewDecision === 'CHANGES_REQUESTED') flags.push('github-review-changes-requested');
  if (reviewDecision === 'REVIEW_REQUIRED') flags.push('github-review-required');
  if (reviewDecision === 'APPROVED' && ['route-code-assisted', 'human-only', 'blocked-risk'].includes(outcome)) flags.push('github-approved-but-operator-review-still-required');
  return flags;
}

function decisionIdForFeedback(feedback = {}) {
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

function feedbackAgeReasons(feedback = {}, now, maxAgeMs) {
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

function rehearsalQueueRefReasons(feedback = {}, currentPr = {}, state = {}) {
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

function rehearsalQueueId(packet = {}) {
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

function emptyObservationWindowSummary() {
  return {
    total: 0,
    byKind: Object.fromEntries(OBSERVATION_SUMMARY_KINDS.map((kind) => [kind, 0])),
    byActionClass: {},
    recheckSuggested: 0,
    warnings: 0,
    failedChecksMax: 0,
    pendingChecksMax: 0,
  };
}

function summarizeObservationWindow(entries) {
  const summary = emptyObservationWindowSummary();
  for (const entry of entries) {
    const kind = OBSERVATION_SUMMARY_KINDS.includes(entry?.kind) ? entry.kind : 'unknown';
    const actionClass = entry?.actionClass || null;
    summary.total += 1;
    summary.byKind[kind] = (summary.byKind[kind] || 0) + 1;
    if (actionClass) summary.byActionClass[actionClass] = (summary.byActionClass[actionClass] || 0) + 1;
    if (actionClass === AUTOMATIC_ACTION_CLASSES.RECHECK) summary.recheckSuggested += 1;
    if (OBSERVATION_WARNING_KINDS.has(kind)) summary.warnings += 1;
    summary.failedChecksMax = Math.max(summary.failedChecksMax, Number(entry?.failedCount || 0));
    summary.pendingChecksMax = Math.max(summary.pendingChecksMax, Number(entry?.pendingCount || 0));
  }
  return summary;
}

export function summarizeObservationLedger(ledger = [], now = new Date()) {
  const entries = Array.isArray(ledger) ? ledger : [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const finiteNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const withTime = entries
    .map((entry) => ({ entry, atMs: Date.parse(entry?.at || '') }))
    .filter(({ atMs }) => Number.isFinite(atMs));
  const last24Timed = withTime.filter(({ atMs }) => finiteNowMs - atMs <= 24 * 60 * 60 * 1000);
  const last48Timed = withTime.filter(({ atMs }) => finiteNowMs - atMs <= 48 * 60 * 60 * 1000);
  const last24h = last24Timed.map(({ entry }) => entry);
  const last48h = last48Timed.map(({ entry }) => entry);
  const last = withTime.length > 0 ? withTime[withTime.length - 1].entry : null;
  const lastClean = [...last48Timed].reverse().find(({ entry }) => entry?.kind === 'clean')?.entry || null;
  const lastWarning = [...last48Timed].reverse().find(({ entry }) => OBSERVATION_WARNING_KINDS.has(entry?.kind))?.entry || null;
  return {
    schema: 'pr-shepherd-observation-summary/v1',
    entries: entries.length,
    lastRunAt: last?.at || null,
    lastCleanAt: lastClean?.at || null,
    lastWarningAt: lastWarning?.at || null,
    lastWarningKind: lastWarning?.kind || null,
    last24h: summarizeObservationWindow(last24h),
    last48h: summarizeObservationWindow(last48h),
  };
}

function observationLedgerLimit(target = {}) {
  const limit = Number(target.observation?.ledgerLimit ?? DEFAULT_OBSERVATION_LEDGER_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_OBSERVATION_LEDGER_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function buildObservationEntry(pr, classification, plannedAction, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    schema: 'pr-shepherd-observation/v1',
    at,
    kind: classification?.kind || 'unknown',
    actionClass: plannedAction?.actionClass || null,
    headRefOid: pr?.headRefOid || null,
    baseRefOid: pr?.baseRefOid || null,
    mergeable: pr?.mergeable || null,
    mergeStateStatus: pr?.mergeStateStatus || null,
    reviewDecision: pr?.reviewDecision || null,
    failedCount: classification?.checks?.failed?.length || 0,
    pendingCount: classification?.checks?.pending?.length || 0,
  };
}

function observationDoctorWarnings(summary) {
  const warnings = [];
  const h48 = summary?.last48h || emptyObservationWindowSummary();
  if (h48.byKind.unknown >= 3) warnings.push(`unknown observed ${h48.byKind.unknown} times in 48h; keep check-only and recheck GitHub mergeability before Phase C`);
  if (h48.byKind.failed > 0) warnings.push(`failed checks observed ${h48.byKind.failed} times in 48h; operator review required before rehearsal`);
  if (h48.byKind.dirty > 0) warnings.push(`dirty/conflicting observed ${h48.byKind.dirty} times in 48h; run one-shot rehearsal only after operator approval`);
  if (h48.total >= 3 && h48.byKind.clean === 0) warnings.push('no clean observation in the last 48h sample; do not advance to Phase C');
  return warnings;
}

function nextRecommendedAction(target, state = {}) {
  if (state.disabled) return 'none — target disabled';
  const currentKind = state.lastKind;
  const hasDoctorWarnings = Array.isArray(state.lastDoctorWarnings) && state.lastDoctorWarnings.length > 0;
  if (currentKind === 'clean' && hasDoctorWarnings) return 'continue check-only observation; review doctor warnings before Phase C rehearsal';
  if (currentKind === 'clean') return 'continue check-only observation until 24-48h stable, then consider Phase C rehearsal criteria';
  const kind = currentKind || state.lastWarningKind;
  if (kind === 'dirty') return 'run one-shot dry-run/rehearsal, then require operator approval before any repair push';
  if (kind === 'failed') return 'operator review failed checks; keep branch mutation disabled';
  if (kind === 'unknown') return 'recheck GitHub PR state; keep observing until mergeability is stable';
  if (kind === 'unstable') return 'watch pending checks; avoid duplicate no-action reports until cadence is due';
  return nextActionForClassification({ kind: state.lastKind || 'unknown', checks: { failed: [], pending: [] } });
}

function recordObservation(state, target, pr, classification, plannedAction, now = new Date()) {
  const entry = buildObservationEntry(pr, classification, plannedAction, now);
  const existing = Array.isArray(state.observationLedger) ? state.observationLedger : [];
  state.observationLedger = [...existing, entry].slice(-observationLedgerLimit(target));
  const summary = summarizeObservationLedger(state.observationLedger, now);
  state.observationSummary = summary;
  state.lastObservationAt = entry.at;
  if (entry.kind === 'clean') state.lastCleanAt = entry.at;
  if (OBSERVATION_WARNING_KINDS.has(entry.kind)) {
    state.lastWarningAt = entry.at;
    state.lastWarningKind = entry.kind;
  }
  state.lastDoctorWarnings = observationDoctorWarnings(summary);
  state.nextRecommendedAction = nextRecommendedAction(target, state);
  return entry;
}

function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    shell: opts.shell || false,
    maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0 && !opts.allowFailure) {
    const printable = opts.shell ? cmd : [cmd, ...args].join(' ');
    throw new Error(`Command failed (${res.status}): ${printable}\n${redact(out).slice(-8000)}`);
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', output: out };
}

function runShell(command, cwd, opts = {}) {
  return run(command, [], { ...opts, cwd, shell: true });
}

function acquireLock(lockPath, staleLockMs) {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return () => { try { unlinkSync(lockPath); } catch {} };
  } catch (err) {
    if (existsSync(lockPath) && staleLockMs > 0) {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > staleLockMs) {
        unlinkSync(lockPath);
        return acquireLock(lockPath, staleLockMs);
      }
    }
    throw new Error(`Lock already held: ${lockPath}`);
  }
}

function defaultState(target) {
  return {
    pr: target.pr,
    headBranch: target.headBranch,
    lastSeenHeadOid: null,
    lastSeenBaseOid: null,
    lastMergeable: null,
    lastMergeStateStatus: null,
    lastReviewDecision: null,
    lastFailureNames: [],
    lastPendingCount: 0,
    lastNotificationKey: null,
    autoPushes: [],
    lastRunAt: null,
    lastOkAt: null,
    disabled: false,
  };
}

function parsePrRef(value) {
  const match = String(value || '').match(/^([^/\s#]+)\/([^\s#]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), pr: `${match[1]}/${match[2]}#${match[3]}` };
}

function normalizeTarget(target, index) {
  const parsed = parsePrRef(target.pr);
  const owner = target.owner || parsed?.owner;
  const repo = target.repo || parsed?.repo;
  const number = Number(target.number || parsed?.number);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    throw new Error(`targets[${index}] must define owner, repo, and number (or pr as owner/repo#number)`);
  }
  const pr = target.pr || `${owner}/${repo}#${number}`;
  return {
    ...target,
    id: target.id || `${owner}-${repo}-${number}`,
    owner,
    repo,
    number,
    pr,
    url: target.url || `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function loadConfig(path) {
  const cfg = loadJson(resolve(path), null);
  const validation = validateConfigObject(cfg, path);
  if (!validation.ok) throw new Error(`config validation failed:\n${validation.errors.join('\n')}`);
  const targets = cfg.targets.map(normalizeTarget);
  return { ...cfg, targets };
}

function selectorAliases(target) {
  return new Set([
    target.id,
    target.pr,
    `${target.owner}/${target.repo}#${target.number}`,
    target.url,
    String(target.number),
  ].filter(Boolean).map(String));
}

export function selectTargets(cfg, selectors = [], allTargets = false) {
  if (allTargets && selectors.length > 0) throw new Error('--all cannot be combined with --target');
  if (allTargets) return cfg.targets.slice();
  if (selectors.length === 0) return cfg.targets.slice(0, 1);

  const selected = [];
  for (const selector of selectors) {
    const matches = cfg.targets.filter((target) => selectorAliases(target).has(String(selector)));
    if (matches.length === 0) throw new Error(`target not found: ${selector}`);
    if (matches.length > 1) throw new Error(`ambiguous target selector ${selector}; use target id or owner/repo#number`);
    if (!selected.some((target) => target.id === matches[0].id)) selected.push(matches[0]);
  }
  return selected;
}

export function multiTargetLiveRepairGateFailures(cfg, targets, args = {}) {
  if (args.cmd !== 'repair' || args.dryRun || targets.length <= 1) return [];
  const approval = cfg?.automaticActions?.multiTargetLiveRepair || {};
  const failures = [];
  if (approval.enabled !== true) failures.push('config.automaticActions.multiTargetLiveRepair.enabled is not true');
  if (approval.scope !== 'multi-target-auto-safe-repair') failures.push('config.automaticActions.multiTargetLiveRepair.scope must be multi-target-auto-safe-repair');
  if (typeof approval.approvalId !== 'string' || approval.approvalId.trim() === '') failures.push('config.automaticActions.multiTargetLiveRepair.approvalId is required');
  if (typeof approval.approvedAt !== 'string' || Number.isNaN(Date.parse(approval.approvedAt))) failures.push('config.automaticActions.multiTargetLiveRepair.approvedAt is missing or invalid');
  if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') failures.push('config.automaticActions.multiTargetLiveRepair.approvedBy is required');
  const approvedTargetIds = new Set(Array.isArray(approval.targetIds) ? approval.targetIds.map((item) => String(item).trim()).filter(Boolean) : []);
  const missingTargetIds = targets.map((target) => target.id).filter((id) => !approvedTargetIds.has(id));
  if (missingTargetIds.length > 0) failures.push(`config.automaticActions.multiTargetLiveRepair.targetIds missing selected target(s): ${missingTargetIds.join(', ')}`);
  return failures;
}

function assertMultiTargetLiveRepairAllowed(cfg, targets, args) {
  const failures = multiTargetLiveRepairGateFailures(cfg, targets, args);
  if (failures.length > 0) {
    throw new Error(`multi-target live repair blocked: ${failures.join('; ')}`);
  }
}

export function targetStateTier(target = {}, state = {}, now = Date.now()) {
  const approval = liveRepairApprovalState(target, state, {}, now);
  if (approval.state === 'unused') return 'live-approved-once';
  if (state.lastRepairRehearsal?.approvalPackage?.schema === 'pr-shepherd-repair-rehearsal-approval/v1') return 'phase-d-ready';
  if (state.lastKind === 'dirty' || state.lastWarningKind === 'dirty') return 'rehearsal-ready';
  return 'check-only';
}

export function buildTargetIncidentSummary(target = {}, state = {}, observationSummary = null) {
  const ledger = Array.isArray(state.actionLedger) ? state.actionLedger : [];
  const recentBlocks = ledger.slice(-DEFAULT_INCIDENT_BLOCK_THRESHOLD).filter((entry) => ['blocked', 'failed'].includes(entry?.result));
  const unknownCount = observationSummary?.last48h?.byKind?.unknown || 0;
  const failedCount = observationSummary?.last48h?.byKind?.failed || 0;
  const affectedTargets = [target.id || state.target].filter(Boolean);
  if (recentBlocks.length >= DEFAULT_INCIDENT_BLOCK_THRESHOLD) {
    return {
      schema: 'pr-shepherd-incident-summary/v1',
      incidentKind: 'repeated-repair-block',
      severity: 'block',
      affectedTargets,
      repeatedCount: recentBlocks.length,
      recommendedOperatorAction: 'keep target check-only; review approval, verify gate, expected refs, and last block reason before retrying repair',
      safeRollbackOrDisableNote: 'disable automaticActions.liveRepair or let the one-shot approval expire; keep status/check paths enabled for visibility',
      lastBlockReason: recentBlocks.at(-1)?.reasons?.[0] || recentBlocks.at(-1)?.details?.error || null,
    };
  }
  if (unknownCount >= 3 || failedCount >= 3) {
    return {
      schema: 'pr-shepherd-incident-summary/v1',
      incidentKind: unknownCount >= 3 ? 'repeated-unknown' : 'repeated-failed-checks',
      severity: 'warning',
      affectedTargets,
      repeatedCount: Math.max(unknownCount, failedCount),
      recommendedOperatorAction: unknownCount >= 3 ? 'recheck GitHub mergeability and keep repair disabled' : 'review failing checks before any rehearsal or approval',
      safeRollbackOrDisableNote: 'no rollback needed; check/status remains read-only and branch mutation stays disabled',
      lastBlockReason: null,
    };
  }
  return null;
}

export function buildFleetOperatorBrief(rows = []) {
  const counts = Object.fromEntries(FLEET_TARGET_STATE_TIERS.map((tier) => [tier, 0]));
  const byKind = {};
  const affectedTargets = [];
  for (const row of rows) {
    const tier = FLEET_TARGET_STATE_TIERS.includes(row?.targetTier) ? row.targetTier : 'check-only';
    counts[tier] += 1;
    const kind = row?.lastKind || row?.kind || 'unknown';
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (row?.incident) affectedTargets.push(row.target);
  }
  const blockedCount = rows.filter((row) => row?.automaticAction?.status === 'blocked' || row?.incident?.severity === 'block').length;
  const warningCount = rows.filter((row) => (Array.isArray(row?.doctorWarnings) && row.doctorWarnings.length > 0) || row?.incident?.severity === 'warning').length;
  return {
    schema: 'pr-shepherd-fleet-operator-brief/v1',
    targets: rows.length,
    tiers: counts,
    byKind,
    cleanCount: byKind.clean || 0,
    warningCount,
    blockedCount,
    approvalReadyCount: counts['phase-d-ready'],
    liveApprovedOnceCount: counts['live-approved-once'],
    affectedTargets,
    liveSendsDefault: 'disabled-or-dry-run',
  };
}

export function buildStatusRows(targets, now = Date.now()) {
  const summaryNow = new Date(now);
  return targets.map((target) => {
    const stateFile = target.statePath && existsSync(target.statePath) ? loadJson(target.statePath, {}) : {};
    const state = { ...defaultState(target), ...stateFile };
    const observationSummary = state.observationSummary || summarizeObservationLedger(state.observationLedger || [], summaryNow);
    const incident = buildTargetIncidentSummary(target, state, observationSummary);
    const targetTier = targetStateTier(target, state, Number(summaryNow));
    return {
      target: target.id,
      pr: target.pr,
      targetTier,
      verifyGate: buildVerifyGate(target),
      liveRepairApprovalState: liveRepairApprovalState(target, state, {}, Number(summaryNow)),
      incident,
      statePath: target.statePath || null,
      stateExists: Boolean(target.statePath && existsSync(target.statePath)),
      configEnabled: isEnabledTarget(target),
      disabled: Boolean(state.disabled),
      lastKind: state.lastKind || null,
      lastMergeable: state.lastMergeable || null,
      lastMergeStateStatus: state.lastMergeStateStatus || null,
      lastReviewDecision: state.lastReviewDecision || null,
      lastSeenHeadOid: state.lastSeenHeadOid || null,
      lastSeenBaseOid: state.lastSeenBaseOid || null,
      lastFailureNames: state.lastFailureNames || [],
      lastPendingCount: state.lastPendingCount || 0,
      recentAutoPushCount: recentAutoPushes(state, now).length,
      lastNotificationKey: state.lastNotificationKey || null,
      automaticAction: state.lastAutomaticActionExecution || (state.lastAutomaticActionPlan ? explainAutomaticActionPlan(state.lastAutomaticActionPlan) : null),
      actionLedger: summarizeActionLedger(state.actionLedger || []),
      operatorDecisionLedger: summarizeOperatorDecisionLedger(state.operatorDecisionLedger || []),
      lastOperatorDecisionFeedback: state.lastOperatorDecisionFeedback || null,
      observationSummary,
      recentRunAt: state.lastObservationAt || observationSummary.lastRunAt || state.lastRunAt || null,
      lastRunAt: state.lastRunAt || null,
      lastOkAt: state.lastOkAt || null,
      lastCleanAt: state.lastCleanAt || observationSummary.lastCleanAt || state.lastOkAt || null,
      lastWarningAt: state.lastWarningAt || null,
      lastWarningKind: state.lastWarningKind || null,
      doctorWarnings: state.lastDoctorWarnings || [],
      nextRecommendedAction: state.nextRecommendedAction || nextRecommendedAction(target, state),
    };
  });
}

function ghPrView(target) {
  const res = run('gh', ['pr', 'view', String(target.number), '--repo', `${target.owner}/${target.repo}`, '--json', PR_FIELDS.join(',')]);
  return JSON.parse(res.stdout);
}

function ghPrChangedFiles(target) {
  const res = run('gh', ['api', `repos/${target.owner}/${target.repo}/pulls/${target.number}/files`, '--paginate'], { allowFailure: true });
  if (res.status !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed.flat() : [];
  } catch {
    try {
      const pages = JSON.parse(`[${res.stdout.trim().replace(/]\s*\[/g, '],[')}]`);
      return Array.isArray(pages) ? pages.flat() : [];
    } catch {
      return [];
    }
  }
}

function sleepMs(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function shouldRecheckUnknown(classification) {
  return classification.kind === 'unknown'
    && classification.checks.failed.length === 0
    && classification.checks.pending.length === 0;
}

function ghPrViewWithUnknownRecheck(target) {
  const maxRechecks = Math.max(0, Number.isFinite(Number(target.unknownRecheckAttempts)) ? Number(target.unknownRecheckAttempts) : 2);
  const delayMs = Math.max(0, Number.isFinite(Number(target.unknownRecheckDelayMs)) ? Number(target.unknownRecheckDelayMs) : 1500);
  let pr = ghPrView(target);
  let classification = classifyPr(pr);
  let rechecks = 0;
  while (rechecks < maxRechecks && shouldRecheckUnknown(classification)) {
    rechecks += 1;
    sleepMs(delayMs);
    pr = ghPrView(target);
    classification = classifyPr(pr);
  }
  return { pr, classification, rechecks };
}

function checkIdentity(check) {
  return check.name || check.context || check.workflowName || check.__typename || 'unknown-check';
}

function isBenignCompletedConclusion(conclusion) {
  const normalizedConclusion = String(conclusion || '').toUpperCase();
  return !normalizedConclusion || ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(normalizedConclusion);
}

export function classifyChecks(statusCheckRollup = []) {
  const failed = [];
  const pending = [];
  const ignored = [];
  const groups = new Map();

  for (const c of statusCheckRollup || []) {
    const name = checkIdentity(c);
    const entry = {
      name,
      status: c.status || '',
      conclusion: c.conclusion || '',
      detailsUrl: c.detailsUrl || c.targetUrl || c.url || null,
    };
    const group = groups.get(name) || [];
    group.push(entry);
    groups.set(name, group);
  }

  for (const group of groups.values()) {
    const pendingEntries = group.filter((check) => {
      const normalizedStatus = String(check.status || '').toUpperCase();
      return normalizedStatus && normalizedStatus !== 'COMPLETED';
    });
    if (pendingEntries.length > 0) {
      pending.push(...pendingEntries);
      ignored.push(...group.filter((check) => String(check.status || '').toUpperCase() === 'COMPLETED' && !isBenignCompletedConclusion(check.conclusion)));
      continue;
    }

    const hasPassingTerminal = group.some((check) => isBenignCompletedConclusion(check.conclusion));
    if (hasPassingTerminal) {
      ignored.push(...group.filter((check) => !isBenignCompletedConclusion(check.conclusion)));
      continue;
    }

    failed.push(...group);
  }

  return { failed, pending, ignored };
}

export function classifyPr(pr) {
  const checks = classifyChecks(pr.statusCheckRollup);
  if (pr.mergedAt || pr.state === 'MERGED') return { kind: 'merged', checks };
  if (checks.failed.length > 0) return { kind: 'failed', checks };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { kind: 'dirty', checks };
  if (pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'UNSTABLE' && checks.pending.length > 0) return { kind: 'unstable', checks };
  if (pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN' && checks.pending.length === 0) return { kind: 'clean', checks };
  return { kind: 'unknown', checks };
}

export function notificationKey(kind, pr, checks, extra = '') {
  if (kind === 'failed') return `failed:${pr.headRefOid}:${checks.failed.map((c) => `${c.name}:${c.conclusion}`).sort().join('|')}`;
  if (kind === 'unstable') return `unstable:${pr.headRefOid}:${checks.pending.length}:${extra}`;
  return `${kind}:${pr.headRefOid || ''}:${pr.mergeable || ''}:${pr.mergeStateStatus || ''}:${extra}`;
}

function liveRepairPolicy(target = {}) {
  return target.automaticActions?.liveRepair || {};
}

function targetPrRef(target = {}) {
  if (target.pr) return target.pr;
  if (target.owner && target.repo && Number.isInteger(Number(target.number)) && Number(target.number) > 0) {
    return `${target.owner}/${target.repo}#${Number(target.number)}`;
  }
  return null;
}

function focusedVerifyCommands(target = {}) {
  return (Array.isArray(target.focusedChecks) ? target.focusedChecks : [])
    .map((command) => String(command || '').trim())
    .filter(Boolean);
}

export function buildVerifyGate(target = {}) {
  const policy = liveRepairPolicy(target);
  const required = policy.strictVerifyRequired !== undefined ? policy.strictVerifyRequired !== false : DEFAULT_STRICT_VERIFY_REQUIRED;
  const commands = focusedVerifyCommands(target);
  const present = commands.length > 0;
  const status = present ? 'present' : (required ? 'missing' : 'not-required');
  return {
    schema: 'pr-shepherd-verify-gate/v1',
    required,
    status,
    commands,
    reason: present || !required ? null : 'automaticActions.liveRepair.strictVerifyRequired requires at least one focusedChecks command',
  };
}

function hasLiveRepairApproval(target = {}) {
  const policy = liveRepairPolicy(target);
  return policy.enabled === true || typeof policy.approvalId === 'string' || typeof policy.approvedAt === 'string';
}

function consumedApprovalIds(state = {}) {
  const ids = new Set();
  if (Array.isArray(state.consumedLiveRepairApprovals)) {
    for (const item of state.consumedLiveRepairApprovals) {
      if (typeof item === 'string') ids.add(item);
      else if (item?.approvalId) ids.add(String(item.approvalId));
    }
  }
  if (state.liveRepairApprovalConsumption?.approvalId) ids.add(String(state.liveRepairApprovalConsumption.approvalId));
  return ids;
}

export function liveRepairApprovalState(target = {}, state = {}, pr = {}, now = Date.now()) {
  const policy = liveRepairPolicy(target);
  const approvalId = typeof policy.approvalId === 'string' ? policy.approvalId.trim() : '';
  if (!approvalId) return { state: 'missing', approvalId: null, reason: 'approval id missing' };
  if (consumedApprovalIds(state).has(approvalId)) return { state: 'consumed', approvalId, reason: 'approval already consumed' };
  if (policy.enabled !== true || policy.scope !== 'auto-safe-repair') return { state: 'invalid', approvalId, reason: 'approval is not enabled for auto-safe-repair' };
  const expiresAt = Date.parse(policy.expiresAt || '');
  if (!Number.isFinite(expiresAt)) return { state: 'invalid', approvalId, reason: 'approval expiry missing or invalid' };
  if (now > expiresAt) return { state: 'expired', approvalId, reason: 'approval expired' };
  if (pr?.headRefOid && policy.headRefOid && policy.headRefOid !== pr.headRefOid) {
    return { state: 'invalidated-by-head-change', approvalId, reason: 'approval expected head does not match current PR head' };
  }
  return { state: 'unused', approvalId, reason: null };
}

function consumeLiveRepairApproval(state, target, outcome, reason, now = new Date()) {
  const policy = liveRepairPolicy(target);
  if (typeof policy.approvalId !== 'string' || policy.approvalId.trim() === '') return null;
  const entry = {
    approvalId: policy.approvalId,
    consumedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    outcome,
    reason,
    target: target.id || null,
    pr: targetPrRef(target),
  };
  const existing = Array.isArray(state.consumedLiveRepairApprovals) ? state.consumedLiveRepairApprovals : [];
  if (!existing.some((item) => item?.approvalId === entry.approvalId || item === entry.approvalId)) {
    state.consumedLiveRepairApprovals = [...existing, entry].slice(-DEFAULT_ACTION_LEDGER_LIMIT);
  }
  state.liveRepairApprovalConsumption = entry;
  return entry;
}

function currentBaseOid(state = {}, pr = {}) {
  return pr.baseRefOid || state.lastSeenBaseOid || null;
}

function repairPlanKey(pr = {}, baseOid = null) {
  return `repair:${pr.headRefOid || ''}:${baseOid || pr.baseRefOid || pr.baseRefName || ''}:${pr.mergeable || ''}:${pr.mergeStateStatus || ''}`;
}

function renderedCommand(command, target, opts = {}) {
  const argv = [
    'node',
    'pr-shepherd.mjs',
    command,
    '--config',
    '<config>',
    '--target',
    target.id || '<target-id>',
  ];
  if (opts.artifactDir) argv.push('--artifact-dir', '<artifact-dir>');
  return argv;
}

export function buildRepairRehearsalApprovalPackage(target = {}, pr = {}, state = {}, plan = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const baseOid = fields.baseOid || currentBaseOid(state, pr);
  const repairKey = fields.repairKey || repairPlanKey(pr, baseOid);
  const headBranch = target.headBranch || pr.headRefName || null;
  const rehearsalCommand = renderedCommand('rehearse', target, fields);
  const liveRepairCommand = renderedCommand('repair', target, fields);
  const expectedRefs = {
    headBranch,
    baseBranch: target.baseBranch || pr.baseRefName || null,
    headRefOid: pr.headRefOid || state.lastSeenHeadOid || null,
    baseRefOid: baseOid || null,
    repairKey,
  };
  const verifyGate = buildVerifyGate(target);
  const evidenceExpiresAt = new Date(now.getTime() + DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS).toISOString();
  const approvalText = [
    `One-shot approval required before live repair for ${target.id || '<target-id>'} / ${target.pr || '<owner/repo#number>'}.`,
    `Allowed command: ${liveRepairCommand.join(' ')}.`,
    'Scope: auto-safe-repair.',
    `Allowed head branch: ${headBranch || '<head-branch>'}.`,
    `Expected head: ${expectedRefs.headRefOid || '<head-ref-oid>'}.`,
    `Expected base: ${expectedRefs.baseRefOid || '<base-ref-oid>'}.`,
    `Repair key: ${repairKey}.`,
    verifyGate.status === 'missing' ? `Verify gate blocker: ${verifyGate.reason}.` : 'Verify gate: focused checks are present.',
    'Approval must include an explicit expiresAt timestamp and expires earlier if any expected ref, branch, target, or repair key changes.',
  ].join(' ');
  const approvalPackage = {
    schema: 'pr-shepherd-repair-rehearsal-approval/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: target.pr || null,
    url: target.url || pr.url || null,
    dryRunOnly: true,
    productionMutation: false,
    rehearsalCommand,
    liveRepairCommand,
    approvalText,
    approvalConfigTemplate: {
      automaticActions: {
        liveRepair: {
          enabled: true,
          scope: 'auto-safe-repair',
          approvalId: '<one-shot-approval-id>',
          approvedAt: '<approval-iso8601>',
          expiresAt: '<approval-expiry-iso8601>',
          approvedBy: '<operator>',
          branchAllowlist: headBranch ? [headBranch] : ['<head-branch>'],
          rehearsalMaxAgeMs: DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS,
          targetId: target.id || '<target-id>',
          owner: target.owner || '<owner>',
          repo: target.repo || '<repo>',
          number: Number.isInteger(Number(target.number)) ? Number(target.number) : '<number>',
          pr: targetPrRef(target) || '<owner/repo#number>',
          headOwner: target.headOwner || '<head-owner>',
          actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
          headRefOid: expectedRefs.headRefOid || '<head-ref-oid>',
          baseRefOid: expectedRefs.baseRefOid || '<base-ref-oid>',
          repairKey,
          phaseDPacketExpiresAt: evidenceExpiresAt,
          strictVerifyRequired: verifyGate.required,
          rollbackNote: 'Remove or set automaticActions.liveRepair.enabled=false after this one-shot repair; rerun status to verify the result.',
        },
      },
    },
    expectedRefs,
    evidenceBundle: {
      classification: fields.classification || plan.classification || null,
      mergeable: pr.mergeable || state.lastMergeable || null,
      mergeStateStatus: pr.mergeStateStatus || state.lastMergeStateStatus || null,
      plannedAction: explainAutomaticActionPlan(plan),
      verifyGate,
      evidenceExpiresAt,
      requiredLedgerMarkers: ['Start', 'Approval before live repair', 'Action', 'Done/PR/Block'],
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
    },
    abortCriteria: [
      'target id, PR number, head branch, expected head/base ref, or repair key changed',
      'live repair approval metadata is missing, expired, wrong scope, or not target-specific',
      'head branch is not listed in automaticActions.liveRepair.branchAllowlist',
      'maintainer-owned head branch is detected without explicit allowMaintainerOwnedBranches=true',
      'worktree is missing, dirty, stale, or has unexpected remotes',
      'push budget is exhausted or the same repair key already failed',
      'focused checks fail, GitHub reports failed checks, or PR is no longer dirty',
      'remote head changes before push or force-with-lease cannot protect the expected head',
      'conflicts are humanOnly/codeAssisted/unlisted or cannot be resolved by deterministic autoSafe policy',
      'OpenClaw runtime/bootstrap context paths would enter the branch diff or artifact evidence',
    ],
    rollbackNote: 'Rehearsal only: no branch mutation, no push, and no force-with-lease. Roll back by keeping repair disabled and continuing check-only observation.',
  };
  return redactLedgerValue(approvalPackage, target);
}

function buildAutomaticActionPlan(actionClass, fields = {}) {
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

function liveRepairGateFailures(target, state, pr, now = Date.now()) {
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
    const gateFailures = liveRepairGateFailures(target, state, pr, opts.now === undefined ? Date.now() : opts.now);
    if (gateFailures.length > 0) {
      return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.BLOCK, {
        ...base,
        allowed: false,
        requiresOperatorApproval: true,
        reasons: gateFailures,
      });
    }
    return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, {
      ...base,
      pushAllowed: true,
      mutatesBranch: true,
      requiresOperatorApproval: true,
      reasons: ['all live auto-safe repair gates passed'],
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

function automaticActionExecution(plan, status, fields = {}) {
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

function phaseEGate(name, ok, details = {}, blocking = true) {
  return {
    name,
    ok: Boolean(ok),
    blocking: Boolean(blocking),
    ...details,
  };
}

function phaseEBlockedReasons(gates, plan) {
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

function notificationEnv(target, line, meta = {}) {
  return {
    PR_SHEPHERD_MESSAGE: line,
    PR_SHEPHERD_TARGET: String(target.id || ''),
    PR_SHEPHERD_PR: String(target.pr || ''),
    PR_SHEPHERD_URL: String(target.url || ''),
    PR_SHEPHERD_KIND: String(meta.kind || ''),
    PR_SHEPHERD_KEY: String(meta.key || ''),
    PR_SHEPHERD_NOTIFY_MODE: String(target.notify?.mode || 'stdout'),
  };
}

function deliverCommandNotification(target, line, meta = {}) {
  const [cmd, ...args] = target.notify.command;
  run(cmd, args, {
    env: notificationEnv(target, line, meta),
    allowFailure: true,
  });
}

function deliverOpenClawNotification(target, line, meta = {}) {
  const dryRun = target.notify?.dryRun !== false;
  if (dryRun || !Array.isArray(target.notify?.command)) {
    console.log(`[pr-shepherd:${target.id}] OpenClaw notify dry-run: ${line}`);
    return true;
  }
  deliverCommandNotification(target, line, { ...meta, openclaw: true });
  return true;
}

function deliverNotification(target, line, meta = {}) {
  const mode = target.notify?.mode || 'stdout';
  if (mode === 'none') return true;
  if (mode === 'command' && Array.isArray(target.notify.command)) deliverCommandNotification(target, line, meta);
  else if (mode === 'openclaw') deliverOpenClawNotification(target, line, meta);
  else console.log(line);
  return true;
}

function notify(target, state, key, message, force = false) {
  if (!force && state.lastNotificationKey === key) return false;
  state.lastNotificationKey = key;
  const line = `[pr-shepherd:${target.id}] ${message}`;
  return deliverNotification(target, line, { kind: String(key).split(':')[0] || 'notification', key });
}

export function buildCanaryNotificationLine(target, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return `[pr-shepherd:${target.id}] ${target.pr} notifier canary at ${at}; no PR state changed`;
}

function handleCanary(target) {
  const line = buildCanaryNotificationLine(target);
  deliverNotification(target, line, { kind: 'canary', key: `canary:${target.id}` });
  console.log(JSON.stringify({
    target: target.id,
    pr: target.pr,
    kind: 'canary',
    notifyMode: target.notify?.mode || 'stdout',
    delivered: target.notify?.mode !== 'none',
  }, null, 2));
}

function updateStateFromPr(state, pr, classification) {
  state.lastRunAt = new Date().toISOString();
  state.lastSeenHeadOid = pr.headRefOid || state.lastSeenHeadOid;
  state.lastSeenBaseOid = pr.baseRefOid || state.lastSeenBaseOid;
  state.lastMergeable = pr.mergeable || null;
  state.lastMergeStateStatus = pr.mergeStateStatus || null;
  state.lastReviewDecision = pr.reviewDecision || null;
  state.lastFailureNames = classification.checks.failed.map((c) => c.name);
  state.lastPendingCount = classification.checks.pending.length;
  if (classification.kind === 'clean') state.lastOkAt = state.lastRunAt;
  if (classification.kind === 'merged') state.disabled = true;
}

function summarizeFailed(checks) {
  return checks.failed.map((c) => `${c.name}${c.conclusion ? `=${c.conclusion}` : ''}${c.detailsUrl ? ` ${c.detailsUrl}` : ''}`).join('; ');
}

function summarizePending(checks) {
  return checks.pending.map((c) => `${c.name}${c.status ? `=${c.status}` : ''}${c.detailsUrl ? ` ${c.detailsUrl}` : ''}`).join('; ');
}

function situationReportEveryMs(target) {
  if (target.notify?.situationReportEveryMs !== undefined) return Number(target.notify.situationReportEveryMs);
  return DEFAULT_SITUATION_REPORT_EVERY_MS;
}

function lastActionSummary(state) {
  if (state.lastActionSummary) return state.lastActionSummary;
  if (state.lastConflictTier) {
    const paths = Array.isArray(state.lastConflictPaths) && state.lastConflictPaths.length > 0
      ? ` (${state.lastConflictPaths.join(', ')})`
      : '';
    return `last conflict=${state.lastConflictTier}${paths}`;
  }
  const pushes = Array.isArray(state.autoPushes) ? state.autoPushes : [];
  const lastPush = pushes[pushes.length - 1];
  if (lastPush) return `last auto-push ${String(lastPush.from || '').slice(0, 8)}..${String(lastPush.to || '').slice(0, 8)} at ${lastPush.at}`;
  return 'none recorded';
}

function nextActionForClassification(classification) {
  switch (classification.kind) {
    case 'clean': return 'none — 현재 조치할 것 없음 / no action needed';
    case 'merged': return 'none — PR merged; target disabled';
    case 'failed': return 'operator review failed checks; no repair attempted';
    case 'dirty': return 'run dry-run/rehearsal, then operator approval needed before any repair push';
    case 'unstable': return 'watch pending checks';
    case 'disabled': return 'none — target disabled';
    default: return 'operator review needed';
  }
}

function actionNeededForClassification(classification) {
  return ['clean', 'dirty', 'failed', 'merged', 'unknown'].includes(classification.kind);
}

export function buildSituationReportLine(target, state, pr, classification) {
  const failedCount = classification.checks?.failed?.length || 0;
  const pendingCount = classification.checks?.pending?.length || 0;
  const prRef = target.pr || `${target.owner}/${target.repo}#${target.number}`;
  const url = target.url || pr?.url || null;
  const observation = state.observationSummary?.last48h;
  const observationPart = observation && observation.total > 0
    ? `observation48h total=${observation.total} clean=${observation.byKind.clean || 0} unknown=${observation.byKind.unknown || 0} failed=${observation.byKind.failed || 0} dirty=${observation.byKind.dirty || 0} recheck=${observation.recheckSuggested || 0}`
    : null;
  const parts = [
    `${prRef} situation report`,
    `target=${target.id}`,
    `repo=${target.owner}/${target.repo}`,
    `classification=${classification.kind}`,
    `mergeable=${pr?.mergeable || state.lastMergeable || 'n/a'}`,
    `mergeStateStatus=${pr?.mergeStateStatus || state.lastMergeStateStatus || 'n/a'}`,
    `checks failed=${failedCount} pending=${pendingCount}`,
    observationPart,
    failedCount > 0 ? `failedChecks=${summarizeFailed(classification.checks)}` : null,
    pendingCount > 0 ? `pendingChecks=${summarizePending(classification.checks)}` : null,
    `lastAction=${lastActionSummary(state)}`,
    `nextAction=${nextActionForClassification(classification)}`,
  ];
  if (url) parts.push(`url=${url}`);
  return parts.filter(Boolean).join('; ');
}

function situationReportKey(pr, classification) {
  return `situation:${classification.kind}:${notificationKey(classification.kind, pr || {}, classification.checks || { failed: [], pending: [] })}`;
}

function sendSituationReport(target, state, pr, classification, key, now = new Date()) {
  state.lastSituationReportKey = key;
  state.lastSituationReportAt = now.toISOString();
  state.lastNotificationKey = key;
  const line = `[pr-shepherd:${target.id}] ${buildSituationReportLine(target, state, pr, classification)}`;
  return deliverNotification(target, line, { kind: 'situation', key });
}

function maybeNotifySituationReport(target, state, pr, classification, now = new Date()) {
  const key = situationReportKey(pr, classification);
  const cadenceMs = situationReportEveryMs(target);
  const lastAtMs = Date.parse(state.lastSituationReportAt || '');
  const cadenceDue = cadenceMs === 0 || !Number.isFinite(lastAtMs) || now.getTime() - lastAtMs >= cadenceMs;
  const immediateDue = actionNeededForClassification(classification) && state.lastSituationReportKey !== key;
  if (!immediateDue && !cadenceDue) return false;
  return sendSituationReport(target, state, pr, classification, key, now);
}

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

function ensureWorktree(target) {
  if (!existsSync(target.worktreePath)) throw new Error(`worktreePath does not exist: ${target.worktreePath}`);
  const clean = runShell('git status --porcelain', target.worktreePath).stdout.trim();
  if (clean) throw new Error(`worktree has uncommitted changes; refusing repair:\n${clean}`);
  runShell(`git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shellQuote(target.remotes.origin)}`, target.worktreePath);
  runShell(`git remote get-url upstream >/dev/null 2>&1 || git remote add upstream ${shellQuote(target.remotes.upstream)}`, target.worktreePath);
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function recentAutoPushes(state, now = Date.now()) {
  return (state.autoPushes || []).filter((p) => now - Date.parse(p.at) < 24 * 60 * 60 * 1000);
}

const DEFAULT_HUMAN_ONLY_CONFLICTS = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
];

function normalizePolicyEntry(entry) {
  if (typeof entry === 'string') return { path: entry };
  if (entry && typeof entry === 'object' && entry.path) return { ...entry };
  return null;
}

function matchesPolicyPath(entry, conflictPath) {
  if (!entry?.path) return false;
  if (entry.path.endsWith('/**')) return conflictPath === entry.path.slice(0, -3) || conflictPath.startsWith(entry.path.slice(0, -2));
  return conflictPath === entry.path;
}

function normalizeConflictPolicy(target = {}) {
  const raw = target.conflictPolicy || {};
  const legacyChangelog = target.knownSafeConflicts?.changelog
    ? [{
        path: target.knownSafeConflicts.changelog.path,
        resolver: 'merge-changelog-top-entry',
        needle: target.knownSafeConflicts.changelog.knownPrLineNeedle,
      }]
    : [];
  const autoSafe = [...legacyChangelog, ...(raw.autoSafe || [])].map(normalizePolicyEntry).filter(Boolean);
  const codeAssisted = (raw.codeAssisted || []).map(normalizePolicyEntry).filter(Boolean);
  const humanOnly = (raw.humanOnly || []).map(normalizePolicyEntry).filter(Boolean);
  for (const path of DEFAULT_HUMAN_ONLY_CONFLICTS) {
    const alreadyConfigured = [...autoSafe, ...codeAssisted, ...humanOnly].some((entry) => matchesPolicyPath(entry, path));
    if (!alreadyConfigured) humanOnly.push({ path, default: true });
  }
  return { autoSafe, codeAssisted, humanOnly };
}

export function classifyConflictPath(conflictPath, target = {}) {
  const policy = normalizeConflictPolicy(target);
  const explicitHumanOnly = policy.humanOnly.find((entry) => !entry.default && matchesPolicyPath(entry, conflictPath));
  if (explicitHumanOnly) return { path: conflictPath, tier: 'humanOnly', policy: explicitHumanOnly, reason: 'humanOnly' };
  const autoSafe = policy.autoSafe.find((entry) => matchesPolicyPath(entry, conflictPath));
  if (autoSafe) return { path: conflictPath, tier: 'autoSafe', policy: autoSafe, reason: 'autoSafe' };
  const codeAssisted = policy.codeAssisted.find((entry) => matchesPolicyPath(entry, conflictPath));
  if (codeAssisted) return { path: conflictPath, tier: 'codeAssisted', policy: codeAssisted, reason: 'codeAssisted' };
  const defaultHumanOnly = policy.humanOnly.find((entry) => matchesPolicyPath(entry, conflictPath));
  if (defaultHumanOnly) return { path: conflictPath, tier: 'humanOnly', policy: defaultHumanOnly, reason: 'defaultHumanOnly' };
  return { path: conflictPath, tier: 'humanOnly', policy: null, reason: 'unlisted' };
}

export function classifyConflictSet(conflicts = [], target = {}) {
  const paths = [...new Set(conflicts)].filter(Boolean).sort();
  const entries = paths.map((path) => classifyConflictPath(path, target));
  let tier = 'none';
  if (entries.some((entry) => entry.tier === 'humanOnly')) tier = 'humanOnly';
  else if (entries.length > 0 && entries.every((entry) => entry.tier === 'autoSafe')) tier = 'autoSafe';
  else if (entries.some((entry) => entry.tier === 'codeAssisted')) tier = 'codeAssisted';
  return {
    tier,
    entries,
    autoPushAllowed: tier === 'autoSafe',
    pushBlocked: tier !== 'autoSafe',
    requiresApproval: tier === 'codeAssisted',
  };
}

function normalizedRepoPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function summarizeChangedFiles(files = []) {
  return files.map((file) => ({
    path: normalizedRepoPath(file.filename || file.path || file.name),
    status: file.status || null,
    additions: Number.isFinite(Number(file.additions)) ? Number(file.additions) : null,
    deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : null,
    changes: Number.isFinite(Number(file.changes)) ? Number(file.changes) : null,
  })).filter((file) => file.path).sort((a, b) => a.path.localeCompare(b.path));
}

function matchDiagnosisHintPath(hintPath, repoPath) {
  if (!hintPath || !repoPath) return false;
  if (hintPath.endsWith('/**')) return repoPath === hintPath.slice(0, -3) || repoPath.startsWith(hintPath.slice(0, -2));
  if (hintPath.includes('*')) {
    const escaped = hintPath.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp(`^${escaped}$`).test(repoPath);
  }
  return repoPath === hintPath;
}

function matchingDiagnosisHints(target = {}, paths = []) {
  const candidates = [...new Set(paths.map(normalizedRepoPath).filter(Boolean))];
  const hints = Array.isArray(target.diagnosisHints) ? target.diagnosisHints.map(normalizeDiagnosisHintEntry).filter(Boolean) : [];
  return hints
    .filter((hint) => candidates.length === 0 || candidates.some((path) => matchDiagnosisHintPath(hint.path, path)))
    .map((hint) => ({
      path: hint.path,
      summary: hint.summary || null,
      commands: hint.commands.filter(isSafeDiagnosisHintCommand),
    }));
}

function checkSummaryFromClassification(classification = {}) {
  return {
    failed: (classification.checks?.failed || []).map((check) => ({ name: check.name, conclusion: check.conclusion || null, detailsUrl: check.detailsUrl || null })),
    pending: (classification.checks?.pending || []).map((check) => ({ name: check.name, status: check.status || null, detailsUrl: check.detailsUrl || null })),
    ignored: (classification.checks?.ignored || []).map((check) => ({ name: check.name, conclusion: check.conclusion || null })),
  };
}

function expectedRefsFromDiagnosisBundle(bundle = {}) {
  return isPlainObject(bundle.expectedRefs) ? bundle.expectedRefs : {};
}

function currentRefsForHandoff(fields = {}) {
  const currentPr = isPlainObject(fields.currentPr) ? fields.currentPr : {};
  const currentRefs = isPlainObject(fields.currentRefs) ? fields.currentRefs : {};
  return {
    headRefOid: currentRefs.headRefOid || currentPr.headRefOid || null,
    baseRefOid: currentRefs.baseRefOid || currentPr.baseRefOid || null,
    conflictKey: currentRefs.conflictKey || null,
  };
}

function diagnosisStaleness(bundle = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const maxAgeMs = fields.maxAgeMs === undefined ? DEFAULT_REPAIR_PLAN_HANDOFF_MAX_AGE_MS : Number(fields.maxAgeMs);
  const createdAtMs = Date.parse(bundle.createdAt || '');
  const expectedRefs = expectedRefsFromDiagnosisBundle(bundle);
  const currentRefs = currentRefsForHandoff(fields);
  const reasons = [];
  if (!Number.isFinite(createdAtMs)) reasons.push('diagnosis bundle createdAt is missing or invalid');
  else if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now.getTime() - createdAtMs > maxAgeMs) {
    reasons.push(`diagnosis bundle is older than ${maxAgeMs}ms`);
  }
  if (currentRefs.headRefOid && expectedRefs.headRefOid && currentRefs.headRefOid !== expectedRefs.headRefOid) reasons.push('current headRefOid differs from diagnosis bundle');
  if (currentRefs.baseRefOid && expectedRefs.baseRefOid && currentRefs.baseRefOid !== expectedRefs.baseRefOid) reasons.push('current baseRefOid differs from diagnosis bundle');
  if (currentRefs.conflictKey && expectedRefs.conflictKey && currentRefs.conflictKey !== expectedRefs.conflictKey) reasons.push('current conflictKey differs from diagnosis bundle');
  return {
    stale: reasons.length > 0,
    reasons,
    evaluatedAt: now.toISOString(),
    maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : null,
  };
}

function repairPlanHandoffDecision(bundle = {}, staleDiagnosis = {}, offendingPaths = []) {
  const classification = bundle.prState?.classification || 'unknown';
  const tier = bundle.conflictPolicy?.tier || 'none';
  const conflicts = Array.isArray(bundle.conflictPaths) ? bundle.conflictPaths : [];
  if (offendingPaths.length > 0) {
    return {
      kind: 'block',
      actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK,
      requiresOperatorApproval: false,
      summary: 'blocked because runtime/bootstrap context paths appear in diagnosis evidence',
      reasons: [`OpenClaw runtime/bootstrap context paths would enter repair-plan evidence: ${offendingPaths.join(', ')}`],
      nextStep: 'Remove forbidden runtime/bootstrap context evidence, then regenerate the diagnose bundle before repair planning.',
    };
  }
  if (staleDiagnosis.stale) {
    return {
      kind: 'refresh-diagnosis',
      actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK,
      requiresOperatorApproval: false,
      summary: 'diagnosis is stale; refresh PR state before choosing a repair path',
      reasons: staleDiagnosis.reasons.slice(),
      nextStep: 'Run check/diagnose again against the current PR head/base before any rehearsal or review handoff.',
    };
  }
  if (['clean', 'merged', 'disabled'].includes(classification)) {
    return {
      kind: 'no-op',
      actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK,
      requiresOperatorApproval: false,
      summary: `PR classification is ${classification}; no repair handoff is needed`,
      reasons: [`diagnose bundle classification is ${classification}`],
      nextStep: 'Record status only; do not rehearse or mutate the branch.',
    };
  }
  if (classification === 'unknown' || classification === 'failed') {
    return {
      kind: 'operator-review',
      actionClass: AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE,
      requiresOperatorApproval: true,
      summary: `PR classification is ${classification}; repair is not safely actionable`,
      reasons: [`diagnose bundle classification is ${classification}`],
      nextStep: 'Recheck GitHub mergeability/checks and review failures before any rehearsal.',
    };
  }
  if (tier === 'autoSafe' && conflicts.length > 0) {
    return {
      kind: 'auto-safe-rehearsal',
      actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL,
      requiresOperatorApproval: true,
      summary: 'all recorded conflicts are autoSafe candidates; hand off to rehearsal before approval',
      reasons: ['diagnose bundle conflict policy is autoSafe'],
      nextStep: 'Run the dry-run rehearse lane, inspect the Phase D approval package, then require one-shot approval before live repair.',
    };
  }
  if (tier === 'codeAssisted') {
    return {
      kind: 'code-assisted-review',
      actionClass: AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT,
      requiresOperatorApproval: true,
      summary: 'code-assisted conflicts require manual review artifacts; no push is allowed from this handoff',
      reasons: ['diagnose bundle conflict policy is codeAssisted'],
      nextStep: 'Review changed files, conflict paths, diagnosis hints, and focused checks; create an explicit follow-up approval before any mutation.',
    };
  }
  if (tier === 'humanOnly' || conflicts.length > 0) {
    return {
      kind: 'human-review-handoff',
      actionClass: AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY,
      requiresOperatorApproval: true,
      summary: 'human-only or unlisted conflicts require maintainer handoff',
      reasons: [`diagnose bundle conflict policy is ${tier}`],
      nextStep: 'Escalate the sanitized bundle to a maintainer; keep automatic repair disabled.',
    };
  }
  return {
    kind: 'wait-or-rediagnose',
    actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK,
    requiresOperatorApproval: false,
    summary: 'no concrete conflict paths were recorded; wait/recheck or regenerate diagnosis evidence',
    reasons: ['diagnose bundle has no conflict paths'],
    nextStep: 'Run status/check and regenerate diagnosis after GitHub reports concrete dirty/conflict evidence.',
  };
}

function repairPlanCommandHints(bundle = {}) {
  const target = bundle.target || '<target-id>';
  return {
    refreshDiagnosis: ['node', 'pr-shepherd.mjs', 'diagnose', '--config', '<config>', '--target', target, '--artifact-dir', '<artifact-dir>'],
    rehearsal: ['node', 'pr-shepherd.mjs', 'rehearse', '--config', '<config>', '--target', target, '--artifact-dir', '<artifact-dir>'],
    statusFollowUp: ['node', 'pr-shepherd.mjs', 'status', '--config', '<config>', '--target', target],
  };
}

export function buildRepairPlanHandoffFromDiagnosisBundle(bundle = {}, fields = {}) {
  if (!isPlainObject(bundle) || bundle.schema !== 'pr-shepherd-conflict-diagnosis-bundle/v1') {
    throw new Error('repair-plan handoff requires a pr-shepherd-conflict-diagnosis-bundle/v1 bundle');
  }
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const evidencePaths = [
    ...(Array.isArray(bundle.conflictPaths) ? bundle.conflictPaths : []),
    ...(Array.isArray(bundle.changedFiles) ? bundle.changedFiles.map((file) => file.path) : []),
    ...(Array.isArray(bundle.evidenceHygiene?.offendingRuntimeContextPaths) ? bundle.evidenceHygiene.offendingRuntimeContextPaths : []),
  ];
  const offendingPaths = findOpenClawRuntimeContextPaths(evidencePaths);
  const stale = diagnosisStaleness(bundle, fields);
  const decision = repairPlanHandoffDecision(bundle, stale, offendingPaths);
  const expectedRefs = expectedRefsFromDiagnosisBundle(bundle);
  const handoff = {
    schema: 'pr-shepherd-repair-plan-handoff/v1',
    createdAt: now.toISOString(),
    source: {
      schema: bundle.schema,
      createdAt: bundle.createdAt || null,
      target: bundle.target || null,
      pr: bundle.pr || null,
      url: bundle.url || null,
      expectedRefs,
      evidenceSource: 'diagnose-bundle',
    },
    productionMutation: false,
    handoffOnly: true,
    pushAllowed: false,
    mutatesBranch: false,
    sourceBacked: true,
    staleDiagnosis: stale,
    decision,
    expectedRefs: {
      ...expectedRefs,
      repairKey: repairPlanKey({
        headRefOid: expectedRefs.headRefOid,
        baseRefName: expectedRefs.baseBranch,
        mergeable: bundle.prState?.mergeable,
        mergeStateStatus: bundle.prState?.mergeStateStatus,
      }, expectedRefs.baseRefOid),
    },
    evidence: {
      prState: bundle.prState || null,
      conflictPolicy: bundle.conflictPolicy || null,
      conflictPaths: Array.isArray(bundle.conflictPaths) ? bundle.conflictPaths.slice() : [],
      changedFiles: Array.isArray(bundle.changedFiles) ? bundle.changedFiles.slice() : [],
      diagnosisHints: Array.isArray(bundle.diagnosisHints) ? bundle.diagnosisHints.slice() : [],
      focusedCommandHints: Array.isArray(bundle.focusedCommandHints) ? bundle.focusedCommandHints.slice() : [],
    },
    reviewArtifacts: [{
      kind: decision.kind,
      paths: Array.isArray(bundle.conflictPaths) ? bundle.conflictPaths.slice() : [],
      changedFiles: Array.isArray(bundle.changedFiles) ? bundle.changedFiles.map((file) => file.path).filter(Boolean) : [],
      diagnosisHints: Array.isArray(bundle.diagnosisHints) ? bundle.diagnosisHints.slice() : [],
      focusedCommandHints: Array.isArray(bundle.focusedCommandHints) ? bundle.focusedCommandHints.slice() : [],
      note: decision.nextStep,
    }],
    commandHints: repairPlanCommandHints(bundle),
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
      offendingRuntimeContextPaths: offendingPaths,
    },
    terminalLedgerMarker: ['block', 'refresh-diagnosis'].includes(decision.kind) ? 'Block' : 'Done',
  };
  return redactLedgerValue(handoff, fields.target || {});
}

export function buildConflictDiagnosisBundle(target = {}, pr = {}, classification = {}, state = {}, fields = {}) {
  const now = fields.now instanceof Date ? fields.now : new Date(fields.now || Date.now());
  const conflicts = [...new Set((fields.conflicts || state.lastConflictPaths || []).map(normalizedRepoPath).filter(Boolean))].sort();
  const changedFiles = summarizeChangedFiles(fields.changedFiles || []);
  const relevantPaths = [...new Set([...conflicts, ...changedFiles.map((file) => file.path)])].sort();
  const conflictInfo = fields.conflictInfo || classifyConflictSet(conflicts, target);
  const plan = fields.plan || buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY, {
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    classification: classification.kind || state.lastKind || 'unknown',
    writesArtifact: true,
    requiresOperatorApproval: false,
    reasons: ['diagnose-only bundle records sanitized conflict context and never pushes'],
    conflicts,
  });
  const conflictKey = fields.conflictKey || conflictSetKey(pr, fields.baseOid || state.lastSeenBaseOid, conflicts);
  const artifactEvidencePaths = fields.artifactEvidencePaths || conflicts;
  const offendingPaths = findOpenClawRuntimeContextPaths([...conflicts, ...changedFiles.map((file) => file.path), ...artifactEvidencePaths]);
  const bundle = {
    schema: 'pr-shepherd-conflict-diagnosis-bundle/v1',
    createdAt: now.toISOString(),
    target: target.id || null,
    pr: targetPrRef(target) || target.pr || null,
    url: target.url || pr?.url || null,
    productionMutation: false,
    diagnoseOnly: true,
    pushAllowed: false,
    mutatesBranch: false,
    diagnosisAllowed: offendingPaths.length === 0,
    blockedReasons: offendingPaths.length > 0
      ? [`OpenClaw runtime/bootstrap context paths would enter diagnosis evidence: ${offendingPaths.join(', ')}`]
      : [],
    expectedRefs: {
      headBranch: target.headBranch || pr.headRefName || null,
      baseBranch: target.baseBranch || pr.baseRefName || null,
      headRefOid: pr.headRefOid || state.lastSeenHeadOid || null,
      baseRefOid: fields.baseOid || state.lastSeenBaseOid || pr.baseRefOid || null,
      conflictKey,
    },
    prState: {
      classification: classification.kind || state.lastKind || 'unknown',
      mergeable: pr.mergeable || state.lastMergeable || null,
      mergeStateStatus: pr.mergeStateStatus || state.lastMergeStateStatus || null,
      checks: checkSummaryFromClassification(classification),
    },
    conflictPolicy: {
      tier: conflictInfo.tier,
      autoPushAllowed: false,
      pushBlocked: true,
      classifications: conflictInfo.entries.map((entry) => ({ path: entry.path, tier: entry.tier, reason: entry.reason })),
    },
    conflictPaths: conflicts,
    changedFiles,
    diagnosisHints: matchingDiagnosisHints(target, relevantPaths),
    focusedCommandHints: (target.focusedChecks || []).filter((command) => typeof command === 'string').map((command) => redactLedgerValue(command, target)),
    operatorNextActions: [
      conflictInfo.tier === 'autoSafe' ? 'autoSafe candidate: run rehearsal first, then require one-shot approval before any push.' : null,
      conflictInfo.tier === 'codeAssisted' ? 'codeAssisted conflict: use the bundle for manual review; do not push without explicit follow-up approval.' : null,
      conflictInfo.tier === 'humanOnly' ? 'humanOnly/unlisted conflict: keep repair disabled and escalate to a human maintainer.' : null,
      conflicts.length === 0 ? 'No concrete conflict paths recorded yet; run sandbox/rehearsal diagnosis before choosing a repair path.' : null,
      (classification.kind === 'unknown' || classification.kind === 'failed') ? 'State is not safely repairable; recheck or review failed checks before any mutation.' : null,
    ].filter(Boolean),
    evidenceHygiene: {
      sanitized: true,
      noRawShellTranscript: true,
      noSecretsOrPrivatePaths: true,
      forbiddenRuntimeContextPaths: [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw/**'],
      offendingRuntimeContextPaths: offendingPaths,
    },
    actionPlan: explainAutomaticActionPlan(plan),
    terminalLedgerMarker: offendingPaths.length > 0 ? 'Block' : 'Done',
    sources: [
      'github-pr-view',
      changedFiles.length > 0 ? 'github-pr-files' : null,
      conflicts.length > 0 ? 'state-or-sandbox-conflict-paths' : null,
      Array.isArray(target.diagnosisHints) && target.diagnosisHints.length > 0 ? 'target-diagnosis-hints' : null,
    ].filter(Boolean),
  };
  bundle.repairPlanHandoff = buildRepairPlanHandoffFromDiagnosisBundle(bundle, { now, target });
  return redactLedgerValue(bundle, target);
}

function writeConflictDiagnosisBundle(target, bundle, artifactDirOverride) {
  assertNoOpenClawRuntimeContextPaths([
    ...(bundle.conflictPaths || []),
    ...(bundle.changedFiles || []).map((file) => file.path),
    ...(bundle.evidenceHygiene?.offendingRuntimeContextPaths || []),
  ], 'diagnosis evidence');
  const artifactDir = resolve(artifactDirOverride || target.artifactDir || `${dirname(target.statePath)}/artifacts`);
  mkdirSync(artifactDir, { recursive: true });
  const safeId = String(target.id || 'target').replace(/[^A-Za-z0-9_.-]+/g, '-');
  const artifactPath = `${artifactDir}/${safeId}-conflict-diagnosis.json`;
  saveJson(artifactPath, bundle);
  return artifactPath;
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

export function conflictSetKey(pr, baseOid, conflicts = []) {
  const head = pr?.headRefOid || 'unknown-head';
  const base = baseOid || pr?.baseRefOid || pr?.baseRefName || 'unknown-base';
  const paths = [...new Set(conflicts)].filter(Boolean).sort().join('|');
  return `conflict:${head}:${base}:${paths}`;
}

function repairAttemptKey(pr, baseOid) {
  return repairPlanKey(pr, baseOid);
}

export function buildConflictArtifactPayload(target, pr, conflictInfo, conflicts, repairKey) {
  return {
    schema: 'pr-shepherd-conflict-artifact/v1',
    target: target.id,
    pr: target.pr,
    url: target.url || pr?.url || null,
    headRefOid: pr?.headRefOid || null,
    baseRefName: target.baseBranch || pr?.baseRefName || null,
    tier: conflictInfo.tier,
    autoPushAllowed: conflictInfo.autoPushAllowed,
    pushBlocked: conflictInfo.pushBlocked,
    requiresApproval: conflictInfo.requiresApproval,
    conflicts: conflicts.slice().sort(),
    classifications: conflictInfo.entries.map((entry) => ({ path: entry.path, tier: entry.tier, reason: entry.reason })),
    repairKey,
    createdAt: new Date().toISOString(),
    note: conflictInfo.tier === 'codeAssisted'
      ? 'Code-assisted conflict: manual resolver/approval required before any push.'
      : 'Conflict escalated; no automatic push was attempted.',
  };
}

function writeConflictArtifact(target, pr, conflictInfo, conflicts, repairKey, artifactDirOverride) {
  assertNoOpenClawRuntimeContextPaths(conflicts, 'artifact evidence');
  const artifactDir = resolve(artifactDirOverride || target.artifactDir || `${dirname(target.statePath)}/artifacts`);
  mkdirSync(artifactDir, { recursive: true });
  const safeId = String(target.id || 'target').replace(/[^A-Za-z0-9_.-]+/g, '-');
  const artifactPath = `${artifactDir}/${safeId}-${conflictInfo.tier}-conflict.json`;
  saveJson(artifactPath, buildConflictArtifactPayload(target, pr, conflictInfo, conflicts, repairKey));
  return artifactPath;
}

export function resolveChangelogConflict(target, policyEntry = null) {
  const legacy = target.knownSafeConflicts?.changelog;
  const cfg = policyEntry || (legacy && {
    path: legacy.path,
    resolver: 'merge-changelog-top-entry',
    needle: legacy.knownPrLineNeedle,
  });
  if (!cfg || cfg.resolver !== 'merge-changelog-top-entry') return false;
  const path = `${target.worktreePath}/${cfg.path}`;
  const text = readFileSync(path, 'utf8');
  if (!text.includes('<<<<<<<') || !text.includes('>>>>>>>')) return false;
  if (cfg.needle && !text.includes(cfg.needle)) return false;
  const resolved = text.replace(/<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*(?:\n|$)/g, (_m, ours, theirs) => {
    const lines = [];
    const seen = new Set();
    for (const line of `${ours}\n${theirs}`.split('\n')) {
      if (!line.trim()) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return `${lines.join('\n')}\n`;
  });
  if (resolved.includes('<<<<<<<') || resolved.includes('>>>>>>>') || resolved.includes('=======')) return false;
  writeFileSync(path, resolved);
  run('git', ['add', cfg.path], { cwd: target.worktreePath });
  return true;
}

function resolveAutoSafeConflicts(target, conflictInfo) {
  for (const entry of conflictInfo.entries) {
    if (entry.tier !== 'autoSafe') return false;
    if (entry.policy?.resolver === 'merge-changelog-top-entry') {
      if (!resolveChangelogConflict(target, entry.policy)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function runFocusedChecks(target) {
  for (const command of target.focusedChecks || []) {
    console.log(`[pr-shepherd:${target.id}] check: ${command}`);
    runShell(command, target.worktreePath);
  }
  for (const item of target.optionalChecks || []) {
    const command = typeof item === 'string' ? item : item.command;
    if (!command) continue;
    console.log(`[pr-shepherd:${target.id}] optional check: ${command}`);
    const first = runShell(command, target.worktreePath, { allowFailure: true });
    if (first.status === 0) continue;
    const missing = /Cannot find module|ERR_MODULE_NOT_FOUND|Module not found|missing dependency|pnpm install/i.test(first.output);
    if (item.retryAfterInstallOnMissingDependency && missing) {
      console.log(`[pr-shepherd:${target.id}] optional check dependency miss; pnpm install --frozen-lockfile then retry once`);
      runShell('pnpm install --frozen-lockfile', target.worktreePath);
      runShell(command, target.worktreePath);
    } else {
      throw new Error(`Optional check failed: ${command}\n${redact(first.output).slice(-8000)}`);
    }
  }
}

function assertNoOpenClawRuntimeContextInBranch(target, baseRef) {
  const changedPaths = run('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: target.worktreePath }).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  assertNoOpenClawRuntimeContextPaths(changedPaths, 'branch diff');
}

function nonRepairableBlockReason(kind) {
  switch (kind) {
    case 'clean': return 'target-clean';
    case 'unstable': return 'target-pending';
    case 'failed': return 'target-failed';
    case 'unknown': return 'target-unknown';
    case 'merged': return 'target-merged';
    case 'disabled': return 'target-disabled';
    default: return `target-${kind || 'not-repairable'}`;
  }
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
    assertNoOpenClawRuntimeContextInBranch(target, `upstream/${target.baseBranch}`);

    const ls = run('git', ['ls-remote', 'origin', `refs/heads/${target.headBranch}`], { cwd: target.worktreePath }).stdout.trim().split(/\s+/)[0];
    if (ls !== remoteHead) throw new Error(`remote head changed; refusing push. expected ${remoteHead}, got ${ls}`);
    run('git', ['push', `--force-with-lease=${target.headBranch}:${remoteHead}`, 'origin', `HEAD:${target.headBranch}`], { cwd: target.worktreePath });
    const newHead = run('git', ['rev-parse', 'HEAD'], { cwd: target.worktreePath }).stdout.trim();
    const pushedAt = new Date();
    state.autoPushes = [...pushes24h, { at: pushedAt.toISOString(), from: remoteHead, to: newHead, reason: 'dirty-rebase' }];
    consumeLiveRepairApproval(state, target, 'pushed', 'auto-safe-repair pushed', pushedAt);
    state.lastPostActionAudit = buildPostActionAuditEntry(target, { ...pr, baseRefOid: baseOid }, 'pushed', {
      state,
      repairKey,
      baseOid,
      beforeHeadOid: remoteHead,
      afterHeadOid: newHead,
      operatorSummary: `${target.pr} repair pushed with force-with-lease; disable one-shot approval and verify PR/CI state.`,
    });
    state.lastActionSummary = `repair pushed with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`;
    appendPlanLedgerEntry(state, target, postFetchPlan, 'pushed', {
      repairKey,
      expectedHeadOid: pr.headRefOid || null,
      expectedBaseOid: baseOid,
      details: { from: remoteHead, to: newHead, push: 'force-with-lease' },
    });
    delete state.lastRepairFailureKey;
    delete state.lastConflictSetKey;
    notify(target, state, `repair-success:${remoteHead}:${newHead}`, `${target.pr} repair pushed with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`, true);
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
