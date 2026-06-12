import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AUTOMATIC_ACTION_CLASSES,
  MINOR_AUTO_ROLLOUT_MODES,
  MINOR_AUTO_SAFE_REPAIR_SCOPE,
  REVIEW_DECISION_OUTCOMES,
  appendActionLedgerEntry,
  appendOperatorDecisionLedgerEntry,
  buildMinorAutoExecutionController,
  buildMinorAutoPostPushObservation,
  buildMinorAutoRepairGate,
  appendSupervisedRehearsalQueueLedgerEntry,
  buildConflictArtifactPayload,
  buildConflictDiagnosisBundle,
  buildLiveRepairExecutionHarness,
  buildPhaseDCandidateGate,
  buildPhaseDOperatorPacket,
  buildPostActionAuditEntry,
  buildRehearsalEvidenceDigest,
  buildRepairRehearsalApprovalPackage,
  buildRepairPlanHandoffFromDiagnosisBundle,
  buildReviewStateFeedback,
  buildSituationReportLine,
  buildStatusRows,
  buildSupervisedRehearsalQueuePacket,
  classifyChecks,
  classifyConflictSet,
  classifyPr,
  conflictSetKey,
  executeAutomaticActionPlan,
  executeMinorAutoExecutionController,
  explainAutomaticActionPlan,
  findOpenClawRuntimeContextPaths,
  buildFleetOperatorBrief,
  getResolver,
  isSafeDiagnosisHintCommand,
  buildVerifyGate,
  liveRepairApprovalState,
  multiTargetLiveRepairGateFailures,
  notificationKey,
  planAutomaticAction,
  planConflictAutomaticAction,
  PR_FIELDS,
  resolveChangelogConflict,
  selectTargets,
  supportedResolverIds,
  SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS,
  summarizeActionLedger,
  summarizeOperatorDecisionLedger,
  summarizeObservationLedger,
  validateConfigObject,
} from './pr-shepherd.mjs';

const base = {
  number: 78261,
  state: 'OPEN',
  mergedAt: null,
  headRefOid: 'abc123',
  baseRefOid: 'base123',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
};

function validationTarget(overrides = {}) {
  return {
    id: 'target-1',
    owner: 'owner',
    repo: 'repo',
    number: 1,
    headBranch: 'feature',
    baseBranch: 'main',
    worktreePath: '/tmp/pr-shepherd/worktree-1',
    statePath: '/tmp/pr-shepherd/state-1.json',
    lockPath: '/tmp/pr-shepherd/lock-1.lock',
    autoPushLimit24h: 5,
    focusedChecks: ['npm test'],
    conflictPolicy: {
      autoSafe: [{ path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Release note' }],
      codeAssisted: ['src/example.ts'],
      humanOnly: ['pnpm-lock.yaml'],
    },
    notify: { mode: 'stdout' },
    ...overrides,
  };
}

test('selectTargets preserves first-target default and supports explicit all-target orchestration', () => {
  const cfg = {
    targets: [
      { id: 'repo-a-1', owner: 'owner-a', repo: 'repo-a', number: 1, pr: 'owner-a/repo-a#1', url: 'https://github.com/owner-a/repo-a/pull/1' },
      { id: 'repo-b-1', owner: 'owner-b', repo: 'repo-b', number: 1, pr: 'owner-b/repo-b#1', url: 'https://github.com/owner-b/repo-b/pull/1' },
    ],
  };
  assert.deepEqual(selectTargets(cfg).map((target) => target.id), ['repo-a-1']);
  assert.deepEqual(selectTargets(cfg, [], true).map((target) => target.id), ['repo-a-1', 'repo-b-1']);
  assert.deepEqual(selectTargets(cfg, ['owner-b/repo-b#1']).map((target) => target.id), ['repo-b-1']);
  assert.throws(() => selectTargets(cfg, ['1']), /ambiguous target selector/);
  assert.throws(() => selectTargets(cfg, ['repo-a-1'], true), /--all cannot be combined with --target/);
});

test('findOpenClawRuntimeContextPaths reports only root runtime context paths', () => {
  assert.deepEqual(findOpenClawRuntimeContextPaths([
    './AGENTS.md',
    '.openclaw/workspace-state.json',
    'docs/AGENTS.md',
    'src/HEARTBEAT.md',
    'TOOLS.md',
  ]), ['.openclaw/workspace-state.json', 'AGENTS.md', 'TOOLS.md']);
});

test('GitHub CLI PR field list excludes unsupported baseRefOid fetch field', () => {
  assert.equal(PR_FIELDS.includes('baseRefOid'), false);
  assert.deepEqual(PR_FIELDS, [...new Set(PR_FIELDS)]);
});

test('strict verify gate defaults to required and detects missing focused checks', () => {
  assert.equal(buildVerifyGate(validationTarget()).status, 'present');
  const missing = buildVerifyGate(validationTarget({ focusedChecks: [] }));
  assert.equal(missing.required, true);
  assert.equal(missing.status, 'missing');
  assert.match(missing.reason, /strictVerifyRequired/);
});

test('sandbox repair proof harness exercises local rebase and force-with-lease repair', () => {
  const result = spawnSync(process.execPath, [new URL('./examples/sandbox-repair-proof.mjs', import.meta.url).pathname], {
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.schema, 'pr-shepherd-sandbox-repair-proof/v1');
  assert.equal(report.sandboxOnly, true);
  assert.equal(report.productionMutation, false);
  assert.deepEqual(report.commands.map((command) => command.status), [0, 0]);
  assert.equal(report.forceWithLeaseEvidence.from, report.expectedRemoteHead);
  assert.equal(report.forceWithLeaseEvidence.to, report.pushedRemoteHead);
  assert.notEqual(report.expectedRemoteHead, report.pushedRemoteHead);
  assert.equal(report.focusedChecksPassed, true);
  assert.deepEqual(report.forbiddenRuntimeContextPaths, []);
  assert.equal(report.proofPath, 'state/sandbox-proof-artifacts/sandbox-repair-proof.json');
});

test('validateConfigObject accepts a production-ready target config', () => {
  const report = validateConfigObject({ targets: [validationTarget()] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test('validateConfigObject accepts dry-run OpenClaw reports and rejects unsafe report config', () => {
  const dryRunReport = validateConfigObject({
    targets: [validationTarget({ notify: { mode: 'openclaw', situationReportEveryMs: 0 } })],
  });
  assert.equal(dryRunReport.ok, true);

  const liveReport = validateConfigObject({
    targets: [validationTarget({
      notify: {
        mode: 'openclaw',
        dryRun: false,
        command: [process.execPath, '--version'],
        situationReportEveryMs: 3600000,
        liveActivation: {
          scope: 'check-only-reporting',
          approvedAt: '2026-05-08T04:00:00Z',
          approvedBy: 'operator',
        },
      },
    })],
  });
  assert.equal(liveReport.ok, true);

  const liveWithoutCommand = validateConfigObject({
    targets: [validationTarget({ notify: { mode: 'openclaw', dryRun: false } })],
  });
  assert.equal(liveWithoutCommand.ok, false);
  assert.match(liveWithoutCommand.errors.join('\n'), /notify\.command is required/);
  assert.match(liveWithoutCommand.errors.join('\n'), /notify\.liveActivation is required/);

  const liveEveryCheck = validateConfigObject({
    targets: [validationTarget({
      notify: {
        mode: 'openclaw',
        dryRun: false,
        command: [process.execPath, '--version'],
        situationReportEveryMs: 0,
        liveActivation: {
          scope: 'check-only-reporting',
          approvedAt: '2026-05-08T04:00:00Z',
          approvedBy: 'operator',
        },
      },
    })],
  });
  assert.equal(liveEveryCheck.ok, false);
  assert.match(liveEveryCheck.errors.join('\n'), /situationReportEveryMs must be at least 3600000/);

  const badLiveActivation = validateConfigObject({
    targets: [validationTarget({
      notify: {
        mode: 'openclaw',
        dryRun: false,
        command: [process.execPath, '--version'],
        liveActivation: { scope: 'repair', approvedAt: 'not-a-date', approvedBy: '' },
      },
    })],
  });
  assert.equal(badLiveActivation.ok, false);
  assert.match(badLiveActivation.errors.join('\n'), /liveActivation\.scope must be check-only-reporting/);
  assert.match(badLiveActivation.errors.join('\n'), /liveActivation\.approvedAt must be an ISO-8601 timestamp/);
  assert.match(badLiveActivation.errors.join('\n'), /liveActivation\.approvedBy is required/);

  const secretBearing = validateConfigObject({
    targets: [validationTarget({
      notify: { mode: 'openclaw', dryRun: false, command: [process.execPath, '-e', ''], chatId: '123456' },
    })],
  });
  assert.equal(secretBearing.ok, false);
  assert.match(secretBearing.errors.join('\n'), /notify\.chatId must not be stored in config/);

  const badCadence = validateConfigObject({
    targets: [validationTarget({ notify: { mode: 'stdout', situationReportEveryMs: -1 } })],
  });
  assert.equal(badCadence.ok, false);
  assert.match(badCadence.errors.join('\n'), /situationReportEveryMs must be a non-negative number/);
});

test('validateConfigObject rejects missing required fields, invalid push limits, and secrets', () => {
  const report = validateConfigObject({
    targets: [validationTarget({
      headBranch: '',
      autoPushLimit24h: 0,
      remotes: { origin: 'https://x-access-token:ghp_12345678901234567890@github.com/owner/repo.git' },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /targets\[0\]\.headBranch is required/);
  assert.match(report.errors.join('\n'), /autoPushLimit24h must be a positive number/);
  assert.match(report.errors.join('\n'), /secret-looking value in config\.targets\[0\]\.remotes\.origin/);

  const observationReport = validateConfigObject({ targets: [validationTarget({ observation: { ledgerLimit: 0 } })] });
  assert.equal(observationReport.ok, false);
  assert.match(observationReport.errors.join('\n'), /observation\.ledgerLimit must be a positive integer/);
});

test('validateConfigObject rejects duplicate target ids and enabled state or lock paths', () => {
  const report = validateConfigObject({
    targets: [
      validationTarget(),
      validationTarget({ id: 'target-1', number: 2, worktreePath: '/tmp/pr-shepherd/worktree-2' }),
    ],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /duplicate target id target-1/);
  assert.match(report.errors.join('\n'), /duplicate enabled target statePath/);
  assert.match(report.errors.join('\n'), /duplicate enabled target lockPath/);
});

test('validateConfigObject rejects duplicate conflict paths across policy tiers', () => {
  const report = validateConfigObject({
    targets: [validationTarget({
      conflictPolicy: {
        autoSafe: [{ path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Release note' }],
        codeAssisted: ['CHANGELOG.md'],
        humanOnly: [],
      },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /duplicates CHANGELOG\.md across tiers: autoSafe, codeAssisted/);
});

test('validateConfigObject rejects non-repo and OpenClaw runtime conflict policy paths', () => {
  const report = validateConfigObject({
    targets: [validationTarget({
      conflictPolicy: {
        autoSafe: [{ path: 'AGENTS.md', resolver: 'merge-changelog-top-entry', needle: 'Release note' }],
        codeAssisted: ['/private/worktree/src/example.ts'],
        humanOnly: ['.openclaw/workspace-state.json'],
      },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /autoSafe\[0\]\.path must not reference OpenClaw runtime\/bootstrap context paths: AGENTS\.md/);
  assert.match(report.errors.join('\n'), /codeAssisted\[0\] must be repo-relative and must not contain \.\./);
  assert.match(report.errors.join('\n'), /humanOnly\[0\] must not reference OpenClaw runtime\/bootstrap context paths: \.openclaw\/workspace-state\.json/);
});

test('validateConfigObject requires explicit live auto-repair gates when enabled', () => {
  const bad = validateConfigObject({ targets: [validationTarget({ automaticActions: { liveRepair: { enabled: true } } })] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /liveRepair\.scope must be auto-safe-repair/);
  assert.match(bad.errors.join('\n'), /liveRepair\.approvalId is required/);
  assert.match(bad.errors.join('\n'), /liveRepair\.approvedAt must be an ISO-8601 timestamp/);
  assert.match(bad.errors.join('\n'), /liveRepair\.expiresAt must be an ISO-8601 timestamp/);
  assert.match(bad.errors.join('\n'), /liveRepair\.approvedBy is required/);
  assert.match(bad.errors.join('\n'), /liveRepair\.branchAllowlist must be a non-empty string array/);

  const good = validateConfigObject({
    targets: [validationTarget({
      automaticActions: {
        liveRepair: {
          enabled: true,
          scope: 'auto-safe-repair',
          approvalId: 'approval-1',
          approvedAt: '2026-05-08T05:00:00Z',
          expiresAt: '2026-05-08T06:00:00Z',
          approvedBy: 'operator',
          branchAllowlist: ['feature'],
        },
      },
    })],
  });
  assert.equal(good.ok, true);

  const malformed = validateConfigObject({
    targets: [validationTarget({
      automaticActions: {
        liveRepair: {
          enabled: false,
          approvalId: '',
          approvedAt: 'not-a-date',
          expiresAt: 'not-a-date',
          approvedBy: '',
        },
      },
    })],
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join('\n'), /liveRepair\.approvalId must be a non-empty string/);
  assert.match(malformed.errors.join('\n'), /liveRepair\.approvedAt must be an ISO-8601 timestamp/);
  assert.match(malformed.errors.join('\n'), /liveRepair\.expiresAt must be an ISO-8601 timestamp/);
  assert.match(malformed.errors.join('\n'), /liveRepair\.approvedBy must be a non-empty string/);
});

test('validateConfigObject supports bounded minor-auto-safe repair policy and rejects risky paths', () => {
  const good = validateConfigObject({
    targets: [validationTarget({
      automaticActions: {
        minorAutoRepair: {
          enabled: true,
          scope: MINOR_AUTO_SAFE_REPAIR_SCOPE,
          actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
          rolloutMode: 'minor-auto-live-limited',
          branchAllowlist: ['feature'],
          pathAllowlist: ['CHANGELOG.md', 'docs/**'],
          resolverAllowlist: ['merge-changelog-top-entry'],
        },
      },
    })],
  });
  assert.equal(good.ok, true);

  const bad = validateConfigObject({
    targets: [validationTarget({
      automaticActions: {
        minorAutoRepair: {
          enabled: true,
          scope: 'auto-safe-repair',
          actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
          pathAllowlist: ['src/runtime.ts', 'pnpm-lock.yaml', 'AGENTS.md'],
          resolverAllowlist: ['manual-merge'],
        },
      },
    })],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /minorAutoRepair\.scope must be minor-auto-safe-repair/);
  assert.match(bad.errors.join('\n'), /source, executable, config, generated metadata, or structured data paths require approval/);
  assert.match(bad.errors.join('\n'), /dependency or lockfile paths require approval/);
  assert.match(bad.errors.join('\n'), /AGENTS\.md/);
  assert.match(bad.errors.join('\n'), /resolverAllowlist\[0\] is not supported/);
});

const multiTargetApproval = {
  enabled: true,
  scope: 'multi-target-auto-safe-repair',
  approvalId: 'fleet-approval-1',
  approvedAt: '2026-05-08T06:00:00Z',
  approvedBy: 'operator',
  targetIds: ['target-1', 'target-2'],
};

test('minor-auto rollout modes default to observe-only and validate live-limited controls', () => {
  assert.deepEqual(MINOR_AUTO_ROLLOUT_MODES, ['observe-only', 'sandbox-proof', 'minor-auto-dry-run', 'minor-auto-live-limited']);

  const observeTarget = validationTarget({
    automaticActions: {
      minorAutoRepair: {
        enabled: true,
        scope: MINOR_AUTO_SAFE_REPAIR_SCOPE,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        branchAllowlist: ['feature'],
        pathAllowlist: ['CHANGELOG.md'],
        resolverAllowlist: ['merge-changelog-top-entry'],
        zeroRehearsalSafe: true,
      },
    },
  });
  const pr = { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const observeGate = buildMinorAutoRepairGate(observeTarget, {}, pr, classification, { changedPaths: ['CHANGELOG.md'] });
  assert.equal(observeGate.rolloutMode, 'observe-only');
  assert.equal(observeGate.gateAllowed, false);
  assert.match(observeGate.blockedReasons.join('\\n'), /observe-only/);

  const dryRunTarget = validationTarget({
    automaticActions: {
      minorAutoRepair: {
        ...observeTarget.automaticActions.minorAutoRepair,
        rolloutMode: 'minor-auto-dry-run',
      },
    },
  });
  const dryRunPlan = planAutomaticAction(dryRunTarget, {}, pr, classification, { dryRun: false, now: Date.parse('2026-05-09T10:00:00Z') });
  assert.equal(dryRunPlan.allowed, true);
  assert.equal(dryRunPlan.pushAllowed, false);
  assert.equal(dryRunPlan.mutatesBranch, false);
  assert.equal(dryRunPlan.dryRun, true);

  const liveTarget = validationTarget({
    automaticActions: {
      minorAutoRepair: {
        ...observeTarget.automaticActions.minorAutoRepair,
        rolloutMode: 'minor-auto-live-limited',
      },
    },
  });
  const breakerGate = buildMinorAutoRepairGate(liveTarget, { minorAutoCircuitBreaker: { state: 'open', reason: 'post-push failed' } }, pr, classification, { changedPaths: ['CHANGELOG.md'] });
  assert.equal(breakerGate.gateAllowed, false);
  assert.match(breakerGate.blockedReasons.join('\n'), /circuit breaker is open/);

  const bad = validateConfigObject({
    targets: [validationTarget({
      automaticActions: { minorAutoRepair: { enabled: true, rolloutMode: 'minor-auto-live-limited', scope: MINOR_AUTO_SAFE_REPAIR_SCOPE, actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR, pathAllowlist: ['CHANGELOG.md'], resolverAllowlist: ['merge-changelog-top-entry'] } },
    })],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\\n'), /branchAllowlist must be a non-empty string array/);
});

test('multi-target live repair requires explicit fleet approval naming selected targets', () => {
  const targets = [validationTarget(), validationTarget({ id: 'target-2', number: 2, statePath: '/tmp/pr-shepherd/state-2.json', lockPath: '/tmp/pr-shepherd/lock-2.lock' })];
  assert.match(
    multiTargetLiveRepairGateFailures({ targets }, targets, { cmd: 'repair', dryRun: false }).join('\n'),
    /multiTargetLiveRepair\.enabled is not true/,
  );
  assert.deepEqual(
    multiTargetLiveRepairGateFailures({ automaticActions: { multiTargetLiveRepair: multiTargetApproval }, targets }, targets, { cmd: 'repair', dryRun: false }),
    [],
  );
  assert.deepEqual(multiTargetLiveRepairGateFailures({ targets }, targets, { cmd: 'repair', dryRun: true }), []);

  const malformed = validateConfigObject({
    automaticActions: { multiTargetLiveRepair: { enabled: true } },
    targets: [validationTarget()],
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join('\n'), /multiTargetLiveRepair\.scope must be multi-target-auto-safe-repair/);
  assert.match(malformed.errors.join('\n'), /multiTargetLiveRepair\.targetIds must be a non-empty string array/);
});

test('action ledger appends once and redacts secrets/private paths', () => {
  const state = {};
  const target = validationTarget({
    worktreePath: '/private/operator/worktree',
    statePath: '/private/operator/state/state.json',
    lockPath: '/private/operator/state/lock',
    automaticActions: {
      liveRepair: {
        enabled: true,
        scope: 'auto-safe-repair',
        approvalId: 'approval-ledger-1',
        approvedAt: '2026-05-08T05:00:00Z',
        approvedBy: 'operator',
        branchAllowlist: ['feature'],
      },
    },
  });
  const entry = {
    id: 'repair:target-1:abc123:failed',
    actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
    result: 'failed',
    approval: {
      id: 'approval-ledger-1',
      approvedBy: 'operator',
      approvedAt: '2026-05-08T05:00:00Z',
      scope: 'auto-safe-repair',
    },
    expectedHeadOid: 'abc123',
    expectedBaseOid: 'base123',
    repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY',
    rollbackNote: 'failed in /private/operator/worktree with token=ghp_123456789012345678901234',
    details: { log: 'state at /private/operator/state/state.json' },
  };
  assert.equal(appendActionLedgerEntry(state, target, entry, new Date('2026-05-08T06:00:00Z')), true);
  assert.equal(appendActionLedgerEntry(state, target, entry, new Date('2026-05-08T06:01:00Z')), false);
  assert.equal(state.actionLedger.length, 1);
  const json = JSON.stringify(state.actionLedger[0]);
  assert.doesNotMatch(json, /ghp_123456789012345678901234/);
  assert.doesNotMatch(json, /\/private\/operator/);
  assert.match(json, /<worktree-root>/);
  assert.match(json, /<state-file>/);
  assert.equal(summarizeActionLedger(state.actionLedger).recent[0].approvalId, 'approval-ledger-1');
});

test('review-state feedback appends an idempotent sanitized operator decision ledger entry', () => {
  assert.equal(REVIEW_DECISION_OUTCOMES.includes('route-code-assisted'), true);
  const target = validationTarget({
    worktreePath: '/private/operator/worktree',
    statePath: '/private/operator/state.json',
    privatePaths: ['/private/operator'],
  });
  const handoff = {
    schema: 'pr-shepherd-repair-plan-handoff/v1',
    createdAt: '2026-05-08T07:00:00Z',
    target: target.id,
    pr: target.pr,
    url: 'https://github.com/owner/repo/pull/1',
    decision: { kind: 'code-assisted-review', actionClass: AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT },
    expectedRefs: { headRefOid: 'head-1', baseRefOid: 'base-1', headBranch: 'feature', baseBranch: 'main' },
    prState: { classification: 'dirty', checks: { failedCount: 0, pendingCount: 0 } },
    focusedCommandHints: ['npm test'],
    terminalLedgerMarker: 'Done',
  };
  const currentPr = { ...base, headRefOid: 'head-1', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' };
  const state = {};
  const feedback = buildReviewStateFeedback(handoff, currentPr, state, {
    target,
    decision: 'route-code-assisted',
    operator: 'gwakga',
    nextOwner: 'Team2',
    workstream: 'telegram-outbound',
    summary: 'Review artifact only; see /private/operator/worktree; token ghp_123456789012345678901234.',
    now: new Date('2026-05-08T08:00:00Z'),
  });

  assert.equal(feedback.schema, 'pr-shepherd-review-state-feedback/v1');
  assert.equal(feedback.noLiveApproval, true);
  assert.equal(feedback.productionMutation, false);
  assert.equal(feedback.outcome, 'route-code-assisted');
  assert.equal(feedback.status, 'recorded');
  assert.equal(feedback.terminalLedgerMarker, 'Done');
  assert.equal(feedback.staleEvidence.stale, false);
  assert.match(feedback.riskFlags.join(','), /code-assisted-review-only/);
  assert.doesNotMatch(JSON.stringify(feedback), /ghp_123456789012345678901234/);
  assert.doesNotMatch(JSON.stringify(feedback), /\/private\/operator/);

  assert.equal(appendOperatorDecisionLedgerEntry(state, target, feedback, new Date(feedback.createdAt)), true);
  assert.equal(appendOperatorDecisionLedgerEntry(state, target, feedback, new Date(feedback.createdAt)), false);
  assert.equal(state.operatorDecisionLedger.length, 1);
  const summary = summarizeOperatorDecisionLedger(state.operatorDecisionLedger);
  assert.equal(summary.count, 1);
  assert.equal(summary.recent[0].outcome, 'route-code-assisted');
  assert.equal(summary.recent[0].noLiveApproval, true);
});

test('review-state feedback blocks stale evidence and unsupported transitions', () => {
  const handoff = {
    schema: 'pr-shepherd-repair-plan-handoff/v1',
    createdAt: '2026-05-08T07:00:00Z',
    target: 'target-1',
    pr: 'owner/repo#1',
    decision: { kind: 'code-assisted-review', actionClass: AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT },
    expectedRefs: { headRefOid: 'old-head', baseRefOid: 'base-1' },
    prState: { classification: 'dirty', checks: { failedCount: 0, pendingCount: 0 } },
  };
  const stale = buildReviewStateFeedback(handoff, { ...base, headRefOid: 'new-head', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, {}, {
    target: validationTarget(),
    decision: 'route-code-assisted',
  });
  assert.equal(stale.outcome, 'blocked-stale');
  assert.equal(stale.terminalLedgerMarker, 'Block');
  assert.match(stale.blockedReasons.join('\n'), /headRefOid differs/);

  const unsupported = buildReviewStateFeedback({ ...handoff, expectedRefs: { headRefOid: 'head-1', baseRefOid: 'base-1' } }, { ...base, headRefOid: 'head-1', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, {}, {
    target: validationTarget(),
    decision: 'accepted-for-rehearsal',
  });
  assert.equal(unsupported.outcome, 'blocked-risk');
  assert.equal(unsupported.terminalLedgerMarker, 'Block');
  assert.match(unsupported.blockedReasons.join('\n'), /does not support outcome accepted-for-rehearsal/);
});

test('Phase J supervised rehearsal queue emits a dry-run-only packet and ledger entry', () => {
  const target = validationTarget({ privatePaths: ['/private/operator'] });
  const handoff = {
    schema: 'pr-shepherd-repair-plan-handoff/v1',
    createdAt: '2026-05-09T01:00:00Z',
    target: target.id,
    pr: target.pr,
    decision: { kind: 'auto-safe-rehearsal', actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL },
    expectedRefs: { headRefOid: 'head-1', baseRefOid: 'base-1', headBranch: 'feature', baseBranch: 'main' },
    prState: { classification: 'dirty', checks: { failedCount: 0, pendingCount: 0 } },
    terminalLedgerMarker: 'Done',
  };
  const currentPr = { ...base, headRefOid: 'head-1', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' };
  const feedback = buildReviewStateFeedback(handoff, currentPr, {}, {
    target,
    decision: 'accepted-for-rehearsal',
    operator: 'gwakga',
    summary: 'Queue supervised dry-run from /private/operator; token ghp_123456789012345678901234.',
    now: new Date('2026-05-09T01:05:00Z'),
  });
  assert.equal(feedback.status, 'recorded');
  assert.equal(feedback.outcome, 'accepted-for-rehearsal');

  const state = { lastSeenHeadOid: 'head-1', lastSeenBaseOid: 'base-1' };
  const packet = buildSupervisedRehearsalQueuePacket(feedback, currentPr, state, {
    target,
    now: new Date('2026-05-09T01:10:00Z'),
    queueName: 'phase-j-supervised-rehearsal',
  });
  assert.equal(packet.schema, 'pr-shepherd-supervised-rehearsal-queue/v1');
  assert.equal(packet.queueAllowed, true);
  assert.equal(packet.status, 'queued');
  assert.equal(packet.dryRunOnly, true);
  assert.equal(packet.pushAllowed, false);
  assert.equal(packet.mutatesBranch, false);
  assert.equal(packet.noLiveApproval, true);
  assert.equal(packet.dryRunPacket.schema, 'pr-shepherd-rehearsal-dry-run-packet/v1');
  assert.deepEqual(packet.dryRunPacket.command, ['node', 'pr-shepherd.mjs', 'rehearse', '--config', '<config>', '--target', 'target-1']);
  assert.equal(packet.queueItem.actionClass, AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL);
  assert.equal(packet.terminalLedgerMarker, 'Done');
  assert.doesNotMatch(JSON.stringify(packet), /ghp_123456789012345678901234/);
  assert.doesNotMatch(JSON.stringify(packet), /\/private\/operator/);

  assert.equal(appendSupervisedRehearsalQueueLedgerEntry(state, target, packet, new Date(packet.createdAt)), true);
  assert.equal(appendSupervisedRehearsalQueueLedgerEntry(state, target, packet, new Date(packet.createdAt)), false);
  assert.equal(state.supervisedRehearsalQueueLedger.length, 1);
  assert.equal(state.supervisedRehearsalQueueLedger[0].dryRunOnly, true);
});

test('Phase J supervised rehearsal queue blocks stale refs, review changes, and runtime-context evidence', () => {
  const target = validationTarget();
  const feedback = {
    schema: 'pr-shepherd-review-state-feedback/v1',
    decisionId: 'decision-1',
    createdAt: '2026-05-09T01:00:00Z',
    expiresAt: '2026-05-09T07:00:00Z',
    target: target.id,
    pr: target.pr,
    status: 'recorded',
    decisionAllowed: true,
    outcome: 'accepted-for-rehearsal',
    terminalLedgerMarker: 'Done',
    noLiveApproval: true,
    expectedRefs: { headRefOid: 'old-head', baseRefOid: 'base-1', headBranch: 'feature', baseBranch: 'main' },
    reviewState: { classification: 'dirty', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' },
    staleEvidence: { stale: false, reasons: [] },
  };
  const packet = buildSupervisedRehearsalQueuePacket(feedback, { ...base, headRefOid: 'new-head', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' }, {}, {
    target,
    now: new Date('2026-05-09T01:10:00Z'),
    artifactEvidencePaths: ['AGENTS.md'],
  });
  assert.equal(packet.queueAllowed, false);
  assert.equal(packet.terminalLedgerMarker, 'Block');
  assert.deepEqual(packet.evidenceHygiene.offendingRuntimeContextPaths, ['AGENTS.md']);
  assert.match(packet.blockedReasons.join('\n'), /CHANGES_REQUESTED/);
  assert.match(packet.blockedReasons.join('\n'), /headRefOid differs/);
  assert.match(packet.blockedReasons.join('\n'), /AGENTS\.md/);
});

test('decision-ledger CLI smoke records review feedback without network or branch mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-decision-'));
  try {
    const handoffPath = join(dir, 'handoff.json');
    const prStatePath = join(dir, 'pr-state.json');
    const statePath = join(dir, 'state.json');
    writeFileSync(handoffPath, JSON.stringify({
      schema: 'pr-shepherd-repair-plan-handoff/v1',
      createdAt: '2026-05-08T07:00:00Z',
      target: 'target-1',
      pr: 'owner/repo#1',
      decision: { kind: 'code-assisted-review', actionClass: AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT },
      expectedRefs: { headRefOid: 'head-1', baseRefOid: 'base-1' },
      prState: { classification: 'dirty', checks: { failedCount: 0, pendingCount: 0 } },
    }));
    writeFileSync(prStatePath, JSON.stringify({ ...base, headRefOid: 'head-1', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname,
      'decision-ledger', '--handoff', handoffPath, '--pr-state', prStatePath, '--state', statePath,
      '--decision', 'route-code-assisted', '--operator', 'gwakga', '--next-owner', 'Team2'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.feedback.noLiveApproval, true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.operatorDecisionLedger.length, 1);
    assert.equal(state.operatorDecisionLedger[0].outcome, 'route-code-assisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearsal-queue CLI smoke writes a dry-run packet without network or branch mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-rehearsal-queue-'));
  try {
    const feedbackPath = join(dir, 'feedback.json');
    const prStatePath = join(dir, 'pr-state.json');
    const statePath = join(dir, 'state.json');
    const outputPath = join(dir, 'queue.json');
    const createdAt = new Date(Date.now() - 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(feedbackPath, JSON.stringify({
      schema: 'pr-shepherd-review-state-feedback/v1',
      decisionId: 'decision-queue-1',
      createdAt,
      expiresAt,
      target: 'target-1',
      pr: 'owner/repo#1',
      status: 'recorded',
      decisionAllowed: true,
      outcome: 'accepted-for-rehearsal',
      terminalLedgerMarker: 'Done',
      noLiveApproval: true,
      expectedRefs: { headRefOid: 'head-1', baseRefOid: 'base-1', headBranch: 'feature', baseBranch: 'main' },
      reviewState: { classification: 'dirty', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' },
      staleEvidence: { stale: false, reasons: [] },
    }));
    writeFileSync(prStatePath, JSON.stringify({ ...base, headRefOid: 'head-1', baseRefOid: 'base-1', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' }));
    writeFileSync(statePath, JSON.stringify({ lastSeenHeadOid: 'head-1', lastSeenBaseOid: 'base-1' }));
    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname,
      'rehearsal-queue', '--feedback', feedbackPath, '--pr-state', prStatePath, '--state', statePath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.packet.dryRunPacket.schema, 'pr-shepherd-rehearsal-dry-run-packet/v1');
    const packet = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(packet.queueAllowed, true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.supervisedRehearsalQueueLedger.length, 1);
    assert.equal(state.supervisedRehearsalQueueLedger[0].noLiveApproval, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observation ledger summarizes 24-48h frequency and recheck suggestions', () => {
  const now = new Date('2026-05-08T12:00:00Z');
  const summary = summarizeObservationLedger([
    { at: '2026-05-08T11:00:00Z', kind: 'clean', actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK, failedCount: 0, pendingCount: 0 },
    { at: '2026-05-08T10:00:00Z', kind: 'unknown', actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK, failedCount: 0, pendingCount: 0 },
    { at: '2026-05-07T11:30:00Z', kind: 'failed', actionClass: AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE, failedCount: 2, pendingCount: 1 },
    { at: '2026-05-05T11:00:00Z', kind: 'dirty', actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, failedCount: 0, pendingCount: 0 },
  ], now);

  assert.equal(summary.entries, 4);
  assert.equal(summary.last24h.total, 2);
  assert.equal(summary.last24h.byKind.clean, 1);
  assert.equal(summary.last24h.byKind.unknown, 1);
  assert.equal(summary.last24h.recheckSuggested, 2);
  assert.equal(summary.last48h.total, 3);
  assert.equal(summary.last48h.byKind.failed, 1);
  assert.equal(summary.last48h.failedChecksMax, 2);
  assert.equal(summary.lastWarningKind, 'failed');
});

test('status command reads state files without network access and summarizes the action and observation ledgers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-status-'));
  try {
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    // The spawned CLI computes 24h/48h observation windows from the real
    // clock, so fixture timestamps must stay relative to now.
    const recentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify({
      disabled: false,
      lastKind: 'failed',
      lastMergeable: 'MERGEABLE',
      lastMergeStateStatus: 'UNSTABLE',
      lastSeenHeadOid: 'head-a',
      lastSeenBaseOid: 'base-a',
      lastFailureNames: ['lint'],
      lastPendingCount: 1,
      lastNotificationKey: 'failed:head-a:lint',
      lastAutomaticActionExecution: {
        status: 'blocked',
        actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK,
        reasons: ['missing approval'],
      },
      autoPushes: [{ at: new Date().toISOString(), from: 'old', to: 'new' }],
      actionLedger: [{
        at: recentAt,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        result: 'failed',
        approval: { id: 'approval-status-1', approvedBy: 'operator', scope: 'auto-safe-repair' },
        repairKey: 'repair:head-a:base-a:CONFLICTING:DIRTY',
      }],
      observationLedger: [{
        at: recentAt,
        kind: 'failed',
        actionClass: AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE,
        failedCount: 1,
        pendingCount: 1,
      }],
      lastWarningAt: recentAt,
      lastWarningKind: 'failed',
      lastDoctorWarnings: ['failed checks observed 1 times in 48h; operator review required before rehearsal'],
      nextRecommendedAction: 'operator review failed checks; keep branch mutation disabled',
    }));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({ statePath, lockPath: join(dir, 'lock'), worktreePath: join(dir, 'worktree') })],
    }));
    assert.equal(buildStatusRows([validationTarget({ statePath })])[0].lastKind, 'failed');

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'status', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.target, 'target-1');
    assert.equal(status.lastKind, 'failed');
    assert.deepEqual(status.lastFailureNames, ['lint']);
    assert.equal(status.recentAutoPushCount, 1);
    assert.equal(status.automaticAction.status, 'blocked');
    assert.deepEqual(status.automaticAction.reasons, ['missing approval']);
    assert.equal(status.actionLedger.count, 1);
    assert.equal(status.actionLedger.recent[0].approvalId, 'approval-status-1');
    assert.equal(status.actionLedger.recent[0].result, 'failed');
    assert.equal(status.observationSummary.entries, 1);
    assert.equal(status.observationSummary.last48h.byKind.failed, 1);
    assert.equal(status.recentRunAt, recentAt);
    assert.equal(status.lastWarningKind, 'failed');
    assert.deepEqual(status.doctorWarnings, ['failed checks observed 1 times in 48h; operator review required before rehearsal']);
    assert.equal(status.nextRecommendedAction, 'operator review failed checks; keep branch mutation disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFakeGh(binDir, pr) {
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(pr))});\n`);
  chmodSync(ghPath, 0o755);
}

function writeFakeGhSequence(binDir, prs) {
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, 'gh');
  const countPath = join(binDir, 'gh-count.txt');
  writeFileSync(ghPath, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const countPath = ${JSON.stringify(countPath)};
const prs = ${JSON.stringify(prs)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify(prs[Math.min(count, prs.length - 1)]));
`);
  chmodSync(ghPath, 0o755);
  return countPath;
}

test('fleet operator brief summarizes tiers and incidents without live sends', () => {
  const rows = [
    { target: 'a', targetTier: 'check-only', lastKind: 'clean', doctorWarnings: [] },
    { target: 'b', targetTier: 'phase-d-ready', lastKind: 'dirty', incident: { severity: 'block' }, doctorWarnings: ['blocked'] },
    { target: 'c', targetTier: 'live-approved-once', lastKind: 'unknown', doctorWarnings: [] },
  ];
  const brief = buildFleetOperatorBrief(rows);
  assert.equal(brief.targets, 3);
  assert.equal(brief.tiers['check-only'], 1);
  assert.equal(brief.approvalReadyCount, 1);
  assert.equal(brief.liveApprovedOnceCount, 1);
  assert.equal(brief.blockedCount, 1);
  assert.deepEqual(brief.affectedTargets, ['b']);
  assert.equal(brief.liveSendsDefault, 'disabled-or-dry-run');
});

test('check --all emits one mixed-target summary and keeps per-target state isolated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-check-all-'));
  try {
    const fakeBin = join(dir, 'bin');
    const configPath = join(dir, 'config.json');
    const statePath1 = join(dir, 'state-1.json');
    const statePath2 = join(dir, 'state-2.json');
    writeFakeGhSequence(fakeBin, [
      base,
      { ...base, number: 2, headRefOid: 'def456', statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] },
    ]);
    writeFileSync(configPath, JSON.stringify({
      targets: [
        validationTarget({ statePath: statePath1, lockPath: join(dir, 'lock-1'), worktreePath: join(dir, 'missing-worktree-1'), notify: { mode: 'none' } }),
        validationTarget({ id: 'target-2', number: 2, statePath: statePath2, lockPath: join(dir, 'lock-2'), worktreePath: join(dir, 'missing-worktree-2'), notify: { mode: 'none' } }),
      ],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'check', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.command, 'check');
    assert.deepEqual(summary.targets.map((target) => [target.target, target.ok, target.kind]), [
      ['target-1', true, 'clean'],
      ['target-2', true, 'failed'],
    ]);
    const state1 = JSON.parse(readFileSync(statePath1, 'utf8'));
    const state2 = JSON.parse(readFileSync(statePath2, 'utf8'));
    assert.equal(state1.lastSeenHeadOid, 'abc123');
    assert.equal(state2.lastSeenHeadOid, 'def456');
    assert.equal(state1.observationLedger.length, 1);
    assert.equal(state1.observationSummary.last48h.byKind.clean, 1);
    assert.equal(state1.nextRecommendedAction, 'continue check-only observation until 24-48h stable, then consider Phase C rehearsal criteria');
    assert.equal(state2.observationLedger.length, 1);
    assert.equal(state2.observationSummary.last48h.byKind.failed, 1);
    assert.equal(state2.lastWarningKind, 'failed');
    assert.match(state2.lastDoctorWarnings.join('\n'), /failed checks observed 1 times in 48h/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repair --all without fleet approval fails closed before GitHub or worktree access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-repair-all-block-'));
  try {
    const configPath = join(dir, 'config.json');
    const statePath1 = join(dir, 'state-1.json');
    const statePath2 = join(dir, 'state-2.json');
    writeFileSync(configPath, JSON.stringify({
      targets: [
        validationTarget({ statePath: statePath1, lockPath: join(dir, 'lock-1'), worktreePath: join(dir, 'missing-worktree-1'), notify: { mode: 'none' } }),
        validationTarget({ id: 'target-2', number: 2, statePath: statePath2, lockPath: join(dir, 'lock-2'), worktreePath: join(dir, 'missing-worktree-2'), notify: { mode: 'none' } }),
      ],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'repair', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /multi-target live repair blocked/);
    assert.equal(existsSync(statePath1), false);
    assert.equal(existsSync(statePath2), false);
    assert.equal(existsSync(join(dir, 'missing-worktree-1')), false);
    assert.equal(existsSync(join(dir, 'missing-worktree-2')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSituationReportLine includes no-action next action for healthy PRs', () => {
  const line = buildSituationReportLine(validationTarget(), {}, base, { kind: 'clean', checks: { failed: [], pending: [] } });
  assert.match(line, /target=target-1/);
  assert.match(line, /repo=owner\/repo/);
  assert.match(line, /classification=clean/);
  assert.match(line, /mergeable=MERGEABLE/);
  assert.match(line, /mergeStateStatus=CLEAN/);
  assert.match(line, /checks failed=0 pending=0/);
  assert.match(line, /nextAction=none/);
  assert.match(line, /현재 조치할 것 없음 \/ no action needed/);
});

test('check emits a full no-action situation report once per cadence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-situation-clean-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const hookPath = join(dir, 'hook.mjs');
    const hookOutPath = join(dir, 'hook-output.jsonl');
    writeFakeGh(fakeBin, base);
    writeFileSync(hookPath, [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.argv[2], JSON.stringify({",
      '  message: process.env.PR_SHEPHERD_MESSAGE,',
      '  kind: process.env.PR_SHEPHERD_KIND,',
      '  key: process.env.PR_SHEPHERD_KEY,',
      '  mode: process.env.PR_SHEPHERD_NOTIFY_MODE,',
      '}) + "\\n");',
      '',
    ].join('\n'));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: join(dir, 'missing-worktree'),
        notify: { mode: 'command', command: [process.execPath, hookPath, hookOutPath], situationReportEveryMs: 3600000 },
      })],
    }));

    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'check', '--config', configPath, '--target', 'target-1'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: fakeBin },
      });
      assert.equal(result.status, 0, result.stderr);
    }

    const deliveries = readFileSync(hookOutPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, 'situation');
    assert.match(deliveries[0].key, /^situation:clean:/);
    assert.equal(deliveries[0].mode, 'command');
    assert.match(deliveries[0].message, /owner\/repo#1 situation report/);
    assert.match(deliveries[0].message, /classification=clean/);
    assert.match(deliveries[0].message, /checks failed=0 pending=0/);
    assert.match(deliveries[0].message, /nextAction=none/);
    assert.match(deliveries[0].message, /no action needed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check can emit every healthy situation report when cadence is zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-situation-every-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const hookPath = join(dir, 'hook.mjs');
    const hookOutPath = join(dir, 'hook-output.jsonl');
    writeFakeGh(fakeBin, base);
    writeFileSync(hookPath, [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.argv[2], process.env.PR_SHEPHERD_MESSAGE + '\\n');",
      '',
    ].join('\n'));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: join(dir, 'missing-worktree'),
        notify: { mode: 'command', command: [process.execPath, hookPath, hookOutPath], situationReportEveryMs: 0 },
      })],
    }));

    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'check-canary', '--config', configPath, '--target', 'target-1'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: fakeBin },
      });
      assert.equal(result.status, 0, result.stderr);
    }

    const deliveries = readFileSync(hookOutPath, 'utf8').trim().split('\n');
    assert.equal(deliveries.length, 2);
    assert.match(deliveries[0], /no action needed/);
    assert.match(deliveries[1], /no action needed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canary command exercises command notifier hook without GitHub or state mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-canary-'));
  try {
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const hookPath = join(dir, 'hook.mjs');
    const hookOutPath = join(dir, 'hook-output.json');
    writeFileSync(hookPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], JSON.stringify({",
      '  message: process.env.PR_SHEPHERD_MESSAGE,',
      '  target: process.env.PR_SHEPHERD_TARGET,',
      '  pr: process.env.PR_SHEPHERD_PR,',
      '  url: process.env.PR_SHEPHERD_URL,',
      '  kind: process.env.PR_SHEPHERD_KIND,',
      '  key: process.env.PR_SHEPHERD_KEY,',
      '}));',
      '',
    ].join('\n'));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: join(dir, 'worktree'),
        notify: { mode: 'command', command: [process.execPath, hookPath, hookOutPath] },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'canary', '--config', configPath, '--all'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(statePath), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.kind, 'canary');
    assert.equal(summary.notifyMode, 'command');
    const hookOutput = JSON.parse(readFileSync(hookOutPath, 'utf8'));
    assert.match(hookOutput.message, /\[pr-shepherd:target-1\] owner\/repo#1 notifier canary/);
    assert.equal(hookOutput.target, 'target-1');
    assert.equal(hookOutput.pr, 'owner/repo#1');
    assert.equal(hookOutput.url, 'https://github.com/owner/repo/pull/1');
    assert.equal(hookOutput.kind, 'canary');
    assert.equal(hookOutput.key, 'canary:target-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('field deployment doctor package is read-only and validates check-only canary config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-field-doctor-'));
  try {
    const doctorPath = new URL('./examples/field-deploy/doctor.mjs', import.meta.url).pathname;
    const configPath = join(dir, 'config.json');
    const statePath = join(dir, 'state.json');
    const lockPath = join(dir, 'lock');
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        id: 'openclaw-78261',
        pr: 'openclaw/openclaw#78261',
        owner: 'openclaw',
        repo: 'openclaw',
        number: 78261,
        statePath,
        lockPath,
        worktreePath: join(dir, 'missing-worktree'),
        notify: {
          mode: 'openclaw',
          dryRun: true,
          command: ['/usr/local/bin/pr-shepherd-openclaw-telegram-notify'],
          situationReportEveryMs: 0,
        },
      })],
    }));

    const result = spawnSync(process.execPath, [doctorPath, '--config', configPath, '--target', 'openclaw-78261'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-gh' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(statePath), false);
    assert.equal(existsSync(lockPath), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, 'pr-shepherd-field-deploy-doctor/v1');
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.reports.config.targets[0].target, 'openclaw-78261');
    assert.equal(report.reports.package.checks.some((check) => check.name === 'wrapper'), true);
    assert.equal(report.reports.package.checks.some((check) => check.name === 'live-readiness-go-no-go'), true);
    assert.equal(report.reports.package.checks.some((check) => check.name === 'phase-a-standing-ops'), true);
    assert.equal(report.reports.package.checks.some((check) => check.name === 'phase-d-operator-decision-packet'), true);
    assert.equal(report.reports.package.checks.some((check) => check.name === 'phase-f-fleet-safe-controls-limited-autonomy'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('field deployment Telegram wrapper examples default to check-only no-send', () => {
  const wrapperPath = new URL('./examples/field-deploy/pr-shepherd-openclaw-telegram-notify.sh', import.meta.url).pathname;
  const servicePath = new URL('./examples/field-deploy/pr-shepherd-check-canary@.service.example', import.meta.url).pathname;
  const timerPath = new URL('./examples/field-deploy/pr-shepherd-check-canary@.timer.example', import.meta.url).pathname;
  const fragmentPath = new URL('./examples/field-deploy/openclaw-78261-notify.fragment.example.json', import.meta.url).pathname;

  const syntax = spawnSync('sh', ['-n', wrapperPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const dryRun = spawnSync('sh', [wrapperPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PR_SHEPHERD_MESSAGE: '[pr-shepherd:openclaw-78261] openclaw/openclaw#78261 situation report classification=clean nextAction=none / no action needed',
      PR_SHEPHERD_TARGET: 'openclaw-78261',
      PR_SHEPHERD_PR: 'openclaw/openclaw#78261',
      PR_SHEPHERD_KIND: 'situation',
      PR_SHEPHERD_KEY: 'situation:clean:test',
    },
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dryRun=1/);
  assert.match(dryRun.stdout, /target=openclaw-78261/);

  const liveMissingTarget = spawnSync('sh', [wrapperPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PR_SHEPHERD_NOTIFY_DRY_RUN: '0',
      PR_SHEPHERD_MESSAGE: 'live smoke should fail before delivery without OpenClaw target',
      PR_SHEPHERD_TARGET: 'openclaw-78261',
      PR_SHEPHERD_PR: 'openclaw/openclaw#78261',
      PR_SHEPHERD_KIND: 'situation',
      PR_SHEPHERD_KEY: 'situation:clean:test',
    },
  });
  assert.equal(liveMissingTarget.status, 2);
  assert.match(liveMissingTarget.stderr, /PR_SHEPHERD_OPENCLAW_TARGET is required/);

  const wrapper = readFileSync(wrapperPath, 'utf8');
  assert.match(wrapper, /openclaw.*message send/s);
  assert.doesNotMatch(wrapper, /api\.telegram\.org|curl -fsS|botToken|TELEGRAM_BOT_TOKEN/);

  const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'));
  assert.equal(fragment.notify.mode, 'openclaw');
  assert.equal(fragment.notify.dryRun, true);
  assert.deepEqual(fragment.notify.command, ['/usr/local/bin/pr-shepherd-openclaw-telegram-notify']);
  assert.equal(fragment.notify.situationReportEveryMs, 0);

  const service = readFileSync(servicePath, 'utf8');
  assert.match(service, /PR_SHEPHERD_NOTIFY_DRY_RUN=1/);
  assert.match(service, /check-canary --config <pr-shepherd-repo>\/config\.json --target %i/);
  assert.doesNotMatch(service, / repair /);

  const timer = readFileSync(timerPath, 'utf8');
  assert.match(timer, /OnUnitActiveSec=10min/);
});

test('check-canary is explicit check-only monitoring and does not require a worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-check-canary-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGh(fakeBin, base);
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        notify: { mode: 'none' },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'check-canary', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(missingWorktree), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.kind, 'clean');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.lastKind, 'clean');
    assert.equal(state.lastSeenHeadOid, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-canary rechecks transient UNKNOWN mergeability before reporting action needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-check-canary-unknown-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGhSequence(fakeBin, [
      { ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      base,
    ]);
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        notify: { mode: 'none' },
        unknownRecheckAttempts: 2,
        unknownRecheckDelayMs: 0,
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'check-canary', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(missingWorktree), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.kind, 'clean');
    assert.equal(summary.mergeable, 'MERGEABLE');
    assert.equal(summary.mergeStateStatus, 'CLEAN');
    assert.equal(summary.rechecks, 1);
    assert.equal(summary.plannedAction.status, 'planned');
    assert.equal(summary.plannedAction.actionClass, AUTOMATIC_ACTION_CLASSES.RECHECK);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.lastKind, 'clean');
    assert.equal(state.lastMergeable, 'MERGEABLE');
    assert.equal(state.lastUnknownRecheckCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRepairRehearsalApprovalPackage renders target-specific approval evidence without mutation', () => {
  const target = validationTarget({ pr: 'owner/repo#1', url: 'https://github.com/owner/repo/pull/1' });
  const pr = { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const plan = planAutomaticAction(target, {}, pr, { kind: 'dirty', checks: { failed: [], pending: [] } }, { dryRun: true, now: 1000 });
  const pkg = buildRepairRehearsalApprovalPackage(target, pr, {}, plan, { now: new Date('2026-05-08T07:00:00Z'), classification: 'dirty' });

  assert.equal(pkg.schema, 'pr-shepherd-repair-rehearsal-approval/v1');
  assert.equal(pkg.dryRunOnly, true);
  assert.equal(pkg.productionMutation, false);
  assert.deepEqual(pkg.rehearsalCommand, ['node', 'pr-shepherd.mjs', 'rehearse', '--config', '<config>', '--target', 'target-1']);
  assert.deepEqual(pkg.liveRepairCommand, ['node', 'pr-shepherd.mjs', 'repair', '--config', '<config>', '--target', 'target-1']);
  assert.equal(pkg.expectedRefs.headRefOid, 'abc123');
  assert.equal(pkg.expectedRefs.baseRefOid, 'base123');
  assert.equal(pkg.expectedRefs.repairKey, 'repair:abc123:base123:CONFLICTING:DIRTY');
  assert.match(pkg.approvalText, /One-shot approval required/);
  assert.match(pkg.approvalText, /repair:abc123:base123:CONFLICTING:DIRTY/);
  assert.match(pkg.abortCriteria.join('\n'), /runtime\/bootstrap context paths/);
  assert.match(pkg.rollbackNote, /no branch mutation, no push/);
});

test('Phase K rehearsal digest records a fail-closed Phase D candidate gate', () => {
  const target = validationTarget({ pr: 'owner/repo#1', url: 'https://github.com/owner/repo/pull/1' });
  const pr = { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: true, now: Date.parse('2026-05-08T07:00:00Z') });
  const approvalPackage = buildRepairRehearsalApprovalPackage(target, pr, {}, plan, {
    now: new Date('2026-05-08T07:00:00Z'),
    repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY',
    baseOid: 'base123',
    classification: 'dirty',
  });
  const state = {
    lastRepairRehearsal: {
      at: '2026-05-08T07:00:00.000Z',
      target: 'target-1',
      repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY',
      headRefOid: 'abc123',
      baseOid: 'base123',
      approvalPackage,
    },
    actionLedger: [{ actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, result: 'rehearsed', repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY' }],
  };

  const gate = buildPhaseDCandidateGate(target, pr, state, { classification, now: new Date('2026-05-08T07:05:00Z') });
  assert.equal(gate.schema, 'pr-shepherd-phase-d-candidate-gate/v1');
  assert.equal(gate.candidateAllowed, true);
  assert.equal(gate.noLiveApproval, true);
  assert.equal(gate.terminalLedgerMarker, 'Done');

  const digest = buildRehearsalEvidenceDigest(target, pr, state, { classification, now: new Date('2026-05-08T07:05:00Z'), phaseDCandidateGate: gate });
  assert.equal(digest.schema, 'pr-shepherd-rehearsal-evidence-digest/v1');
  assert.equal(digest.phaseDCandidateGate.candidateAllowed, true);
  assert.equal(digest.pushAllowed, false);
  assert.equal(digest.nextStep.includes('Phase D operator packet'), true);

  const contaminated = buildPhaseDCandidateGate(target, pr, state, {
    classification,
    now: new Date('2026-05-08T07:05:00Z'),
    artifactEvidencePaths: ['.openclaw/workspace-state.json'],
  });
  assert.equal(contaminated.candidateAllowed, false);
  assert.deepEqual(contaminated.evidenceHygiene.offendingRuntimeContextPaths, ['.openclaw/workspace-state.json']);
  assert.match(contaminated.blockedReasons.join('\n'), /runtime\/bootstrap context paths/);
});


test('Phase L assembles a sanitized Phase D operator packet and blocks contaminated evidence', () => {
  const target = validationTarget({
    pr: 'owner/repo#1',
    url: 'https://github.com/owner/repo/pull/1',
    privatePaths: ['/private/operator'],
  });
  const pr = { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: true, now: Date.parse('2026-05-08T07:00:00Z') });
  const approvalPackage = buildRepairRehearsalApprovalPackage(target, pr, {}, plan, {
    now: new Date('2026-05-08T07:00:00Z'),
    repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY',
    baseOid: 'base123',
    classification: 'dirty',
  });
  const state = {
    lastRepairRehearsal: {
      at: '2026-05-08T07:00:00.000Z',
      target: 'target-1',
      repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY',
      headRefOid: 'abc123',
      baseOid: 'base123',
      approvalPackage,
    },
    actionLedger: [{ actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, result: 'rehearsed', repairKey: 'repair:abc123:base123:CONFLICTING:DIRTY' }],
  };
  state.lastRehearsalEvidenceDigest = buildRehearsalEvidenceDigest(target, pr, state, {
    classification,
    now: new Date('2026-05-08T07:05:00Z'),
  });

  const packet = buildPhaseDOperatorPacket(target, pr, state, {
    classification,
    now: new Date('2026-05-08T07:06:00Z'),
    preparedBy: 'automation in /private/operator with token=ghp_123456789012345678901234',
    phaseBSummary: 'observation clean; see /private/operator/state.json',
  });

  assert.equal(packet.schema, 'pr-shepherd-phase-d-operator-packet/v1');
  assert.equal(packet.packetAllowed, true);
  assert.equal(packet.status, 'ready-for-operator');
  assert.equal(packet.noLiveApproval, true);
  assert.equal(packet.pushAllowed, false);
  assert.equal(packet.mutatesBranch, false);
  assert.deepEqual(packet.liveCommandUnderConsideration, ['node', 'pr-shepherd.mjs', 'repair', '--config', '<config>', '--target', 'target-1']);
  assert.equal(packet.expectedRefs.repairKey, 'repair:abc123:base123:CONFLICTING:DIRTY');
  assert.equal(packet.approvalConfigTemplate.automaticActions.liveRepair.scope, 'auto-safe-repair');
  assert.equal(packet.closeout.startMarker, 'Start');
  assert.deepEqual(packet.closeout.returnFields, ['startCommentUrl', 'prUrl', 'doneCommentUrl', 'blockCommentUrl']);
  assert.doesNotMatch(JSON.stringify(packet), /ghp_123456789012345678901234/);
  assert.doesNotMatch(JSON.stringify(packet), /\/private\/operator/);

  const contaminated = buildPhaseDOperatorPacket(target, pr, state, {
    classification,
    now: new Date('2026-05-08T07:06:00Z'),
    artifactEvidencePaths: ['USER.md', '.openclaw/workspace-state.json'],
  });
  assert.equal(contaminated.packetAllowed, false);
  assert.equal(contaminated.terminalLedgerMarker, 'Block');
  assert.deepEqual(contaminated.evidenceHygiene.offendingRuntimeContextPaths, ['.openclaw/workspace-state.json', 'USER.md']);
  assert.match(contaminated.blockedReasons.join('\n'), /USER\.md/);
});

test('rehearse is an approval-gated dry-run repair alias that stops before git mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-rehearse-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGh(fakeBin, { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        notify: { mode: 'none' },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'rehearse', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /action planned: repair-rehearsal/);
    assert.match(result.stdout, /dry-run stops before git mutation/);
    assert.match(result.stdout, /pr-shepherd-repair-rehearsal-approval\/v1/);
    assert.match(result.stdout, /rehearsalEvidenceDigest/);
    assert.equal(existsSync(missingWorktree), false);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.lastKind, 'dirty');
    assert.equal(state.lastMergeStateStatus, 'DIRTY');
    assert.equal(state.lastAutomaticActionExecution.status, 'planned');
    assert.equal(state.lastAutomaticActionExecution.actionClass, AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL);
    assert.equal(state.lastRepairRehearsal.approvalPackage.schema, 'pr-shepherd-repair-rehearsal-approval/v1');
    assert.equal(state.lastRepairRehearsal.approvalPackage.expectedRefs.repairKey, 'repair:abc123:base123:CONFLICTING:DIRTY');
    assert.equal(state.lastRehearsalEvidenceDigest.schema, 'pr-shepherd-rehearsal-evidence-digest/v1');
    assert.equal(state.lastRehearsalEvidenceDigest.phaseDCandidateGate.candidateAllowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearse rejects push approval flags', () => {
  const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'rehearse', '--config', 'config.example.json', '--allow-code-assisted-push'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-code-assisted-push is not allowed/);
});

test('strict verify gate blocks live repair before worktree access when focused checks are missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-live-verify-block-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGh(fakeBin, { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    writeFileSync(statePath, JSON.stringify({
      lastRepairRehearsal: {
        at: '2026-05-08T05:00:00.000Z',
        target: 'target-1',
        repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
        headRefOid: 'abc123',
        baseOid: 'base-a',
        approvalPackage: { schema: 'pr-shepherd-repair-rehearsal-approval/v1', expectedRefs: { headRefOid: 'abc123', baseRefOid: 'base-a', repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY' }, abortCriteria: ['abort'], rollbackNote: 'rollback', evidenceBundle: { evidenceExpiresAt: '2099-05-08T06:00:00Z' } },
      },
      actionLedger: [{ actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, result: 'rehearsed', repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY' }],
    }));
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        focusedChecks: [],
        notify: { mode: 'none' },
        automaticActions: { liveRepair: {
          enabled: true,
          scope: 'auto-safe-repair',
          approvalId: 'approval-verify-1',
          approvedAt: '2026-05-08T05:00:00Z',
          expiresAt: '2099-05-08T06:00:00Z',
          approvedBy: 'operator',
          branchAllowlist: ['feature'],
          targetId: 'target-1',
          owner: 'owner',
          repo: 'repo',
          number: 1,
          pr: 'owner/repo#1',
          actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
          headRefOid: 'abc123',
          baseRefOid: 'base-a',
          repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
          phaseDPacketExpiresAt: '2099-05-08T06:00:00Z',
          rollbackNote: 'disable live repair after the one-shot run',
        } },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'repair', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /strictVerifyRequired/);
    assert.equal(existsSync(missingWorktree), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean target with live approval produces no-op audit and consumes approval without worktree mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-clean-approval-noop-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGh(fakeBin, { ...base, baseRefOid: 'base-a', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        notify: { mode: 'none' },
        automaticActions: { liveRepair: {
          enabled: true,
          scope: 'auto-safe-repair',
          approvalId: 'approval-clean-1',
          approvedAt: '2026-05-08T05:00:00Z',
          expiresAt: '2099-05-08T06:00:00Z',
          approvedBy: 'operator',
          branchAllowlist: ['feature'],
          targetId: 'target-1',
          owner: 'owner',
          repo: 'repo',
          number: 1,
          pr: 'owner/repo#1',
          actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
          headRefOid: 'abc123',
          baseRefOid: 'base-a',
          repairKey: 'repair:abc123:base-a:MERGEABLE:CLEAN',
          phaseDPacketExpiresAt: '2099-05-08T06:00:00Z',
          rollbackNote: 'disable live repair after the one-shot run',
        } },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'repair', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(missingWorktree), false);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.lastPostActionAudit.outcome, 'no-op');
    assert.equal(state.lastPostActionAudit.approvalPresent, true);
    assert.equal(state.lastPostActionAudit.blockReason, 'target-clean');
    assert.equal(state.lastPostActionAudit.mutatesBranch, false);
    assert.equal(liveRepairApprovalState(validationTarget({ automaticActions: { liveRepair: { approvalId: 'approval-clean-1', expiresAt: '2099-05-08T06:00:00Z' } } }), state).state, 'consumed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live repair command fails closed before worktree access without live auto-action config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-live-policy-block-'));
  try {
    const fakeBin = join(dir, 'bin');
    const statePath = join(dir, 'state.json');
    const configPath = join(dir, 'config.json');
    const missingWorktree = join(dir, 'missing-worktree');
    writeFakeGh(fakeBin, { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    writeFileSync(configPath, JSON.stringify({
      targets: [validationTarget({
        statePath,
        lockPath: join(dir, 'lock'),
        worktreePath: missingWorktree,
        notify: { mode: 'none' },
      })],
    }));

    const result = spawnSync(process.execPath, [new URL('./pr-shepherd.mjs', import.meta.url).pathname, 'repair', '--config', configPath, '--target', 'target-1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /automatic action blocked/);
    assert.equal(existsSync(missingWorktree), false);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.lastAutomaticActionPlan.actionClass, AUTOMATIC_ACTION_CLASSES.BLOCK);
    assert.equal(state.lastAutomaticActionExecution.status, 'blocked');
    assert.match(state.lastActionSummary, /automatic action blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifies clean PR', () => {
  assert.equal(classifyPr(base).kind, 'clean');
});

test('classifies dirty/conflicting PR', () => {
  assert.equal(classifyPr({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).kind, 'dirty');
});

test('classifies unstable pending PR without failures', () => {
  const pr = { ...base, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] };
  const c = classifyPr(pr);
  assert.equal(c.kind, 'unstable');
  assert.equal(c.checks.pending.length, 1);
});

test('classifies failed checks', () => {
  const pr = { ...base, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.invalid' }] };
  const c = classifyPr(pr);
  assert.equal(c.kind, 'failed');
  assert.equal(c.checks.failed[0].name, 'lint');
});

test('merged disables before check failures', () => {
  assert.equal(classifyPr({ ...base, state: 'MERGED', mergedAt: '2026-05-07T00:00:00Z', statusCheckRollup: [{ name: 'old', status: 'COMPLETED', conclusion: 'FAILURE' }] }).kind, 'merged');
});

test('notification key is stable for same failed checks', () => {
  const pr = { ...base, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  const c = classifyPr(pr);
  assert.equal(notificationKey('failed', pr, c.checks), notificationKey('failed', pr, c.checks));
});

test('classifyChecks treats success/skipped/neutral as non-failures', () => {
  const c = classifyChecks([
    { name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'neutral', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ]);
  assert.equal(c.failed.length, 0);
  assert.equal(c.pending.length, 0);
});

test('classifyChecks ignores stale duplicate cancelled checks resolved by same-name success', () => {
  const c = classifyChecks([
    { name: 'auto-response', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://example.invalid/cancelled' },
    { name: 'auto-response', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.invalid/success' },
  ]);
  assert.equal(c.failed.length, 0);
  assert.equal(c.pending.length, 0);
  assert.equal(c.ignored.length, 1);
  assert.equal(c.ignored[0].name, 'auto-response');
});

test('classifyChecks keeps unresolved cancelled checks actionable', () => {
  const c = classifyChecks([
    { name: 'auto-response', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://example.invalid/cancelled' },
  ]);
  assert.equal(c.failed.length, 1);
  assert.equal(c.failed[0].name, 'auto-response');
  assert.equal(c.pending.length, 0);
});

test('classifyPr treats mergeable clean PR as clean when duplicate cancelled check is resolved', () => {
  const c = classifyPr({
    ...base,
    statusCheckRollup: [
      { name: 'auto-response', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { name: 'auto-response', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  });
  assert.equal(c.kind, 'clean');
  assert.equal(c.checks.failed.length, 0);
  assert.equal(c.checks.ignored.length, 1);
});

test('automatic action planner fails closed for unknown, failed, and ungated dirty live states', () => {
  const target = validationTarget({ headOwner: 'contributor', baseOwner: 'owner' });
  const unknown = planAutomaticAction(target, {}, { ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, { kind: 'unknown', checks: { failed: [], pending: [] } });
  assert.equal(unknown.actionClass, AUTOMATIC_ACTION_CLASSES.RECHECK);
  assert.equal(unknown.pushAllowed, false);

  const failed = planAutomaticAction(target, {}, { ...base }, { kind: 'failed', checks: { failed: [{ name: 'lint' }], pending: [] } });
  assert.equal(failed.actionClass, AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE);
  assert.equal(failed.pushAllowed, false);

  const dirtyLive = planAutomaticAction(target, {}, { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, { kind: 'dirty', checks: { failed: [], pending: [] } }, { dryRun: false, now: 0 });
  assert.equal(dirtyLive.actionClass, AUTOMATIC_ACTION_CLASSES.BLOCK);
  assert.equal(dirtyLive.allowed, false);
  assert.match(dirtyLive.reasons.join('\n'), /liveRepair\.enabled/);
  assert.throws(() => executeAutomaticActionPlan(dirtyLive), /automatic action blocked/);
});

test('minor-auto-safe repair lane permits only bounded low-risk changed paths without operator approval', () => {
  const target = validationTarget({
    headOwner: 'contributor',
    baseOwner: 'owner',
    automaticActions: {
      minorAutoRepair: {
        enabled: true,
        scope: MINOR_AUTO_SAFE_REPAIR_SCOPE,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        rolloutMode: 'minor-auto-live-limited',
        branchAllowlist: ['feature'],
        pathAllowlist: ['CHANGELOG.md', 'docs/**'],
        resolverAllowlist: ['merge-changelog-top-entry'],
        zeroRehearsalSafe: true,
      },
    },
  });
  const pr = { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: false, now: Date.parse('2026-05-09T08:00:00Z') });
  assert.equal(plan.actionClass, AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR);
  assert.equal(plan.lane, MINOR_AUTO_SAFE_REPAIR_SCOPE);
  assert.equal(plan.requiresOperatorApproval, false);
  assert.equal(plan.pushAllowed, true);
  assert.equal(plan.minorAutoRepairGate.gates.find((gate) => gate.name === 'changed-paths-within-allowlist').deferred, true);

  const okGate = buildMinorAutoRepairGate(target, {}, pr, classification, {
    now: new Date('2026-05-09T08:01:00Z'),
    changedPaths: ['CHANGELOG.md', 'docs/usage.md'],
    conflictInfo: classifyConflictSet(['CHANGELOG.md'], target),
  });
  assert.equal(okGate.gateAllowed, true);
  assert.equal(okGate.status, 'auto-repaired');
  assert.equal(okGate.requiresOperatorApproval, false);

  const riskyGate = buildMinorAutoRepairGate(target, {}, pr, classification, {
    now: new Date('2026-05-09T08:01:00Z'),
    changedPaths: ['src/runtime.ts', 'pnpm-lock.yaml', 'AGENTS.md'],
  });
  assert.equal(riskyGate.gateAllowed, false);
  assert.equal(riskyGate.status, 'blocked-risk');
  assert.match(riskyGate.blockedReasons.join('\n'), /outside automaticActions\.minorAutoRepair\.pathAllowlist/);
  assert.match(riskyGate.blockedReasons.join('\n'), /require approval/);
  assert.match(riskyGate.blockedReasons.join('\n'), /OpenClaw runtime\/bootstrap context paths/);
});

test('minor-auto execution controller requires final refs, focused checks, and clean evidence before handler dispatch', () => {
  const target = validationTarget({
    headOwner: 'contributor',
    baseOwner: 'owner',
    automaticActions: {
      minorAutoRepair: {
        enabled: true,
        scope: MINOR_AUTO_SAFE_REPAIR_SCOPE,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        rolloutMode: 'minor-auto-live-limited',
        branchAllowlist: ['feature'],
        pathAllowlist: ['CHANGELOG.md', 'docs/**'],
        resolverAllowlist: ['merge-changelog-top-entry'],
        zeroRehearsalSafe: true,
      },
    },
  });
  const pr = { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: false, now: Date.parse('2026-05-09T09:00:00Z') });
  const controller = buildMinorAutoExecutionController(target, pr, {}, {
    now: new Date('2026-05-09T09:01:00Z'),
    plan,
    classification,
    changedPaths: ['CHANGELOG.md'],
    conflictInfo: classifyConflictSet(['CHANGELOG.md'], target),
    focusedChecksPassed: true,
    expectedRemoteHeadOid: 'abc123',
    currentRemoteHeadOid: 'abc123',
    baseOid: 'base-a',
  });
  assert.equal(controller.schema, 'pr-shepherd-minor-auto-execution-controller/v1');
  assert.equal(controller.executionAllowed, true);
  assert.equal(controller.requiresOperatorApproval, false);
  assert.equal(controller.pushGuard.forceWithLease, 'feature:abc123');
  assert.equal(controller.postActionAudit.pushed.outcome, 'pushed');

  const executed = executeMinorAutoExecutionController(controller, {
    [AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR]: (packet) => packet.pushGuard.forceWithLease,
  });
  assert.equal(executed.status, 'executed');
  assert.equal(executed.result, 'feature:abc123');

  const blocked = buildMinorAutoExecutionController(target, pr, {}, {
    now: new Date('2026-05-09T09:02:00Z'),
    plan,
    classification,
    changedPaths: ['AGENTS.md'],
    focusedChecksPassed: false,
    expectedRemoteHeadOid: 'abc123',
    currentRemoteHeadOid: 'changed',
    baseOid: 'base-a',
  });
  assert.equal(blocked.executionAllowed, false);
  assert.equal(blocked.actionClass, AUTOMATIC_ACTION_CLASSES.BLOCK);
  assert.match(blocked.blockedReasons.join('\n'), /focused checks must pass/);
  assert.match(blocked.blockedReasons.join('\n'), /pre-push remote head changed/);
  assert.match(blocked.blockedReasons.join('\n'), /OpenClaw runtime\/bootstrap context paths/);
  assert.deepEqual(blocked.evidenceHygiene.offendingRuntimeContextPaths, ['AGENTS.md']);
  const blockedExecution = executeMinorAutoExecutionController(blocked, {}, { throwOnBlocked: false });
  assert.equal(blockedExecution.status, 'blocked');
});

test('minor-auto rollout opens circuit breaker guidance after failed post-push observation', () => {
  const target = validationTarget({
    automaticActions: {
      minorAutoRepair: {
        enabled: true,
        rolloutMode: 'minor-auto-live-limited',
        scope: MINOR_AUTO_SAFE_REPAIR_SCOPE,
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        branchAllowlist: ['feature'],
        pathAllowlist: ['CHANGELOG.md'],
        resolverAllowlist: ['merge-changelog-top-entry'],
        zeroRehearsalSafe: true,
      },
    },
  });
  const observation = buildMinorAutoPostPushObservation(target, {
    ...base,
    headRefOid: 'newhead',
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
  }, { lastPostActionAudit: { expectedRefs: { beforeHeadOid: 'oldhead', afterHeadOid: 'newhead' } } }, {
    now: new Date('2026-05-09T11:00:00Z'),
  });
  assert.equal(observation.schema, 'pr-shepherd-minor-auto-post-push-observation/v1');
  assert.equal(observation.outcome, 'post-push-failed');
  assert.equal(observation.autoMergeAllowed, false);
  assert.equal(observation.retryLoopAllowed, false);
  assert.equal(observation.rolloutStopRequired, true);
  assert.equal(observation.circuitBreakerTransition.state, 'open');
  assert.equal(observation.rollbackGuidance.furtherMinorAutoAttemptsBlocked, true);
  assert.match(observation.rollbackGuidance.escalation, /Seo Jin On approval/);
});

test('automatic action explanations cover every action class without executing handlers', () => {
  const expectations = {
    [AUTOMATIC_ACTION_CLASSES.RECHECK]: { pushAllowed: false, writesArtifact: false },
    [AUTOMATIC_ACTION_CLASSES.DIAGNOSE]: { pushAllowed: false, writesArtifact: false },
    [AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY]: { pushAllowed: false, writesArtifact: true },
    [AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE]: { pushAllowed: false, writesArtifact: false },
    [AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL]: { pushAllowed: false, writesArtifact: false },
    [AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT]: { pushAllowed: false, writesArtifact: true },
    [AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR]: { pushAllowed: true, writesArtifact: false },
    [AUTOMATIC_ACTION_CLASSES.BLOCK]: { pushAllowed: false, writesArtifact: false, blocked: true },
  };

  for (const [actionClass, expected] of Object.entries(expectations)) {
    const plan = {
      actionClass,
      allowed: actionClass !== AUTOMATIC_ACTION_CLASSES.BLOCK,
      pushAllowed: expected.pushAllowed,
      mutatesBranch: actionClass === AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
      writesArtifact: expected.writesArtifact,
      requiresOperatorApproval: actionClass !== AUTOMATIC_ACTION_CLASSES.RECHECK,
      reasons: [`${actionClass} reason`],
    };
    const explanation = explainAutomaticActionPlan(plan);
    assert.equal(explanation.status, expected.blocked ? 'blocked' : 'planned');
    assert.equal(explanation.actionClass, actionClass);
    assert.equal(explanation.pushAllowed, expected.pushAllowed);
    assert.equal(explanation.writesArtifact, expected.writesArtifact);
    assert.deepEqual(explanation.reasons, [`${actionClass} reason`]);
  }
});

test('automatic action executor reports planned, blocked, executed, and skipped outcomes', () => {
  const recheckPlan = { actionClass: AUTOMATIC_ACTION_CLASSES.RECHECK, allowed: true, reasons: ['safe refresh'] };
  const skipped = executeAutomaticActionPlan(recheckPlan);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.executed, false);
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.reasons, ['safe refresh']);

  const rehearsalPlan = { actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL, allowed: true, reasons: ['dry-run only'] };
  const planned = executeAutomaticActionPlan(rehearsalPlan, {}, { dryRun: true });
  assert.equal(planned.status, 'planned');
  assert.equal(planned.dryRun, true);
  assert.equal(planned.skipped, true);

  const notifyPlan = { actionClass: AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE, allowed: true, reasons: ['tell operator'] };
  const executed = executeAutomaticActionPlan(notifyPlan, {
    [AUTOMATIC_ACTION_CLASSES.NOTIFY_ESCALATE]: (plan) => `handled:${plan.actionClass}`,
  });
  assert.equal(executed.status, 'executed');
  assert.equal(executed.executed, true);
  assert.equal(executed.result, 'handled:notify-escalate');

  const blockedPlan = { actionClass: AUTOMATIC_ACTION_CLASSES.BLOCK, allowed: false, reasons: ['missing approval'] };
  assert.throws(() => executeAutomaticActionPlan(blockedPlan), /automatic action blocked: missing approval/);
  const blocked = executeAutomaticActionPlan(blockedPlan, {}, { throwOnBlocked: false });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.executed, false);
});

test('automatic action planner records rehearsal before permitting gated live repair', () => {
  const target = validationTarget({
    headOwner: 'contributor',
    baseOwner: 'owner',
    automaticActions: {
      liveRepair: {
        enabled: true,
        scope: 'auto-safe-repair',
        approvalId: 'approval-1',
        approvedAt: '2026-05-08T05:00:00Z',
        expiresAt: '2026-05-08T06:00:00Z',
        approvedBy: 'operator',
        branchAllowlist: ['feature'],
        rehearsalMaxAgeMs: 10000,
        targetId: 'target-1',
        owner: 'owner',
        repo: 'repo',
        number: 1,
        pr: 'owner/repo#1',
        headOwner: 'contributor',
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        headRefOid: 'abc123',
        baseRefOid: 'base-a',
        repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
        rollbackNote: 'disable live repair after the one-shot run',
      },
    },
  });
  const pr = { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const rehearsal = planAutomaticAction(target, {}, pr, classification, { dryRun: true, now: 1000 });
  assert.equal(rehearsal.actionClass, AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL);
  assert.equal(rehearsal.pushAllowed, false);

  const missingRehearsal = planAutomaticAction(target, {}, pr, classification, { dryRun: false, now: 1000 });
  assert.equal(missingRehearsal.allowed, false);
  assert.match(missingRehearsal.reasons.join('\n'), /rehearsal evidence is required/);

  const approvalPackage = buildRepairRehearsalApprovalPackage(target, pr, {}, rehearsal, {
    now: new Date(1000),
    repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
    baseOid: 'base-a',
    classification: 'dirty',
  });
  const state = {
    lastRepairRehearsal: {
      at: new Date(1000).toISOString(),
      target: 'target-1',
      repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
      headRefOid: 'abc123',
      baseOid: 'base-a',
      approvalPackage,
    },
    actionLedger: [{
      actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL,
      result: 'rehearsed',
      repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
    }],
  };
  state.lastRehearsalEvidenceDigest = buildRehearsalEvidenceDigest(target, pr, state, { classification, now: new Date(2000) });
  state.lastRepairRehearsal.evidenceDigest = state.lastRehearsalEvidenceDigest;
  const live = planAutomaticAction(target, state, pr, classification, { dryRun: false, now: 2000 });
  assert.equal(live.actionClass, AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR);
  assert.equal(live.allowed, true);
  assert.equal(live.pushAllowed, true);
  assert.equal(live.mutatesBranch, true);
});

test('live approval is target-scoped and rejects reuse across another target or changed head', () => {
  const target = validationTarget({
    id: 'target-b',
    number: 2,
    pr: 'owner/repo#2',
    headOwner: 'contributor',
    automaticActions: { liveRepair: {
      enabled: true,
      scope: 'auto-safe-repair',
      approvalId: 'approval-target-a',
      approvedAt: '2026-05-08T05:00:00Z',
      expiresAt: '2099-05-08T06:00:00Z',
      approvedBy: 'operator',
      branchAllowlist: ['feature'],
      targetId: 'target-a',
      owner: 'owner',
      repo: 'repo',
      number: 1,
      pr: 'owner/repo#1',
      actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
      headRefOid: 'abc123',
      baseRefOid: 'base-a',
      repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
      requireRecentRehearsal: false,
      rollbackNote: 'disable live repair after the one-shot run',
    } },
  });
  const pr = { ...base, baseRefOid: 'base-a', headRefOid: 'abc123', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: false, now: Date.parse('2026-05-08T05:30:00Z') });
  assert.equal(plan.allowed, false);
  assert.match(plan.reasons.join('\n'), /targetId must match selected target target-b/);
  assert.match(plan.reasons.join('\n'), /number must match selected PR number 2/);

  assert.equal(liveRepairApprovalState(target, {}, { headRefOid: 'changed-head' }, Date.parse('2026-05-08T05:30:00Z')).state, 'invalidated-by-head-change');
});

test('Phase E execution harness fails closed without explicit one-shot approval', () => {
  const target = validationTarget({ pr: 'owner/repo#1', headOwner: 'contributor', baseOwner: 'owner' });
  const pr = { ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const harness = buildLiveRepairExecutionHarness(target, pr, {}, {
    now: new Date('2026-05-08T05:30:00Z'),
    branchDiffPaths: ['CHANGELOG.md'],
    artifactEvidencePaths: [],
  });

  assert.equal(harness.schema, 'pr-shepherd-live-repair-execution-harness/v1');
  assert.equal(harness.productionMutation, false);
  assert.equal(harness.executionAllowed, false);
  assert.match(harness.blockedReasons.join('\n'), /approval|liveRepair\.enabled/);
  assert.equal(harness.postActionAudit.block.schema, 'pr-shepherd-post-action-audit/v1');
  assert.equal(harness.postActionAudit.block.terminalLedgerMarker, 'Block');
  assert.deepEqual(harness.evidenceHygiene.offendingRuntimeContextPaths, []);
});

test('Phase E execution harness records readiness, post-action audit shape, and contamination blocks', () => {
  const target = validationTarget({
    pr: 'owner/repo#1',
    url: 'https://github.com/owner/repo/pull/1',
    headOwner: 'contributor',
    baseOwner: 'owner',
    focusedChecks: ['npm test'],
    automaticActions: {
      liveRepair: {
        enabled: true,
        scope: 'auto-safe-repair',
        approvalId: 'approval-phase-e-1',
        approvedAt: '2026-05-08T05:00:00Z',
        expiresAt: '2026-05-08T06:00:00Z',
        approvedBy: 'operator',
        branchAllowlist: ['feature'],
        rehearsalMaxAgeMs: 60 * 60 * 1000,
        targetId: 'target-1',
        owner: 'owner',
        repo: 'repo',
        number: 1,
        pr: 'owner/repo#1',
        headOwner: 'contributor',
        actionClass: AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR,
        headRefOid: 'abc123',
        baseRefOid: 'base-a',
        repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
        rollbackNote: 'disable live repair after this one-shot run',
      },
    },
  });
  const pr = { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: 'feature', baseRefName: 'main' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const rehearsalPlan = planAutomaticAction(target, {}, pr, classification, { dryRun: true, now: Date.parse('2026-05-08T05:00:00Z') });
  const approvalPackage = buildRepairRehearsalApprovalPackage(target, pr, {}, rehearsalPlan, {
    now: new Date('2026-05-08T05:00:00Z'),
    repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
    baseOid: 'base-a',
    classification: 'dirty',
  });
  const state = {
    lastRepairRehearsal: {
      at: '2026-05-08T05:00:00.000Z',
      target: 'target-1',
      repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
      headRefOid: 'abc123',
      baseOid: 'base-a',
      approvalPackage,
    },
    actionLedger: [{
      actionClass: AUTOMATIC_ACTION_CLASSES.REPAIR_REHEARSAL,
      result: 'rehearsed',
      repairKey: 'repair:abc123:base-a:CONFLICTING:DIRTY',
    }],
    autoPushes: [],
  };
  state.lastRehearsalEvidenceDigest = buildRehearsalEvidenceDigest(target, pr, state, {
    classification,
    now: new Date('2026-05-08T05:30:00Z'),
  });
  state.lastRepairRehearsal.evidenceDigest = state.lastRehearsalEvidenceDigest;

  const harness = buildLiveRepairExecutionHarness(target, pr, state, {
    classification,
    now: new Date('2026-05-08T05:30:00Z'),
    baseOid: 'base-a',
    branchDiffPaths: ['CHANGELOG.md'],
  });
  assert.equal(harness.executionAllowed, true);
  assert.equal(harness.expectedRefs.repairKey, 'repair:abc123:base-a:CONFLICTING:DIRTY');
  assert.equal(harness.gates.find((gate) => gate.name === 'action-class-auto-safe-repair').ok, true);
  assert.deepEqual(harness.commandTemplates.liveRepair, ['node', 'pr-shepherd.mjs', 'repair', '--config', '<config>', '--target', 'target-1']);
  assert.equal(harness.postActionAudit.pushed.outcome, 'pushed');
  assert.equal(harness.postActionAudit.pushed.ciFollowUp.required, true);
  assert.equal(harness.postActionAudit['no-op'].terminalLedgerMarker, 'Done');

  const contaminated = buildLiveRepairExecutionHarness(target, pr, state, {
    classification,
    now: new Date('2026-05-08T05:30:00Z'),
    baseOid: 'base-a',
    branchDiffPaths: ['AGENTS.md'],
  });
  assert.equal(contaminated.executionAllowed, false);
  assert.deepEqual(contaminated.evidenceHygiene.offendingRuntimeContextPaths, ['AGENTS.md']);
  assert.match(contaminated.blockedReasons.join('\n'), /OpenClaw runtime\/bootstrap context paths/);

  const audit = buildPostActionAuditEntry(target, pr, 'pushed', {
    now: new Date('2026-05-08T05:45:00Z'),
    baseOid: 'base-a',
    beforeHeadOid: 'abc123',
    afterHeadOid: 'def456',
  });
  assert.equal(audit.schema, 'pr-shepherd-post-action-audit/v1');
  assert.equal(audit.terminalLedgerMarker, 'Done');
  assert.equal(audit.expectedRefs.afterHeadOid, 'def456');
});

test('automatic action planner enforces branch allowlist and maintainer boundary', () => {
  const target = validationTarget({
    headOwner: 'owner',
    baseOwner: 'owner',
    automaticActions: {
      liveRepair: {
        enabled: true,
        scope: 'auto-safe-repair',
        approvalId: 'approval-2',
        approvedAt: '2026-05-08T05:00:00Z',
        approvedBy: 'operator',
        branchAllowlist: ['other-branch'],
        requireRecentRehearsal: false,
      },
    },
  });
  const pr = { ...base, baseRefOid: 'base-a', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  const classification = { kind: 'dirty', checks: { failed: [], pending: [] } };
  const plan = planAutomaticAction(target, {}, pr, classification, { dryRun: false });
  assert.equal(plan.allowed, false);
  assert.match(plan.reasons.join('\n'), /not in automaticActions\.liveRepair\.branchAllowlist/);
  assert.match(plan.reasons.join('\n'), /maintainer-owned head branches/);
});

const conflictPolicyTarget = {
  id: 'openclaw-78261',
  pr: 'openclaw/openclaw#78261',
  url: 'https://github.com/openclaw/openclaw/pull/78261',
  baseBranch: 'main',
  remotes: {
    origin: 'https://x-access-token:TOKEN_EXAMPLE_REDACT_ME@github.com/example/private.git',
  },
  conflictPolicy: {
    autoSafe: [
      { path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Telegram/Plugin SDK: expose delivery.providerAccepted' },
    ],
    codeAssisted: [
      'extensions/telegram/src/outbound-adapter.ts',
      'extensions/telegram/src/send.ts',
    ],
    humanOnly: ['pnpm-lock.yaml'],
  },
};

test('classifies autoSafe CHANGELOG conflict', () => {
  const c = classifyConflictSet(['CHANGELOG.md'], conflictPolicyTarget);
  assert.equal(c.tier, 'autoSafe');
  assert.equal(c.autoPushAllowed, true);
  assert.equal(c.pushBlocked, false);
});

test('classifies codeAssisted TypeScript conflict with push blocked by default', () => {
  const c = classifyConflictSet(['extensions/telegram/src/outbound-adapter.ts'], conflictPolicyTarget);
  assert.equal(c.tier, 'codeAssisted');
  assert.equal(c.requiresApproval, true);
  assert.equal(c.pushBlocked, true);
});

test('conflict planner creates artifacts for assisted conflicts but only plans autoSafe mutation', () => {
  const autoSafe = planConflictAutomaticAction(classifyConflictSet(['CHANGELOG.md'], conflictPolicyTarget), ['CHANGELOG.md']);
  assert.equal(autoSafe.actionClass, AUTOMATIC_ACTION_CLASSES.AUTO_SAFE_REPAIR);
  assert.equal(autoSafe.pushAllowed, true);

  const assisted = planConflictAutomaticAction(
    classifyConflictSet(['extensions/telegram/src/outbound-adapter.ts'], conflictPolicyTarget),
    ['extensions/telegram/src/outbound-adapter.ts'],
  );
  assert.equal(assisted.actionClass, AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT);
  assert.equal(assisted.writesArtifact, true);
  assert.equal(assisted.pushAllowed, false);

  const humanOnly = planConflictAutomaticAction(classifyConflictSet(['pnpm-lock.yaml'], conflictPolicyTarget), ['pnpm-lock.yaml']);
  assert.equal(humanOnly.actionClass, AUTOMATIC_ACTION_CLASSES.DIAGNOSE_ONLY);
  assert.equal(humanOnly.pushAllowed, false);
  assert.equal(humanOnly.requiresOperatorApproval, false);
  assert.equal(humanOnly.writesArtifact, true);
});

test('classifies lockfile conflict as humanOnly', () => {
  const c = classifyConflictSet(['pnpm-lock.yaml'], conflictPolicyTarget);
  assert.equal(c.tier, 'humanOnly');
  assert.equal(c.pushBlocked, true);
});

test('unlisted conflict paths escalate to humanOnly', () => {
  const c = classifyConflictSet(['src/auth/permissions.ts'], conflictPolicyTarget);
  assert.equal(c.tier, 'humanOnly');
  assert.equal(c.entries[0].reason, 'unlisted');
});

test('conflict set key includes head, base, and sorted conflict paths', () => {
  const pr = { headRefOid: 'head-a', baseRefName: 'main' };
  assert.equal(
    conflictSetKey(pr, 'base-a', ['b.ts', 'a.ts']),
    conflictSetKey(pr, 'base-a', ['a.ts', 'b.ts']),
  );
  assert.notEqual(conflictSetKey(pr, 'base-a', ['a.ts']), conflictSetKey(pr, 'base-b', ['a.ts']));
});

test('source never uses plain force push', () => {
  const source = readFileSync(new URL('./pr-shepherd.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("'--force'"), false);
  assert.match(source, /--force-with-lease=/);
});

test('conflict artifacts omit secrets and private worktree details', () => {
  const payload = buildConflictArtifactPayload(
    { ...conflictPolicyTarget, worktreePath: '/private/worktree', statePath: '/private/state.json' },
    { headRefOid: 'head-a', url: 'https://github.com/openclaw/openclaw/pull/78261' },
    classifyConflictSet(['extensions/telegram/src/outbound-adapter.ts'], conflictPolicyTarget),
    ['extensions/telegram/src/outbound-adapter.ts'],
    'conflict:head-a:base-a:extensions/telegram/src/outbound-adapter.ts',
  );
  const json = JSON.stringify(payload);
  assert.equal(json.includes('TOKEN_EXAMPLE_REDACT_ME'), false);
  assert.equal(json.includes('/private/'), false);
});

test('Phase G conflict diagnosis bundle is sanitized and diagnose-only', () => {
  const target = {
    ...conflictPolicyTarget,
    worktreePath: '/private/worktree',
    statePath: '/private/state.json',
    focusedChecks: ['pnpm test extensions/telegram/src/outbound-adapter.test.ts'],
    diagnosisHints: [{
      path: 'extensions/telegram/src/**',
      summary: 'Review Telegram outbound receipt mapping.',
      commands: ['pnpm test extensions/telegram/src/outbound-adapter.test.ts', 'curl https://example.invalid'],
    }],
  };
  const bundle = buildConflictDiagnosisBundle(
    target,
    { ...base, headRefName: 'feature', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', url: target.url },
    { kind: 'dirty', checks: { failed: [], pending: [] } },
    {},
    {
      now: new Date('2026-05-09T00:00:00Z'),
      conflicts: ['extensions/telegram/src/outbound-adapter.ts'],
      changedFiles: [{ filename: 'extensions/telegram/src/outbound-adapter.ts', status: 'modified', additions: 5, deletions: 2, changes: 7 }],
      baseOid: 'base-a',
    },
  );
  const json = JSON.stringify(bundle);
  assert.equal(bundle.schema, 'pr-shepherd-conflict-diagnosis-bundle/v1');
  assert.equal(bundle.diagnoseOnly, true);
  assert.equal(bundle.pushAllowed, false);
  assert.equal(bundle.mutatesBranch, false);
  assert.equal(bundle.conflictPolicy.tier, 'codeAssisted');
  assert.equal(bundle.diagnosisHints[0].commands.length, 1);
  assert.equal(json.includes('TOKEN_EXAMPLE_REDACT_ME'), false);
  assert.equal(json.includes('/private/'), false);
});

test('Phase H repair-plan handoff is source-backed and non-mutating', () => {
  const target = {
    ...conflictPolicyTarget,
    worktreePath: '/private/worktree',
    statePath: '/private/state.json',
    focusedChecks: ['pnpm test extensions/telegram/src/outbound-adapter.test.ts'],
    diagnosisHints: [{
      path: 'extensions/telegram/src/**',
      summary: 'Review Telegram outbound receipt mapping.',
      commands: ['pnpm test extensions/telegram/src/outbound-adapter.test.ts'],
    }],
  };
  const bundle = buildConflictDiagnosisBundle(
    target,
    { ...base, headRefName: 'feature', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', url: target.url },
    { kind: 'dirty', checks: { failed: [], pending: [] } },
    {},
    {
      now: new Date('2026-05-09T00:00:00Z'),
      conflicts: ['extensions/telegram/src/outbound-adapter.ts'],
      changedFiles: [{ filename: 'extensions/telegram/src/outbound-adapter.ts', status: 'modified', additions: 5, deletions: 2, changes: 7 }],
      baseOid: 'base-a',
    },
  );
  const handoff = buildRepairPlanHandoffFromDiagnosisBundle(bundle, {
    now: new Date('2026-05-09T00:01:00Z'),
    currentRefs: { headRefOid: 'abc123', baseRefOid: 'base-a' },
  });
  const json = JSON.stringify(handoff);
  assert.equal(bundle.repairPlanHandoff.schema, 'pr-shepherd-repair-plan-handoff/v1');
  assert.equal(handoff.schema, 'pr-shepherd-repair-plan-handoff/v1');
  assert.equal(handoff.sourceBacked, true);
  assert.equal(handoff.productionMutation, false);
  assert.equal(handoff.pushAllowed, false);
  assert.equal(handoff.mutatesBranch, false);
  assert.equal(handoff.staleDiagnosis.stale, false);
  assert.equal(handoff.decision.kind, 'code-assisted-review');
  assert.equal(handoff.decision.actionClass, AUTOMATIC_ACTION_CLASSES.CONFLICT_ARTIFACT);
  assert.equal(handoff.evidence.changedFiles[0].path, 'extensions/telegram/src/outbound-adapter.ts');
  assert.equal(handoff.reviewArtifacts[0].paths[0], 'extensions/telegram/src/outbound-adapter.ts');
  assert.equal(json.includes('TOKEN_EXAMPLE_REDACT_ME'), false);
  assert.equal(json.includes('/private/'), false);
});

test('Phase H repair-plan handoff detects stale refs and runtime-context evidence', () => {
  const bundle = buildConflictDiagnosisBundle(
    conflictPolicyTarget,
    { ...base, headRefName: 'feature', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { kind: 'dirty', checks: { failed: [], pending: [] } },
    {},
    {
      now: new Date('2026-05-09T00:00:00Z'),
      conflicts: ['CHANGELOG.md'],
      baseOid: 'base-a',
    },
  );
  const stale = buildRepairPlanHandoffFromDiagnosisBundle(bundle, {
    now: new Date('2026-05-09T00:01:00Z'),
    currentRefs: { headRefOid: 'new-head', baseRefOid: 'base-a' },
  });
  assert.equal(stale.staleDiagnosis.stale, true);
  assert.equal(stale.terminalLedgerMarker, 'Block');
  assert.match(stale.decision.reasons.join('\n'), /headRefOid differs/);

  const contaminated = buildRepairPlanHandoffFromDiagnosisBundle({
    ...bundle,
    conflictPaths: ['AGENTS.md'],
    evidenceHygiene: { offendingRuntimeContextPaths: ['.openclaw/workspace-state.json'] },
  }, { now: new Date('2026-05-09T00:01:00Z') });
  assert.equal(contaminated.terminalLedgerMarker, 'Block');
  assert.deepEqual(contaminated.evidenceHygiene.offendingRuntimeContextPaths, ['.openclaw/workspace-state.json', 'AGENTS.md']);
  assert.match(contaminated.decision.reasons.join('\n'), /AGENTS\.md/);
});

test('diagnosis hint validation allows read-only commands and blocks mutation/secrets', () => {
  assert.equal(isSafeDiagnosisHintCommand('pnpm test extensions/telegram/src/outbound-adapter.test.ts'), true);
  assert.equal(isSafeDiagnosisHintCommand('git diff --check'), true);
  assert.equal(isSafeDiagnosisHintCommand('git push origin HEAD'), false);
  assert.equal(isSafeDiagnosisHintCommand('curl https://example.invalid'), false);
  assert.equal(isSafeDiagnosisHintCommand('printenv GITHUB_TOKEN'), false);

  const cfg = {
    targets: [validationTarget({
      diagnosisHints: [
        { path: 'src/**', summary: 'safe hint', commands: ['npm test src/example.test.ts'] },
        { path: 'AGENTS.md', commands: ['npm test'] },
        { path: 'src/**', commands: ['git push origin HEAD'] },
      ],
    })],
  };
  const report = validateConfigObject(cfg);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /OpenClaw runtime\/bootstrap context paths/);
  assert.match(report.errors.join('\n'), /not an allowed diagnose-only hint command/);
});

test('autoSafe resolver registry drives validation and the minor-auto allowlist', () => {
  const resolver = getResolver('merge-changelog-top-entry');
  assert.ok(resolver, 'built-in changelog resolver is registered');
  assert.equal(resolver.minorAutoSafe, true);
  assert.equal(typeof resolver.resolve, 'function');
  assert.deepEqual([...SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS], supportedResolverIds().filter((id) => getResolver(id).minorAutoSafe));
  const report = validateConfigObject({
    targets: [validationTarget({
      conflictPolicy: { autoSafe: [{ path: 'CHANGELOG.md', resolver: 'unknown-resolver' }], codeAssisted: [], humanOnly: [] },
    })],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /resolver must be one of \[merge-changelog-top-entry\]/);
});

test('autoSafe CHANGELOG resolver preserves both sides and removes conflict markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-changelog-'));
  try {
    spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'CHANGELOG.md'), [
      '<<<<<<< HEAD',
      '- Telegram/Plugin SDK: expose delivery.providerAccepted',
      '=======',
      '- Upstream release note',
      '>>>>>>> upstream/main',
      '',
    ].join('\n'));
    assert.equal(resolveChangelogConflict({ worktreePath: dir }, {
      path: 'CHANGELOG.md',
      resolver: 'merge-changelog-top-entry',
      needle: 'Telegram/Plugin SDK: expose delivery.providerAccepted',
    }), true);
    const resolved = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(resolved, /Telegram\/Plugin SDK: expose delivery\.providerAccepted/);
    assert.match(resolved, /Upstream release note/);
    assert.equal(resolved.includes('<<<<<<<'), false);
    assert.equal(resolved.includes('======='), false);
    assert.equal(resolved.includes('>>>>>>>'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
