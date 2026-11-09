import test from 'node:test';
import assert from 'node:assert/strict';
import { planCapacity } from '../scripts/scheduled-policy.mjs';
import { runScheduledSync } from '../scripts/sync-scheduled.mjs';

const NOW = Date.parse('2026-11-09T02:16:00Z');
const state = overrides => ({ available: 10342, pending: 0, staleWindow: false, cutoff: '2026-11-09T00:00:00.000Z', ...overrides });

test('一万多个工程需要三个额度窗口，并为重试保留容量', () => {
  const p = planCapacity(state(), { now: NOW });
  assert.equal(p.historyWindows, 3);
  assert.equal(p.requiredWindows, 3);
  assert.equal(p.capacity, 13800);
  assert.equal(p.discoveryLimit, 250);
  assert.equal(p.capacityStatus, 'sufficient');
  assert.equal(p.finalHistoryRound, true);
});

test('已有历史缺口或样本超过可维护容量时不再扩大样本', () => {
  assert.equal(planCapacity(state({ pending: 1 }), { now: NOW }).discoveryLimit, 0);
  const p = planCapacity(state({ available: 13000 }), { now: NOW });
  assert.equal(p.requiredWindows, 4);
  assert.equal(p.capacityStatus, 'insufficient');
  assert.equal(p.discoveryLimit, 0);
});

test('有效响应头额度进一步收缩当轮预算，过期额度不继续阻塞', () => {
  const quota = { remaining: 150, resetAt: new Date(NOW + 60000).toISOString() };
  assert.equal(planCapacity(state({ quota }), { now: NOW }).effectiveBudget, 50);
  assert.equal(planCapacity(state({ quota }), { now: NOW + 120000 }).effectiveBudget, 4600);
});

test('剩余额度不足安全余量时不请求网络，也不误报覆盖完成', async () => {
  const current = state({ pending: 2, quota: { remaining: 50, resetAt: new Date(NOW + 60000).toISOString() } });
  const r = await runScheduledSync({ now: () => NOW, inspect: async () => current, report: () => {},
    fill: async () => assert.fail('额度不足不应调用补齐'), collect: async () => assert.fail('额度不足不应采元数据') });
  assert.equal(r.requests, 0);
  assert.equal(r.status, 'blocked');
  assert.equal(r.coverageComplete, false);
  assert.equal(r.exitCode, 2);
});

test('预算用尽但未补齐时进程成功与覆盖完成分别记录，末轮给出未完成退出码', async () => {
  for (const [clock, expectedCode] of [[NOW, 2], [Date.parse('2026-11-09T00:05:00Z'), 0]]) {
    let current = state({ available: 3, pending: 3 });
    const r = await runScheduledSync({ budget: 2, now: () => clock, inspect: async () => current, report: () => {},
      fill: async () => { const before = current; current = state({ available: 3, pending: 1 }); return { requests: 2, reason: 'request-budget', before, after: current }; },
      collect: async () => assert.fail('预算已用尽') });
    assert.equal(r.exitCode, expectedCode);
    assert.equal(r.status, 'partial');
    assert.equal(r.coverageComplete, false);
    assert.equal(r.completion.pending, 1);
  }
});

test('发现限速传至真实采集选项，存在缺口时仍可复核元数据但关闭发现和打捞', async () => {
  for (const pending of [0, 1]) {
    const current = state({ pending });
    await runScheduledSync({ profile: 'full', harvest: true, now: () => NOW, inspect: async () => current, report: () => {},
      fill: async () => ({ requests: 0, reason: pending ? 'cooldown-or-upstream-delay' : 'complete', after: current }),
      collect: async o => { assert.equal(o.maxNewRepositories, pending ? 0 : 250); assert.equal(o.discover, !pending); assert.equal(o.harvest, !pending); return { requests: 0, exitCode: 0 }; } });
  }
});
