// CLI usage text and argv parsing.
import { REVIEW_DECISION_OUTCOMES } from './policy.mjs';

export function usage(exitCode = 1) {
  console.error(`Usage:\n  node pr-shepherd.mjs validate --config config.json\n  node pr-shepherd.mjs status --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs check-canary --config config.json [--target id|owner/repo#number] [--all]\n  node pr-shepherd.mjs diagnose --config config.json [--target id|owner/repo#number] [--all] [--artifact-dir path]\n  node pr-shepherd.mjs repair-plan --diagnose-bundle path [--output path]\n  node pr-shepherd.mjs decision-ledger --handoff path --decision outcome [--config config.json --target id|owner/repo#number | --pr-state path] [--state path] [--output path]\n  node pr-shepherd.mjs rehearsal-queue --feedback path [--config config.json --target id|owner/repo#number | --pr-state path] [--state path] [--output path]\n  node pr-shepherd.mjs phase-d-packet --config config.json [--target id|owner/repo#number] [--pr-state path] [--output path]\n  node pr-shepherd.mjs rehearse --config config.json [--target id|owner/repo#number] [--all] [--artifact-dir path] [--no-keep-failed-rebase-worktree]\n  node pr-shepherd.mjs repair --config config.json [--target id|owner/repo#number] [--all] [--dry-run] [--artifact-dir path] [--allow-code-assisted-push] [--no-keep-failed-rebase-worktree]\n\nFor backward compatibility, omitting both --target and --all processes only the first configured target for status/check/check-canary/diagnose/repair/rehearse.`);
  process.exit(exitCode);
}

export function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !['validate', 'status', 'canary', 'check', 'check-canary', 'diagnose', 'repair-plan', 'decision-ledger', 'rehearsal-queue', 'phase-d-packet', 'repair', 'rehearse'].includes(cmd)) usage();
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
    preparedBy: null,
    configRevision: null,
    phaseBSummary: null,
    phaseCRehearsalEvidence: null,
    decisionDeadline: null,
    focusedChecks: [],
    riskFlags: [],
    branchDiffPaths: [],
    artifactEvidencePaths: [],
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
    else if (a === '--prepared-by') args.preparedBy = requireValue(a, rest[++i]);
    else if (a === '--config-revision') args.configRevision = requireValue(a, rest[++i]);
    else if (a === '--phase-b-summary') args.phaseBSummary = requireValue(a, rest[++i]);
    else if (a === '--phase-c-evidence' || a === '--phase-c-rehearsal-evidence') args.phaseCRehearsalEvidence = requireValue(a, rest[++i]);
    else if (a === '--decision-deadline' || a === '--expires-at') args.decisionDeadline = requireValue(a, rest[++i]);
    else if (a === '--focused-check') args.focusedChecks.push(requireValue(a, rest[++i]));
    else if (a === '--risk') args.riskFlags.push(requireValue(a, rest[++i]));
    else if (a === '--branch-diff-path') args.branchDiffPaths.push(requireValue(a, rest[++i]));
    else if (a === '--artifact-evidence-path') args.artifactEvidencePaths.push(requireValue(a, rest[++i]));
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
  } else if (args.cmd === 'phase-d-packet') {
    if (!args.config) usage();
    if (args.allTargets) throw new Error('phase-d-packet assembles one operator packet at a time; --all is not supported');
  } else if (!args.config) usage();
  if (args.cmd === 'rehearse') {
    args.dryRun = true;
    if (args.allowCodeAssistedPush) throw new Error('rehearse is dry-run only; --allow-code-assisted-push is not allowed');
  }
  if (args.allTargets && args.targetSelectors.length > 0) throw new Error('--all cannot be combined with --target');
  return args;
}
