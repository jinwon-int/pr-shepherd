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
export const DEFAULT_ACTION_LEDGER_LIMIT = 50;
export const DEFAULT_OBSERVATION_LEDGER_LIMIT = 288; // 48h at a 10-minute standing-ops cadence.
export const DEFAULT_STRICT_VERIFY_REQUIRED = true;
export const DEFAULT_INCIDENT_BLOCK_THRESHOLD = 3;
export const PHASE_E_POST_ACTION_OUTCOMES = ['no-op', 'pushed', 'block'];

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
  console.error(`Usage:\n  node pr-shepherd.mjs validate --config config.json\n  node pr-shepherd.mjs status --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check-canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs rehearse --config config.json [--target id|owner/repo#number] [--all] [--artifact-dir path] [--no-keep-failed-rebase-worktree]\n  node pr-shepherd.mjs repair --config config.json [--target id|owner/repo#number] [--all] [--dry-run] [--artifact-dir path] [--allow-code-assisted-push] [--no-keep-failed-rebase-worktree]\n\nFor backward compatibility, omitting both --target and --all processes only the first configured target for status/check/check-canary/repair/rehearse.`);
  process.exit(exitCode);
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !['validate', 'status', 'canary', 'check', 'check-canary', 'repair', 'rehearse'].includes(cmd)) usage();
  const args = {
    cmd,
    dryRun: false,
    allowCodeAssistedPush: false,
    keepFailedRebaseWorktree: true,
    artifactDir: null,
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
    else if (a === '--help' || a === '-h') usage(0);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.config) usage();
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
      lastSeenHeadOid: state.lastSeenHeadOid || null,
      lastSeenBaseOid: state.lastSeenBaseOid || null,
      lastFailureNames: state.lastFailureNames || [],
      lastPendingCount: state.lastPendingCount || 0,
      recentAutoPushCount: recentAutoPushes(state, now).length,
      lastNotificationKey: state.lastNotificationKey || null,
      automaticAction: state.lastAutomaticActionExecution || (state.lastAutomaticActionPlan ? explainAutomaticActionPlan(state.lastAutomaticActionPlan) : null),
      actionLedger: summarizeActionLedger(state.actionLedger || []),
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
  return buildAutomaticActionPlan(AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE, {
    writesArtifact: conflicts.length > 0,
    requiresOperatorApproval: true,
    conflicts: conflicts.slice().sort(),
    reasons: ['human-only, unlisted, or unknown conflicts require manual review'],
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
  const summary = { target: target.id, kind: classification.kind, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, failed: classification.checks.failed.length, pending: classification.checks.pending.length, rechecks, disabled: state.disabled, plannedAction, observationSummary: state.observationSummary, doctorWarnings: state.lastDoctorWarnings || [], nextRecommendedAction: state.nextRecommendedAction || null };
  if (opts.print !== false) console.log(JSON.stringify(summary, null, 2));
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
        const artifactExecution = executeAutomaticActionPlan(conflictPlan, {
          [AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT]: () => writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir),
          [AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE]: () => writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir),
        });
        let artifactPath = artifactExecution.result;
        if (!artifactPath) {
          artifactPath = writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir);
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
