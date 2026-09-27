import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, buildUpdateQueue, discoveryQueries, parseArguments,
  recordDailySample, syncData, toSnapshotProject } from '../scripts/sync-github-data.mjs';
import { calculateGrowth } from '../src/data/history.js';

const NOW = '2026-09-28T08:00:00.000Z';
const OLD = '2026-09-24T08:00:00.000Z';
const repository = (name, stars = 120) => ({ id: 123, full_name: name, name: name.split('/')[1],
  private: false, visibility: 'public', description: 'Actual description', stargazers_count: stars,
  forks_count: 20, open_issues_count: 3, license: { spdx_id: 'MIT' }, topics: ['tools'],
  language: 'JavaScript', created_at: '2018-06-12T13:49:36Z',
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

test('metadata comes only from REST, including creation timestamp and unknown contributor count', () => {
  const actual = toSnapshotProject(repository('vuejs/core'), NOW, { createdAt: '2013-07-29', contributors: 999, descriptionSource: 'legacy-editorial' });
  assert.equal(actual.createdAt, '2018-06-12T13:49:36.000Z');
  assert.equal(actual.pushedAt, '2026-09-27T13:00:00.000Z');
  assert.equal(actual.contributors, null);
  assert.equal(actual.descriptionSource, 'github-rest');
  assert.equal(actual.fetchedAt, NOW);
  assert.equal(toSnapshotProject({ ...repository('a/b'), license: null }, NOW).license, null);
  assert.throws(() => toSnapshotProject({ full_name: 'a/b' }, NOW), /star count/);
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

test('discovery pages all bounded periods, deduplicates repositories, and discloses truncation', async () => {
  const queries = [];
  const result = await syncData(options(registry([project('known/repo')]), { discover: true, discoveryPages: 2, limit: 1,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/repos/')) return response(repository('known/repo'));
      const query = parsed.searchParams.get('q');
      const page = Number(parsed.searchParams.get('page'));
      queries.push([query, page]);
      if (query.includes('2026-09-21')) return response({ total_count: 250, incomplete_results: page === 2,
        items: Array.from({ length: 100 }, (_, i) => repository(`new/repo-${i + (page - 1) * 100}`)) });
      return response({ total_count: 1, incomplete_results: false, items: [repository('new/repo-0')] });
    } }));
  assert.equal(queries.length, 4);
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

test('CLI rejects malformed limits instead of silently skipping work', () => {
  assert.throws(() => parseArguments(['--limit', 'NaN']), /positive integer/);
  assert.throws(() => parseArguments(['--budget', '-1']), /positive integer/);
  assert.throws(() => parseArguments(['--discovery-pages', '11']), /at most 10/);
  assert.equal(parseArguments(['--no-discover', '--limit', '3', '--dry']).discover, false);
  assert.equal(discoveryQueries(NOW).length, 3);
});
