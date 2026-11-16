import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledSync } from '../scripts/sync-scheduled.mjs';
import { planCapacity } from '../scripts/scheduled-policy.mjs';
import { syncData } from '../scripts/sync-github-data.mjs';
import { fillStarHistory, historyCoverage } from '../scripts/fill-star-history.mjs';
import { assembleSnapshot } from '../src/data/github-data.js';

const NOW = Date.parse('2026-11-16T03:00:00Z');
const pending = { available: 10000, pending: 1, staleWindow: false, cutoff: '2026-11-16T00:00:00.000Z',
  boards: [{ id: 'threeDay', candidates: 0 }], pendingRepositories: [{ fullName: 'owner/reused' }] };

test('单仓库历史延迟不能阻断元数据和新候选发现，避免新建榜长期为空', async () => {
  let collected = false;
  await runScheduledSync({ profile: 'full', now: () => NOW, inspect: async () => pending, report: () => {},
    fill: async () => ({ requests: 1, updated: 0, reason: 'upstream-delay' }),
    collect: async options => { collected = true; assert.equal(options.discover, true); assert.ok(options.maxNewRepositories > 0); return { requests: 1, exitCode: 0 }; },
  });
  assert.equal(collected, true);
});

test('空新建榜优先发现已完成统计日内的新仓库，不被旧年度查询耗尽名额', async () => {
  const calls = [];
  const result = await syncData({ snapshot: { schemaVersion: 1, projects: [] }, now: () => new Date(NOW).toISOString(),
    discover: true, discoveryPriority: 'recent', maxNewRepositories: 1, limit: 0, budget: 2,
    fetchImpl: async url => { const q = new URL(url).searchParams.get('q'); calls.push(q);
      return new Response(JSON.stringify({ total_count: 1, items: [{ id: 50, full_name: 'fresh/project',
        stargazers_count: 10, created_at: '2026-11-14T03:00:00Z', private: false }] })); },
  });
  assert.deepEqual(calls, ['created:2026-11-13..2026-11-15 is:public']);
  assert.equal(result.snapshot.projects[0].fullName, 'fresh/project');
});

test('真实采集链从身份冲突与空新建榜恢复，并使用新身份的真实历史排名', async () => {
  const weeks = anchor => Array.from({ length: 6 }, (_, i) => ({ week: (anchor - i * 7 * 86400000) / 1000, total: 7, days: Array(7).fill(1) }));
  let projects = Array.from({ length: 101 }, (_, i) => ({ fullName: i ? `stable/r${i}` : 'owner/reused', githubId: i ? i + 100 : 1,
    availability: 'available', stars: 50, createdAt: '2026-01-01T00:00:00Z', fetchedAt: '2026-11-15T02:00:00Z' }));
  let history = { 'owner/reused': { '2026-11-15': 500 } };
  let activity = { schemaVersion: 1, status: {}, repositories: Object.fromEntries(projects.map((p, i) => [p.fullName,
    { source: 'github-star-history', githubId: p.githubId, fetchedAt: i ? '2026-11-16T02:00:00Z' : '2026-11-15T02:00:00Z',
      weeks: weeks(Date.parse(i ? '2026-11-15T00:00:00Z' : '2026-11-08T00:00:00Z')) }])) };
  let queue = [{ fullName: 'owner/reused', githubId: 2, createdAt: '2026-11-09T20:44:17Z' }];
  const metadata = (name, id) => ({ id, full_name: name, stargazers_count: 7, private: false,
    created_at: name === 'fresh/project' ? '2026-11-14T00:00:00Z' : name === 'owner/reused' ? '2026-11-09T20:44:17Z' : '2026-01-01T00:00:00Z' });
  const result = await runScheduledSync({ profile: 'full', budget: 500, maxNewPerRound: 1, now: () => NOW, report: () => {},
    inspect: async () => ({ ...historyCoverage(projects, activity, NOW).report, pendingRepositories: [] }),
    fill: async options => {
      const r = await fillStarHistory(projects, activity, { ...options, now: () => NOW,
        fetchImpl: async url => new Response(JSON.stringify(weeks(Date.parse(projects.find(p => url.includes('/repos/' + p.fullName + '/'))?.githubId === 1 ? '2026-11-08T00:00:00Z' : '2026-11-15T00:00:00Z')))) });
      activity = r.activity; return r;
    },
    collect: async options => {
      const r = await syncData({ ...options, snapshot: { schemaVersion: 1, projects, discoveryQueue: queue }, history, activity,
        now: () => new Date(NOW).toISOString(), fetchImpl: async url => {
          const u = new URL(url); if (u.pathname.includes('/search/')) return new Response(JSON.stringify({ total_count: 1, items: [metadata('fresh/project', 999)] }));
          const name = u.pathname.slice(7); return new Response(JSON.stringify(metadata(name, name === 'owner/reused' ? 2 : projects.find(p => p.fullName === name)?.githubId)));
        } });
      projects = r.snapshot.projects; history = r.history; activity = r.starActivity; queue = r.snapshot.discoveryQueue;
      return { requests: r.snapshot.sync.requests, exitCode: r.exitCode };
    },
  });
  assert.equal(result.coverageComplete, true);
  assert.equal(queue.length, 0);
  assert.equal(projects.find(p => p.fullName === 'owner/reused').githubId, 2);
  assert.equal(history['owner/reused']['2026-11-15'], undefined);
  const board = assembleSnapshot(projects, { now: NOW, history, starActivity: activity }).newGrowthBoards[0];
  assert.equal(board.projects.length, 1); assert.equal(board.projects[0].fullName, 'fresh/project');
});

test('少量历史缺口维持有界发现，大量缺口或日界未更新仍暂停扩样', () => {
  assert.ok(planCapacity(pending, { now: NOW }).discoveryLimit > 0);
  assert.equal(planCapacity({ ...pending, pending: 500 }, { now: NOW }).discoveryLimit, 0);
  assert.equal(planCapacity({ ...pending, staleWindow: true }, { now: NOW }).discoveryLimit, 0);
});

test('元数据阶段预留历史请求与时间，长批采集结束后仍能补历史', async () => {
  let clock = NOW;
  const seen = [];
  await runScheduledSync({ profile: 'full', budget: 800, maxNewPerRound: 50, maxRuntimeMs: 10 * 60000,
    now: () => clock, inspect: async () => pending, report: () => {},
    fill: async options => { seen.push(options.maxRuntimeMs); return { requests: 1, reason: 'upstream-delay' }; },
    collect: async options => {
      assert.ok(options.deadlineAt <= NOW + 8 * 60000);
      assert.equal(options.budget, 748);
      clock = options.deadlineAt;
      return { requests: options.budget, exitCode: 0 };
    },
  });
  assert.equal(seen.length, 2);
  assert.ok(seen[1] >= 2 * 60000);
});

test('同名仓库换ID是身份修复，零新增预算也必须替换且不能继承旧历史', async () => {
  const name = 'owner/reused';
  const snapshot = { schemaVersion: 1, projects: [{ fullName: name, githubId: 1, stars: 500,
    createdAt: '2026-10-26T00:00:00Z', fetchedAt: '2026-11-08T00:00:00Z', availability: 'available' }] };
  const result = await syncData({ snapshot, history: { [name]: { '2026-11-15': 500 } },
    activity: { schemaVersion: 1, repositories: { [name]: { source: 'github-star-history', githubId: 1,
      fetchedAt: '2026-11-15T01:00:00Z', weeks: [] } }, status: {} },
    now: () => new Date(NOW).toISOString(), discover: false, maxNewRepositories: 0, limit: 1, budget: 1,
    fetchImpl: async () => new Response(JSON.stringify({ id: 2, full_name: name, stargazers_count: 7, private: false,
      created_at: '2026-11-09T20:44:17Z', description: 'New identity', topics: [] })),
  });
  assert.equal(result.snapshot.projects.length, 1);
  assert.equal(result.snapshot.projects[0].githubId, 2);
  assert.equal(result.snapshot.discoveryQueue.length, 0);
  assert.equal(result.history[name]['2026-11-15'], undefined);
  assert.equal(result.history[name]['2026-11-16'], 7);
  assert.equal(result.starActivity.repositories[name], undefined);
});
