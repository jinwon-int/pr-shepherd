// Shared constants and OpenClaw runtime/bootstrap context denylist checks.
import { minorAutoSafeResolverIds } from './resolvers.mjs';
export const PR_FIELDS = [
  'number', 'state', 'mergeable', 'mergeStateStatus', 'mergedAt', 'headRefOid',
  'headRefName', 'baseRefName', 'updatedAt', 'statusCheckRollup', 'reviewDecision', 'url'
];

export const OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];

export const GITHUB_PROVIDERS = Object.freeze(['gh', 'rest']);
export const DEFAULT_SITUATION_REPORT_EVERY_MS = 6 * 60 * 60 * 1000;
export const MIN_LIVE_OPENCLAW_SITUATION_REPORT_EVERY_MS = 60 * 60 * 1000;
export const MINOR_AUTO_SAFE_REPAIR_SCOPE = 'minor-auto-safe-repair';
export const SUPPORTED_MINOR_AUTO_SAFE_RESOLVERS = Object.freeze(minorAutoSafeResolverIds());
export const MINOR_AUTO_ROLLOUT_MODES = Object.freeze([
  'observe-only',
  'sandbox-proof',
  'minor-auto-dry-run',
  'minor-auto-live-limited',
]);
export const DEFAULT_MINOR_AUTO_POST_PUSH_OBSERVATION_WINDOW_MS = 60 * 60 * 1000;

export const AUTOMATIC_ACTION_CLASSES = Object.freeze({
  RECHECK: 'recheck',
  DIAGNOSE: 'diagnose',
  DIAGNOSE_ONLY: 'diagnose-only',
  NOTIFY_ESCALATE: 'notify-escalate',
  REPAIR_REHEARSAL: 'repair-rehearsal',
  CONFLICT_ARTIFACT: 'conflict-artifact',
  AUTO_SAFE_REPAIR: 'auto-safe-repair',
  BLOCK: 'block',
});

export const FLEET_TARGET_STATE_TIERS = Object.freeze([
  'check-only',
  'rehearsal-ready',
  'phase-d-ready',
  'live-approved-once',
]);

export const DEFAULT_REPAIR_REHEARSAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REPAIR_PLAN_HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_SUPERVISED_REHEARSAL_QUEUE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_REHEARSAL_EVIDENCE_DIGEST_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_ACTION_LEDGER_LIMIT = 50;
export const DEFAULT_OBSERVATION_LEDGER_LIMIT = 288; // 48h at a 10-minute standing-ops cadence.
export const DEFAULT_STRICT_VERIFY_REQUIRED = true;
export const DEFAULT_INCIDENT_BLOCK_THRESHOLD = 3;
export const PHASE_E_POST_ACTION_OUTCOMES = ['no-op', 'pushed', 'block'];
export const REVIEW_DECISION_OUTCOMES = Object.freeze([
  'accepted-for-rehearsal',
  'route-code-assisted',
  'human-only',
  'wait-recheck',
  'no-op-clean',
  'blocked-stale',
  'blocked-risk',
]);

export const OBSERVATION_WARNING_KINDS = new Set(['dirty', 'failed', 'unknown']);
export const OBSERVATION_SUMMARY_KINDS = ['clean', 'unstable', 'unknown', 'failed', 'dirty', 'merged', 'disabled'];

export function findOpenClawRuntimeContextPaths(paths = []) {
  const rootFiles = new Set(OPENCLAW_RUNTIME_CONTEXT_ROOT_FILES);
  const offending = [];
  const seen = new Set();
  for (const rawPath of paths) {
    const path = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    if (rootFiles.has(path) || path === '.openclaw' || path.startsWith('.openclaw/')) {
      offending.push(path);
      seen.add(path);
    }
  }
  return offending.sort();
}

export function assertNoOpenClawRuntimeContextPaths(paths, evidenceKind) {
  const offending = findOpenClawRuntimeContextPaths(paths);
  if (offending.length > 0) {
    throw new Error(`OpenClaw runtime/bootstrap context paths would enter ${evidenceKind}; refusing: ${offending.join(', ')}`);
  }
}
