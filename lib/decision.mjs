// @ts-check
// Shared pre-mutation decision object (#123) and path risk classification used
// by the advanced automation lanes (Phase P auto-merge, Phase Q bounded retry,
// Phase R risky-change packet). None of these helpers mutate anything; they
// describe eligibility and risk for a gate or packet.
import { findOpenClawRuntimeContextPaths, MINOR_SAFE_RISK_CLASS, RISK_CLASS_SEVERITY } from './policy.mjs';
import { normalizedRepoPath } from './conflicts.mjs';

/**
 * The shared pre-mutation decision object recommended in #123. Every advanced
 * lane embeds one so operators read eligibility, provenance, risk class, the
 * expected head/lease, a checks snapshot, and the audit packet pointer in a
 * single consistent shape.
 * @typedef {object} PreMutationDecision
 * @property {string} schema
 * @property {boolean} eligible
 * @property {string[]} blockedReason
 * @property {?object} provenance
 * @property {?string} riskClass
 * @property {?string} policyId
 * @property {?string} expectedHead
 * @property {?object} checksSnapshot
 * @property {?string} auditPacketPath
 */

/**
 * @param {object} [fields]
 * @returns {PreMutationDecision}
 */
export function buildPreMutationDecision(fields = {}) {
  const blockedReason = [...new Set([...(fields.blockedReason || fields.blockedReasons || [])].filter(Boolean))];
  return {
    schema: 'pr-shepherd-pre-mutation-decision/v1',
    eligible: blockedReason.length === 0 && fields.eligible !== false,
    blockedReason,
    provenance: fields.provenance || null,
    riskClass: fields.riskClass || null,
    policyId: fields.policyId || null,
    expectedHead: fields.expectedHead || null,
    checksSnapshot: fields.checksSnapshot || null,
    auditPacketPath: fields.auditPacketPath || null,
  };
}

/**
 * Classify a single repo-relative path into a risk class. Aligned with the
 * minor-auto path risk rules so the auto-merge lane and the minor-auto repair
 * lane agree on what is documentation/text-safe.
 * @param {string} path
 * @returns {string} one of RISK_CLASS_SEVERITY
 */
export function classifyPathRiskCategory(path) {
  const normalized = normalizedRepoPath(path);
  const lower = normalized.toLowerCase();
  const name = lower.split('/').pop() || '';
  if (findOpenClawRuntimeContextPaths([normalized]).length > 0) return 'runtime-bootstrap-context';
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return 'unclassified';
  if (/^(.+\.)?(env|npmrc|yarnrc|pypirc)$/.test(name) || /(^|\/)(config|configs|security|auth|secrets?)(\/|$)/.test(lower)) return 'security-auth-config';
  if (lower === '.github' || lower.startsWith('.github/')) return 'ci-workflow';
  if (name === 'package.json' || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|cargo\.lock|go\.sum|composer\.lock|gemfile\.lock)$/.test(lower)) return 'dependency-lockfile';
  if (/\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|fish|ps1|sql)$/i.test(normalized)) return 'semantic-source';
  if (/\.(ya?ml|toml|json|lock)$/i.test(normalized)) return 'structured-data';
  if (/^(changelog|changes|news|release-notes?)(\.|\/|$)/i.test(normalized)) return MINOR_SAFE_RISK_CLASS;
  if (/^(docs|documentation)\//i.test(normalized) && /\.(md|mdx|txt|rst)$/i.test(normalized)) return MINOR_SAFE_RISK_CLASS;
  if (/\.(md|mdx|txt|rst)$/i.test(normalized)) return MINOR_SAFE_RISK_CLASS;
  return 'unclassified';
}

/**
 * Classify a set of changed paths, returning the highest-severity risk class
 * present plus the per-path breakdown.
 * @param {string[]} [paths]
 * @returns {{ riskClass: ?string, perPath: { path: string, riskClass: string }[] }}
 */
export function classifyChangedPathsRisk(paths = []) {
  const perPath = [...new Set(paths.map(normalizedRepoPath).filter(Boolean))]
    .sort()
    .map((path) => ({ path, riskClass: classifyPathRiskCategory(path) }));
  let topIndex = RISK_CLASS_SEVERITY.length - 1;
  for (const item of perPath) {
    const idx = RISK_CLASS_SEVERITY.indexOf(item.riskClass);
    if (idx >= 0 && idx < topIndex) topIndex = idx;
  }
  return { riskClass: perPath.length ? RISK_CLASS_SEVERITY[topIndex] : null, perPath };
}

/**
 * True only when every changed path is in the minor-safe documentation/text
 * risk class. Used as the non-risky precondition for auto-merge and bounded
 * retry.
 * @param {string[]} [paths]
 * @returns {boolean}
 */
export function changedPathsAreMinorSafe(paths = []) {
  const { perPath } = classifyChangedPathsRisk(paths);
  return perPath.length > 0 && perPath.every((item) => item.riskClass === MINOR_SAFE_RISK_CLASS);
}
