// Collect real metadata; exact UTC-date star baselines live in star-history.json.
// Never rewrite source code or synthesize missing counts or dates.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyStarActivity, refreshStarActivity, summarizeStarActivity } from '../src/data/star-activity.js';
import { discoverySearchPlan, classifyRepositoryDetails, translateWithProvider, withinScope, scopeCutoffMs } from '../src/data/github-data.js';

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
  // Case variants of the same repository (e.g. after an owner rename) are one
  // repo: fold them into the canonical current casing instead of keeping
  // duplicate keys that strict JSON parsers reject.
  const lower = fullName.toLowerCase();
  let record = {};
  for (const name of Object.keys(next)) {
    if (name.toLowerCase() === lower) {
      record = { ...record, ...next[name] };
      delete next[name];
    }
  }
  // Only today's last sample changes. Earlier UTC days remain fixed baselines.
  next[fullName] = { ...record, [day(sampledAt)]: stars };
  return next;
}

export function toSnapshotProject(data, fetchedAt, previous = {}) {
  if (isNonPublic(data)) throw new Error('Non-public repository metadata is excluded');
  if (!VALID_NAME.test(data.full_name || '') || integer(data.stargazers_count) === null) {
    throw new Error('GitHub response lacks valid repository name or star count');
  }
  const description = typeof data.description === 'string' ? data.description : '';
  const language = typeof data.language === 'string' ? data.language : null;
  const topics = Array.isArray(data.topics) ? data.topics.filter((topic) => typeof topic === 'string') : [];
  const classification = classifyRepositoryDetails({ fullName: data.full_name, name: data.name, description, language, topics });
  // A changed original invalidates the persisted translation; identical text
  // keeps it so the Chinese description survives routine metadata refreshes.
  const keepTranslation = description === (previous.description || '');
  return {
    ...previous, id: data.full_name, githubId: integer(data.id), fullName: data.full_name,
    name: data.name || data.full_name.split('/')[1],
    description,
    descriptionZh: keepTranslation ? previous.descriptionZh ?? null : null,
    descriptionZhAt: keepTranslation ? previous.descriptionZhAt ?? null : null,
    descriptionZhProvider: keepTranslation ? previous.descriptionZhProvider ?? null : null,
    descriptionSource: 'github-rest', provenance: 'GitHub REST repository metadata',
    htmlUrl: `https://github.com/${data.full_name}`,
    language,
    category: classification.category, categoryTags: classification.tags, categoryVersion: classification.version,
    stars: data.stargazers_count, forks: integer(data.forks_count),
    openIssues: integer(data.open_issues_count), license: data.license?.spdx_id || null,
    topics,
    createdAt: iso(data.created_at), pushedAt: iso(data.pushed_at), updatedAt: iso(data.updated_at),
    contributors: null, // Repository metadata does not contain this count.
    archived: data.archived === true, disabled: data.disabled === true,
    fetchedAt, sampleDate: day(fetchedAt), availability: 'available', lastAttemptAt: fetchedAt,
    nextRetryAt: null, lastError: null, source: 'github-rest', metadataSource: 'github-rest',
  };
}

/**
 * Persisted Chinese descriptions via the shared provider chain (Google
 * first, MyMemory fallback). Repositories are translated in descending
 * official weekly star additions, so the surge board gets Chinese copy
 * first; total stars only break ties. Repositories without activity data
 * sort last (-1). With `retranslate`, entries whose persisted translation
 * did not come from Google are redone so quality upgrades roll through the
 * corpus without touching already-Google translations. The first service
 * failure stops the run's translation phase; untranslated repositories
 * simply keep their original text until a later run.
 */
export async function translateDescriptions(repos, { fetchImpl = fetch, now = () => new Date().toISOString(), limit = 50, activity = null, retranslate = false, delayMs = 0,
  sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) } = {}) {
  const nowMs = Date.parse(now());
  const pending = repos.filter((repo) => repo.availability === 'available' && typeof repo.description === 'string' &&
    repo.description.trim() && !/[一-龥]/.test(repo.description) &&
    (!repo.descriptionZh || (retranslate && repo.descriptionZhProvider !== 'google')))
    .sort((a, b) => {
      const addedLastWeek = (repo) => {
        const cached = activity?.repositories?.[repo.fullName];
        if (!cached) return -1;
        return summarizeStarActivity(cached, { now: nowMs, createdAt: repo.createdAt }).weekAdded ?? -1;
      };
      return addedLastWeek(b) - addedLastWeek(a) || (b.stars || 0) - (a.stars || 0) || a.fullName.localeCompare(b.fullName);
    });
  let translated = 0, stopped = false;
  for (const repo of pending.slice(0, Math.max(0, limit))) {
    if (translated > 0 && delayMs > 0) await sleepImpl(delayMs); // pace requests so scheduled bulk runs stay under provider limits
    try {
      const { text, provider } = await translateWithProvider(repo.description, { fetchImpl });
      if (provider === 'none') continue;
      repo.descriptionZh = text;
      repo.descriptionZhAt = iso(now());
      repo.descriptionZhProvider = provider;
      translated += 1;
    } catch {
      stopped = true; // Quota or outage: resume with the next collection run.
      break;
    }
  }
  return { translated, pending: pending.length, stopped };
}

/**
 * Update queue priority: staleness in hours, plus two boosts measured in
 * equivalent stale hours so a single numeric comparison orders the queue.
 * - Hot repositories (>= 100 official additions last week) are refreshed as if
 *   they were 48h stale, keeping surge rankings current regardless of the tail.
 * - Repositories whose last push sits near the 24h "daily update" boundary
 *   get a 24h boost so the board does not flip on stale metadata.
 * - Repositories below LOW_STAR_STARS sampled within LOW_STAR_INTERVAL_HOURS
 *   carry a negative boost: scarce daily capacity serves higher-star projects
 *   first, and the low-star tail rotates in roughly every other day. Projects
 *   never sampled successfully are unaffected — their staleness is maximal.
 * Without activity data the ordering is pure oldest-first, as before.
 */
const LOW_STAR_STARS = 1000;
const LOW_STAR_INTERVAL_HOURS = 36;
export function buildUpdateQueue(projects, now, { activity = null } = {}) {
  const nowMs = Date.parse(now);
  const staleness = (repo) => (nowMs - (Date.parse(repo.fetchedAt) || 0)) / 3_600_000;
  const boost = (repo) => {
    let hours = 0;
    const cached = activity?.repositories?.[repo.fullName];
    if (cached) {
      const added = summarizeStarActivity(cached, { now: nowMs, createdAt: repo.createdAt }).weekAdded;
      if (added !== null && added >= 100) hours += 48;
    }
    const pushed = Date.parse(repo.pushedAt);
    if (Number.isFinite(pushed)) {
      const ageHours = (nowMs - pushed) / 3_600_000;
      if (ageHours >= 18 && ageHours <= 36) hours += 24;
    }
    if (Number.isFinite(repo.stars) && repo.stars < LOW_STAR_STARS && staleness(repo) < LOW_STAR_INTERVAL_HOURS)
      hours -= LOW_STAR_INTERVAL_HOURS;
    return hours;
  };
  return projects.filter((repo) => VALID_NAME.test(repo.fullName || '') &&
    (!repo.nextRetryAt || Date.parse(repo.nextRetryAt) <= Date.parse(now)))
    .sort((a, b) => (staleness(b) + boost(b)) - (staleness(a) + boost(a)) ||
      Number(Boolean(a.createdAt)) - Number(Boolean(b.createdAt)) ||
      a.fullName.localeCompare(b.fullName));
}

export function discoveryQueries(now) {
  return discoverySearchPlan(now);
}

// Injected I/O lets tests exercise resuming and rate limiting without network.
export async function syncData({ snapshot, history = {}, fetchImpl = fetch,
  now = () => new Date().toISOString(), token = '', limit = 750, budget = 900,
  discover = true, discoveryPages = 2, reserve = 5, maxRuntimeMs = 20 * 60_000, activity = null,
  harvest = false, harvestMinStars = 1000, harvestMaxStars = null, harvestDelayMs = 2200 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.projects)) {
    throw new Error('Missing repository registry: src/data/github-snapshot.json');
  }
  // An empty registry is valid only when discovery (or harvest) can seed it;
  // a bare refresh of nothing is a misconfiguration.
  if (!snapshot.projects.length && !discover && !harvest) {
    throw new Error('Missing repository registry: src/data/github-snapshot.json');
  }
  const startedAt = iso(now());
  if (!startedAt) throw new Error('Invalid collection time');
  const repos = new Map(snapshot.projects.map((repo) => [repo.fullName.toLowerCase(), { ...repo }]));
  let nextHistory = structuredClone(history);
  // Product scope is a rolling three-year creation window: every run prunes
  // repositories that have aged out, together with their star history.
  const scopeNow = Date.parse(startedAt);
  let pruned = 0;
  for (const [key, repo] of [...repos.entries()]) {
    if (repo.availability === 'available' && repo.createdAt && !withinScope(repo.createdAt, scopeNow)) {
      repos.delete(key);
      delete nextHistory[repo.fullName];
      pruned += 1;
    }
  }
  // Orphan history entries (renames, earlier removals) have no consumer.
  const registryNames = new Set([...repos.values()].map((repo) => repo.fullName));
  for (const name of Object.keys(nextHistory)) {
    if (!registryNames.has(name)) delete nextHistory[name];
  }
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
  if (pruned) warn(`${pruned} repositories aged out of the rolling three-year scope and were removed.`);
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
  // Harvest mode replaces bounded discovery: star-band slicing enumerates the
  // whole high-star tail of the rolling scope, not just each window's top 200.
  const harvestCoverage = { minStars: harvestMinStars, maxStars: harvestMaxStars, scopeStart: day(scopeCutoffMs(scopeNow)), bands: [], fetched: 0, completedAt: null };
  if (harvest) {
    const pace = () => harvestDelayMs > 0 ? new Promise((resolvePace) => setTimeout(resolvePace, harvestDelayMs)) : null;
    const scopeQ = `created:>=${day(scopeCutoffMs(scopeNow))} is:public`;
    const searchPage = async (starsQ, page, perPage) => {
      // Authenticated Search permits 30 requests/minute; pacing keeps long
      // harvest runs clear of the secondary rate limit.
      await pace();
      const params = new URLSearchParams({ q: `${scopeQ} ${starsQ}`, sort: 'stars', order: 'desc', per_page: String(perPage), page: String(page) });
      const response = await request(`/search/repositories?${params}`, 'search');
      if (!response?.ok) throw new Error(response ? `HTTP ${response.status}` : 'request budget exhausted');
      return response.json();
    };
    // Split [lo, hi] (hi null = unbounded) until every band fits the 1000-result
    // page cap; a single star value over the cap cannot be split further.
    const split = async (lo, hi) => {
      const starsQ = hi === null ? `stars:>=${lo}` : hi === lo ? `stars:${lo}` : `stars:${lo}..${hi}`;
      if (!canRequest('search')) return [{ stars: starsQ, total: null, truncated: true }];
      const countResult = await searchPage(starsQ, 1, 1);
      const total = integer(countResult.total_count) ?? 0;
      if (total > 1000 && (hi === null || hi > lo)) {
        const mid = hi === null ? lo * 2 - 1 : lo + Math.floor((hi - lo) / 2);
        return [...await split(lo, mid), ...await split(mid + 1, hi)];
      }
      return [{ stars: starsQ, total, truncated: total > 1000 }];
    };
    try {
      const bands = await split(harvestMinStars, harvestMaxStars ?? null);
      for (const band of bands) {
        const cov = { query: `${scopeQ} ${band.stars}`, stars: band.stars, totalCount: band.total,
          fetched: 0, pages: 0, truncated: band.truncated };
        harvestCoverage.bands.push(cov);
        if (band.truncated) warn(`Harvest band ${band.stars} exceeds the 1000-result cap; only the top 1000 by stars are collected.`);
        for (let page = 1; page <= 10 && cov.fetched < Math.min(band.total ?? 0, 1000); page += 1) {
          if (!canRequest('search')) break;
          try {
            const result = await searchPage(band.stars, page, 100);
            if (!Array.isArray(result.items)) throw new Error('Invalid repository search result');
            consecutiveFailures = 0;
            cov.pages += 1;
            const fetchedAt = iso(now());
            for (const item of result.items) {
              if (isNonPublic(item)) { warn('Non-public harvest result excluded.'); continue; }
              if (item.created_at && !withinScope(item.created_at, scopeNow)) continue;
              accept(item, item.full_name, fetchedAt);
              cov.fetched += 1;
            }
            if (result.items.length < 100) break;
          } catch (error) {
            failures += 1;
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) { halted = true; warn('Five consecutive request failures; preserving successful samples and stopping.'); }
            warn(`Harvest (${band.stars}, page ${page}): ${error.message}`);
            break;
          }
        }
        harvestCoverage.fetched += cov.fetched;
        if (halted) break;
      }
      harvestCoverage.completedAt = iso(now());
    } catch (error) {
      failures += 1;
      warn(`Harvest planning: ${error.message}`);
    }
  }
  if (discover && !harvest) {
    const previousDiscovery = new Map((snapshot.coverage?.discovery || []).map(item => [item.id, item]));
    const plan = discoveryQueries(startedAt).sort((a, b) =>
      (Date.parse(previousDiscovery.get(a.id)?.completedAt) || 0) - (Date.parse(previousDiscovery.get(b.id)?.completedAt) || 0));
    for (const item of plan) {
      const { query } = item;
      const coverage = { ...item, totalCount: null, fetched: 0, pages: 0, incomplete: false, truncated: true,
        completedAt: previousDiscovery.get(item.id)?.completedAt || null };
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
            // Defense in depth: results outside the rolling three-year
            // creation scope never enter the registry, even if a query leaks them.
            if (item.created_at && !withinScope(item.created_at, scopeNow)) continue;
            accept(item, item.full_name, fetchedAt);
          }
          coverage.fetched += result.items.length;
          coverage.truncated = coverage.incomplete || coverage.totalCount === null || coverage.fetched < coverage.totalCount;
          coverage.attemptedAt = fetchedAt;
          if (page === discoveryPages || result.items.length < 100 || coverage.fetched >= Math.min(coverage.totalCount ?? 1000, 1000)) coverage.completedAt = fetchedAt;
          if (result.items.length < 100 || coverage.fetched >= Math.min(coverage.totalCount ?? 1000, 1000)) break;
        } catch (error) {
          failures += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 5) { halted = true; warn('Five consecutive request failures; preserving successful samples and stopping.'); }
          warn(`Discovery (${item.id}, page ${page}): ${error.message}`);
          break;
        }
      }
    }
  }
  const eligible = buildUpdateQueue([...repos.values()], startedAt, { activity })
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
        discovery: discover && !harvest ? discovery : snapshot.coverage?.discovery || [],
        discoveryAt: discover && !harvest ? startedAt : snapshot.coverage?.discoveryAt || null,
        harvest: harvest ? harvestCoverage : snapshot.coverage?.harvest || null,
        note: 'Tracked repositories are limited to a rolling three-year creation window; star-sorted discovery is not a global growth ranking.' },
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

/**
 * Mutual exclusion between the dev server's auto-collection and scheduled
 * runs: both spawn this script against the same JSON files, and the last
 * writer wins. A lock younger than LOCK_TTL_MS blocks a second collector;
 * older locks are treated as crashed holders and taken over.
 */
const LOCK_TTL_MS = 30 * 60_000;
export function acquireSyncLock(path, { now = () => new Date().toISOString() } = {}) {
  const claim = () => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: now() }), { encoding: 'utf8', flag: 'wx' });
  };
  try { claim(); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.parse(now()) - Date.parse(held.acquiredAt) < LOCK_TTL_MS) return false;
    unlinkSync(path); // Stale lock: the previous collector died mid-run.
    claim();
    return true;
  } catch { return false; }
}
export function releaseSyncLock(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function resolveToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function parseArguments(args) {
  const result = { dry: false, discover: true, limit: 750, budget: 900, discoveryPages: 2, translate: true, translateLimit: 50, translateDelay: 0, retranslate: false, harvest: false, harvestMinStars: 1000, harvestMaxStars: null, harvestDelayMs: 2200 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry') result.dry = true;
    else if (arg === '--discover') result.discover = true;
    else if (arg === '--no-discover') result.discover = false;
    else if (arg === '--no-translate') result.translate = false;
    else if (arg === '--retranslate') result.retranslate = true;
    else if (arg === '--history-only') result.historyOnly = true;
    else if (arg === '--harvest') result.harvest = true;
    else if (['--limit', '--budget', '--discovery-pages', '--translate-limit', '--translate-delay', '--harvest-min', '--harvest-max', '--harvest-delay'].includes(arg)) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < (arg === '--harvest-delay' ? 0 : 1)) throw new Error(`${arg} requires a positive integer`);
      result[{ '--limit': 'limit', '--budget': 'budget', '--discovery-pages': 'discoveryPages', '--translate-limit': 'translateLimit', '--translate-delay': 'translateDelay', '--harvest-min': 'harvestMinStars', '--harvest-max': 'harvestMaxStars', '--harvest-delay': 'harvestDelayMs' }[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.discoveryPages > 10) throw new Error('GitHub Search exposes at most 10 pages of 100 results');
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const lockPath = join(ROOT, 'src/data/.sync.lock');
  if (!options.dry && !acquireSyncLock(lockPath)) {
    console.log('Another collector holds the sync lock; this run exits without touching data files.');
    return;
  }
  try {
    await runSync(options);
  } finally {
    if (!options.dry) releaseSyncLock(lockPath);
  }
}

async function runSync(options) {
  const snapshotPath = join(ROOT, 'src/data/github-snapshot.json');
  const historyPath = join(ROOT, 'src/data/star-history.json');
  const activityPath = join(ROOT, 'src/data/star-activity.json');
  // Data files are local-only (gitignored); a fresh checkout or CI runner
  // starts from an empty registry and rebuilds through discovery.
  let snapshot = { schemaVersion: 1, projects: [] };
  try { snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(snapshot.projects)) snapshot.projects = [];
  let history = {};
  try { history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = resolveToken();
  if (!token) console.log('No token: GitHub permits 60 unauthenticated core requests/hour; response headers control this run.');
  let activity = emptyStarActivity();
  try { activity = JSON.parse(readFileSync(activityPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const activityBefore = activity;
  activity = await refreshStarActivity(snapshot.projects, activity, { token,
    limit: Math.min(options.limit, options.historyOnly ? options.budget : Math.floor(options.budget / 3)), maxRuntimeMs: 5 * 60_000 });
  const activityRequests = activity.status.attemptedAt === activityBefore.status?.attemptedAt ? 0 : activity.status.requests || 0;
  if (!options.dry) atomicWriteJson(activityPath, activity);
  console.log(`Official star history: ${activityRequests} requests; ${activity.status.message || 'cache ready'}`);
  if (options.historyOnly) { process.exitCode = activity.status.failures && !activity.status.updated ? 1 : 0; return; }
  const outcome = await syncData({ ...options, budget: Math.max(0, options.budget - activityRequests), snapshot, history, token, activity });
  // Probe official history for newly discovered candidates (fresh cohorts and
  // the surge channel) with whatever request budget remains, so a promising
  // repository can enter the boards in this run instead of the next one.
  const probeBudget = Math.min(Math.max(0, options.budget - activityRequests - outcome.snapshot.sync.requests), 120);
  if (probeBudget > 0) {
    const probed = await refreshStarActivity(outcome.snapshot.projects, activity, { token, limit: probeBudget, maxRuntimeMs: 2 * 60_000 });
    if (probed.status.attemptedAt !== activity.status?.attemptedAt) {
      activity = probed;
      if (!options.dry) atomicWriteJson(activityPath, activity);
      console.log(`Candidate history probes: ${probed.status.requests || 0} requests, ${probed.status.updated || 0} repositories updated.`);
    }
  }
  // Persisted Chinese descriptions: a separate translation-service budget,
  // hottest repositories first; service failures pause until the next run.
  let translation = { translated: 0, pending: 0, stopped: false };
  if (options.translate) {
    translation = await translateDescriptions(outcome.snapshot.projects, { limit: options.translateLimit, activity, retranslate: options.retranslate, delayMs: options.translateDelay });
    if (translation.stopped) console.warn('! Description translation paused (service quota or outage); originals kept for the next run.');
  }
  if (!options.dry) {
    // Keep official star history aligned with the registry: entries for
    // pruned or removed repositories have no consumers left.
    const registeredNames = new Set(outcome.snapshot.projects.map((repo) => repo.fullName));
    const before = Object.keys(activity.repositories || {}).length;
    activity.repositories = Object.fromEntries(Object.entries(activity.repositories || {})
      .filter(([fullName]) => registeredNames.has(fullName)));
    if (Object.keys(activity.repositories).length !== before) atomicWriteJson(activityPath, activity);
    // Publish snapshot last so it cannot advertise samples missing from history.
    atomicWriteJson(historyPath, outcome.history);
    atomicWriteJson(snapshotPath, outcome.snapshot);
  }
  console.log(`${options.dry ? 'DRY RUN (no files written): ' : ''}${outcome.snapshot.sync.result}; ${outcome.snapshot.sync.refreshed} repositories collected, ${outcome.snapshot.sync.requests} requests; ${translation.translated} descriptions translated (${translation.pending} pending).`);
  for (const warning of outcome.snapshot.warnings) console.warn(`! ${warning}`);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Sync failed: ${error.message}`); process.exitCode = 1; });
}
