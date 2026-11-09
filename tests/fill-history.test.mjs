import test from 'node:test';
import assert from 'node:assert/strict';
import { fillStarHistory } from '../scripts/fill-star-history.mjs';
import { runScheduledSync as runScheduled } from '../scripts/sync-scheduled.mjs';

const NOW = Date.parse('2026-11-02T00:13:00Z');
const DAY = 86400000;
const runScheduledSync = options => runScheduled({ inspect: async () => ({available: 1, pending: 0, staleWindow: false, cutoff: '2026-11-02T00:00:00.000Z'}), ...options });
const anchor = Date.parse('2026-11-01T00:00:00Z');
const weeks = () => Array.from({ length: 6 }, (_, i) => ({ week: (anchor - i * 7 * DAY) / 1000, total: 7, days: Array(7).fill(1) }));
const projects = count => Array.from({ length: count }, (_, i) => ({ fullName: `test/repo-${i}`, githubId: i + 1,
  availability: 'available', fetchedAt: new Date(NOW).toISOString(), createdAt: '2024-01-01T00:00:00Z', stars: 100 }));
const record = fetchedAt => ({ source: 'github-star-history', fetchedAt, weeks: weeks() });
const cache = repositories => ({ schemaVersion: 1, repositories, status: {} });
const response = (status = 200, headers = {}, payload = weeks()) => new Response(JSON.stringify(payload), { status, headers });

test('新完整统计日即使缓存不足两小时也会补齐，随后同日不重复请求', async () => {
  const rows = projects(1);
  let calls = 0;
  const options = { now: () => NOW, fetchImpl: async () => { calls++; return response(); } };
  const first = await fillStarHistory(rows, cache({ 'test/repo-0': record('2026-11-01T23:30:00Z') }), options);
  assert.equal(first.before.staleWindow, true);
  assert.equal(first.requests, 1);
  assert.equal(first.after.cutoff, '2026-11-02T00:00:00.000Z');
  assert.equal(first.after.pending, 0);
  const second = await fillStarHistory(rows, first.activity, options);
  assert.equal(second.requests, 0);
  assert.equal(calls, 1);
});

test('分批补齐只请求缺口并遵守整轮预算，固定时钟也能正确累计', async () => {
  const seen = [];
  const saved = [];
  const result = await fillStarHistory(projects(5), cache({}), { now: () => NOW, maxRequests: 3, batchSize: 2,
    fetchImpl: async url => { seen.push(url); return response(); }, save: async value => saved.push(value) });
  assert.equal(result.requests, 3);
  assert.equal(result.updated, 3);
  assert.equal(result.after.pending, 2);
  assert.equal(result.reason, 'request-budget');
  assert.equal(new Set(seen).size, 3);
  assert.ok(saved.length >= 2);
});

test('404 冷却项不会阻塞其他工程，也不会反复请求', async () => {
  const rows = projects(3);
  const seen = [];
  const result = await fillStarHistory(rows, { ...cache({}), status: { historyUnavailable: { 'test/repo-0': new Date(NOW + DAY).toISOString() } } }, {
    now: () => NOW, batchSize: 1, fetchImpl: async url => { seen.push(url); return response(url.includes('repo-1/') ? 404 : 200); },
  });
  assert.equal(result.requests, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.after.pending, 2);
  assert.ok(seen.every(url => !url.includes('repo-0/')));
  assert.equal(new Set(seen).size, 2);
});

test('请求额度停止时仍保存已成功历史，后续批次不越过重置时间', async () => {
  let saved;
  const result = await fillStarHistory(projects(2), cache({}), { now: () => NOW,
    fetchImpl: async () => response(200, { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': String((NOW + DAY) / 1000) }),
    save: async value => { saved = value; },
  });
  assert.equal(result.requests, 1);
  assert.equal(result.reason, 'rate-limit');
  assert.equal(Object.keys(saved.repositories).length, 1);
});

test('接口只返回部分历史时，本轮只尝试一次并保留真实缺口', async () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const result = await fillStarHistory(projects(1), cache({}), { now: () => now, fetchImpl: async () => response(200, {}, weeks().slice(0, 1)) });
  assert.equal(result.requests, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.after.pending, 1);
  assert.equal(result.after.weekEligible, 0);
});

test('HTTP 限额响应按等待处理并保存冷却状态，不当作持续接口故障', async () => {
  const result = await fillStarHistory(projects(2), cache({}), { token: 'test-token', now: () => NOW,
    fetchImpl: async () => response(403, { 'retry-after': '3600' }) });
  assert.equal(result.requests, 1);
  assert.equal(result.reason, 'rate-limit');
  assert.ok(Date.parse(result.activity.status.retryAfter) > NOW);
});

test('运行时间预算到期后不再发新请求', async () => {
  let clock = NOW;
  const result = await fillStarHistory(projects(3), cache({}), { now: () => clock, maxRuntimeMs: 1000, batchSize: 1,
    fetchImpl: async () => { clock += 1000; return response(); } });
  assert.equal(result.requests, 1);
  assert.equal(result.reason, 'time-budget');
});

test('自动八轮先补历史再采元数据，最后补新候选，共享请求预算', async () => {
  const seen = [];
  let round = 0;
  const result = await runScheduledSync({ profile: 'full', budget: 4600, now: () => NOW, report: () => {},
    fill: async options => { seen.push(['fill', options.maxRequests]); return { requests: ++round === 1 ? 4000 : 100, updated: 1, reason: 'complete' }; },
    collect: async options => { seen.push(['metadata', options.budget]); assert.equal(options.limit, 3000); assert.equal(options.discover, true); return { requests: 400, exitCode: 0 }; },
  });
  assert.deepEqual(seen, [['fill', 4600], ['metadata', 600], ['fill', 200]]);
  assert.equal(result.requests, 4500);
  assert.equal(result.remaining, 100);
});

test('热榜轮保留元数据上限，同时有额度补齐历史', async () => {
  let round = 0;
  const result = await runScheduledSync({ profile: 'hot', now: () => NOW, report: () => {},
    fill: async () => ({ requests: round++ ? 100 : 0, updated: 0, reason: 'complete' }),
    collect: async options => { assert.equal(options.limit, 300); assert.equal(options.budget, 450); assert.equal(options.discover, false); return { requests: 300, exitCode: 0 }; },
  });
  assert.equal(result.requests, 400);
});

test('接口要求等待重置时自动任务暂停剩余阶段', async () => {
  const result = await runScheduledSync({ report: () => {},
    fill: async () => ({ requests: 0, updated: 0, reason: 'rate-limit' }),
    collect: async () => assert.fail('不能继续元数据请求'),
  });
  assert.equal(result.phases.length, 1);
});

test('自动任务时间用完后保留补采结果并跳过剩余工作', async () => {
  let clock = NOW;
  const result = await runScheduledSync({ now: () => clock, maxRuntimeMs: 1000, report: () => {},
    fill: async () => { clock += 1000; return { requests: 1, updated: 1, reason: 'time-budget' }; },
    collect: async () => assert.fail('不能越过截止时间'),
  });
  assert.equal(result.requests, 1);
  assert.equal(result.phases.length, 1);
});

test('元数据失败仍执行可保存的历史补齐，并保留失败告警', async () => {
  let count = 0;
  const result = await runScheduledSync({ report: () => {}, fill: async () => { count++; return { requests: 0, updated: 0, reason: 'complete' }; },
    collect: async () => ({ requests: 1, exitCode: 1 }) });
  assert.equal(count, 2);
  assert.equal(result.exitCode, 1);
});
