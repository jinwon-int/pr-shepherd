// Conflict policy classification, diagnosis bundles, repair-plan handoff, artifacts, resolvers, and focused checks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AUTOMATIC_ACTION_CLASSES, DEFAULT_REPAIR_PLAN_HANDOFF_MAX_AGE_MS, OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, assertNoOpenClawRuntimeContextPaths, findOpenClawRuntimeContextPaths } from './policy.mjs';
import { isPlainObject, isSafeDiagnosisHintCommand, normalizeDiagnosisHintEntry, saveJson } from './config.mjs';
import { redact, redactLedgerValue } from './ledger.mjs';
import { run, runShell } from './targets.mjs';
import { repairPlanKey, targetPrRef } from './approval.mjs';
import { buildAutomaticActionPlan, explainAutomaticActionPlan } from './plan.mjs';

export function ensureWorktree(target) {
  if (!existsSync(target.worktreePath)) throw new Error(`worktreePath does not exist: ${target.worktreePath}`);
  const clean = runShell('git status --porcelain', target.worktreePath).stdout.trim();
  if (clean) throw new Error(`worktree has uncommitted changes; refusing repair:\n${clean}`);
  runShell(`git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shellQuote(target.remotes.origin)}`, target.worktreePath);
  runShell(`git remote get-url upstream >/dev/null 2>&1 || git remote add upstream ${shellQuote(target.remotes.upstream)}`, target.worktreePath);
}

export function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export function recentAutoPushes(state, now = Date.now()) {
  return (state.autoPushes || []).filter((p) => now - Date.parse(p.at) < 24 * 60 * 60 * 1000);
}

export const DEFAULT_HUMAN_ONLY_CONFLICTS = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
];

export function normalizePolicyEntry(entry) {
  if (typeof entry === 'string') return { path: entry };
  if (entry && typeof entry === 'object' && entry.path) return { ...entry };
  return null;
}

export function matchesPolicyPath(entry, conflictPath) {
  if (!entry?.path) return false;
  if (entry.path.endsWith('/**')) return conflictPath === entry.path.slice(0, -3) || conflictPath.startsWith(entry.path.slice(0, -2));
  return conflictPath === entry.path;
}

export function normalizeConflictPolicy(target = {}) {
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

export function normalizedRepoPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function summarizeChangedFiles(files = []) {
  return files.map((file) => ({
    path: normalizedRepoPath(file.filename || file.path || file.name),
    status: file.status || null,
    additions: Number.isFinite(Number(file.additions)) ? Number(file.additions) : null,
    deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : null,
    changes: Number.isFinite(Number(file.changes)) ? Number(file.changes) : null,
  })).filter((file) => file.path).sort((a, b) => a.path.localeCompare(b.path));
}

export function matchDiagnosisHintPath(hintPath, repoPath) {
  if (!hintPath || !repoPath) return false;
  if (hintPath.endsWith('/**')) return repoPath === hintPath.slice(0, -3) || repoPath.startsWith(hintPath.slice(0, -2));
  if (hintPath.includes('*')) {
    const escaped = hintPath.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp(`^${escaped}$`).test(repoPath);
  }
  return repoPath === hintPath;
}

export function matchingDiagnosisHints(target = {}, paths = []) {
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

export function checkSummaryFromClassification(classification = {}) {
  return {
    failed: (classification.checks?.failed || []).map((check) => ({ name: check.name, conclusion: check.conclusion || null, detailsUrl: check.detailsUrl || null })),
    pending: (classification.checks?.pending || []).map((check) => ({ name: check.name, status: check.status || null, detailsUrl: check.detailsUrl || null })),
    ignored: (classification.checks?.ignored || []).map((check) => ({ name: check.name, conclusion: check.conclusion || null })),
  };
}

export function expectedRefsFromDiagnosisBundle(bundle = {}) {
  return isPlainObject(bundle.expectedRefs) ? bundle.expectedRefs : {};
}

export function currentRefsForHandoff(fields = {}) {
  const currentPr = isPlainObject(fields.currentPr) ? fields.currentPr : {};
  const currentRefs = isPlainObject(fields.currentRefs) ? fields.currentRefs : {};
  return {
    headRefOid: currentRefs.headRefOid || currentPr.headRefOid || null,
    baseRefOid: currentRefs.baseRefOid || currentPr.baseRefOid || null,
    conflictKey: currentRefs.conflictKey || null,
  };
}

export function diagnosisStaleness(bundle = {}, fields = {}) {
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

export function repairPlanHandoffDecision(bundle = {}, staleDiagnosis = {}, offendingPaths = []) {
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

export function repairPlanCommandHints(bundle = {}) {
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

export function writeConflictDiagnosisBundle(target, bundle, artifactDirOverride) {
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

export function conflictSetKey(pr, baseOid, conflicts = []) {
  const head = pr?.headRefOid || 'unknown-head';
  const base = baseOid || pr?.baseRefOid || pr?.baseRefName || 'unknown-base';
  const paths = [...new Set(conflicts)].filter(Boolean).sort().join('|');
  return `conflict:${head}:${base}:${paths}`;
}

export function repairAttemptKey(pr, baseOid) {
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

export function writeConflictArtifact(target, pr, conflictInfo, conflicts, repairKey, artifactDirOverride) {
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

export function resolveAutoSafeConflicts(target, conflictInfo) {
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

export function runFocusedChecks(target) {
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

export function assertNoOpenClawRuntimeContextInBranch(target, baseRef) {
  const changedPaths = run('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: target.worktreePath }).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  assertNoOpenClawRuntimeContextPaths(changedPaths, 'branch diff');
}

export function nonRepairableBlockReason(kind) {
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
