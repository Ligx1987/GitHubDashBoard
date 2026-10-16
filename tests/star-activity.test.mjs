import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStarWeeks, summarizeStarActivity, refreshStarActivity, mergeStarActivity, buildAddedTrend } from '../src/data/star-activity.js';
import { assembleSnapshot } from '../src/data/github-data.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const ANCHOR = Date.parse('2026-09-27T00:00:00Z');
const weeks = (value = 3, anchor = ANCHOR) => Array.from({ length: 6 }, (_, i) => ({ week: (anchor - i * 7 * DAY) / 1000, total: 7 * value, days: Array(7).fill(value) }));
const record = (value = 3, extra = {}) => ({ source: 'github-star-history', fetchedAt: new Date(NOW).toISOString(), weeks: weeks(value), ...extra });
const project = (fullName = 'a/repo', extra = {}) => ({ fullName, availability: 'available', stars: 999, fetchedAt: new Date(NOW).toISOString(), createdAt: '2020-01-01T00:00:00Z', ...extra });
const ok = body => new Response(JSON.stringify(body), { status: 200 });

test('official history immediately provides 7/30 complete-day growth without local baselines', () => {
  const snapshot = assembleSnapshot([project()], { now: NOW, starActivity: { repositories: { 'a/repo': record() } } });
  assert.equal(snapshot.projects[0].weekAdded, 21);
  assert.equal(snapshot.projects[0].prevWeekAdded, 21);
  assert.equal(snapshot.projects[0].monthAdded, 90);
  assert.equal(snapshot.projects[0].weekStars, null);
  assert.equal(snapshot.weeklyTop10.length, 1);
  assert.equal(snapshot.monthlyTop30.length, 1);
  assert.equal(snapshot.weeklyNetTop10.length, 0);
});

test('rankings use period additions rather than total stars and retain Top10/Top30 limits', () => {
  const projects = Array.from({ length: 35 }, (_, i) => project(`a/repo-${i}`, { stars: 10000 - i }));
  const starActivity = { repositories: Object.fromEntries(projects.map((p, i) => [p.fullName, record(i)])) };
  const snapshot = assembleSnapshot(projects, { now: NOW, starActivity });
  assert.equal(snapshot.weeklyTop10.length, 10);
  assert.equal(snapshot.monthlyTop30.length, 30);
  assert.equal(snapshot.weeklyTop10[0].fullName, 'a/repo-34');
});

test('current partial day is excluded and API non-UTC boundary is respected', () => {
  const rows = weeks(1, ANCHOR + 8 * 3600000);
  rows[0].days[1] = 9000; rows[0].total += 8999;
  const result = summarizeStarActivity(record(1, { weeks: rows }), { now: NOW });
  assert.equal(result.activityWindowEnd, '2026-09-28T08:00:00.000Z');
  assert.equal(result.weekAdded, 7);
  assert.equal(result.monthAdded, 30);
});

test('a missing old week disables month only; absent values are never filled with zero', () => {
  const rows = weeks(); rows.splice(3, 1);
  const result = summarizeStarActivity(record(3, { weeks: rows }), { now: NOW });
  assert.equal(result.weekAdded, 21);
  assert.equal(result.monthAdded, null);
  assert.equal(summarizeStarActivity(record(3, { weeks: weeks().slice(1) }), { now: NOW }).weekAdded, null);
});

test('zero activity is valid; a new repo can have zero days only before verified creation', () => {
  assert.equal(summarizeStarActivity(record(0), { now: NOW }).monthAdded, 0);
  const fresh = record(2, { weeks: weeks(2).slice(0, 1) });
  assert.equal(summarizeStarActivity(fresh, { now: NOW, createdAt: '2026-09-27T10:00:00Z' }).monthAdded, 2);
  assert.equal(summarizeStarActivity(fresh, { now: NOW }).monthAdded, null);
});

test('stale cache beyond the grace day and future samples cannot pretend to be current', () => {
  // Record fetched 2026-09-28T12:00Z. One day later it still qualifies: the
  // previous-boundary grace keeps overnight/early-morning batches on the
  // boards (its final window day may miss a few late-night hours). Two days
  // later it is stale and drops out.
  assert.equal(summarizeStarActivity(record(), { now: NOW + DAY }).weekAdded, 21);
  assert.equal(summarizeStarActivity(record(), { now: NOW + 2 * DAY }).weekAdded, null);
  assert.equal(summarizeStarActivity(record(), { now: NOW - 1 }).weekAdded, null);
  const unavailable = assembleSnapshot([project('a/repo', { availability: 'unavailable' })], { now: NOW, starActivity: { repositories: { 'a/repo': record() } } });
  assert.equal(unavailable.weeklyTop10.length, 0);
});

test('malformed, duplicated and contradictory week data is rejected', () => {
  assert.throws(() => validateStarWeeks([]));
  assert.throws(() => validateStarWeeks([...weeks(), weeks()[0]]));
  assert.throws(() => validateStarWeeks([{ week: 1, total: 2, days: [1, 1] }]));
  assert.throws(() => validateStarWeeks([{ ...weeks()[0], total: 999 }]));
  assert.throws(() => validateStarWeeks([{ ...weeks()[0], days: [1, 1, 1, 1, 1, 1, -1] }]));
});

test('fetch uses the documented endpoint and preserves raw weeks and sampling time', async () => {
  let progress = 0;
  const result = await refreshStarActivity([project()], undefined, { now: () => NOW, token: 'test-token', onProgress: () => progress++, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/a/repo/stargazers/history?per_page=6&page=1');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return ok(weeks());
  } });
  assert.equal(progress, 1);
  assert.deepEqual(result.repositories['a/repo'].weeks, weeks());
  assert.equal(result.status.updated, 1);
});

test('rate limits stop the batch, preserve successful cache, and avoid retry loops', async () => {
  const old = { repositories: { 'a/old': record() } };
  let calls = 0;
  const result = await refreshStarActivity([project('a/old'), project('a/new'), project('a/other')], old, { now: () => NOW,
    fetchImpl: async () => { calls++; return new Response('{}', { status: 403, headers: { 'x-ratelimit-reset': String((NOW + 3600000) / 1000) } }); } });
  assert.equal(calls, 1);
  assert.deepEqual(result.repositories['a/old'], old.repositories['a/old']);
  await refreshStarActivity([project('a/new')], result, { now: () => NOW, fetchImpl: async () => { throw new Error('should not retry'); } });
  const recovered = await refreshStarActivity([project('a/new')], result, { now: () => NOW, token: 'new-token', fetchImpl: async () => ok(weeks()) });
  assert.equal(recovered.status.updated, 1);
});

test('invalid response does not replace prior records, and batch budgets resume missing records', async () => {
  const projects = [project('a/one'), project('a/two')];
  const calls = [];
  const options = { now: () => NOW, limit: 1, fetchImpl: async url => { calls.push(url); return ok(weeks()); } };
  const first = await refreshStarActivity(projects, undefined, options);
  const second = await refreshStarActivity(projects, first, options);
  assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
  const failed = await refreshStarActivity(projects, second, { now: () => NOW, ttlMs: 0, fetchImpl: async () => ok({ pending: true }) });
  assert.deepEqual(failed.repositories, second.repositories);
});

test('history refresh keeps hot repositories ahead of the cold tail', async () => {
  // 20/day for a 140-addition week vs. 1/day for 7: the hot one goes first.
  const cache = { repositories: { 'a/hot': record(20), 'a/cold': record(1) } };
  const called = [];
  await refreshStarActivity([project('a/cold'), project('a/hot')], cache, { now: () => NOW, ttlMs: 0, limit: 1,
    fetchImpl: async url => { called.push(url); return ok(weeks()); } });
  assert.equal(called.length, 1);
  assert.match(called[0], /a\/hot/);
});

test('history refresh defers recently sampled low-star repositories behind higher-star ones', async () => {
  // Both records are fresh and neither is hot; the 500-star project yields to
  // the 5000-star one, but is deferred rather than skipped (limit 2 gets both).
  const cache = { repositories: { 'a/low': record(1), 'a/high': record(1) } };
  const called = [];
  const fetchImpl = async url => { called.push(url); return ok(weeks()); };
  await refreshStarActivity([project('a/low', { stars: 500 }), project('a/high', { stars: 5000 })], cache,
    { now: () => NOW, ttlMs: 0, limit: 1, fetchImpl });
  assert.match(called[0], /a\/high/);
  await refreshStarActivity([project('a/low', { stars: 500 }), project('a/high', { stars: 5000 })], cache,
    { now: () => NOW, ttlMs: 0, limit: 2, fetchImpl });
  assert.equal(called.length, 3);
});

test('history 404 cools the repository down instead of aborting the whole batch', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return url.includes('gone') ? new Response('{}', { status: 404 }) : ok(weeks()); };
  const first = await refreshStarActivity([project('a/gone'), project('a/live')], undefined, { now: () => NOW, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(first.status.failures, 0);
  assert.ok(first.repositories['a/live']);
  assert.ok(Date.parse(first.status.historyUnavailable['a/gone']) > NOW);
  const second = await refreshStarActivity([project('a/gone'), project('a/live')], first, { now: () => NOW, ttlMs: 0, fetchImpl });
  assert.equal(calls.length, 3);
  assert.ok(!calls.slice(2).some(url => url.includes('gone')));
});

test('cache merging chooses newer observations; chart includes only comparable complete series', () => {
  const current = { repositories: { 'a/repo': record() }, status: { attemptedAt: new Date(NOW).toISOString() } };
  const old = { repositories: { 'a/repo': record(99, { fetchedAt: new Date(NOW - DAY).toISOString() }) } };
  assert.deepEqual(mergeStarActivity(current, old).repositories, current.repositories);
  const rows = [summarizeStarActivity(record(), { now: NOW }), summarizeStarActivity(record(2), { now: NOW })];
  assert.deepEqual(buildAddedTrend(rows).values, Array(7).fill(5));
});
