#!/usr/bin/env node
// Generates docs/runtime-context-policy.md from the code constants in
// lib/policy.mjs and verifies that no markdown document drifts from the
// runtime/bootstrap contamination denylist.
//
// Usage:
//   node scripts/policy-docs.mjs generate   # (re)write the generated doc
//   node scripts/policy-docs.mjs check      # fail if the doc is stale or any
//                                           # markdown lists the denylist partially
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES,
  AUTOMATIC_ACTION_CLASSES,
  MINOR_AUTO_ROLLOUT_MODES,
  FLEET_TARGET_STATE_TIERS,
  DEFAULT_ACTION_LEDGER_LIMIT,
  DEFAULT_OBSERVATION_LEDGER_LIMIT,
  DEFAULT_SITUATION_REPORT_EVERY_MS,
  MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS,
  DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS,
  DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS,
  MINOR_AUTO_MERGE_SCOPE,
  BOUNDED_RETRY_SCOPE,
  RISKY_CHANGE_APPROVAL_SCOPE,
  SUPPORTED_MERGE_METHODS,
  MAX_BOUNDED_RETRY_ATTEMPTS,
  RISK_CLASS_SEVERITY,
} from '../lib/policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(repoRoot, 'docs', 'runtime-context-policy.md');

function hours(ms) {
  return `${ms / (60 * 60 * 1000)}h`;
}

function renderDoc() {
  return `<!-- GENERATED FILE - do not edit by hand. Source: lib/policy.mjs. Regenerate with: npm run docs:policy -->

# Runtime-context contamination policy

This document is generated from the constants in \`lib/policy.mjs\` so the
documented policy can never drift from the enforced policy. Every gate that
writes evidence, attaches artifacts, or pushes a branch fails closed when one
of these repo-relative paths would be included.

## Denylisted OpenClaw runtime/bootstrap context paths

${OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES.map((p) => `- \`${p}\``).join('\n')}
- \`.openclaw/**\`

Block reports must name only the offending repo-relative paths, never the file
contents.

## Automatic action classes

${Object.values(AUTOMATIC_ACTION_CLASSES).map((c) => `- \`${c}\``).join('\n')}

## Minor-auto rollout modes

${MINOR_AUTO_ROLLOUT_MODES.map((m) => `- \`${m}\``).join('\n')}

## Fleet target state tiers

${FLEET_TARGET_STATE_TIERS.map((t) => `- \`${t}\``).join('\n')}

## Advanced automation lane scopes (default off)

| Lane | Scope | Notes |
| --- | --- | --- |
| Phase P auto-merge | \`${MINOR_AUTO_MERGE_SCOPE}\` | Only proven minor-auto outputs; merge methods: ${SUPPORTED_MERGE_METHODS.map((m) => `\`${m}\``).join(', ')} |
| Phase Q bounded retry | \`${BOUNDED_RETRY_SCOPE}\` | Max ${MAX_BOUNDED_RETRY_ATTEMPTS} attempts, same scope only |
| Phase R risky-change approval | \`${RISKY_CHANGE_APPROVAL_SCOPE}\` | One-shot, expiring, packet-prepared |

Risk classes, most-risky first (only \`${RISK_CLASS_SEVERITY[RISK_CLASS_SEVERITY.length - 1]}\` may pass the auto-merge lane):

${RISK_CLASS_SEVERITY.map((c) => `- \`${c}\``).join('\n')}

## Key defaults

| Constant | Value |
| --- | --- |
| \`DEFAULT_ACTION_LEDGER_LIMIT\` | ${DEFAULT_ACTION_LEDGER_LIMIT} entries |
| \`DEFAULT_OBSERVATION_LEDGER_LIMIT\` | ${DEFAULT_OBSERVATION_LEDGER_LIMIT} entries |
| \`DEFAULT_SITUATION_REPORT_EVERY_MS\` | ${hours(DEFAULT_SITUATION_REPORT_EVERY_MS)} |
| \`MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS\` | ${hours(MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS)} |
| \`DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS\` | ${hours(DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS)} |
| \`DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS\` | ${hours(DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS)} |
`;
}

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

function checkDenylistDrift() {
  const problems = [];
  const required = [...OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES, '.openclaw'];
  for (const path of markdownFiles(repoRoot)) {
    if (resolve(path) === docPath) continue;
    const text = readFileSync(path, 'utf8');
    const mentioned = OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES.filter((p) => text.includes(p));
    if (mentioned.length === 0) continue;
    const missing = required.filter((p) => !text.includes(p));
    if (missing.length > 0) {
      problems.push(`${relative(repoRoot, path)}: lists the runtime-context denylist partially; missing ${missing.join(', ')} (see docs/runtime-context-policy.md)`);
    }
  }
  return problems;
}

const mode = process.argv[2];
if (mode === 'generate') {
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, renderDoc());
  console.log(`wrote ${relative(repoRoot, docPath)}`);
} else if (mode === 'check') {
  const problems = [];
  if (!existsSync(docPath)) {
    problems.push('docs/runtime-context-policy.md is missing; run: npm run docs:policy');
  } else if (readFileSync(docPath, 'utf8') !== renderDoc()) {
    problems.push('docs/runtime-context-policy.md is stale; run: npm run docs:policy');
  }
  problems.push(...checkDenylistDrift());
  if (problems.length > 0) {
    for (const problem of problems) console.error(`policy-docs: ${problem}`);
    process.exit(1);
  }
  console.log('policy docs in sync');
} else {
  console.error('usage: node scripts/policy-docs.mjs <generate|check>');
  process.exit(2);
}
