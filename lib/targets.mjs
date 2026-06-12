// Process execution, per-target locks, state defaults, config loading, and target selection.
import { closeSync, existsSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadJson, validateConfigObject } from './config.mjs';
import { redact } from './ledger.mjs';

export function run(cmd, args = [], opts = {}) {
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

export function runShell(command, cwd, opts = {}) {
  return run(command, [], { ...opts, cwd, shell: true });
}

export function acquireLock(lockPath, staleLockMs) {
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

export function defaultState(target) {
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

export function parsePrRef(value) {
  const match = String(value || '').match(/^([^/\s#]+)\/([^\s#]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), pr: `${match[1]}/${match[2]}#${match[3]}` };
}

export function normalizeTarget(target, index) {
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

export function loadConfig(path) {
  const cfg = loadJson(resolve(path), null);
  const validation = validateConfigObject(cfg, path);
  if (!validation.ok) throw new Error(`config validation failed:\n${validation.errors.join('\n')}`);
  const targets = cfg.targets.map(normalizeTarget);
  return { ...cfg, targets };
}

export function selectorAliases(target) {
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

export function assertMultiTargetLiveRepairAllowed(cfg, targets, args) {
  const failures = multiTargetLiveRepairGateFailures(cfg, targets, args);
  if (failures.length > 0) {
    throw new Error(`multi-target live repair blocked: ${failures.join('; ')}`);
  }
}
