// Collect real metadata; exact UTC-date star baselines live in star-history.json.
// Never rewrite source code or synthesize missing counts or dates.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;
const VALID_NAME = /^[\w.-]+\/[\w.-]+$/;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const day = (value) => new Date(value).toISOString().slice(0, 10);
const isNonPublic = (data) => data.private === true || (data.visibility && data.visibility !== 'public');

export function recordDailySample(history, fullName, stars, sampledAt) {
  if (!VALID_NAME.test(fullName) || integer(stars) === null) throw new Error('Invalid star sample');
  const cutoff = Date.parse(day(sampledAt)) - 45 * DAY_MS;
  const next = {};
  for (const [name, entries] of Object.entries(history)) {
    const kept = Object.fromEntries(Object.entries(entries).filter(([date, count]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) && integer(count) !== null &&
      Date.parse(date) >= cutoff && Date.parse(date) <= Date.parse(day(sampledAt))));
    if (Object.keys(kept).length) next[name] = kept;
  }
  // Only today's last sample changes. Earlier UTC days remain fixed baselines.
  next[fullName] = { ...next[fullName], [day(sampledAt)]: stars };
  return next;
}

export function toSnapshotProject(data, fetchedAt, previous = {}) {
  if (isNonPublic(data)) throw new Error('Non-public repository metadata is excluded');
  if (!VALID_NAME.test(data.full_name || '') || integer(data.stargazers_count) === null) {
    throw new Error('GitHub response lacks valid repository name or star count');
  }
  return {
    ...previous, id: data.full_name, githubId: integer(data.id), fullName: data.full_name,
    name: data.name || data.full_name.split('/')[1],
    description: typeof data.description === 'string' ? data.description : '',
    descriptionSource: 'github-rest', provenance: 'GitHub REST repository metadata',
    htmlUrl: `https://github.com/${data.full_name}`,
    language: typeof data.language === 'string' ? data.language : null,
    stars: data.stargazers_count, forks: integer(data.forks_count),
    openIssues: integer(data.open_issues_count), license: data.license?.spdx_id || null,
    topics: Array.isArray(data.topics) ? data.topics.filter((topic) => typeof topic === 'string') : [],
    createdAt: iso(data.created_at), pushedAt: iso(data.pushed_at), updatedAt: iso(data.updated_at),
    contributors: null, // Repository metadata does not contain this count.
    archived: data.archived === true, disabled: data.disabled === true,
    fetchedAt, sampleDate: day(fetchedAt), availability: 'available', lastAttemptAt: fetchedAt,
    nextRetryAt: null, lastError: null, source: 'github-rest', metadataSource: 'github-rest',
  };
}

export function buildUpdateQueue(projects, now) {
  return projects.filter((repo) => VALID_NAME.test(repo.fullName || '') &&
    (!repo.nextRetryAt || Date.parse(repo.nextRetryAt) <= Date.parse(now)))
    .sort((a, b) => (Date.parse(a.fetchedAt) || 0) - (Date.parse(b.fetchedAt) || 0) ||
      Number(Boolean(a.createdAt)) - Number(Boolean(b.createdAt)) ||
      a.fullName.localeCompare(b.fullName));
}

export function discoveryQueries(now) {
  return [7, 30, 90].map((days) => ({ days,
    query: `created:>=${day(Date.parse(now) - days * DAY_MS)} stars:>=10 fork:false archived:false is:public` }));
}

// Injected I/O lets tests exercise resuming and rate limiting without network.
export async function syncData({ snapshot, history = {}, fetchImpl = fetch,
  now = () => new Date().toISOString(), token = '', limit = 750, budget = 900,
  discover = true, discoveryPages = 2, reserve = 5, maxRuntimeMs = 20 * 60_000 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.projects) || !snapshot.projects.length) {
    throw new Error('Missing repository registry: src/data/github-snapshot.json');
  }
  const startedAt = iso(now());
  if (!startedAt) throw new Error('Invalid collection time');
  const repos = new Map(snapshot.projects.map((repo) => [repo.fullName.toLowerCase(), { ...repo }]));
  let nextHistory = structuredClone(history);
  const warnings = [];
  const rates = structuredClone(snapshot.rateLimits || {});
  let requests = 0, failures = 0, unavailable = 0;
  let consecutiveFailures = 0;
  const startedClock = Date.now();
  let halted = Date.parse(snapshot.sync?.retryAfter) > Date.parse(startedAt);
  let latestSuccess = null, retryAfter = halted ? snapshot.sync.retryAfter : null;
  const refreshed = new Set();
  const discovery = [];
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'github-pulse-sync', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const warn = (message) => { if (warnings.length < 100) warnings.push(message); };
  const canRequest = (resource) => {
    if (halted || requests >= budget || Date.now() - startedClock >= maxRuntimeMs) return false;
    const rate = rates[resource];
    return !(rate && rate.remaining <= reserve && Date.parse(rate.resetAt) > Date.parse(now()));
  };
  async function request(path, resource) {
    if (!canRequest(resource)) return null;
    requests += 1;
    const response = await fetchImpl(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const bucket = response.headers.get('x-ratelimit-resource') || resource;
    if (remainingHeader !== null && Number.isFinite(Number(remainingHeader))) {
      rates[bucket] = { remaining: Number(remainingHeader),
        resetAt: resetHeader && Number.isFinite(Number(resetHeader)) ? new Date(Number(resetHeader) * 1000).toISOString() : null };
    }
    if ([401, 403, 429].includes(response.status)) {
      halted = true;
      const retrySeconds = Number(response.headers.get('retry-after'));
      retryAfter = retrySeconds > 0 ? new Date(Date.parse(now()) + retrySeconds * 1000).toISOString() : rates[bucket]?.resetAt || null;
      warn(`GitHub HTTP ${response.status}; collection stopped${retryAfter ? ` until at least ${retryAfter}` : ''}.`);
    }
    return response;
  }
  function accept(data, requestedName, fetchedAt) {
    const requestedKey = requestedName.toLowerCase();
    const previous = repos.get(requestedKey) || {};
    const project = toSnapshotProject(data, fetchedAt, previous);
    const canonicalKey = project.fullName.toLowerCase();
    // Redirected/renamed repositories retain their history under one name.
    if (previous.fullName && previous.fullName !== project.fullName) {
      nextHistory[project.fullName] = { ...nextHistory[previous.fullName], ...nextHistory[project.fullName] };
      delete nextHistory[previous.fullName];
    }
    if (requestedKey !== canonicalKey) repos.delete(requestedKey);
    repos.set(canonicalKey, project);
    nextHistory = recordDailySample(nextHistory, project.fullName, project.stars, fetchedAt);
    refreshed.add(canonicalKey);
    consecutiveFailures = 0;
    latestSuccess = fetchedAt;
  }
  if (discover) {
    for (const { days, query } of discoveryQueries(startedAt)) {
      const coverage = { days, query, totalCount: null, fetched: 0, pages: 0, incomplete: false, truncated: true };
      discovery.push(coverage);
      for (let page = 1; page <= discoveryPages; page += 1) {
        if (!canRequest('search')) break;
        try {
          const params = new URLSearchParams({ q: query, sort: 'stars', order: 'desc', per_page: '100', page: String(page) });
          const response = await request(`/search/repositories?${params}`, 'search');
          if (!response?.ok) throw new Error(response ? `HTTP ${response.status}` : 'request budget exhausted');
          const result = await response.json();
          if (!Array.isArray(result.items)) throw new Error('Invalid repository search result');
          consecutiveFailures = 0;
          coverage.totalCount = integer(result.total_count);
          coverage.incomplete ||= result.incomplete_results === true;
          coverage.pages += 1;
          const fetchedAt = iso(now());
          for (const item of result.items) {
            if (isNonPublic(item)) { warn('Non-public discovery result excluded.'); continue; }
            accept(item, item.full_name, fetchedAt);
          }
          coverage.fetched += result.items.length;
          coverage.truncated = coverage.incomplete || coverage.totalCount === null || coverage.fetched < coverage.totalCount;
          if (result.items.length < 100 || coverage.fetched >= Math.min(coverage.totalCount ?? 1000, 1000)) break;
        } catch (error) {
          failures += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 5) { halted = true; warn('Five consecutive request failures; preserving successful samples and stopping.'); }
          warn(`Discovery (${days} days, page ${page}): ${error.message}`);
          break;
        }
      }
    }
  }
  const eligible = buildUpdateQueue([...repos.values()], startedAt)
    .filter((repo) => !refreshed.has(repo.fullName.toLowerCase()));
  const queue = eligible.slice(0, limit);
  for (const repo of queue) {
    if (!canRequest('core')) break;
    const attemptedAt = iso(now());
    try {
      const response = await request(`/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`, 'core');
      if (response?.status === 404) {
        consecutiveFailures = 0;
        unavailable += 1;
        repos.set(repo.fullName.toLowerCase(), { ...repo, availability: 'unavailable', lastAttemptAt: attemptedAt,
          lastError: 'HTTP 404', nextRetryAt: new Date(Date.parse(attemptedAt) + 7 * DAY_MS).toISOString() });
        warn(`${repo.fullName}: unavailable through the public API (HTTP 404).`);
        continue;
      }
      if (!response?.ok) throw new Error(response ? `HTTP ${response.status}` : 'request budget exhausted');
      const data = await response.json();
      if (isNonPublic(data)) {
        unavailable += 1;
        repos.set(repo.fullName.toLowerCase(), { id: repo.fullName, fullName: repo.fullName,
          name: repo.fullName.split('/')[1], stars: null, forks: null, openIssues: null,
          description: '', language: null, license: null, topics: [], contributors: null,
          createdAt: null, pushedAt: null, updatedAt: null, fetchedAt: null,
          availability: 'unavailable', lastError: 'Repository is not public', lastAttemptAt: attemptedAt,
          nextRetryAt: new Date(Date.parse(attemptedAt) + 7 * DAY_MS).toISOString() });
        delete nextHistory[repo.fullName];
        warn(`${repo.fullName}: non-public metadata excluded.`);
        continue;
      }
      accept(data, repo.fullName, iso(now()));
    } catch (error) {
      failures += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) { halted = true; warn('Five consecutive request failures; preserving successful samples and stopping.'); }
      repos.set(repo.fullName.toLowerCase(), { ...repo, lastAttemptAt: attemptedAt,
        lastError: error.message, nextRetryAt: retryAfter || new Date(Date.parse(attemptedAt) + 3_600_000).toISOString() });
      warn(`${repo.fullName}: ${error.message}`);
    }
  }
  const projects = [...repos.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const pending = projects.filter((repo) => !repo.fetchedAt && repo.availability !== 'unavailable').length;
  const stoppedEarly = halted || requests >= budget || !canRequest('core') || (discover && !canRequest('search'));
  if (stoppedEarly) warn('Collection stopped at a request/time budget or upstream error; later runs resume with the oldest successful samples first.');
  if (!refreshed.size) warn('No repository metadata was collected; previous successful collection time is unchanged.');
  const result = !refreshed.size ? 'failed' : failures || unavailable || stoppedEarly || pending || eligible.length > limit ? 'partial' : 'success';
  return {
    exitCode: refreshed.size ? 0 : 1,
    snapshot: {
      ...snapshot, schemaVersion: 1, source: 'cached', fetchedAt: latestSuccess || snapshot.fetchedAt || null,
      projects, rateLimits: rates, warning: warnings.join(' '), warnings,
      coverage: { ...snapshot.coverage, scope: 'tracked-repositories', exhaustive: false,
        registered: projects.length, available: projects.filter((repo) => repo.availability === 'available').length,
        sampledCount: projects.filter((repo) => integer(repo.stars) !== null && repo.availability === 'available').length,
        metadataVerified: projects.filter((repo) => repo.createdAt && repo.availability === 'available').length,
        unavailable: projects.filter((repo) => repo.availability === 'unavailable').length,
        pending, fetchedThisRun: refreshed.size,
        discovery: discover ? discovery : snapshot.coverage?.discovery || [],
        discoveryAt: discover ? startedAt : snapshot.coverage?.discoveryAt || null,
        note: 'Tracked repositories plus bounded, star-sorted 7/30/90-day discovery samples; not all GitHub repositories.' },
      sync: { startedAt, result, requests, refreshed: refreshed.size, failures, unavailable, retryAfter },
    }, history: nextHistory,
  };
}

export function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function resolveToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function parseArguments(args) {
  const result = { dry: false, discover: true, limit: 750, budget: 900, discoveryPages: 2 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry') result.dry = true;
    else if (arg === '--discover') result.discover = true;
    else if (arg === '--no-discover') result.discover = false;
    else if (['--limit', '--budget', '--discovery-pages'].includes(arg)) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} requires a positive integer`);
      result[{ '--limit': 'limit', '--budget': 'budget', '--discovery-pages': 'discoveryPages' }[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.discoveryPages > 10) throw new Error('GitHub Search exposes at most 10 pages of 100 results');
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshotPath = join(ROOT, 'src/data/github-snapshot.json');
  const historyPath = join(ROOT, 'src/data/star-history.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  let history = {};
  try { history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = resolveToken();
  if (!token) console.log('No token: GitHub permits 60 unauthenticated core requests/hour; response headers control this run.');
  const outcome = await syncData({ ...options, snapshot, history, token });
  if (!options.dry) {
    // Publish snapshot last so it cannot advertise samples missing from history.
    atomicWriteJson(historyPath, outcome.history);
    atomicWriteJson(snapshotPath, outcome.snapshot);
  }
  console.log(`${options.dry ? 'DRY RUN (no files written): ' : ''}${outcome.snapshot.sync.result}; ${outcome.snapshot.sync.refreshed} repositories collected, ${outcome.snapshot.sync.requests} requests.`);
  for (const warning of outcome.snapshot.warnings) console.warn(`! ${warning}`);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Sync failed: ${error.message}`); process.exitCode = 1; });
}
