// JSON helpers plus config validation (validateConfigObject and friends).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_SITUATION_REPORT_EVERY_MS, MINOR_AUTO_ROLLOUT_MODES, MINOR_AUTO_SAFE_REPAIR_SCOPE, MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS, SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { configuredMinorAutoPaths, configuredMinorAutoResolvers, minorAutoPathRiskReason, minorAutoRolloutMode } from './minor-auto.mjs';
import { getResolver, supportedResolverIds } from './resolvers.mjs';
import { parsePrRef } from './targets.mjs';

export function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isEnabledTarget(target) {
  return target?.enabled !== false;
}

export function configPathPrefix(path, key) {
  return path ? `${path}.${key}` : key;
}

export function normalizeConfigPath(baseDir, value) {
  return resolve(baseDir, String(value));
}

export function validateRequiredString(errors, target, targetPath, field) {
  if (typeof target[field] !== 'string' || target[field].trim() === '') {
    errors.push(`${targetPath}.${field} is required`);
  }
}

export function validatePositiveNumber(errors, target, targetPath, field) {
  if (target[field] !== undefined && (!Number.isFinite(Number(target[field])) || Number(target[field]) <= 0)) {
    errors.push(`${targetPath}.${field} must be a positive number`);
  }
}

export function secretLookingValues(value, path = 'config', out = []) {
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

export function validateConflictPolicyPath(errors, entryPath, rawPath) {
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

export function validatePolicyEntry(errors, targetPath, tier, entry, index) {
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
    const resolver = getResolver(entry.resolver);
    if (!resolver) errors.push(`${entryPath}.resolver must be one of [${supportedResolverIds().join(', ')}] for autoSafe entries`);
    else if (typeof resolver.validateEntry === 'function') resolver.validateEntry(entry, entryPath, errors);
  }
  return path ? { path, entryPath, resolver: entry.resolver || null } : null;
}

export function validateConflictPolicy(errors, target, targetPath) {
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

export function normalizeDiagnosisHintEntry(entry) {
  if (!isPlainObject(entry)) return null;
  return {
    path: typeof entry.path === 'string' ? entry.path.trim().replace(/\\/g, '/') : '',
    summary: typeof entry.summary === 'string' ? entry.summary.trim() : '',
    commands: Array.isArray(entry.commands) ? entry.commands.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
  };
}

export function validateDiagnosisHints(errors, target, targetPath) {
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

export function validateLiveOpenClawActivation(errors, notify, targetPath) {
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

export function validateObservationConfig(errors, target, targetPath) {
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

export function validateAutomaticActions(errors, target, targetPath) {
  if (target.automaticActions === undefined) return;
  if (!isPlainObject(target.automaticActions)) {
    errors.push(`${targetPath}.automaticActions must be an object`);
    return;
  }
  const liveRepair = target.automaticActions.liveRepair;
  validateMinorAutoRepair(errors, target, targetPath);
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

export function validateMinorAutoRepair(errors, target, targetPath) {
  const policy = target.automaticActions?.minorAutoRepair;
  if (policy === undefined) return;
  const policyPath = `${targetPath}.automaticActions.minorAutoRepair`;
  if (!isPlainObject(policy)) {
    errors.push(`${policyPath} must be an object`);
    return;
  }
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') errors.push(`${policyPath}.enabled must be a boolean`);
  if (policy.rolloutMode !== undefined && !MINOR_AUTO_ROLLOUT_MODES.includes(policy.rolloutMode)) errors.push(`${policyPath}.rolloutMode must be one of: ${MINOR_AUTO_ROLLOUT_MODES.join(', ')}`);
  if (policy.scope !== undefined && policy.scope !== MINOR_AUTO_SAFE_REPAIR_SCOPE) errors.push(`${policyPath}.scope must be ${MINOR_AUTO_SAFE_REPAIR_SCOPE}`);
  if (policy.actionClass !== undefined && policy.actionClass !== AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR) errors.push(`${policyPath}.actionClass must be auto-safe-repair`);
  if (policy.zeroRehearsalSafe !== undefined && typeof policy.zeroRehearsalSafe !== 'boolean') errors.push(`${policyPath}.zeroRehearsalSafe must be a boolean`);
  if (policy.requireRecentRehearsal !== undefined && typeof policy.requireRecentRehearsal !== 'boolean') errors.push(`${policyPath}.requireRecentRehearsal must be a boolean`);
  if (policy.rehearsalMaxAgeMs !== undefined && (!Number.isFinite(Number(policy.rehearsalMaxAgeMs)) || Number(policy.rehearsalMaxAgeMs) <= 0)) errors.push(`${policyPath}.rehearsalMaxAgeMs must be a positive number`);
  if (policy.cooldownMs !== undefined && (!Number.isFinite(Number(policy.cooldownMs)) || Number(policy.cooldownMs) <= 0)) errors.push(`${policyPath}.cooldownMs must be a positive number`);
  if (policy.repoPushLimit24h !== undefined && (!Number.isFinite(Number(policy.repoPushLimit24h)) || Number(policy.repoPushLimit24h) <= 0)) errors.push(`${policyPath}.repoPushLimit24h must be a positive number`);
  if (policy.postPushObservationWindowMs !== undefined && (!Number.isFinite(Number(policy.postPushObservationWindowMs)) || Number(policy.postPushObservationWindowMs) <= 0)) errors.push(`${policyPath}.postPushObservationWindowMs must be a positive number`);
  if (policy.allowMaintainerOwnedBranches !== undefined && typeof policy.allowMaintainerOwnedBranches !== 'boolean') errors.push(`${policyPath}.allowMaintainerOwnedBranches must be a boolean`);
  if (policy.branchAllowlist !== undefined && (!Array.isArray(policy.branchAllowlist) || !policy.branchAllowlist.every((item) => typeof item === 'string' && item.trim() !== ''))) {
    errors.push(`${policyPath}.branchAllowlist must be a string array`);
  }
  const pathAllowlist = configuredMinorAutoPaths(policy);
  const rolloutMode = minorAutoRolloutMode(policy);
  if (policy.enabled === true) {
    if (policy.scope !== MINOR_AUTO_SAFE_REPAIR_SCOPE) errors.push(`${policyPath}.scope must be ${MINOR_AUTO_SAFE_REPAIR_SCOPE} when enabled`);
    if (policy.actionClass !== AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR) errors.push(`${policyPath}.actionClass must be auto-safe-repair when enabled`);
    if (pathAllowlist.length === 0) errors.push(`${policyPath}.pathAllowlist must be a non-empty string array when enabled`);
    if (configuredMinorAutoResolvers(policy).length === 0) errors.push(`${policyPath}.resolverAllowlist must be a non-empty string array when enabled`);
    if (rolloutMode === 'minor-auto-live-limited' && (!Array.isArray(policy.branchAllowlist) || policy.branchAllowlist.length === 0)) errors.push(`${policyPath}.branchAllowlist must be a non-empty string array for minor-auto-live-limited`);
  }
  if (rolloutMode !== 'observe-only' && policy.enabled !== true) errors.push(`${policyPath}.enabled must be true when rolloutMode is ${rolloutMode}`);
  if (policy.pathAllowlist !== undefined && (!Array.isArray(policy.pathAllowlist) || !policy.pathAllowlist.every((item) => typeof item === 'string' && item.trim() !== ''))) {
    errors.push(`${policyPath}.pathAllowlist must be a string array`);
  }
  pathAllowlist.forEach((path, index) => {
    validateConflictPolicyPath(errors, `${policyPath}.pathAllowlist[${index}]`, path);
    const risk = minorAutoPathRiskReason(path.endsWith('/**') ? `${path.slice(0, -3)}/README.md` : path);
    if (risk) errors.push(`${policyPath}.pathAllowlist[${index}] is not minor-auto-safe: ${risk}`);
  });
  const resolvers = configuredMinorAutoResolvers(policy);
  if (policy.resolverAllowlist !== undefined && (!Array.isArray(policy.resolverAllowlist) || !policy.resolverAllowlist.every((item) => typeof item === 'string' && item.trim() !== ''))) {
    errors.push(`${policyPath}.resolverAllowlist must be a string array`);
  }
  resolvers.forEach((resolver, index) => {
    if (!SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS.includes(resolver)) errors.push(`${policyPath}.resolverAllowlist[${index}] is not supported for minor-auto-safe repair: ${resolver}`);
  });
}

export function validateMultiTargetLiveRepair(errors, cfg) {
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

export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
