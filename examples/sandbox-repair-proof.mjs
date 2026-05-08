#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shepherd = join(repoRoot, 'pr-shepherd.mjs');
const targetId = 'sandbox-repair-proof';
const headBranch = 'sandbox/repair-proof';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}\n${res.stdout || ''}${res.stderr || ''}`);
  }
  return res;
}

function git(args, cwd, opts = {}) {
  return run('git', args, { ...opts, cwd });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function setupSandbox(root) {
  const upstream = join(root, 'upstream.git');
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const worktree = join(root, 'worktree');

  git(['init', '--bare', upstream], root);
  git(['init', '--bare', origin], root);
  git(['init', seed], root);
  git(['config', 'user.email', 'sandbox@example.invalid'], seed);
  git(['config', 'user.name', 'PR Shepherd Sandbox'], seed);
  await writeFile(join(seed, 'CHANGELOG.md'), '# Changelog\n\n- Shared baseline\n');
  git(['add', 'CHANGELOG.md'], seed);
  git(['commit', '-m', 'Initial changelog'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['remote', 'add', 'upstream', upstream], seed);
  git(['push', 'origin', 'main'], seed);
  git(['push', 'upstream', 'main'], seed);

  git(['checkout', '-b', headBranch], seed);
  await writeFile(join(seed, 'CHANGELOG.md'), '# Changelog\n\n- Sandbox PR repair proof\n- Shared baseline\n');
  git(['commit', '-am', 'Add sandbox PR changelog entry'], seed);
  git(['push', 'origin', `HEAD:${headBranch}`], seed);

  git(['checkout', 'main'], seed);
  await writeFile(join(seed, 'CHANGELOG.md'), '# Changelog\n\n- Upstream release note\n- Shared baseline\n');
  git(['commit', '-am', 'Add upstream changelog entry'], seed);
  git(['push', 'upstream', 'main'], seed);

  git(['clone', origin, worktree], root);
  git(['config', 'user.email', 'sandbox@example.invalid'], worktree);
  git(['config', 'user.name', 'PR Shepherd Sandbox'], worktree);
  git(['remote', 'add', 'upstream', upstream], worktree);

  return { upstream, origin, seed, worktree };
}

async function writeFakeGh(binDir, origin, upstream) {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env node\n` +
`import { spawnSync } from 'node:child_process';\n` +
`const origin = ${JSON.stringify(origin)};\n` +
`const upstream = ${JSON.stringify(upstream)};\n` +
`const headBranch = ${JSON.stringify(headBranch)};\n` +
`function git(dir, ref) {\n` +
`  const res = spawnSync('git', ['--git-dir', dir, 'rev-parse', ref], { encoding: 'utf8' });\n` +
`  if (res.status !== 0) { console.error(res.stderr || res.stdout); process.exit(res.status || 1); }\n` +
`  return res.stdout.trim();\n` +
`}\n` +
`if (process.argv[2] !== 'pr' || process.argv[3] !== 'view') {\n` +
`  console.error('fake gh only supports: gh pr view');\n` +
`  process.exit(2);\n` +
`}\n` +
`console.log(JSON.stringify({\n` +
`  number: 1,\n` +
`  state: 'OPEN',\n` +
`  mergeable: 'CONFLICTING',\n` +
`  mergeStateStatus: 'DIRTY',\n` +
`  mergedAt: null,\n` +
`  headRefOid: git(origin, 'refs/heads/' + headBranch),\n` +
`  baseRefOid: git(upstream, 'refs/heads/main'),\n` +
`  headRefName: headBranch,\n` +
`  baseRefName: 'main',\n` +
`  updatedAt: new Date(0).toISOString(),\n` +
`  statusCheckRollup: [],\n` +
`  reviewDecision: null,\n` +
`  url: 'https://example.invalid/sandbox/pr/1'\n` +
`}));\n`;
  const ghPath = join(binDir, 'gh');
  await writeFile(ghPath, script, { mode: 0o755 });
  return ghPath;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'pr-shepherd-sandbox-proof-'));
  const keep = process.argv.includes('--keep-sandbox');
  try {
    const { origin, upstream, worktree } = await setupSandbox(root);
    const binDir = join(root, 'bin');
    await writeFakeGh(binDir, origin, upstream);

    const configPath = join(root, 'config.json');
    const statePath = join(root, 'state', 'state.json');
    const artifactDir = resolve(process.env.PR_SHEPHERD_SANDBOX_ARTIFACT_DIR || join(repoRoot, 'state', 'sandbox-proof-artifacts'));
    const config = {
      targets: [{
        id: targetId,
        pr: 'sandbox/repo#1',
        headBranch,
        baseBranch: 'main',
        worktreePath: worktree,
        statePath,
        lockPath: join(root, 'state', 'repair.lock'),
        artifactDir,
        autoPushLimit24h: 5,
        remotes: { origin, upstream },
        conflictPolicy: {
          autoSafe: [{ path: 'CHANGELOG.md', resolver: 'merge-changelog-top-entry', needle: 'Sandbox PR repair proof' }],
          codeAssisted: [],
          humanOnly: ['package-lock.json'],
        },
        focusedChecks: [
          'node -e "const fs=require(\'fs\'); const text=fs.readFileSync(\'CHANGELOG.md\',\'utf8\'); if (text.includes(\'<<<<<<<\') || !text.includes(\'Sandbox PR repair proof\') || !text.includes(\'Upstream release note\')) process.exit(1)"',
        ],
        automaticActions: {
          liveRepair: {
            enabled: true,
            scope: 'auto-safe-repair',
            approvalId: 'sandbox-proof-approval',
            approvedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            approvedBy: 'sandbox-proof-harness',
            branchAllowlist: [headBranch],
          },
        },
        notify: { mode: 'none' },
      }],
    };
    await writeJson(configPath, config);
    await mkdir(dirname(statePath), { recursive: true });

    const env = { PATH: `${binDir}:${process.env.PATH || ''}` };
    const rehearse = run(process.execPath, [shepherd, 'rehearse', '--config', configPath, '--target', targetId], { env });
    const rehearsedState = JSON.parse(await readFile(statePath, 'utf8'));
    const activationTemplate = rehearsedState.lastRepairRehearsal.approvalPackage.approvalConfigTemplate.automaticActions.liveRepair;
    config.targets[0].automaticActions.liveRepair = {
      ...config.targets[0].automaticActions.liveRepair,
      targetId: activationTemplate.targetId,
      pr: activationTemplate.pr,
      headRefOid: activationTemplate.headRefOid,
      baseRefOid: activationTemplate.baseRefOid,
      repairKey: activationTemplate.repairKey,
      rollbackNote: activationTemplate.rollbackNote,
    };
    await writeJson(configPath, config);
    const expectedRemoteHead = git(['--git-dir', origin, 'rev-parse', `refs/heads/${headBranch}`], root).stdout.trim();
    const repair = run(process.execPath, [shepherd, 'repair', '--config', configPath, '--target', targetId], { env });
    const pushedRemoteHead = git(['--git-dir', origin, 'rev-parse', `refs/heads/${headBranch}`], root).stdout.trim();
    const repairedChangelog = git(['--git-dir', origin, 'show', `refs/heads/${headBranch}:CHANGELOG.md`], root).stdout;
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const lastPush = state.autoPushes.at(-1);

    assert.notEqual(pushedRemoteHead, expectedRemoteHead, 'sandbox branch should be updated by repair');
    assert.equal(lastPush.from, expectedRemoteHead, 'state records expected remote head used for lease');
    assert.equal(lastPush.to, pushedRemoteHead, 'state records pushed sandbox head');
    assert.match(state.lastActionSummary, /force-with-lease/, 'state records force-with-lease repair evidence');
    assert.ok(repairedChangelog.includes('Sandbox PR repair proof'));
    assert.ok(repairedChangelog.includes('Upstream release note'));
    assert.ok(!repairedChangelog.includes('<<<<<<<'));

    const proof = {
      schema: 'pr-shepherd-sandbox-repair-proof/v1',
      target: targetId,
      sandboxOnly: true,
      productionMutation: false,
      commands: [
        { name: 'rehearse', status: rehearse.status },
        { name: 'repair', status: repair.status },
      ],
      branch: headBranch,
      expectedRemoteHead,
      pushedRemoteHead,
      forceWithLeaseEvidence: {
        from: lastPush.from,
        to: lastPush.to,
        reason: lastPush.reason,
      },
      focusedChecksPassed: true,
      repairedChangelogContains: ['Sandbox PR repair proof', 'Upstream release note'],
      forbiddenRuntimeContextPaths: [],
    };
    const proofPath = join(artifactDir, 'sandbox-repair-proof.json');
    await writeJson(proofPath, proof);
    const displayProofPath = proofPath.startsWith(`${repoRoot}/`) ? relative(repoRoot, proofPath) : 'sandbox-repair-proof.json';
    console.log(JSON.stringify({ ok: true, proofPath: displayProofPath, ...proof }, null, 2));
  } finally {
    if (!keep) await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
