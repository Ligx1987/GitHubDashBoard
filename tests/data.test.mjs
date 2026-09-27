import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateGrowth, buildTrendSeries } from '../src/data/history.js';
import {
  assembleSnapshot, selectProjects, licenseRisk, scoreOpportunity, projectFromGitHub,
  fetchGitHubProjects, loadDashboardData, translateProjects,
} from '../src/data/github-data.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const fixture = (fullName, extra = {}) => ({
  fullName, stars: 120, forks: 15, openIssues: 2, license: 'MIT', category: 'web',
  fetchedAt: '2026-09-28T11:00:00Z', pushedAt: '2026-09-28T10:00:00Z',
  createdAt: '2026-09-25T00:00:00Z', contributors: null, ...extra,
});

test('growth requires exact UTC 1/7/30-day baselines, including negative net changes', () => {
  assert.deepEqual(calculateGrowth({ '2026-09-27': 110, '2026-09-21': 130, '2026-08-29': 70 }, 120, NOW),
    { todayStars: 10, weekStars: -10, monthStars: 50 });
  assert.deepEqual(calculateGrowth({ '2026-09-27': 110 }, 120, NOW),
    { todayStars: 10, weekStars: null, monthStars: null });
  assert.deepEqual(calculateGrowth({ '2026-09-21': 0 }, 0, NOW),
    { todayStars: null, weekStars: 0, monthStars: null });
  assert.deepEqual(calculateGrowth({ '2026-09-21': 20 }, null, NOW),
    { todayStars: null, weekStars: null, monthStars: null });
  // Beijing 00:30 still belongs to the previous UTC date.
  assert.equal(calculateGrowth({ '2026-09-20': 5 }, 8, '2026-09-28T00:30:00+08:00').weekStars, 3);
});

test('repeated same-day observations compare with yesterday instead of overwriting their baseline', () => {
  const history = { '2026-09-27': 100, '2026-09-28': 110 };
  assert.equal(calculateGrowth(history, 110, NOW).todayStars, 10);
  history['2026-09-28'] = 120;
  assert.equal(calculateGrowth(history, 120, NOW).todayStars, 20);
});

test('assembly ignores legacy growth, missing dates and stale endpoints', () => {
  const snapshot = assembleSnapshot([
    fixture('a/current', { todayStars: 999, weekStars: 999, monthStars: 999 }),
    fixture('a/stale', { fetchedAt: '2026-09-27T23:59:00Z' }),
    fixture('a/unknown', { fetchedAt: null, createdAt: null, pushedAt: null }),
    fixture('a/gone', { availability: 'unavailable' }),
  ], { now: NOW, history: Object.fromEntries(['current', 'stale', 'unknown', 'gone'].map((name) => [`a/${name}`, { '2026-09-21': 100 }])) });
  assert.equal(snapshot.projects[0].weekStars, 20);
  assert.equal(snapshot.projects[0].todayStars, null);
  assert.equal(snapshot.projects[1].weekStars, null);
  assert.equal(snapshot.projects[2].weekStars, null);
  assert.equal(snapshot.projects[2].ageDays, null);
  assert.equal(snapshot.projects[3].weekStars, null);
  assert.equal(snapshot.lastUpdated, null);
  assert.deepEqual(snapshot.coverage.growth, { today: 0, week: 1, month: 0 });
  assert.equal(snapshot.stats.projects, 2);
  assert.equal(snapshot.coverage.unverified, 1);
  assert.deepEqual(snapshot.weeklyTop10.map((project) => project.fullName), ['a/current']);
  assert.deepEqual(snapshot.monthlyTop30, []);
});

test('legacy candidates stay out of statistics and rankings until a real API observation promotes them', () => {
  const legacy = fixture('a/candidate', { fetchedAt: null, sampleDate: '2026-09-24', stars: 100000 });
  const snapshot = assembleSnapshot([legacy, fixture('a/verified')], { now: NOW });
  assert.equal(snapshot.coverage.registered, 2);
  assert.equal(snapshot.coverage.available, 1);
  assert.equal(snapshot.coverage.unverified, 1);
  assert.equal(snapshot.stats.totalStars, 120);
  assert.equal(snapshot.projects.find((project) => project.fullName === 'a/candidate').stars, 100000);
  assert.equal(selectProjects(snapshot)[0].fullName, 'a/verified');
  assert.equal(selectProjects(snapshot, { query: 'candidate', year: 2026 }).length, 0);
  const observed = projectFromGitHub({ full_name: 'a/candidate', stargazers_count: 1, private: false, created_at: '2026-09-25T00:00:00Z' }, '2026-09-28T11:00:00Z');
  const promoted = assembleSnapshot([observed, fixture('a/verified')], { now: NOW });
  assert.equal(promoted.coverage.available, 2);
  assert.equal(promoted.coverage.unverified, 0);
  assert.equal(selectProjects(promoted, { query: 'candidate' })[0].stars, 1);
  const explicitlyUnverified = assembleSnapshot([fixture('a/flagged', { availability: 'unverified' })], { now: NOW });
  assert.equal(explicitlyUnverified.stats.projects, 0);
});

test('daily updated means a known push during the preceding 24 hours', () => {
  const snapshot = assembleSnapshot([
    fixture('a/recent', { pushedAt: '2026-09-28T11:00:00Z' }),
    fixture('a/old', { pushedAt: '2026-09-27T11:59:59Z' }),
    fixture('a/unknown', { pushedAt: null }),
    fixture('a/future', { pushedAt: '2026-09-29T11:00:00Z' }),
  ], { now: NOW });
  assert.deepEqual(snapshot.dailyUpdated.map((project) => project.fullName), ['a/recent']);
  assert.equal(snapshot.stats.activeToday, 1);
  assert.equal(assembleSnapshot([fixture('a/no-push', { pushedAt: null })], { now: NOW }).stats.activeToday, null);
});

test('category/search/year filters run before top-N ranking and unknown dates stay out', () => {
  const projects = Array.from({ length: 20 }, (_, index) => fixture(`a/global-${index}`, { stars: 1000 + index, category: 'ai' }));
  projects.push(fixture('a/web-candidate', { stars: 2, description: 'rare widget' }));
  projects.push(fixture('a/no-date', { stars: 3000, createdAt: null }));
  const snapshot = assembleSnapshot(projects, { now: NOW });
  assert.equal(selectProjects(snapshot, { category: 'web', createdWithinDays: 7 })[0].fullName, 'a/web-candidate');
  assert.equal(selectProjects(snapshot, { query: 'rare', year: 2026 })[0].fullName, 'a/web-candidate');
  assert.equal(selectProjects(snapshot, { query: 'rare', year: 2025 }).length, 0);
  assert.equal(selectProjects(snapshot, { year: 2026, limit: Infinity }).length, 21);
});

test('weekly and monthly growth ranks have the correct metric and list sizes', () => {
  const projects = Array.from({ length: 35 }, (_, index) => fixture(`a/repo-${index}`, { stars: 1000 + index }));
  const history = Object.fromEntries(projects.map((project, index) => [project.fullName, { '2026-09-21': 1000, '2026-08-29': 1000 + 2 * index }]));
  const snapshot = assembleSnapshot(projects, { now: NOW, history });
  assert.equal(snapshot.weeklyTop10.length, 10);
  assert.equal(snapshot.weeklyTop10[0].fullName, 'a/repo-34');
  assert.equal(snapshot.monthlyTop30.length, 30);
  assert.equal(snapshot.monthlyTop30[0].fullName, 'a/repo-0');
  assert.equal(snapshot.monthlyTop30[29].monthStars, -29);
});

test('trend uses actual consecutive daily samples with explicit partial coverage', () => {
  const trend = buildTrendSeries([{ fullName: 'a/known' }, { fullName: 'a/missing' }], {
    'a/known': { '2026-09-26': 100, '2026-09-27': 98, '2026-09-28': 108 },
  }, NOW);
  assert.deepEqual(trend.values, [null, null, null, null, null, -2, 10]);
  assert.deepEqual(trend.coverage, [0, 0, 0, 0, 0, 1, 1]);
  assert.equal(trend.total, 2);
});

test('unknown licenses and incomplete inputs never get invented opportunity scores', () => {
  for (const license of [undefined, null, '', 'NOASSERTION', 'NONE', 'Custom-License']) assert.equal(licenseRisk(license), 'unknown');
  assert.equal(licenseRisk('MPL-2.0'), 'copyleft');
  assert.equal(licenseRisk('MIT'), 'permissive');
  assert.equal(licenseRisk('BUSL-1.1'), 'risky');
  assert.equal(scoreOpportunity(fixture('a/repo', { weekStars: null }), NOW), null);
  assert.equal(scoreOpportunity(fixture('a/repo', { weekStars: 10, license: 'NOASSERTION' }), NOW), null);
  const score = scoreOpportunity(fixture('a/repo', { weekStars: 10 }), NOW);
  assert.ok(Number.isFinite(score) && score >= 0 && score <= 100);
});

test('API mapping retains original text, truthful dates, nulls and zero counts', () => {
  const project = projectFromGitHub({ full_name: 'a/example', name: 'example', description: '<img src=x>',
    stargazers_count: 0, forks_count: 0, created_at: '2018-06-12T13:49:36Z', updated_at: '2026-09-28T01:00:00Z', html_url: 'javascript:alert(1)' }, '2026-09-28T11:00:00Z');
  assert.equal(project.stars, 0);
  assert.equal(project.forks, 0);
  assert.equal(project.contributors, null);
  assert.equal(project.pushedAt, null);
  assert.equal(project.openIssues, null);
  assert.equal(project.weekStars, null);
  assert.equal(project.createdAt, '2018-06-12T13:49:36Z');
  assert.equal(project.description, '<img src=x>');
  assert.equal(project.htmlUrl, 'https://github.com/a/example');
});

test('Search fetch paginates a bounded sample, deduplicates, and declares truncation', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const page = new URL(url).searchParams.get('page');
    return new Response(JSON.stringify({ total_count: 500, incomplete_results: false,
      items: Array.from({ length: 100 }, (_, index) => ({ full_name: `a/repo-${(Number(page) - 1) * 90 + index}`, stargazers_count: 1 })) }), { status: 200 });
  });
  const projects = await fetchGitHubProjects({ queries: ['stars:>0'], maxPages: 50 });
  assert.equal(urls.length, 2);
  assert.equal(projects.length, 190);
  assert.equal(projects.coverage.truncated, true);
  assert.equal(projects.coverage.queryCoverage[0].matched, 500);
  assert.equal(projects[0].contributors, null);
  assert.ok(projects[0].fetchedAt);
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'stars:>0 is:public');
});

test('private/internal repositories never enter a public dashboard even with a token', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ total_count: 3, incomplete_results: false,
    items: [{ full_name: 'a/public', private: false }, { full_name: 'a/secret', private: true }, { full_name: 'a/internal', visibility: 'internal' }] }), { status: 200 }));
  const projects = await fetchGitHubProjects({ token: 'test-only-token' });
  assert.deepEqual(projects.map((project) => project.fullName), ['a/public']);
  assert.throws(() => projectFromGitHub({ full_name: 'a/secret', private: true }), /公开/);
});

test('Search errors and incomplete_results reject, instead of succeeding with false zeroes', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ total_count: 1, incomplete_results: true, items: [] }), { status: 200 }));
  await assert.rejects(fetchGitHubProjects(), /不完整结果/);
  mock.mock.mockImplementation(async () => new Response('{}', { status: 403 }));
  await assert.rejects(fetchGitHubProjects(), /403/);
});

test('saved snapshot retains structurally valid, traceable observations as collection evolves', async () => {
  const saved = JSON.parse(await readFile(new URL('../src/data/github-snapshot.json', import.meta.url), 'utf8'));
  const history = JSON.parse(await readFile(new URL('../src/data/star-history.json', import.meta.url), 'utf8'));
  assert.ok(saved.projects.length > 0);
  assert.equal(new Set(saved.projects.map((project) => project.fullName.toLowerCase())).size, saved.projects.length);
  for (const project of saved.projects) {
    assert.match(project.fullName, /^[\w.-]+\/[\w.-]+$/);
    assert.ok(['available', 'unavailable', 'unverified'].includes(project.availability));
    assert.ok(project.provenance, `${project.fullName} must identify its source`);
    for (const field of ['stars', 'forks', 'openIssues', 'contributors']) assert.ok(project[field] === null || Number.isSafeInteger(project[field]) && project[field] >= 0);
    if (project.fetchedAt) assert.ok(Number.isFinite(Date.parse(project.fetchedAt)));
    if (project.stars !== null) assert.ok(project.fetchedAt || project.sampleDate, `${project.fullName} must identify a sampling time or date`);
  }
  for (const samples of Object.values(history)) {
    for (const [date, count] of Object.entries(samples)) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isSafeInteger(count) && count >= 0);
    }
  }
});

test('loading saved data uses persisted sampling times and preserves original history', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => new Response(JSON.stringify(String(url).endsWith('star-history.json')
    ? { 'a/one': { '2026-09-24': 120 } }
    : { projects: [fixture('a/one', { fetchedAt: null })], fetchedAt: null, warnings: ['historical sample'] }), { status: 200 }));
  const snapshot = await loadDashboardData();
  assert.equal(snapshot.lastUpdated, null);
  assert.equal(snapshot.projects[0].weekStars, null);
  assert.equal(snapshot.history['a/one']['2026-09-24'], 120);
  assert.equal(snapshot.warning, 'historical sample');
});

test('explicit translation preserves source and leaves text untouched on service error', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: '开发工具' } }), { status: 200 }));
  const projects = [{ description: 'Developer tool' }];
  assert.equal((await translateProjects(projects)).translated, 1);
  assert.equal(projects[0].originalDescription, 'Developer tool');
  mock.mock.mockImplementation(async () => new Response('{}', { status: 503 }));
  const failed = [{ description: 'Original description' }];
  assert.equal((await translateProjects(failed)).translated, 0);
  assert.equal(failed[0].description, 'Original description');
});
