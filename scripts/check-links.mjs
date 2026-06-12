#!/usr/bin/env node
// Fails when any markdown file in the repository contains a relative link to a
// file that does not exist. External (http/mailto) and pure-anchor links are
// ignored; anchors on relative links are stripped before the existence check.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of markdownFiles(repoRoot)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(path)))) {
      problems.push(`${relative(repoRoot, file)}: broken relative link -> ${target}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-links: ${problem}`);
  process.exit(1);
}
console.log('markdown links ok');
