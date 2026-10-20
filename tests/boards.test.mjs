import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSnapshot, selectNewProjectGrowth, selectSurgeProjects, selectYearlyTop30, discoverySearchPlan, CATEGORY_VERSION } from '../src/data/github-data.js';
import { summarizeStarActivity, refreshStarActivity } from '../src/data/star-activity.js';
import { syncData } from '../scripts/sync-github-data.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const END = Date.parse('2026-10-11T00:00:00Z');
const iso = value => new Date(value).toISOString();
const project = (name, age = 2, extra = {}) => ({ fullName: `test/${name}`, stars: 100, category: 'web', categoryVersion: CATEGORY_VERSION,
  createdAt: iso(END - age * DAY), fetchedAt: iso(NOW), availability: 'available', ...extra });
function activity(p, amount = 1, offset = 0) {
  const anchor = END + offset;
  const weeks = Array.from({ length: 6 }, (_, i) => {
    const start = anchor - i * 7 * DAY;
    const days = Array.from({ length: 7 }, (_, d) => start + (d + 1) * DAY <= Date.parse(p.createdAt) ? 0 : amount);
    return { week: start / 1000, total: days.reduce((a, b) => a + b, 0), days };
  });
  return { source: 'github-star-history', fetchedAt: iso(NOW), weeks };
}
const snapshot = (projects, records) => assembleSnapshot(projects, { now: NOW,
  starActivity: { repositories: records || Object.fromEntries(projects.map((p, i) => [p.fullName, activity(p, i + 1)])) } });

test('new-project boards enforce creation windows, independent limits, and addition rather than total-star ordering', () => {
  const rows = Array.from({ length: 35 }, (_, i) => project(`new-${i}`, 2, { stars: 1000 - i }));
  rows.push(project('old-fast', 100, { stars: 1000000 }));
  const data = snapshot(rows);
  assert.deepEqual(data.newGrowthBoards.map(b => b.projects.length), [10, 10, 30]);
  for (const board of data.newGrowthBoards) {
    assert.equal(board.projects[0].fullName, 'test/new-34');
    assert.ok(!board.projects.some(p => p.fullName === 'test/old-fast'));
    assert.equal(board.coverage.candidates, 35);
  }
});

test('creation bounds include start, exclude end and first registration does not make an old repository new', () => {
  const rows = [project('at-start', 3), project('before-start', 3 + 1 / DAY), project('at-end', 0),
    project('future', -1), project('unknown', 1, { createdAt: null }), project('first-seen-old', 365)];
  const data = snapshot(rows);
  assert.deepEqual(data.newThreeDayTop10.map(p => p.fullName), ['test/at-start']);
  assert.equal(data.newGrowthBoards[0].coverage.createdAtUnknown, 1);
  assert.equal(data.newGrowthBoards[0].windowStart, iso(END - 3 * DAY));
  assert.equal(data.newGrowthBoards[0].windowEnd, iso(END));
});

test('new-project history keeps true zeroes, incomplete and mismatched day boundaries in pending coverage', () => {
  const rows = [project('zero'), project('missing'), project('other-boundary'), project('valid')];
  const records = { [rows[0].fullName]: activity(rows[0], 0), [rows[2].fullName]: activity(rows[2], 2, -8 * 3600000),
    [rows[3].fullName]: activity(rows[3], 1) };
  const board = snapshot(rows, records).newGrowthBoards[0];
  assert.equal(board.coverage.candidates, 4);
  assert.equal(board.coverage.eligible, 2);
  assert.equal(board.coverage.pending, 2);
  assert.deepEqual(board.projects.map(p => p.fullName), ['test/valid', 'test/zero']);
  assert.equal(board.projects[1].threeDayAdded, 0);
});

test('three-day history excludes current partial day and never substitutes a missing day with zero', () => {
  const p = project('new', 3);
  const record = activity(p, 2);
  record.weeks[0].days[0] = 1000;
  record.weeks[0].total += 998;
  assert.equal(summarizeStarActivity(record, { now: NOW, createdAt: p.createdAt }).threeDayAdded, 6);
  const incomplete = { ...record, weeks: record.weeks.slice(0, 1) };
  assert.equal(summarizeStarActivity(incomplete, { now: NOW, createdAt: p.createdAt }).threeDayAdded, null);
});

test('growth filters operate on the full cohort before Top N and do not move the common boundary', () => {
  const rows = [...Array.from({ length: 35 }, (_, i) => project(`ai-${i}`, 2, { category: 'ai' })), project('rare-widget')];
  const data = snapshot(rows);
  const board = selectNewProjectGrowth(data, { days: 3, category: 'web', query: 'rare' });
  assert.equal(board.projects.length, 1);
  assert.equal(board.projects[0].fullName, 'test/rare-widget');
  assert.equal(board.windowEnd, data.newGrowthBoards[0].windowEnd);
});

test('yearly boards only cover the rolling three-year scope and filter before truncation', () => {
  const rows = [];
  for (let year = 2021; year <= 2026; year++) {
    // NOW is 2026-10-11, so the rolling three-year scope starts 2023-10-11.
    const createdAt = year === 2023 ? '2023-12-01T00:00:00Z' : `${year}-01-01T00:00:00Z`;
    for (let i = 0; i < 35; i++) rows.push(project(`${year}-${i}`, 1, { createdAt, stars: i, category: 'ai' }));
    rows.push(project(`${year}-web`, 1, { createdAt, stars: 1 }));
  }
  rows.push(project('unknown', 1, { createdAt: null, stars: 99999 }), project('future', -1, { stars: 99999 }),
    project('no-stars', 1, { stars: null }));
  const data = snapshot(rows, {});
  assert.deepEqual(data.yearlyTop30.map(b => b.year), [2026, 2025, 2024, 2023]);
  assert.ok(data.yearlyTop30.every(b => b.projects.length === 30 && b.projects[0].stars === 34));
  assert.equal(selectYearlyTop30(data, { category: 'web', query: '-web' })[0].projects[0].fullName, 'test/2026-web');
  assert.ok(!data.yearlyTop30[0].projects.some(p => p.fullName === 'test/future'));
  assert.ok(data.yearlyTop30.flatMap(b => b.projects).every(p => !/2021|2022/.test(p.fullName))); // pre-scope years never appear
  const rolled = assembleSnapshot(rows, { now: Date.parse('2027-01-01T00:00:00Z') });
  assert.deepEqual(rolled.yearlyTop30.map(b => b.year), [2027, 2026, 2025, 2024]);
});

test('discovery uses independent recent windows and year cohorts bounded by the three-year scope', () => {
  const plan = discoverySearchPlan(NOW);
  assert.deepEqual(plan.slice(0, 3).map(p => p.days), [3, 7, 30]);
  assert.deepEqual(plan.slice(3, 7).map(p => p.year), [2026, 2025, 2024, 2023]);
  assert.equal(plan.length, 10); // 3 recent + 4 in-scope year cohorts + 3 surge bands
  assert.match(plan[0].query, /2026-10-07\.\.2026-10-11/);
  assert.match(plan[3].query, /2026-01-01\.\.2026-10-11/);
  assert.match(plan[4].query, /2025-01-01\.\.2025-12-31/);
  assert.match(plan[6].query, /2023-10-11\.\.2023-12-31/); // cutoff year starts at the scope boundary, not January
  assert.ok(plan.slice(0, 7).every(p => !p.query.includes('stars:')));
});

test('surge discovery adds star-banded recent-push channels bounded by the three-year scope', () => {
  const surge = discoverySearchPlan(NOW).filter(p => p.kind === 'surge');
  assert.equal(surge.length, 3);
  assert.deepEqual(surge.map(p => p.band), ['50..500', '500..5000', '>5000']);
  assert.ok(surge.every(p => p.query.includes(`stars:${p.band}`) && p.query.includes('pushed:>=2026-10-03') &&
    p.query.includes('created:>=2023-10-11') && p.query.includes('is:public')));
});

test('surge boards rank established repositories by recent additions that new-project boards exclude', () => {
  const rows = [project('old-surge', 400, { stars: 5000 }), project('young', 2, { stars: 100 }), project('quiet', 300)];
  const data = snapshot(rows, {
    'test/old-surge': activity(rows[0], 10), 'test/young': activity(rows[1], 5), 'test/quiet': activity(rows[2], 1),
  });
  assert.deepEqual(data.surgeWeekTop30.map(p => p.fullName), ['test/old-surge', 'test/young', 'test/quiet']);
  assert.equal(data.surgeMonthTop30.length, 3);
  assert.equal(data.surgeBoards[0].coverage.eligible, 3);
  assert.ok(!data.newWeeklyTop10.some(p => p.fullName === 'test/old-surge'));
  const filtered = selectSurgeProjects(data, { field: 'weekAdded', query: 'quiet' });
  assert.deepEqual(filtered.projects.map(p => p.fullName), ['test/quiet']);
});

test('acceleration flags breakouts versus the previous complete week and ignores tiny-sample noise', () => {
  const boom = project('boom', 400);
  const record = activity(boom, 2); // previous weeks: 14 additions each
  record.weeks[1] = { week: record.weeks[1].week, days: Array(7).fill(10), total: 70 }; // current window: 70
  const data = snapshot([boom], { 'test/boom': record });
  assert.equal(data.projects[0].weekAdded, 70);
  assert.equal(data.projects[0].prevWeekAdded, 14);
  assert.equal(data.projects[0].accelerationRatio, 5);
  assert.equal(data.projects[0].accelerating, true);
  const breakout = project('breakout', 400);
  const zeroThenUp = activity(breakout, 0);
  zeroThenUp.weeks[1] = { week: zeroThenUp.weeks[1].week, days: Array(7).fill(3), total: 21 };
  const data2 = snapshot([breakout], { 'test/breakout': zeroThenUp });
  assert.equal(data2.projects[0].prevWeekAdded, 0);
  assert.equal(data2.projects[0].accelerationRatio, null);
  assert.equal(data2.projects[0].accelerating, true);
  const tiny = project('tiny', 400);
  const noise = activity(tiny, 0);
  noise.weeks[1] = { week: noise.weeks[1].week, days: Array(7).fill(2), total: 14 };
  assert.equal(snapshot([tiny], { 'test/tiny': noise }).projects[0].accelerating, false);
});

test('limited discovery runs resume untouched cohorts instead of repeatedly collecting the first period', async () => {
  const called = [];
  const seed = { projects: [project('seed')] };
  const collect = source => syncData({ snapshot: source, budget: 1, discover: true, discoveryPages: 1, now: () => iso(NOW),
    fetchImpl: async url => {
      called.push(new URL(url).searchParams.get('q'));
      return new Response(JSON.stringify({ total_count: 0, items: [], incomplete_results: false }));
    } });
  const first = await collect(seed);
  await collect(first.snapshot);
  assert.notEqual(called[0], called[1]);
  assert.equal(called.length, 2);
});

test('a single record with a fresher day boundary does not push the majority into pending', () => {
  const rows = [project('a'), project('b'), project('outlier')];
  const records = {
    'test/a': activity(rows[0], 1),
    'test/b': activity(rows[1], 2),
    'test/outlier': activity(rows[2], 9, 8 * 3600000), // newer anchor than the rest
  };
  const data = snapshot(rows, records);
  const board = data.surgeBoards[0];
  assert.equal(board.windowEnd, iso(END)); // modal boundary wins over the newer outlier
  assert.equal(board.coverage.eligible, 2);
  assert.equal(board.coverage.pending, 1);
  assert.deepEqual(board.projects.map(p => p.fullName), ['test/b', 'test/a']);
});

test('history budget prioritizes newly created candidates over an older high-star repository', async () => {
  const rows = [project('old', 365, { stars: 999999 }), project('new')];
  const called = [];
  await refreshStarActivity(rows, undefined, { now: () => NOW, limit: 1, fetchImpl: async url => {
    called.push(url); return new Response(JSON.stringify(activity(rows[1]).weeks));
  } });
  assert.match(called[0], /test\/new\/stargazers/);
});
