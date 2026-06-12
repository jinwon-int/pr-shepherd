// Registry of deterministic autoSafe conflict resolvers.
//
// Contract: a resolver must be deterministic, scoped to the single conflicted
// file named by its policy entry, side-effect-free outside that file, and must
// return false (fail closed) on any unexpected content. Resolvers never stage,
// commit, or push; callers stage the path after a successful resolution.
// Resolvers marked minorAutoSafe are eligible for the bounded Phase M/N
// minor-auto lane; everything else stays approval-required.
import { readFileSync, writeFileSync } from 'node:fs';

const REGISTRY = new Map();

function registerResolver(id, definition) {
  REGISTRY.set(id, Object.freeze({ id, minorAutoSafe: false, ...definition }));
}

export function getResolver(id) {
  return REGISTRY.get(id) || null;
}

export function supportedResolverIds() {
  return [...REGISTRY.keys()];
}

export function minorAutoSafeResolverIds() {
  return [...REGISTRY.values()].filter((resolver) => resolver.minorAutoSafe).map((resolver) => resolver.id);
}

registerResolver('merge-changelog-top-entry', {
  description: 'Merge both sides of a changelog conflict, keeping every distinct line once and requiring the configured needle line to be present.',
  minorAutoSafe: true,
  validateEntry(entry, entryPath, errors) {
    if (typeof entry.needle !== 'string') errors.push(`${entryPath}.needle is required for merge-changelog-top-entry`);
  },
  resolve(target, policyEntry) {
    const path = `${target.worktreePath}/${policyEntry.path}`;
    const text = readFileSync(path, 'utf8');
    if (!text.includes('<<<<<<<') || !text.includes('>>>>>>>')) return false;
    if (policyEntry.needle && !text.includes(policyEntry.needle)) return false;
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
    return true;
  },
});
