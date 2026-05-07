#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PR_FIELDS = [
  'number', 'state', 'mergeable', 'mergeStateStatus', 'mergedAt', 'headRefOid',
  'headRefName', 'baseRefName', 'updatedAt', 'statusCheckRollup', 'reviewDecision', 'url'
];

function usage(exitCode = 1) {
  console.error(`Usage:\n  node pr-shepherd.mjs check --config config.json [--target id]\n  node pr-shepherd.mjs repair --config config.json [--target id] [--dry-run] [--artifact-dir path] [--allow-code-assisted-push] [--no-keep-failed-rebase-worktree]`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !['check', 'repair'].includes(cmd)) usage();
  const args = { cmd, dryRun: false, allowCodeAssistedPush: false, keepFailedRebaseWorktree: true, artifactDir: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--config') args.config = rest[++i];
    else if (a === '--target') args.target = rest[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-code-assisted-push') args.allowCodeAssistedPush = true;
    else if (a === '--keep-failed-rebase-worktree') args.keepFailedRebaseWorktree = true;
    else if (a === '--no-keep-failed-rebase-worktree') args.keepFailedRebaseWorktree = false;
    else if (a === '--artifact-dir') args.artifactDir = rest[++i];
    else if (a === '--help' || a === '-h') usage(0);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.config) usage();
  return args;
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
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

function loadConfig(path) {
  const cfg = loadJson(resolve(path), null);
  if (!cfg || !Array.isArray(cfg.targets) || cfg.targets.length === 0) throw new Error('config must contain targets[]');
  return cfg;
}

function pickTarget(cfg, id) {
  const target = id ? cfg.targets.find((t) => t.id === id) : cfg.targets[0];
  if (!target) throw new Error(`target not found: ${id}`);
  return target;
}

function ghPrView(target) {
  const res = run('gh', ['pr', 'view', String(target.number), '--repo', `${target.owner}/${target.repo}`, '--json', PR_FIELDS.join(',')]);
  return JSON.parse(res.stdout);
}

export function classifyChecks(statusCheckRollup = []) {
  const failed = [];
  const pending = [];
  for (const c of statusCheckRollup || []) {
    const name = c.name || c.context || c.workflowName || c.__typename || 'unknown-check';
    const conclusion = c.conclusion || '';
    const status = c.status || '';
    const detailsUrl = c.detailsUrl || c.targetUrl || c.url || null;
    const normalizedConclusion = String(conclusion).toUpperCase();
    const normalizedStatus = String(status).toUpperCase();
    if (normalizedStatus && normalizedStatus !== 'COMPLETED') pending.push({ name, status, conclusion, detailsUrl });
    else if (!normalizedConclusion || ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(normalizedConclusion)) continue;
    else failed.push({ name, status, conclusion, detailsUrl });
  }
  return { failed, pending };
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

function notify(target, state, key, message, force = false) {
  if (!force && state.lastNotificationKey === key) return false;
  state.lastNotificationKey = key;
  const line = `[pr-shepherd:${target.id}] ${message}`;
  if (target.notify?.mode === 'none') return true;
  if (target.notify?.mode === 'command' && Array.isArray(target.notify.command)) {
    const [cmd, ...args] = target.notify.command;
    run(cmd, args, { env: { PR_SHEPHERD_MESSAGE: line }, allowFailure: true });
  } else {
    console.log(line);
  }
  return true;
}

function updateStateFromPr(state, pr, classification) {
  state.lastRunAt = new Date().toISOString();
  state.lastSeenHeadOid = pr.headRefOid || state.lastSeenHeadOid;
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

function handleCheck(target) {
  const state = { ...defaultState(target), ...loadJson(target.statePath, {}) };
  if (state.disabled) {
    console.log(`[pr-shepherd:${target.id}] disabled`);
    return { target, state, pr: null, classification: { kind: 'disabled' } };
  }
  const pr = ghPrView(target);
  const classification = classifyPr(pr);
  const previousKind = state.lastKind;
  updateStateFromPr(state, pr, classification);
  state.lastKind = classification.kind;

  if (classification.kind === 'merged') notify(target, state, notificationKey('merged', pr, classification.checks), `${target.pr} merged; disabling future runs`, true);
  else if (classification.kind === 'clean' && previousKind && !['clean', 'disabled'].includes(previousKind)) notify(target, state, notificationKey('clean', pr, classification.checks), `${target.pr} recovered to CLEAN`);
  else if (classification.kind === 'failed') notify(target, state, notificationKey('failed', pr, classification.checks), `${target.pr} CI failed: ${summarizeFailed(classification.checks)}`);
  else if (classification.kind === 'unstable') {
    const pendingSince = state.pendingSince || new Date().toISOString();
    state.pendingSince = pendingSince;
    const age = Date.now() - Date.parse(pendingSince);
    if (age >= target.pendingNotifyAfterMs) notify(target, state, notificationKey('pending-long', pr, classification.checks, pendingSince), `${target.pr} pending for ${Math.round(age / 60000)}m (${classification.checks.pending.length} checks)`);
  } else {
    delete state.pendingSince;
  }

  saveJson(target.statePath, state);
  console.log(JSON.stringify({ target: target.id, kind: classification.kind, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, failed: classification.checks.failed.length, pending: classification.checks.pending.length, disabled: state.disabled }, null, 2));
  return { target, state, pr, classification };
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
  return `repair:${pr.headRefOid || ''}:${baseOid || pr.baseRefOid || pr.baseRefName || ''}:${pr.mergeable || ''}:${pr.mergeStateStatus || ''}`;
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

function handleRepair(target, dryRun, opts = {}) {
  const unlock = acquireLock(target.lockPath, target.staleLockMs || 0);
  try {
    const { state, pr, classification } = handleCheck(target);
    if (state.disabled) return;
    if (classification.kind !== 'dirty') {
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
    if (dryRun) {
      saveJson(target.statePath, state);
      console.log(`[pr-shepherd:${target.id}] dry-run stops before git mutation`);
      return;
    }

    ensureWorktree(target);
    run('git', ['fetch', 'upstream', target.baseBranch], { cwd: target.worktreePath });
    const baseOid = run('git', ['rev-parse', `upstream/${target.baseBranch}`], { cwd: target.worktreePath }).stdout.trim();
    state.lastSeenBaseOid = baseOid;
    const repairKey = repairAttemptKey(pr, baseOid);
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
      const conflictInfo = classifyConflictSet(conflicts, target);
      const conflictKey = conflictSetKey(pr, baseOid, conflicts);
      const canResolveAutomatically = conflictInfo.tier === 'autoSafe' && resolveAutoSafeConflicts(target, conflictInfo);
      if (canResolveAutomatically) {
        run('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: target.worktreePath });
      } else {
        const artifactPath = writeConflictArtifact(target, pr, conflictInfo, conflicts, conflictKey, opts.artifactDir);
        const keepWorktree = conflictInfo.tier === 'codeAssisted'
          && target.keepFailedRebaseWorktree !== false
          && opts.keepFailedRebaseWorktree !== false;
        if (!keepWorktree) run('git', ['rebase', '--abort'], { cwd: target.worktreePath, allowFailure: true });
        state.lastRepairFailureKey = repairKey;
        state.lastConflictSetKey = conflictKey;
        state.lastConflictTier = conflictInfo.tier;
        state.lastConflictPaths = conflicts.slice().sort();
        const pushNote = conflictInfo.tier === 'codeAssisted' && !opts.allowCodeAssistedPush
          ? '; push blocked pending explicit code-assisted approval'
          : '; no automatic resolver available, push not attempted';
        notify(target, state, `repair-conflict:${conflictKey}`, `${target.pr} repair stopped: ${conflictInfo.tier} conflicts ${conflicts.join(', ') || '(unknown)'}${pushNote}; artifact ${basename(artifactPath)}`, true);
        saveJson(target.statePath, state);
        return;
      }
    }

    runFocusedChecks(target);

    const ls = run('git', ['ls-remote', 'origin', `refs/heads/${target.headBranch}`], { cwd: target.worktreePath }).stdout.trim().split(/\s+/)[0];
    if (ls !== remoteHead) throw new Error(`remote head changed; refusing push. expected ${remoteHead}, got ${ls}`);
    run('git', ['push', `--force-with-lease=${target.headBranch}:${remoteHead}`, 'origin', `HEAD:${target.headBranch}`], { cwd: target.worktreePath });
    const newHead = run('git', ['rev-parse', 'HEAD'], { cwd: target.worktreePath }).stdout.trim();
    state.autoPushes = [...pushes24h, { at: new Date().toISOString(), from: remoteHead, to: newHead, reason: 'dirty-rebase' }];
    delete state.lastRepairFailureKey;
    delete state.lastConflictSetKey;
    notify(target, state, `repair-success:${remoteHead}:${newHead}`, `${target.pr} repair pushed with force-with-lease ${remoteHead.slice(0, 8)}..${newHead.slice(0, 8)}`, true);
    saveJson(target.statePath, state);
    handleCheck(target);
  } catch (err) {
    const state = { ...defaultState(target), ...loadJson(target.statePath, {}) };
    notify(target, state, `repair-error:${String(err.message).slice(0, 160)}`, `${target.pr} repair failed: ${redact(err.message).slice(0, 1200)}`, true);
    saveJson(target.statePath, state);
    throw err;
  } finally {
    unlock();
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cfg = loadConfig(args.config);
  const target = pickTarget(cfg, args.target);
  if (args.cmd === 'check') handleCheck(target);
  else handleRepair(target, args.dryRun, args);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
