#!/usr/bin/env node
// Minimal event-trigger receiver for PR Shepherd.
//
// Accepts authenticated POST /trigger requests (for example from a GitHub
// Actions workflow in the watched fork) and runs exactly one read-only
// one-shot `check-canary --target <id>` against the operator-local config and
// state. It is a latency optimization on top of the polling timers, never a
// replacement for them, and it can never start a mutation lane: the spawned
// command is fixed to the read-only check path and targets must be on an
// explicit allowlist.
//
// Environment (no secrets in argv or config files):
//   PR_SHEPHERD_EVENT_SECRET      shared secret, required, min 16 chars
//   PR_SHEPHERD_EVENT_CONFIG      path to the operator config.json, required
//   PR_SHEPHERD_EVENT_TARGETS     comma-separated target id allowlist, required
//   PR_SHEPHERD_EVENT_PORT        listen port (default 8743)
//   PR_SHEPHERD_EVENT_HOST        listen host (default 127.0.0.1)
//   PR_SHEPHERD_EVENT_DEBOUNCE_MS per-target debounce (default 60000)
//   PR_SHEPHERD_BIN               pr-shepherd.mjs path (default: repo sibling)
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shepherdBin = process.env.PR_SHEPHERD_BIN || join(repoRoot, 'pr-shepherd.mjs');
const secret = process.env.PR_SHEPHERD_EVENT_SECRET || '';
const configPath = process.env.PR_SHEPHERD_EVENT_CONFIG || '';
const allowedTargets = new Set((process.env.PR_SHEPHERD_EVENT_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean));
const port = Number(process.env.PR_SHEPHERD_EVENT_PORT || 8743);
const host = process.env.PR_SHEPHERD_EVENT_HOST || '127.0.0.1';
const debounceMs = Number(process.env.PR_SHEPHERD_EVENT_DEBOUNCE_MS || 60000);

if (secret.length < 16) {
  console.error('PR_SHEPHERD_EVENT_SECRET is required and must be at least 16 characters');
  process.exit(1);
}
if (!configPath) {
  console.error('PR_SHEPHERD_EVENT_CONFIG is required');
  process.exit(1);
}
if (allowedTargets.size === 0) {
  console.error('PR_SHEPHERD_EVENT_TARGETS is required (comma-separated target id allowlist)');
  process.exit(1);
}

const lastTriggerAt = new Map();

function secretMatches(candidate) {
  const a = createHash('sha256').update(String(candidate || '')).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
}

function runCheckCanary(target) {
  const args = [shepherdBin, 'check-canary', '--config', configPath, '--target', target];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => {
    console.log(JSON.stringify({ event: 'check-canary-finished', target, code, at: new Date().toISOString() }));
  });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return respond(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/trigger') return respond(res, 404, { ok: false, error: 'not found' });
  if (!secretMatches(req.headers['x-pr-shepherd-secret'])) return respond(res, 401, { ok: false, error: 'unauthorized' });

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => {
    let target = null;
    try {
      target = JSON.parse(raw || '{}').target;
    } catch {
      return respond(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    if (typeof target !== 'string' || !allowedTargets.has(target)) {
      return respond(res, 403, { ok: false, error: 'target not on the event-trigger allowlist' });
    }
    const last = lastTriggerAt.get(target) || 0;
    const now = Date.now();
    if (now - last < debounceMs) {
      return respond(res, 202, { ok: true, target, action: 'debounced' });
    }
    lastTriggerAt.set(target, now);
    console.log(JSON.stringify({ event: 'check-canary-trigger', target, at: new Date(now).toISOString() }));
    runCheckCanary(target);
    return respond(res, 202, { ok: true, target, action: 'check-canary-started' });
  });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: 'listening', host, port, targets: [...allowedTargets], command: 'check-canary' }));
});
