// PR check and merge-state classification.
export function checkIdentity(check) {
  return check.name || check.context || check.workflowName || check.__typename || 'unknown-check';
}

export function isBenignCompletedConclusion(conclusion) {
  const normalizedConclusion = String(conclusion || '').toUpperCase();
  return !normalizedConclusion || ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(normalizedConclusion);
}

export function classifyChecks(statusCheckRollup = []) {
  const failed = [];
  const pending = [];
  const ignored = [];
  const groups = new Map();

  for (const c of statusCheckRollup || []) {
    const name = checkIdentity(c);
    const entry = {
      name,
      status: c.status || '',
      conclusion: c.conclusion || '',
      detailsUrl: c.detailsUrl || c.targetUrl || c.url || null,
    };
    const group = groups.get(name) || [];
    group.push(entry);
    groups.set(name, group);
  }

  for (const group of groups.values()) {
    const pendingEntries = group.filter((check) => {
      const normalizedStatus = String(check.status || '').toUpperCase();
      return normalizedStatus && normalizedStatus !== 'COMPLETED';
    });
    if (pendingEntries.length > 0) {
      pending.push(...pendingEntries);
      ignored.push(...group.filter((check) => String(check.status || '').toUpperCase() === 'COMPLETED' && !isBenignCompletedConclusion(check.conclusion)));
      continue;
    }

    const hasPassingTerminal = group.some((check) => isBenignCompletedConclusion(check.conclusion));
    if (hasPassingTerminal) {
      ignored.push(...group.filter((check) => !isBenignCompletedConclusion(check.conclusion)));
      continue;
    }

    failed.push(...group);
  }

  return { failed, pending, ignored };
}

export function classifyPr(pr) {
  const checks = classifyChecks(pr.statusCheckRollup);
  if (pr.mergedAt || pr.state === 'MERGED') return { kind: 'merged', checks };
  if (checks.failed.length > 0) return { kind: 'failed', checks };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { kind: 'dirty', checks };
  if (pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'UNSTABLE' && checks.pending.length > 0) return { kind: 'unstable', checks };
  if (pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN' && checks.pending.length === 0) return { kind: 'clean', checks };
  return { kind: 'unknown', checks };
}

export function notificationKey(kind, pr, checks, extra = '') {
  if (kind === 'failed') return `failed:${pr.headRefOid}:${checks.failed.map((c) => `${c.name}:${c.conclusion}`).sort().join('|')}`;
  if (kind === 'unstable') return `unstable:${pr.headRefOid}:${checks.pending.length}:${extra}`;
  return `${kind}:${pr.headRefOid || ''}:${pr.mergeable || ''}:${pr.mergeStateStatus || ''}:${extra}`;
}
