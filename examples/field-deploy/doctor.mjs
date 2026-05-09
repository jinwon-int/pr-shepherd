#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findOpenClawRuntimeContextPaths,
  selectTargets,
  validateConfigObject,
} from '../../pr-shepherd.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const packageFiles = {
  doctor: resolve(here, 'doctor.mjs'),
  packageJson: resolve(here, 'package.json'),
  wrapper: resolve(here, 'pr-shepherd-openclaw-telegram-notify.sh'),
  service: resolve(here, 'pr-shepherd-check-canary@.service.example'),
  timer: resolve(here, 'pr-shepherd-check-canary@.timer.example'),
  fragment: resolve(here, 'openclaw-78261-notify.fragment.example.json'),
  decision: resolve(here, 'post-live-canary-decision.md'),
  liveReadiness: resolve(here, 'live-readiness-go-no-go.md'),
  phaseAStandingOps: resolve(here, 'phase-a-standing-ops.md'),
  phaseDOperatorDecisionPacket: resolve(here, 'phase-d-operator-decision-packet.md'),
  phaseFControlsPolicy: resolve(here, 'phase-f-fleet-safe-controls-limited-autonomy.md'),
  phaseGDiagnoseOnly: resolve(here, 'phase-g-diagnose-only-conflict-context.md'),
  phaseHRepairPlanHandoff: resolve(here, 'phase-h-repair-plan-handoff.md'),
};

function usage(exitCode = 1) {
  console.error(`Usage:\n  node examples/field-deploy/doctor.mjs [--config config.json] [--target id|owner/repo#number] [--all]\n\nThe doctor is read-only. It validates the field-deploy example package and, when --config is supplied, checks selected target(s) for check-only deployment readiness.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { config: null, targetSelectors: [], allTargets: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--config requires a value');
      args.config = value;
    } else if (a === '--target') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--target requires a value');
      args.targetSelectors.push(...value.split(',').map((part) => part.trim()).filter(Boolean));
    } else if (a === '--all') {
      args.allTargets = true;
    } else if (a === '--help' || a === '-h') {
      usage(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.allTargets && args.targetSelectors.length > 0) throw new Error('--all cannot be combined with --target');
  return args;
}

function readText(path, errors) {
  if (!existsSync(path)) {
    errors.push(`missing field deployment package file: ${relativeToRepo(path)}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function relativeToRepo(path) {
  const absolute = resolve(path).replace(/\\/g, '/');
  const root = `${repoRoot.replace(/\\/g, '/')}/`;
  return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
}

function check(condition, errors, message) {
  if (!condition) errors.push(message);
}

function warn(condition, warnings, message) {
  if (!condition) warnings.push(message);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: repoRoot });
}

function loadJson(path, errors) {
  try {
    return JSON.parse(readText(path, errors));
  } catch (err) {
    errors.push(`${relativeToRepo(path)} is not valid JSON: ${err.message}`);
    return null;
  }
}

function packageDoctor() {
  const errors = [];
  const warnings = [];
  const checks = [];

  const manifest = loadJson(packageFiles.packageJson, errors);
  if (manifest) {
    check(manifest.name === '@jinwon-int/pr-shepherd-field-deploy', errors, 'field deployment package name is unexpected');
    check(manifest.private === true, errors, 'field deployment package must stay private');
    check(manifest.bin?.['pr-shepherd-field-deploy-doctor'] === './doctor.mjs', errors, 'field deployment package must expose the doctor bin');
    checks.push({ name: 'package-manifest', ok: true, path: relativeToRepo(packageFiles.packageJson) });
  }

  const doctor = readText(packageFiles.doctor, errors);
  if (doctor) {
    checks.push({ name: 'doctor-script', ok: true, path: relativeToRepo(packageFiles.doctor) });
  }

  const wrapper = readText(packageFiles.wrapper, errors);
  if (wrapper) {
    const syntax = run('/bin/sh', ['-n', packageFiles.wrapper]);
    const syntaxOutput = syntax.error ? syntax.error.message : String(syntax.stderr || syntax.stdout || '').trim();
    check(syntax.status === 0, errors, `wrapper shell syntax failed: ${syntaxOutput}`);
    check(/PR_SHEPHERD_NOTIFY_DRY_RUN:-1/.test(wrapper), errors, 'wrapper must default PR_SHEPHERD_NOTIFY_DRY_RUN to dry-run/no-send');
    check(/openclaw_bin=\$\{OPENCLAW_BIN:-openclaw\}/.test(wrapper), errors, 'wrapper should deliver through the OpenClaw CLI, not direct provider APIs');
    check(/message send/.test(wrapper), errors, 'wrapper must use OpenClaw message send for live delivery');
    check(!/api\.telegram\.org|curl\s+-|curl\s+--|botToken|TELEGRAM_BOT_TOKEN|gatewayToken/i.test(wrapper), errors, 'wrapper must not contain direct Telegram/API token delivery logic');
    checks.push({ name: 'wrapper', ok: syntax.status === 0, path: relativeToRepo(packageFiles.wrapper) });
  }

  const service = readText(packageFiles.service, errors);
  if (service) {
    check(/PR_SHEPHERD_NOTIFY_DRY_RUN=1/.test(service), errors, 'service example must default to no-send dry-run');
    check(/check-canary\s+--config\s+<pr-shepherd-repo>\/config\.json\s+--target\s+%i/.test(service), errors, 'service example must run check-canary for the selected target');
    check(!/\brepair\b/.test(service), errors, 'service example must not schedule repair');
    checks.push({ name: 'service', ok: true, path: relativeToRepo(packageFiles.service) });
  }

  const timer = readText(packageFiles.timer, errors);
  if (timer) {
    check(/OnUnitActiveSec=10min/.test(timer), errors, 'timer example should keep the documented 10-minute canary interval');
    check(/Persistent=true/.test(timer), errors, 'timer example should be persistent for check-only monitoring');
    checks.push({ name: 'timer', ok: true, path: relativeToRepo(packageFiles.timer) });
  }

  const fragment = loadJson(packageFiles.fragment, errors);
  if (fragment) {
    check(fragment?.notify?.mode === 'openclaw', errors, 'notify fragment must use notify.mode=openclaw');
    check(fragment?.notify?.dryRun === true, errors, 'notify fragment must default notify.dryRun=true');
    check(Array.isArray(fragment?.notify?.command) && fragment.notify.command.length === 1, errors, 'notify fragment must name exactly one operator-owned wrapper command');
    check(fragment?.notify?.situationReportEveryMs === 0, errors, 'notify fragment should force every canary check to render a report while dry-run');
    checks.push({ name: 'notify-fragment', ok: true, path: relativeToRepo(packageFiles.fragment) });
  }

  const decision = readText(packageFiles.decision, errors);
  if (decision) {
    check(/check-only/i.test(decision), errors, 'decision record must preserve check-only activation language');
    check(/Do not enable aggregate reporting, additional targets, or any `repair` command/i.test(decision), errors, 'decision record must block repair under the live canary decision');
    checks.push({ name: 'decision-record', ok: true, path: relativeToRepo(packageFiles.decision) });
  }

  const liveReadiness = readText(packageFiles.liveReadiness, errors);
  if (liveReadiness) {
    check(/GO\/NO-GO/i.test(liveReadiness), errors, 'live readiness package must name the operator GO/NO-GO decision');
    check(/`Start`/.test(liveReadiness) && /`PR: <url>`/.test(liveReadiness) && /`Done`/.test(liveReadiness) && /`Block`/.test(liveReadiness), errors, 'live readiness package must preserve Start and terminal ledger markers');
    check(/runtime\/bootstrap context path in branch diff/i.test(liveReadiness), errors, 'live readiness package must include the branch diff contamination guard');
    check(/Do not paste file contents|do not paste file contents/i.test(liveReadiness), errors, 'live readiness package must block runtime context content disclosure');
    checks.push({ name: 'live-readiness-go-no-go', ok: true, path: relativeToRepo(packageFiles.liveReadiness) });
  }

  const phaseAStandingOps = readText(packageFiles.phaseAStandingOps, errors);
  if (phaseAStandingOps) {
    check(/check-canary\s+--config\s+<pr-shepherd-repo>\/config\.json\s+--target\s+<target-id>/.test(phaseAStandingOps), errors, 'Phase A standing ops must schedule check-canary for one target');
    check(/PR_SHEPHERD_NOTIFY_DRY_RUN=1/.test(phaseAStandingOps), errors, 'Phase A standing ops must default to dry-run/no-send');
    check(/24-48h observation/i.test(phaseAStandingOps), errors, 'Phase A standing ops must include the first 24-48h observation template');
    check(/State and evidence rotation checklist/i.test(phaseAStandingOps), errors, 'Phase A standing ops must include state/evidence rotation guidance');
    check(/One-shot live Telegram\/OpenClaw reporting canary/i.test(phaseAStandingOps), errors, 'Phase A standing ops must include the one-shot live reporting canary boundary');
    check(/GO for Phase A check-only standing operations; NO-GO for production live repair unless separately approved/i.test(phaseAStandingOps), errors, 'Phase A standing ops must preserve the GO/NO-GO boundary');
    check(!/\brepair\s+--|\brepair\b.*timer|force-with-lease=.*push/i.test(phaseAStandingOps), errors, 'Phase A standing ops must not schedule repair or live force pushes');
    checks.push({ name: 'phase-a-standing-ops', ok: true, path: relativeToRepo(packageFiles.phaseAStandingOps) });
  }

  const phaseDOperatorDecisionPacket = readText(packageFiles.phaseDOperatorDecisionPacket, errors);
  if (phaseDOperatorDecisionPacket) {
    check(/Phase D operator decision packet/i.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must name the operator decision packet');
    check(/GO live repair|NO-GO continue observation|NO-GO block/i.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must document GO/NO-GO decision outcomes');
    check(/node pr-shepherd\.mjs repair --config config\.json --target <target-id>/.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must name the target-specific live repair command under consideration');
    check(/--force-with-lease=<branch>:<expected-head>/.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must preserve the expected-head force-with-lease guard');
    check(/`Start`/.test(phaseDOperatorDecisionPacket) && /`PR: <url>`/.test(phaseDOperatorDecisionPacket) && /`Done`/.test(phaseDOperatorDecisionPacket) && /`Block`/.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must preserve Start and terminal ledger markers');
    check(/AGENTS\.md/.test(phaseDOperatorDecisionPacket) && /\.openclaw\/\*\*/.test(phaseDOperatorDecisionPacket), errors, 'Phase D packet must include the runtime/bootstrap contamination guard');
    checks.push({ name: 'phase-d-operator-decision-packet', ok: true, path: relativeToRepo(packageFiles.phaseDOperatorDecisionPacket) });
  }

  const phaseFControlsPolicy = readText(packageFiles.phaseFControlsPolicy, errors);
  if (phaseFControlsPolicy) {
    check(/fleet-safe controls/i.test(phaseFControlsPolicy), errors, 'Phase F policy must name fleet-safe controls');
    check(/limited autonomy/i.test(phaseFControlsPolicy), errors, 'Phase F policy must name limited autonomy');
    check(/F0 observe-only/i.test(phaseFControlsPolicy) && /F3 one-shot live repair/i.test(phaseFControlsPolicy), errors, 'Phase F policy must define autonomy tiers through one-shot live repair');
    check(/F4 prohibited/i.test(phaseFControlsPolicy), errors, 'Phase F policy must prohibit standing live repair automation');
    check(/Phase D\/E/i.test(phaseFControlsPolicy) && /repair --target <id>/.test(phaseFControlsPolicy), errors, 'Phase F policy must keep live repair behind Phase D/E target-specific approval');
    check(/AGENTS\.md/.test(phaseFControlsPolicy) && /\.openclaw\/\*\*/.test(phaseFControlsPolicy), errors, 'Phase F policy must include the runtime/bootstrap contamination guard');
    check(/`Start`/.test(phaseFControlsPolicy) && /`PR: <url>`/.test(phaseFControlsPolicy) && /`Done`/.test(phaseFControlsPolicy) && /`Block`/.test(phaseFControlsPolicy), errors, 'Phase F policy must preserve Start and terminal ledger markers');
    checks.push({ name: 'phase-f-fleet-safe-controls-limited-autonomy', ok: true, path: relativeToRepo(packageFiles.phaseFControlsPolicy) });
  }

  const phaseGDiagnoseOnly = readText(packageFiles.phaseGDiagnoseOnly, errors);
  if (phaseGDiagnoseOnly) {
    check(/diagnose-only/i.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must name diagnose-only operations');
    check(/conflict context bundle/i.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must document conflict context bundles');
    check(/disposable .*sandbox|sandbox\/rehearsal worktree/i.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must keep conflict context collection sandbox-only');
    check(/baseRefOid/.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must preserve the unsupported GitHub field guard');
    check(/diagnosisHints/i.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must document optional per-repo diagnosis hints');
    check(/shell metacharacters/i.test(phaseGDiagnoseOnly) && /token\/env var reads/i.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must fail closed for unsafe commands and secret reads');
    check(/AGENTS\.md/.test(phaseGDiagnoseOnly) && /\.openclaw\/\*\*/.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must include the runtime/bootstrap contamination guard');
    check(/`Start`/.test(phaseGDiagnoseOnly) && /`PR: <url>`/.test(phaseGDiagnoseOnly) && /`Done`/.test(phaseGDiagnoseOnly) && /`Block`/.test(phaseGDiagnoseOnly), errors, 'Phase G runbook must preserve Start and terminal ledger markers');
    checks.push({ name: 'phase-g-diagnose-only-conflict-context', ok: true, path: relativeToRepo(packageFiles.phaseGDiagnoseOnly) });
  }

  const phaseHRepairPlanHandoff = readText(packageFiles.phaseHRepairPlanHandoff, errors);
  if (phaseHRepairPlanHandoff) {
    check(/repair-plan handoff/i.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must name repair-plan handoff operations');
    check(/Phase G diagnose-only bundle/i.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must consume Phase G diagnose-only evidence');
    check(/wait\/recheck/i.test(phaseHRepairPlanHandoff) && /autoSafe rehearsal/i.test(phaseHRepairPlanHandoff) && /humanOnly handoff/i.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must enumerate safe next lanes');
    check(/must not run live `repair`|must not run `repair`/i.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must block live repair during handoff');
    check(/`Start`/.test(phaseHRepairPlanHandoff) && /`PR: <url>`/.test(phaseHRepairPlanHandoff) && /`Done`/.test(phaseHRepairPlanHandoff) && /`Block`/.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must preserve Start and terminal ledger markers');
    check(/startCommentUrl/.test(phaseHRepairPlanHandoff) && /prUrl/.test(phaseHRepairPlanHandoff) && /doneCommentUrl/.test(phaseHRepairPlanHandoff) && /blockCommentUrl/.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must require returned marker URLs');
    check(/AGENTS\.md/.test(phaseHRepairPlanHandoff) && /\.openclaw\/\*\*/.test(phaseHRepairPlanHandoff), errors, 'Phase H runbook must include the runtime/bootstrap contamination guard');
    checks.push({ name: 'phase-h-repair-plan-handoff', ok: true, path: relativeToRepo(packageFiles.phaseHRepairPlanHandoff) });
  }

  const packagePaths = Object.values(packageFiles).map(relativeToRepo);
  const contextPaths = findOpenClawRuntimeContextPaths(packagePaths);
  check(contextPaths.length === 0, errors, `field deployment package includes runtime/bootstrap context paths: ${contextPaths.join(', ')}`);

  warn(existsSync(resolve(repoRoot, 'state')), warnings, 'state/ exists locally; keep generated evidence ignored or outside the repository before publishing');

  return { ok: errors.length === 0, errors, warnings, checks };
}

function normalizeTargetForSelection(target, index) {
  const pr = String(target.pr || '');
  const parsed = pr.match(/^([^/\s#]+)\/([^\s#]+)#(\d+)$/);
  const owner = target.owner || parsed?.[1];
  const repo = target.repo || parsed?.[2];
  const number = Number(target.number || parsed?.[3]);
  return {
    ...target,
    owner,
    repo,
    number,
    pr: target.pr || (owner && repo && Number.isInteger(number) ? `${owner}/${repo}#${number}` : undefined),
    id: target.id || (owner && repo && Number.isInteger(number) ? `${owner}-${repo}-${number}` : `target-${index + 1}`),
    url: target.url || (owner && repo && Number.isInteger(number) ? `https://github.com/${owner}/${repo}/pull/${number}` : undefined),
  };
}

function configDoctor(configPath, selectors, allTargets) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const absoluteConfig = resolve(configPath);
  const cfg = loadJson(absoluteConfig, errors);
  if (!cfg) return { ok: false, errors, warnings, targets: [], checks };

  const validation = validateConfigObject(cfg, absoluteConfig);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);
  checks.push({ name: 'config-validation', ok: validation.ok, path: relativeToRepo(absoluteConfig) });

  const normalizedCfg = {
    ...cfg,
    targets: Array.isArray(cfg.targets) ? cfg.targets.map(normalizeTargetForSelection) : [],
  };
  let targets = [];
  try {
    targets = selectTargets(normalizedCfg, selectors, allTargets);
  } catch (err) {
    errors.push(err.message);
  }

  const targetReports = targets.map((target) => {
    const targetErrors = [];
    const targetWarnings = [];
    const notify = target.notify || {};
    check(notify.mode === 'openclaw' || notify.mode === 'stdout' || notify.mode === 'command' || notify.mode === 'none' || notify.mode === undefined, targetErrors, `${target.id}: notify.mode is unsupported`);
    if (notify.mode === 'openclaw') {
      check(notify.dryRun !== false || notify.liveActivation?.scope === 'check-only-reporting', targetErrors, `${target.id}: live OpenClaw delivery requires notify.liveActivation.scope=check-only-reporting`);
      check(notify.dryRun !== false || Number(notify.situationReportEveryMs ?? 0) >= 60 * 60 * 1000, targetErrors, `${target.id}: live OpenClaw delivery must use situationReportEveryMs >= 3600000`);
      check(notify.dryRun !== false || Array.isArray(notify.command), targetErrors, `${target.id}: live OpenClaw delivery requires an operator-owned wrapper command`);
    } else {
      targetWarnings.push(`${target.id}: notify.mode is ${notify.mode || 'stdout'}; Telegram/OpenClaw field canary delivery is not enabled by this config`);
    }
    check(!target.automaticActions?.liveRepair?.enabled, targetErrors, `${target.id}: live repair is enabled; field deployment doctor expects check-only monitoring`);
    check(!String(target.id || '').includes('/'), targetErrors, `${target.id}: target id should be systemd-instance friendly and not contain /`);
    for (const field of ['worktreePath', 'statePath', 'lockPath']) {
      if (typeof target[field] === 'string' && target[field].startsWith('/')) {
        targetWarnings.push(`${target.id}: ${field} is absolute; redact it from published evidence`);
      }
    }
    return { target: target.id, ok: targetErrors.length === 0, errors: targetErrors, warnings: targetWarnings };
  });

  for (const report of targetReports) {
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }
  checks.push({ name: 'selected-targets', ok: targetReports.every((report) => report.ok), count: targetReports.length });

  return { ok: errors.length === 0, errors, warnings, targets: targetReports, checks };
}

export function runFieldDeploymentDoctor(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const packageReport = packageDoctor();
  const reports = { package: packageReport };
  const errors = [...packageReport.errors];
  const warnings = [...packageReport.warnings];

  if (args.config) {
    const configReport = configDoctor(args.config, args.targetSelectors, args.allTargets);
    reports.config = configReport;
    errors.push(...configReport.errors);
    warnings.push(...configReport.warnings);
  } else if (args.targetSelectors.length > 0 || args.allTargets) {
    errors.push('--target/--all require --config');
  }

  const out = {
    schema: 'pr-shepherd-field-deploy-doctor/v1',
    ok: errors.length === 0,
    errors,
    warnings,
    reports,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    runFieldDeploymentDoctor();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
