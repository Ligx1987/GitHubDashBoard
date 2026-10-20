import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, acquireSyncLock, releaseSyncLock, buildUpdateQueue, discoveryQueries, parseArguments,
  recordDailySample, syncData, toSnapshotProject, translateDescriptions } from '../scripts/sync-github-data.mjs';
import { calculateGrowth } from '../src/data/history.js';
import { CATEGORY_VERSION } from '../src/data/github-data.js';

const NOW = '2026-09-28T08:00:00.000Z';
const OLD = '2026-09-24T08:00:00.000Z';
const repository = (name, stars = 120) => ({ id: 123, full_name: name, name: name.split('/')[1],
  private: false, visibility: 'public', description: 'Actual description', stargazers_count: stars,
  forks_count: 20, open_issues_count: 3, license: { spdx_id: 'MIT' }, topics: ['tools'],
  language: 'JavaScript', created_at: '2024-06-12T13:49:36Z',
  pushed_at: '2026-09-27T13:00:00Z', updated_at: '2026-09-28T07:30:00Z' });
const project = (fullName, fetchedAt = null) => ({ fullName, fetchedAt, stars: 100, availability: 'available' });
const registry = (projects) => ({ schemaVersion: 1, fetchedAt: OLD, projects });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const options = (snapshot, overrides = {}) => ({ snapshot, discover: false, now: () => NOW, ...overrides });

test('same-day samples update their closing value but retain prior UTC day baselines', () => {
  const old = { 'owner/repo': { '2026-09-27': 100 } };
  const first = recordDailySample(old, 'owner/repo', 110, '2026-09-28T01:00:00Z');
  const second = recordDailySample(first, 'owner/repo', 125, '2026-09-28T20:00:00Z');
  assert.deepEqual(calculateGrowth(second['owner/repo'], 125, NOW), { todayStars: 25, weekStars: null, monthStars: null });
  assert.equal(second['owner/repo']['2026-09-27'], 100);
  assert.equal(old['owner/repo']['2026-09-28'], undefined);
});

test('UTC rollover uses yesterday, preserves negative growth, and never invents a 7/30-day baseline', () => {
  const history = recordDailySample({ 'owner/repo': { '2026-09-27': 100, '2026-09-21': 110, '2026-08-29': 120 } }, 'owner/repo', 95, NOW);
  assert.deepEqual(calculateGrowth(history['owner/repo'], 95, NOW), { todayStars: -5, weekStars: -15, monthStars: -25 });
  const next = recordDailySample(history, 'owner/repo', 98, '2026-09-29T00:01:00Z');
  assert.deepEqual(calculateGrowth(next['owner/repo'], 98, '2026-09-29'), { todayStars: 3, weekStars: null, monthStars: null });
});

test('case-variant history keys fold into the canonical current casing', () => {
  const old = {
    'aidanpark/openclaw-android': { '2026-10-18': 10 },
    'AidanPark/openclaw-android': { '2026-10-19': 12 },
  };
  const next = recordDailySample(old, 'AidanPark/openclaw-android', 15, '2026-10-20T01:00:00Z');
  assert.deepEqual(Object.keys(next), ['AidanPark/openclaw-android']);
  assert.deepEqual(next['AidanPark/openclaw-android'], { '2026-10-18': 10, '2026-10-19': 12, '2026-10-20': 15 });
});

test('metadata comes only from REST, including creation timestamp and unknown contributor count', () => {
  const actual = toSnapshotProject({ ...repository('vuejs/core'), created_at: '2018-06-12T13:49:36Z' }, NOW, { createdAt: '2013-07-29', contributors: 999, descriptionSource: 'legacy-editorial' });
  assert.equal(actual.createdAt, '2018-06-12T13:49:36.000Z');
  assert.equal(actual.pushedAt, '2026-09-27T13:00:00.000Z');
  assert.equal(actual.contributors, null);
  assert.equal(actual.descriptionSource, 'github-rest');
  assert.equal(actual.fetchedAt, NOW);
  assert.equal(toSnapshotProject({ ...repository('a/b'), license: null }, NOW).license, null);
  assert.throws(() => toSnapshotProject({ full_name: 'a/b' }, NOW), /star count/);
});

test('metadata refresh stores current classification and secondary domain tags', () => {
  const actual = toSnapshotProject({
    ...repository('morluto/rea'), language: 'TypeScript',
    description: 'Reverse engineer anything with agents, from app behavior down to native binaries.',
    topics: ['agent-skills', 'ai-agents', 'binary-analysis', 'claude-code', 'cli', 'developer-tools', 'llm', 'mcp', 'reverse-engineering', 'static-analysis'],
  }, NOW);
  assert.equal(actual.category, 'ai');
  assert.equal(actual.categoryVersion, CATEGORY_VERSION);
  assert.ok(actual.categoryTags.includes('security'));
  assert.ok(actual.categoryTags.includes('developer-tools'));
});

test('successive limited runs resume at the oldest successful sample instead of restarting', async () => {
  const called = [];
  const fetchImpl = async (url) => { const name = new URL(url).pathname.slice(7); called.push(name); return response(repository(name)); };
  const first = await syncData(options(registry([project('owner/a'), project('owner/b')]), { limit: 1, fetchImpl }));
  const second = await syncData(options(first.snapshot, { history: first.history, limit: 1, fetchImpl }));
  assert.deepEqual(called, ['owner/a', 'owner/b']);
  assert.equal(second.snapshot.coverage.pending, 0);
  assert.equal(second.history['owner/a']['2026-09-28'], 120);
  assert.equal(second.history['owner/b']['2026-09-28'], 120);
});

test('unknown metadata is prioritized only when successful sampling times tie', () => {
  const sorted = buildUpdateQueue([{ ...project('owner/a'), createdAt: OLD }, project('owner/z'),
    project('owner/new', NOW)], NOW);
  assert.deepEqual(sorted.map((p) => p.fullName), ['owner/z', 'owner/a', 'owner/new']);
});

test('hot history and 24h-boundary pushes boost queue priority over plain staleness', () => {
  const hotWeeks = Array.from({ length: 6 }, (_, i) => ({
    week: (Date.parse('2026-09-27T00:00:00Z') - i * 7 * 86400000) / 1000, total: 140, days: Array(7).fill(20) }));
  const activity = { repositories: { 'owner/hot': { source: 'github-star-history', fetchedAt: NOW, weeks: hotWeeks } } };
  const rows = [
    project('owner/stale', '2026-09-27T02:00:00.000Z'), // 30h stale, no boost
    { ...project('owner/hot', NOW), createdAt: '2020-01-01T00:00:00Z' }, // fresh but hot (+48)
    { ...project('owner/boundary', NOW), pushedAt: '2026-09-27T14:00:00.000Z' }, // push 18h old (+24)
    project('owner/fresh', '2026-09-28T04:00:00.000Z'), // 4h stale, no boost
  ];
  assert.deepEqual(buildUpdateQueue(rows, NOW, { activity }).map((p) => p.fullName),
    ['owner/hot', 'owner/stale', 'owner/boundary', 'owner/fresh']);
  // Without activity data the hot repository loses its boost; the boundary boost stays.
  assert.deepEqual(buildUpdateQueue(rows, NOW).map((p) => p.fullName),
    ['owner/stale', 'owner/boundary', 'owner/fresh', 'owner/hot']);
});

test('recently sampled low-star repositories yield queue capacity to higher stars', () => {
  const rows = [
    { ...project('owner/low-fresh', '2026-09-28T04:00:00.000Z'), stars: 100 }, // 4h stale, demoted
    { ...project('owner/high-fresh', '2026-09-28T04:00:00.000Z'), stars: 5000 }, // 4h stale, keeps place
    { ...project('owner/low-stale', '2026-09-25T04:00:00.000Z'), stars: 100 }, // 76h stale, past the interval
    project('owner/never'), // never sampled: maximal staleness, never demoted
  ];
  assert.deepEqual(buildUpdateQueue(rows, NOW).map((p) => p.fullName),
    ['owner/never', 'owner/low-stale', 'owner/high-fresh', 'owner/low-fresh']);
});

test('failed repositories keep their last successful timestamps; successes still persist', async () => {
  const source = registry([project('owner/a', OLD), project('owner/b', OLD)]);
  const result = await syncData(options(source, { history: { 'owner/a': { '2026-09-24': 100 } },
    fetchImpl: async (url) => url.endsWith('/a') ? response({}, 503) : response(repository('owner/b', 150)) }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshot.sync.result, 'partial');
  assert.equal(result.snapshot.projects.find((p) => p.fullName === 'owner/a').fetchedAt, OLD);
  assert.equal(result.snapshot.projects.find((p) => p.fullName === 'owner/b').fetchedAt, NOW);
  assert.equal(result.history['owner/a']['2026-09-28'], undefined);
  assert.equal(result.history['owner/b']['2026-09-28'], 150);
  assert.match(result.snapshot.warnings[0], /503/);
});

test('total failure returns nonzero and preserves prior collection time and history', async () => {
  const history = { 'owner/repo': { '2026-09-24': 100 } };
  const result = await syncData(options(registry([project('owner/repo', OLD)]), { history,
    fetchImpl: async () => response({}, 503) }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.snapshot.fetchedAt, OLD);
  assert.deepEqual(result.history, history);
  assert.equal(result.snapshot.sync.result, 'failed');
});

test('an upstream outage stops after five consecutive failures and retains earlier success', async () => {
  let calls = 0;
  const result = await syncData(options(registry(Array.from({ length: 20 }, (_, i) => project(`owner/repo-${String(i).padStart(2, '0')}`))), {
    fetchImpl: async (url) => { calls += 1; return calls === 1 ? response(repository('owner/repo-00')) : response({}, 503); } }));
  assert.equal(calls, 6);
  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshot.sync.refreshed, 1);
  assert.equal(result.snapshot.sync.result, 'partial');
  assert.equal(result.history['owner/repo-00']['2026-09-28'], 120);
});

test('expired execution budget stops before issuing a request and does not advance sampling time', async () => {
  const result = await syncData(options(registry([project('owner/repo', OLD)]), { maxRuntimeMs: 0,
    fetchImpl: async () => { throw new Error('must not request'); } }));
  assert.equal(result.snapshot.sync.requests, 0);
  assert.equal(result.snapshot.fetchedAt, OLD);
  assert.equal(result.exitCode, 1);
});

test('404 excludes repositories and prevents repeated requests to the unavailable item', async () => {
  const result = await syncData(options(registry([project('owner/gone', OLD)]), { fetchImpl: async () => response({}, 404) }));
  assert.equal(result.snapshot.projects[0].availability, 'unavailable');
  assert.equal(result.snapshot.projects[0].fetchedAt, OLD);
  assert.equal(result.snapshot.coverage.unavailable, 1);
  assert.equal(buildUpdateQueue(result.snapshot.projects, NOW).length, 0);
  assert.equal(result.exitCode, 1);
});

test('authoritative rate-limit headers stop requests, and the next reset resumes pending repositories', async () => {
  const calls = [];
  const first = await syncData(options(registry([project('owner/a'), project('owner/b')]), {
    fetchImpl: async (url) => { calls.push(url); return response(repository('owner/a'), 200, {
      'x-ratelimit-remaining': '5', 'x-ratelimit-reset': String(Date.parse(NOW) / 1000 + 3600), 'x-ratelimit-resource': 'core' }); } }));
  assert.equal(calls.length, 1);
  assert.equal(first.snapshot.sync.result, 'partial');
  const paused = await syncData(options(first.snapshot, { fetchImpl: async () => { throw new Error('must not request'); } }));
  assert.equal(paused.snapshot.sync.requests, 0);
  assert.equal(paused.exitCode, 1);
  const resumed = await syncData(options(first.snapshot, { now: () => '2026-09-28T10:00:00Z', history: first.history, limit: 1,
    fetchImpl: async (url) => { assert.ok(url.endsWith('/owner/b')); return response(repository('owner/b')); } }));
  assert.equal(resumed.snapshot.sync.refreshed, 1);
});

test('secondary-rate-limit retry-after stops immediately and survives the next run', async () => {
  let calls = 0;
  const first = await syncData(options(registry([project('owner/a'), project('owner/b')]), {
    fetchImpl: async () => { calls += 1; return response({}, 429, { 'retry-after': '120' }); } }));
  const second = await syncData(options(first.snapshot, { fetchImpl: async () => { calls += 1; return response({}); } }));
  assert.equal(calls, 1);
  assert.equal(second.exitCode, 1);
  assert.equal(second.snapshot.sync.requests, 0);
});

test('harvest splits star bands over the page cap and fully paginates each slice', async () => {
  const searches = [];
  // NOW is 2026-09-28, so the scope query must start at 2023-09-28.
  const counts = { 'stars:>=1000': 1500, 'stars:1000..1999': 800, 'stars:>=2000': 700 };
  const result = await syncData(options(registry([project('known/repo')]), {
    harvest: true, discover: false, limit: 0, budget: 100, harvestDelayMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get('q');
      searches.push(query);
      const stars = query.match(/stars:[^\s]+/)[0];
      const total = counts[stars] ?? 0;
      if (parsed.searchParams.get('per_page') === '1') return response({ total_count: total, incomplete_results: false, items: [] });
      const page = Number(parsed.searchParams.get('page'));
      const start = (page - 1) * 100;
      const items = Array.from({ length: Math.max(0, Math.min(100, total - start)) },
        (_, i) => repository(`harvest/${stars.replace(/\D+/g, '-')}-${start + i}`));
      return response({ total_count: total, incomplete_results: false, items });
    } }));
  assert.equal(result.snapshot.projects.length, 1 + 800 + 700);
  assert.ok(searches.every((q) => q.includes('created:>=2023-09-28') && q.includes('is:public')));
  assert.equal(result.snapshot.coverage.harvest.minStars, 1000);
  assert.equal(result.snapshot.coverage.harvest.fetched, 1500);
  assert.equal(result.snapshot.coverage.harvest.bands.length, 2);
  assert.ok(result.snapshot.coverage.harvest.bands.every((b) => !b.truncated));
  assert.equal(result.history['harvest/-1000-1999-0']['2026-09-28'], 120);
});

test('harvest flags an unsplittable over-cap band as truncated and skips out-of-scope items', async () => {
  // Every band containing star value 1000 reports 1500: recursion bottoms out
  // at the single-value band, which cannot be split further.
  const result = await syncData(options(registry([project('known/repo')]), {
    harvest: true, discover: false, limit: 0, budget: 100, harvestDelayMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get('q');
      const stars = query.match(/stars:[^\s]+/)[0];
      const covers1000 = />=1000/.test(stars) || (() => { const m = stars.match(/stars:(\d+)(?:\.\.(\d+))?/);
        return m && Number(m[1]) <= 1000 && (m[2] === undefined || Number(m[2]) >= 1000); })();
      const total = covers1000 ? 1500 : 0;
      if (parsed.searchParams.get('per_page') === '1') return response({ total_count: total, incomplete_results: false, items: [] });
      const page = Number(parsed.searchParams.get('page'));
      const items = Array.from({ length: 100 }, (_, i) => repository(`dense/r-${(page - 1) * 100 + i}`));
      items.push({ ...repository('ghost/ancient'), created_at: '2010-01-01T00:00:00Z' });
      return response({ total_count: total, incomplete_results: false, items });
    } }));
  const harvest = result.snapshot.coverage.harvest;
  const dense = harvest.bands.find((b) => b.stars === 'stars:1000');
  assert.ok(dense && dense.truncated);
  assert.equal(dense.fetched, 1000); // page cap 10 x 100
  assert.ok(!result.snapshot.projects.some((p) => p.fullName === 'ghost/ancient'));
  assert.ok(result.snapshot.warnings.some((w) => w.includes('truncat') || w.includes('dense') || w.includes('stars:1000')));
});

test('CLI parses --harvest and --harvest-min', () => {
  assert.deepEqual(parseArguments(['--harvest']).harvest, true);
  assert.equal(parseArguments(['--harvest']).harvestMinStars, 1000);
  assert.equal(parseArguments(['--harvest', '--harvest-min', '500']).harvestMinStars, 500);
  assert.equal(parseArguments([]).harvest, false);
});

test('discovery pages all bounded periods, deduplicates repositories, and discloses truncation', async () => {
  const queries = [];
  const result = await syncData(options(registry([project('known/repo')]), { discover: true, discoveryPages: 2, limit: 1,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/repos/')) return response(repository('known/repo'));
      const query = parsed.searchParams.get('q');
      const page = Number(parsed.searchParams.get('page'));
      queries.push([query, page]);
      if (query.includes('2026-09-24')) return response({ total_count: 250, incomplete_results: page === 2,
        items: Array.from({ length: 100 }, (_, i) => repository(`new/repo-${i + (page - 1) * 100}`)) });
      return response({ total_count: 1, incomplete_results: false, items: [repository('new/repo-0')] });
    } }));
  assert.equal(queries.length, 11);
  assert.ok(queries.every(([query]) => query.includes('is:public')));
  assert.equal(result.snapshot.projects.length, 201);
  assert.equal(result.snapshot.coverage.discovery[0].fetched, 200);
  assert.equal(result.snapshot.coverage.discovery[0].truncated, true);
  assert.equal(result.snapshot.coverage.discovery[0].incomplete, true);
  assert.equal(result.snapshot.coverage.exhaustive, false);
  assert.equal(result.history['new/repo-199']['2026-09-28'], 120);
});

test('private metadata is erased instead of being published with a public cache', async () => {
  const result = await syncData(options(registry([{ ...project('owner/repo', OLD), description: 'old', topics: ['old'] }]), {
    history: { 'owner/repo': { '2026-09-24': 100 } },
    fetchImpl: async () => response({ ...repository('owner/repo'), private: true, description: 'SECRET' }) }));
  assert.equal(result.snapshot.projects[0].availability, 'unavailable');
  assert.equal(result.snapshot.projects[0].description, '');
  assert.equal(result.snapshot.projects[0].stars, null);
  assert.equal(result.history['owner/repo'], undefined);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('redirected repository names merge history and remove stale registry aliases', async () => {
  const result = await syncData(options(registry([project('owner/old', OLD)]), {
    history: { 'owner/old': { '2026-09-27': 100 } }, fetchImpl: async () => response(repository('owner/new')) }));
  assert.deepEqual(result.snapshot.projects.map((p) => p.fullName), ['owner/new']);
  assert.equal(result.history['owner/new']['2026-09-27'], 100);
  assert.equal(result.history['owner/old'], undefined);
});

test('atomic JSON publication leaves a complete replacement and no temporary file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'github-sync-test-'));
  try {
    const target = join(directory, 'snapshot.json');
    atomicWriteJson(target, { previous: true });
    atomicWriteJson(target, { projects: [project('owner/repo')] });
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).projects[0].fullName, 'owner/repo');
    assert.deepEqual(readdirSync(directory), ['snapshot.json']);
  } finally { rmSync(directory, { recursive: true }); }
});

test('persisted translations prefer hot repositories and survive unchanged metadata refreshes', async () => {
  const hotWeeks = Array.from({ length: 6 }, (_, i) => ({
    week: (Date.parse('2026-09-27T00:00:00Z') - i * 7 * 86400000) / 1000, total: 140, days: Array(7).fill(20) }));
  const activity = { repositories: { 'owner/hot': { source: 'github-star-history', fetchedAt: NOW, weeks: hotWeeks } } };
  const repos = [
    { ...project('owner/cold', OLD), description: 'Cold tool', stars: 9999, availability: 'available', createdAt: '2020-01-01T00:00:00Z' },
    { ...project('owner/hot', OLD), description: 'Hot tool', stars: 5, availability: 'available', createdAt: '2020-01-01T00:00:00Z' },
  ];
  const translated = [];
  const result = await translateDescriptions(repos, { now: () => NOW, limit: 1, activity, fetchImpl: async (url) => {
    if (!String(url).includes('translate.googleapis.com')) return response({}, 503); // chain prefers Google; only record fallback hits
    translated.push(new URL(url).searchParams.get('q'));
    return response([[['热门工具', 'Hot tool']], null, 'en']);
  } });
  assert.deepEqual(translated, ['Hot tool']); // hot beats cold despite fewer stars
  assert.equal(result.translated, 1);
  assert.equal(repos[1].descriptionZh, '热门工具');
  const kept = toSnapshotProject({ ...repository('owner/hot'), description: 'Hot tool' }, NOW, repos[1]);
  assert.equal(kept.descriptionZh, '热门工具');
  const changed = toSnapshotProject({ ...repository('owner/hot'), description: 'Rewritten text' }, NOW, repos[1]);
  assert.equal(changed.descriptionZh, null);
});

test('translation queue orders hot repositories by weekly additions before total stars', async () => {
  const week = (amount) => Array.from({ length: 6 }, (_, i) => ({
    week: (Date.parse('2026-09-27T00:00:00Z') - i * 7 * 86400000) / 1000, total: amount, days: Array(7).fill(amount / 7) }));
  const activity = { repositories: {
    'owner/high-star-slower': { source: 'github-star-history', fetchedAt: NOW, weeks: week(140) },
    'owner/low-star-faster': { source: 'github-star-history', fetchedAt: NOW, weeks: week(7000) },
  } };
  const repos = [
    { ...project('owner/high-star-slower', OLD), description: 'Slower project', stars: 999999, availability: 'available', createdAt: '2020-01-01T00:00:00Z' },
    { ...project('owner/low-star-faster', OLD), description: 'Faster project', stars: 10, availability: 'available', createdAt: '2020-01-01T00:00:00Z' },
  ];
  const translated = [];
  await translateDescriptions(repos, { now: () => NOW, limit: 1, activity, fetchImpl: async (url) => {
    if (!String(url).includes('translate.googleapis.com')) return response({}, 503); // chain prefers Google; only record fallback hits
    translated.push(new URL(url).searchParams.get('q'));
    return response([[['更快项目', 'Faster project']], null, 'en']);
  } });
  assert.deepEqual(translated, ['Faster project']); // bigger weekly surge wins despite far fewer total stars
});

test('retranslate replaces non-Google persisted translations and records the provider', async () => {
  const repos = [
    { ...project('owner/google', OLD), description: 'Kept text', descriptionZh: '旧谷歌译文', descriptionZhProvider: 'google', availability: 'available' },
    { ...project('owner/legacy', OLD), description: 'Legacy text', descriptionZh: '旧机翻', descriptionZhProvider: 'mymemory', availability: 'available' },
    { ...project('owner/fresh', OLD), description: 'Fresh text', availability: 'available' },
  ];
  const seen = [];
  const result = await translateDescriptions(repos, { now: () => NOW, limit: 5, retranslate: true, fetchImpl: async (url) => {
    seen.push(String(url));
    return response([[['全新译文', 'x']], null, 'en']);
  } });
  assert.equal(result.translated, 2); // legacy retranslated + fresh translated
  assert.equal(repos[0].descriptionZh, '旧谷歌译文'); // Google translations survive retranslation runs untouched.
  assert.equal(repos[1].descriptionZh, '全新译文');
  assert.equal(repos[1].descriptionZhProvider, 'google');
  assert.equal(repos[2].descriptionZhProvider, 'google');
  assert.ok(seen.every((url) => url.includes('translate.googleapis.com')));
  assert.equal(parseArguments(['--retranslate']).retranslate, true);
  assert.equal(parseArguments([]).retranslate, false);
});

test('unchanged metadata keeps the translation provider, changed text clears it', () => {
  const previous = { ...project('owner/repo', OLD), description: 'Actual description', descriptionZh: '译文', descriptionZhProvider: 'google' };
  const kept = toSnapshotProject(repository('owner/repo'), NOW, previous);
  assert.equal(kept.descriptionZh, '译文');
  assert.equal(kept.descriptionZhProvider, 'google');
  const changed = toSnapshotProject({ ...repository('owner/repo'), description: 'Rewritten text' }, NOW, previous);
  assert.equal(changed.descriptionZh, null);
  assert.equal(changed.descriptionZhProvider, null);
});

test('translation pacing sleeps between requests so daily runs stay under provider limits', async () => {
  const repos = [
    { ...project('owner/one', OLD), description: 'First tool', availability: 'available' },
    { ...project('owner/two', OLD), description: 'Second tool', availability: 'available' },
    { ...project('owner/three', OLD), description: 'Third tool', availability: 'available' },
  ];
  const sleeps = [];
  const result = await translateDescriptions(repos, { now: () => NOW, limit: 3, delayMs: 400,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => response([[['译文', 'x']], null, 'en']) });
  assert.equal(result.translated, 3);
  assert.deepEqual(sleeps, [400, 400]); // no sleep before the first request
  assert.equal(parseArguments(['--translate-delay', '400']).translateDelay, 400);
  assert.equal(parseArguments([]).translateDelay, 0);
  assert.throws(() => parseArguments(['--translate-delay', '-5']), /positive integer/);
});

test('translation service failure stops the batch and keeps originals for the next run', async () => {
  const repos = [{ ...project('owner/a', OLD), description: 'Alpha', availability: 'available' },
    { ...project('owner/b', OLD), description: 'Beta', availability: 'available' }];
  const result = await translateDescriptions(repos, { now: () => NOW, fetchImpl: async () => response({ responseStatus: 403, responseData: {} }) });
  assert.equal(result.translated, 0);
  assert.equal(result.stopped, true);
  assert.equal(repos[0].descriptionZh, undefined);
  assert.equal(parseArguments(['--no-translate']).translate, false);
  assert.equal(parseArguments(['--translate-limit', '5']).translateLimit, 5);
});

test('sync prunes repositories that aged out of the rolling three-year scope', async () => {
  // NOW is 2026-09-28, so the scope cutoff is 2023-09-28.
  const registryWithOld = registry([
    { ...project('owner/fresh', OLD), createdAt: '2024-01-01T00:00:00Z', availability: 'available' },
    { ...project('owner/aged-out', OLD), createdAt: '2022-05-01T00:00:00Z', availability: 'available' },
    { ...project('owner/unknown-age', OLD), createdAt: null, availability: 'available' },
  ]);
  const result = await syncData(options(registryWithOld, {
    history: { 'owner/aged-out': { '2026-09-27': 500 }, 'owner/fresh': { '2026-09-27': 100 },
      'ghost/repo': { '2026-09-27': 42 } }, // orphan history without a registry entry
    limit: 0, budget: 0, // no network: pruning happens before any request
  }));
  assert.deepEqual(result.snapshot.projects.map((p) => p.fullName), ['owner/fresh', 'owner/unknown-age']);
  assert.equal(result.history['owner/aged-out'], undefined);
  assert.equal(result.history['ghost/repo'], undefined);
  assert.equal(result.history['owner/fresh']['2026-09-27'], 100);
});

test('sync lock rejects concurrent collectors, takes over stale locks, and releases cleanly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'github-sync-lock-'));
  try {
    const lockPath = join(directory, 'sync.lock');
    assert.equal(acquireSyncLock(lockPath, { now: () => '2026-09-28T08:00:00.000Z' }), true);
    assert.equal(acquireSyncLock(lockPath, { now: () => '2026-09-28T08:05:00.000Z' }), false); // held by another run
    assert.equal(acquireSyncLock(lockPath, { now: () => '2026-09-28T08:45:00.000Z' }), true); // stale: previous holder died
    releaseSyncLock(lockPath);
    assert.equal(acquireSyncLock(lockPath, { now: () => '2026-09-28T08:46:00.000Z' }), true);
    releaseSyncLock(lockPath);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true }); }
});

test('CLI rejects malformed limits instead of silently skipping work', () => {
  assert.throws(() => parseArguments(['--limit', 'NaN']), /positive integer/);
  assert.throws(() => parseArguments(['--budget', '-1']), /positive integer/);
  assert.throws(() => parseArguments(['--discovery-pages', '11']), /at most 10/);
  assert.equal(parseArguments(['--no-discover', '--limit', '3', '--dry']).discover, false);
  assert.equal(discoveryQueries(NOW).length, 10);
  assert.equal(discoveryQueries(NOW).filter((q) => q.kind === 'surge').length, 3);
});
