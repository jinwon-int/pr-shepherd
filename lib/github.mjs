// Read-only GitHub PR access behind pluggable providers.
//
// Providers implement fetchPrState(target) and fetchChangedFiles(target).
// 'gh' (default) shells out to the authenticated gh CLI exactly as before.
// 'rest' talks to the GitHub API directly with GITHUB_TOKEN/GH_TOKEN, using
// the GraphQL endpoint for PR state so field shapes and enums stay identical
// to `gh pr view --json`. Both lanes are read-only; pushes never go through
// a provider.
import { GITHUB_PROVIDERS, PR_FIELDS } from './policy.mjs';
import { run } from './targets.mjs';
import { classifyPr } from './classify.mjs';

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const DEFAULT_REST_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

export function githubProvider(target = {}) {
  return target.github?.provider || process.env.PR_SHEPHERD_GITHUB_PROVIDER || 'gh';
}

export function githubApiBaseUrl(target = {}) {
  return String(target.github?.apiBaseUrl || process.env.PR_SHEPHERD_GITHUB_API_URL || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
}

export function githubToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

export function ghPrView(target) {
  const res = run('gh', ['pr', 'view', String(target.number), '--repo', `${target.owner}/${target.repo}`, '--json', PR_FIELDS.join(',')]);
  return JSON.parse(res.stdout);
}

export function ghPrChangedFiles(target) {
  const res = run('gh', ['api', `repos/${target.owner}/${target.repo}/pulls/${target.number}/files`, '--paginate'], { allowFailure: true });
  if (res.status !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed.flat() : [];
  } catch {
    try {
      const pages = JSON.parse(`[${res.stdout.trim().replace(/]\s*\[/g, '],[')}]`);
      return Array.isArray(pages) ? pages.flat() : [];
    } catch {
      return [];
    }
  }
}

// Synchronous HTTP via a short-lived child Node process running fetch, so the
// rest of the CLI stays synchronous and dependency-free. The request payload
// (including the Authorization header) travels only through the child's
// environment, never through argv or logs.
export function httpRequestSync(request) {
  const script = [
    "const req = JSON.parse(process.env.PR_SHEPHERD_HTTP_REQUEST);",
    "const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.body || undefined });",
    'const body = await res.text();',
    'const headers = {};',
    'for (const [name, value] of res.headers) headers[name.toLowerCase()] = value;',
    'process.stdout.write(JSON.stringify({ status: res.status, headers, body }));',
  ].join('\n');
  const res = run(process.execPath, ['--input-type=module', '-e', script], {
    env: { PR_SHEPHERD_HTTP_REQUEST: JSON.stringify(request) },
    allowFailure: true,
  });
  if (res.status !== 0) {
    throw new Error(`GitHub API request failed before a response was received: ${res.output.trim().slice(-2000)}`);
  }
  return JSON.parse(res.stdout);
}

export function githubRestErrorMessage(status, headers = {}, context = 'GitHub API request') {
  if (status === 401) {
    return `${context} was rejected (HTTP 401); set GITHUB_TOKEN (or GH_TOKEN) with read access to the watched repository`;
  }
  const remaining = Number(headers['x-ratelimit-remaining']);
  if ((status === 403 || status === 429) && remaining === 0) {
    const resetAt = Number(headers['x-ratelimit-reset']);
    const resetText = Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toISOString() : 'unknown';
    return `${context} hit the GitHub API rate limit; it resets at ${resetText}. Reduce check cadence or use a token with a higher limit`;
  }
  return `${context} failed with HTTP ${status}`;
}

function restRetryDelays(target = {}) {
  const configured = target.github?.retryDelaysMs;
  if (Array.isArray(configured) && configured.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0)) {
    return configured.map(Number);
  }
  return [...DEFAULT_REST_RETRY_DELAYS_MS];
}

export function restRequest(target, path, fields = {}, transport = httpRequestSync) {
  const token = githubToken();
  if (!token) {
    throw new Error('GitHub rest provider requires GITHUB_TOKEN or GH_TOKEN in the environment; use the default gh provider when only gh CLI auth is available');
  }
  const method = fields.method || 'GET';
  const context = fields.context || `GitHub API ${method} ${path}`;
  const url = `${githubApiBaseUrl(target)}${path}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'pr-shepherd',
    'x-github-api-version': '2022-11-28',
    ...(fields.body ? { 'content-type': 'application/json' } : {}),
  };
  const delays = restRetryDelays(target);
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) sleepMs(delays[attempt - 1]);
    let response;
    try {
      response = transport({ url, method, headers, body: fields.body || null });
    } catch (err) {
      lastError = err; // network-level failure: retry
      continue;
    }
    if (response.status >= 200 && response.status < 300) return response;
    const message = githubRestErrorMessage(response.status, response.headers || {}, context);
    if (response.status >= 500) {
      lastError = new Error(message); // transient server error: retry
      continue;
    }
    throw new Error(message); // 4xx (including rate limit): fail closed immediately
  }
  throw lastError || new Error(`${context} failed after retries`);
}

export const GRAPHQL_PR_QUERY = `query PrShepherdPrState($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state mergeable mergeStateStatus mergedAt headRefOid headRefName baseRefName updatedAt reviewDecision url
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

// Maps the GraphQL pull request node onto the exact shape gh pr view --json
// produces, so classification and state handling never see provider drift.
export function mapGraphQlPullRequest(node) {
  if (!node || typeof node !== 'object') {
    throw new Error('GitHub GraphQL response did not include the requested pull request; check repository access and PR number');
  }
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  return {
    number: node.number,
    state: node.state,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    mergedAt: node.mergedAt ?? null,
    headRefOid: node.headRefOid,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision ?? null,
    url: node.url,
    statusCheckRollup: contexts.map((ctx) => (ctx.__typename === 'StatusContext'
      ? { __typename: 'StatusContext', context: ctx.context, state: ctx.state, targetUrl: ctx.targetUrl ?? null }
      : { __typename: ctx.__typename || 'CheckRun', name: ctx.name, status: ctx.status, conclusion: ctx.conclusion, detailsUrl: ctx.detailsUrl ?? null })),
  };
}

export function restPrView(target, transport = httpRequestSync) {
  const context = `GitHub GraphQL pull request lookup for ${target.owner}/${target.repo}#${target.number}`;
  const response = restRequest(target, '/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: GRAPHQL_PR_QUERY, variables: { owner: target.owner, repo: target.repo, number: target.number } }),
    context,
  }, transport);
  const parsed = JSON.parse(response.body);
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error(`${context} failed: ${parsed.errors.map((err) => err.message).join('; ').slice(0, 2000)}`);
  }
  return mapGraphQlPullRequest(parsed.data?.repository?.pullRequest);
}

// Changed files stay best-effort to match the gh provider: callers treat an
// empty list as "no summaries available", never as approval to act.
export function restChangedFiles(target, transport = httpRequestSync) {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    let response;
    try {
      response = restRequest(target, `/repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=100&page=${page}`, {
        context: `GitHub changed-files lookup for ${target.owner}/${target.repo}#${target.number}`,
      }, transport);
    } catch {
      return files;
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return files;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) break;
    files.push(...parsed);
    if (parsed.length < 100) break;
  }
  return files;
}

export function fetchPrState(target) {
  return githubProvider(target) === 'rest' ? restPrView(target) : ghPrView(target);
}

export function fetchChangedFiles(target) {
  return githubProvider(target) === 'rest' ? restChangedFiles(target) : ghPrChangedFiles(target);
}

export function sleepMs(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

export function shouldRecheckUnknown(classification) {
  return classification.kind === 'unknown'
    && classification.checks.failed.length === 0
    && classification.checks.pending.length === 0;
}

export function ghPrViewWithUnknownRecheck(target) {
  const maxRechecks = Math.max(0, Number.isFinite(Number(target.unknownRecheckAttempts)) ? Number(target.unknownRecheckAttempts) : 2);
  const delayMs = Math.max(0, Number.isFinite(Number(target.unknownRecheckDelayMs)) ? Number(target.unknownRecheckDelayMs) : 1500);
  let pr = fetchPrState(target);
  let classification = classifyPr(pr);
  let rechecks = 0;
  while (rechecks < maxRechecks && shouldRecheckUnknown(classification)) {
    rechecks += 1;
    sleepMs(delayMs);
    pr = fetchPrState(target);
    classification = classifyPr(pr);
  }
  return { pr, classification, rechecks };
}
