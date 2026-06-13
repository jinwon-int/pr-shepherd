// Live repair approval state, verify gate, and rehearsal approval package.
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_ACTION_LEDGER_LIMIT, DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS, DEFAULT_STRICT_VERIFY_REQUIRED, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES } from './policy.mjs';
import { redactLedgerValue } from './ledger.mjs';
import { explainAutomaticActionPlan } from './plan.mjs';

export function liveRepairPolicy(target = {}) {
  return target.automaticActions?.liveRepair || {};
}

export function targetPrRef(target = {}) {
  if (target.pr) return target.pr;
  if (target.owner && target.repo && Number.isInteger(Number(target.number)) && Number(target.number) > 0) {
    return `${target.owner}/${target.repo}#${Number(target.number)}`;
  }
  return null;
}

export function focusedVerifyCommands(target = {}) {
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

export function hasLiveRepairApproval(target = {}) {
  const policy = liveRepairPolicy(target);
  return policy.enabled === true || typeof policy.approvalId === 'string' || typeof policy.approvedAt === 'string';
}

export function consumedApprovalIds(state = {}) {
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

export function consumeLiveRepairApproval(state, target, outcome, reason, now = new Date()) {
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

export function currentBaseOid(state = {}, pr = {}) {
  return pr.baseRefOid || state.lastSeenBaseOid || null;
}

export function repairPlanKey(pr = {}, baseOid = null) {
  return `repair:${pr.headRefOid || ''}:${baseOid || pr.baseRefOid || pr.baseRefName || ''}:${pr.mergeable || ''}:${pr.mergeStateStatus || ''}`;
}

export function renderedCommand(command, target, opts = {}) {
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
