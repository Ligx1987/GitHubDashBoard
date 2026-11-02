import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStarWeeks, summarizeStarActivity, refreshStarActivity, mergeStarActivity, chooseStarActivityRecord, buildAddedTrend } from '../src/data/star-activity.js';
import { assembleSnapshot } from '../src/data/github-data.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const ANCHOR = Date.parse('2026-09-27T00:00:00Z');
const weeks = (value = 3, anchor = ANCHOR) => Array.from({ length: 6 }, (_, i) => ({ week: (anchor - i * 7 * DAY) / 1000, total: 7 * value, days: Array(7).fill(value) }));
const record = (value = 3, extra = {}) => ({ source: 'github-star-history', fetchedAt: new Date(NOW).toISOString(), weeks: weeks(value), ...extra });
const project = (fullName = 'a/repo', extra = {}) => ({ fullName, availability: 'available', stars: 999, fetchedAt: new Date(NOW).toISOString(), createdAt: '2024-01-01T00:00:00Z', ...extra });
const ok = body => new Response(JSON.stringify(body), { status: 200 });

test('Sunday rollover accepts a completed previous week without requiring an empty new-week row', async () => {
  const sunday = Date.parse('2026-10-25T02:00:00Z');
  const priorWeek = Date.parse('2026-10-18T00:00:00Z');
  const payload = weeks(3, priorWeek);
  const result = await refreshStarActivity([project()], undefined, { now: () => sunday, fetchImpl: async () => ok(payload) });
  assert.equal(result.status.updated, 1);
  const added = summarizeStarActivity(result.repositories['a/repo'], { now: sunday });
  assert.equal(added.weekAdded, 21);
  assert.equal(added.activityWindowEnd, '2026-10-25T00:00:00.000Z');
});

test('cached Saturday partial data retains its last complete cutoff when Sunday arrives', () => {
  const priorWeek = Date.parse('2026-10-18T00:00:00Z');
  const payload = weeks(3, priorWeek);
  payload[0].days[6] = 9000; payload[0].total += 8997;
  const cached = { source: 'github-star-history', fetchedAt: '2026-10-24T02:00:00Z', weeks: payload };
  const added = summarizeStarActivity(cached, { now: Date.parse('2026-10-25T02:00:00Z') });
  assert.equal(added.weekAdded, 21);
  assert.equal(added.activityWindowEnd, '2026-10-24T00:00:00.000Z');
});

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
  const delayed = summarizeStarActivity(record(3, { weeks: weeks().slice(1) }), { now: NOW });
  assert.equal(delayed.weekAdded, 21);
  assert.equal(delayed.activityWindowEnd, '2026-09-27T00:00:00.000Z');
});

test('zero activity is valid; a new repo can have zero days only before verified creation', () => {
  assert.equal(summarizeStarActivity(record(0), { now: NOW }).monthAdded, 0);
  const fresh = record(2, { weeks: weeks(2).slice(0, 1) });
  assert.equal(summarizeStarActivity(fresh, { now: NOW, createdAt: '2026-09-27T10:00:00Z' }).monthAdded, 2);
  assert.equal(summarizeStarActivity(fresh, { now: NOW }).monthAdded, null);
});

test('cached observations retain their complete cutoff, expire after seven days, and reject future samples', () => {
  assert.equal(summarizeStarActivity(record(), { now: NOW + DAY }).weekAdded, 21);
  assert.equal(summarizeStarActivity(record(), { now: NOW + DAY }).activityWindowEnd, '2026-09-28T00:00:00.000Z');
  assert.equal(summarizeStarActivity(record(), { now: NOW + 7 * DAY }).weekAdded, null);
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

test('new three-day candidates are not starved by older hot repositories in the recent lane', async () => {
  const fresh = project('a/new-three-day', { createdAt: '2026-09-27T10:00:00Z' });
  const older = project('a/hot-monthly', { createdAt: '2026-09-10T00:00:00Z' });
  const called = [];
  await refreshStarActivity([older, fresh], { repositories: { 'a/hot-monthly': record(20) } }, {
    now: () => NOW, ttlMs: 0, limit: 1,
    fetchImpl: async url => { called.push(url); return ok(weeks()); },
  });
  assert.match(called[0], /a\/new-three-day/);
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

test('partial new history preserves complete cached windows without advancing their sampling time', async () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const saved = record(3, { fetchedAt: '2026-09-29T12:00:00Z' });
  const result = await refreshStarActivity([project()], { repositories: { 'a/repo': saved } }, {
    now: () => now, fetchImpl: async () => ok(weeks().slice(0, 1)),
  });
  assert.deepEqual(result.repositories['a/repo'], saved);
  assert.equal(result.status.updated, 0);
  assert.equal(result.status.failures, 1);
  assert.match(result.status.message, /覆盖.*退|完整.*缓存/);
  const summary = summarizeStarActivity(result.repositories['a/repo'], { now });
  assert.equal(summary.activityWindowEnd, '2026-09-29T00:00:00.000Z');
  assert.equal(summary.weekAdded, 21);
  assert.equal(summary.monthAdded, 90);
});

test('cache merge preserves still-valid complete observations in either input order', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const saved = record(3, { fetchedAt: '2026-09-29T12:00:00Z' });
  const partial = record(9, { fetchedAt: new Date(now).toISOString(), weeks: weeks(9).slice(0, 1) });
  const fullCache = { repositories: { 'a/repo': saved } };
  const partialCache = { repositories: { 'a/repo': partial } };
  const preserved = mergeStarActivity(fullCache, partialCache, { now });
  assert.deepEqual(preserved.repositories['a/repo'], saved);
  assert.match(preserved.status.message, /覆盖不足.*保留/);
  assert.deepEqual(mergeStarActivity(partialCache, fullCache, { now }).repositories['a/repo'], saved);

  // Once the complete cache expires, a genuinely newer three-day observation
  // may restore three-day coverage; no old partial day is relabelled complete.
  const later = Date.parse('2026-10-08T12:00:00Z');
  const freshPartial = record(2, { fetchedAt: new Date(later).toISOString(), weeks: weeks(2, Date.parse('2026-10-04T00:00:00Z')).slice(0, 1) });
  const merged = mergeStarActivity(fullCache, { repositories: { 'a/repo': freshPartial } }, { now: later });
  assert.deepEqual(merged.repositories['a/repo'], freshPartial);
  assert.equal(summarizeStarActivity(merged.repositories['a/repo'], { now: later }).monthAdded, null);
});

test('each lane reserves history requests for missing and aged-out records across hot refresh batches', async () => {
  let now = NOW;
  const rows = [];
  let cache = { repositories: {} };
  for (const lane of ['recent', 'established']) {
    const extra = lane === 'recent' ? { createdAt: '2026-09-10T00:00:00Z' } : {};
    for (let i = 0; i < 6; i++) {
      const name = `a/${lane}-hot-${i}`;
      rows.push(project(name, extra));
      cache.repositories[name] = record(20, { fetchedAt: new Date(NOW - 3 * 3600000).toISOString() });
    }
    rows.push(project(`a/${lane}-missing`, extra), project(`a/${lane}-expired`, extra));
    cache.repositories[`a/${lane}-expired`] = record(1, {
      fetchedAt: new Date(NOW - 10 * DAY).toISOString(), weeks: weeks(1, ANCHOR - 14 * DAY),
    });
  }
  const called = [];
  for (let batch = 0; batch < 3; batch++) {
    const start = called.length;
    cache = await refreshStarActivity(rows, cache, { now: () => now, limit: 6, fetchImpl: async url => {
      const name = url.split('/repos/')[1].split('/stargazers/')[0]; called.push(name);
      return ok(weeks(name.includes('-hot-') ? 20 : 1));
    } });
    assert.equal(called.slice(start).filter(name => name.includes('recent')).length, 3);
    assert.equal(called.slice(start).filter(name => name.includes('established')).length, 3);
    if (batch === 0) {
      assert.ok(called.some(name => name.endsWith('-missing')));
      assert.ok(called.some(name => name.endsWith('-expired')));
    }
    now += 3 * 3600000;
  }
  for (const lane of ['recent', 'established']) {
    assert.ok(called.includes(`a/${lane}-missing`));
    assert.ok(called.includes(`a/${lane}-expired`));
    assert.notEqual(summarizeStarActivity(cache.repositories[`a/${lane}-expired`], { now }).monthAdded, null);
  }
});

test('one- and two-request budgets retain fairness across consecutive batches', async () => {
  for (const limit of [1, 2]) {
    let now = NOW;
    const rows = [project('a/established-hot'), project('a/established-expired')];
    let cache = { repositories: { 'a/established-hot': record(20), 'a/established-expired': record(1, {
      fetchedAt: new Date(NOW - 10 * DAY).toISOString(), weeks: weeks(1, ANCHOR - 14 * DAY),
    }) } };
    if (limit === 2) {
      rows.push(project('a/recent-hot', { createdAt: '2026-09-10T00:00:00Z' }), project('a/recent-expired', { createdAt: '2026-09-10T00:00:00Z' }));
      cache.repositories['a/recent-hot'] = record(20);
      cache.repositories['a/recent-expired'] = cache.repositories['a/established-expired'];
    }
    const called = [];
    for (let batch = 0; batch < 3; batch++) {
      cache = await refreshStarActivity(rows, cache, { now: () => now, ttlMs: 0, limit, fetchImpl: async url => {
        const name = url.split('/repos/')[1].split('/stargazers/')[0]; called.push(name);
        return ok(weeks(name.includes('-hot') ? 20 : 1));
      } });
      now += 3 * 3600000;
    }
    assert.ok(called.includes('a/established-expired'), `budget ${limit} must rotate the established lane`);
    if (limit === 2) assert.ok(called.includes('a/recent-expired'));
  }
});

test('failed missing records yield to untouched records and cooldown survives cache merging', async () => {
  const rows = [project('a/broken', { stars: 9999 }), project('a/untouched')];
  const first = await refreshStarActivity(rows, undefined, { now: () => NOW, limit: 1,
    fetchImpl: async () => new Response('{}', { status: 503 }) });
  const merged = mergeStarActivity(first, { repositories: {}, status: { attemptedAt: new Date(NOW + 1).toISOString() } }, { now: NOW + 1 });
  const called = [];
  await refreshStarActivity(rows, merged, { now: () => NOW + 1, limit: 1, fetchImpl: async url => { called.push(url); return ok(weeks()); } });
  assert.match(called[0], /a\/untouched/);
});

test('a single-request batch alternates both lanes and rotates failed candidates after cooldown', async () => {
  let now = NOW;
  let cache;
  const rows = [project('a/recent-broken', { stars: 9999, createdAt: '2026-09-10T00:00:00Z' }),
    project('a/recent-waiting', { createdAt: '2026-09-10T00:00:00Z' }),
    project('a/established-broken', { stars: 9999 }), project('a/established-waiting')];
  const called = [];
  for (let batch = 0; batch < 4; batch++) {
    cache = await refreshStarActivity(rows, cache, { now: () => now, limit: 1, fetchImpl: async url => {
      const name = url.split('/repos/')[1].split('/stargazers/')[0]; called.push(name);
      return name.includes('broken') ? new Response('{}', { status: 503 }) : ok(weeks());
    } });
    now += 2 * 3600000;
  }
  assert.deepEqual(called, ['a/recent-broken', 'a/established-broken', 'a/recent-waiting', 'a/established-waiting']);
});

test('newer successful attempts clear stale per-repository retry state when caches merge', () => {
  const at = new Date(NOW).toISOString();
  const failure = { repositories: {}, status: { attemptedAt: at,
    historyAttempts: { 'a/repo': { at, retryAfter: new Date(NOW + 3600000).toISOString() } },
    queueTurns: { recent: 2, established: 3, nextLane: 'recent' } } };
  const successAt = new Date(NOW + 1).toISOString();
  const success = { repositories: { 'a/repo': record(3, { fetchedAt: successAt }) }, status: { attemptedAt: successAt,
    historyAttempts: { 'a/repo': { at: successAt, retryAfter: null } },
    queueTurns: { recent: 3, established: 3, nextLane: 'established' } } };
  const merged = mergeStarActivity(success, failure, { now: NOW + 1 });
  assert.equal(merged.status.historyAttempts['a/repo'].retryAfter, null);
  assert.equal(merged.status.queueTurns.recent, 3);
  assert.equal(merged.status.queueTurns.nextLane, 'established');
});

test('complete history from another repository ID cannot displace the target identity', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const oldIdentity = record(50, { githubId: 101, fetchedAt: new Date(now - 1).toISOString() });
  const newIdentity = record(1, { githubId: 202, fetchedAt: new Date(now).toISOString(), weeks: weeks(1).slice(0, 1) });
  assert.equal(chooseStarActivityRecord(oldIdentity, newIdentity, { now }), newIdentity);
  assert.equal(chooseStarActivityRecord(oldIdentity, newIdentity, { now, githubId: 202 }), newIdentity);
  assert.equal(chooseStarActivityRecord(newIdentity, oldIdentity, { now, githubId: 202 }), newIdentity);
  assert.equal(chooseStarActivityRecord(undefined, oldIdentity, { now, githubId: 202 }), undefined);
  assert.equal(chooseStarActivityRecord(oldIdentity, undefined, { now, githubId: 202 }), undefined);

  // 没有 ID 的旧缓存没有冲突证据，仍按现有覆盖保护规则兼容。
  const legacy = { ...oldIdentity }; delete legacy.githubId;
  assert.equal(chooseStarActivityRecord(legacy, newIdentity, { now, githubId: 202 }), legacy);
});

test('persisted history identity changes bypass old TTL and repository cooldowns', async () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const first = await refreshStarActivity([project('a/repo', { githubId: 101 })], undefined, {
    now: () => now, fetchImpl: async () => ok(weeks(20)),
  });
  assert.equal(first.repositories['a/repo'].githubId, 101);
  const reloaded = JSON.parse(JSON.stringify(first));
  reloaded.status.historyUnavailable['a/repo'] = new Date(now + 7 * DAY).toISOString();
  reloaded.status.historyAttempts['a/repo'] = { githubId: 101, at: new Date(now).toISOString(), retryAfter: new Date(now + 3600000).toISOString() };
  let calls = 0;
  const next = await refreshStarActivity([project('a/repo', { githubId: 202 })], reloaded, {
    now: () => now + 1, fetchImpl: async () => { calls++; return ok(weeks(1).slice(0, 1)); },
  });
  assert.equal(calls, 1);
  assert.equal(next.status.updated, 1);
  assert.equal(next.repositories['a/repo'].githubId, 202);
  assert.equal(next.status.historyAttempts['a/repo'].githubId, 202);
  assert.equal(next.status.historyUnavailable['a/repo'], undefined);
  assert.equal(summarizeStarActivity(next.repositories['a/repo'], { now: now + 1 }).monthAdded, null);
});

test('an identity change discards stale history even when the replacement request fails', async () => {
  const cached = { repositories: { 'a/repo': record(20, { githubId: 101 }) } };
  const failed = await refreshStarActivity([project('a/repo', { githubId: 202 })], cached, {
    now: () => NOW + 1, fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  assert.equal(failed.status.requests, 1);
  assert.equal(failed.repositories['a/repo'], undefined);
  assert.equal(failed.status.historyAttempts['a/repo'].githubId, 202);
});

test('a tagged old-identity 404 cannot block a reused name after its history was removed', async () => {
  const cache = { repositories: {}, status: {
    historyUnavailable: { 'a/repo': new Date(NOW + 7 * DAY).toISOString() },
    historyAttempts: { 'a/repo': { githubId: 101, at: new Date(NOW).toISOString(), retryAfter: null } },
  } };
  const next = await refreshStarActivity([project('a/repo', { githubId: 202 })], cache, {
    now: () => NOW + 1, fetchImpl: async () => ok(weeks()),
  });
  assert.equal(next.status.requests, 1);
  assert.equal(next.repositories['a/repo'].githubId, 202);
});
