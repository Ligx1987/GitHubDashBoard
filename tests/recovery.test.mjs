import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledSync } from '../scripts/sync-scheduled.mjs';
import { saveDailyState } from '../scripts/sync-scheduled.mjs';
import { planRecovery } from '../scripts/recovery-policy.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-11-10T02:25:00Z');
const pending = { available: 10, pending: 1, staleWindow: false, cutoff: '2026-11-10T00:00:00.000Z',
  pendingRepositories: [{ fullName: 'owner/delayed', retryAt: '2026-11-10T03:25:00.000Z' }] };

test('末轮历史接口延迟后自动产生可执行的补偿计划，不能停止在失败状态', async () => {
  const result = await runScheduledSync({ now: () => NOW, inspect: async () => pending, report: () => {},
    fill: async () => ({ requests: 1, updated: 0, reason: 'upstream-error', before: pending, after: pending }),
    collect: async () => assert.fail('上游失败后普通轮次不应再消耗元数据预算'),
  });
  assert.equal(result.coverageComplete, false);
  assert.equal(result.recovery.status, 'retry-pending');
  assert.ok(Date.parse(result.recovery.nextRunAt) >= Date.parse('2026-11-10T03:25:00Z'));
});

test('守护不会不断推迟已排好的重试，同时遵守额度重置和仓库冷却', () => {
  const now = Date.parse('2026-11-10T05:00:00Z');
  const first = planRecovery({ ...pending, quota: { remaining: 0, resetAt: '2026-11-10T06:00:00Z' } }, { now });
  assert.equal(first.nextRunAt, '2026-11-10T06:01:00.000Z');
  const second = planRecovery(pending, { now: now + 15 * 60000, previous: first });
  assert.equal(second.nextRunAt, first.nextRunAt);
  assert.equal(second.due, false);
  assert.equal(planRecovery(pending, { now: Date.parse(first.nextRunAt), previous: second }).due, true);
});

test('自动补偿指数退避、避让主任务；逾期仍继续并保留未完成状态', () => {
  const now = Date.parse('2026-11-10T05:00:00Z');
  const first = planRecovery(pending, { now, attempted: true });
  assert.equal(first.status, 'overdue');
  assert.equal(first.nextRunAt, '2026-11-10T06:05:00.000Z');
  const second = planRecovery(pending, { now: Date.parse(first.nextRunAt), previous: first, attempted: true });
  assert.equal(second.nextRunAt, '2026-11-10T08:15:00.000Z');
  const reserved = planRecovery(pending, { now: Date.parse('2026-11-10T15:30:00Z') });
  assert.equal(reserved.reason, 'reserve-regular-round');
  assert.equal(reserved.nextRunAt, '2026-11-10T17:10:00.000Z');
});

test('历史完整但元数据未齐时继续补偿，两者完整才停止且不再发请求', async () => {
  let current = { ...pending, pending: 0, pendingRepositories: [], metadata: { pending: 2 },
    metadataPendingRepositories: [{ fullName: 'owner/a' }, { fullName: 'owner/b' }] };
  const now = Date.parse('2026-11-10T05:00:00Z');
  assert.equal(planRecovery(current, { now }).complete, false);
  const result = await runScheduledSync({ profile: 'recovery', now: () => now, inspect: async () => current, report: () => {},
    collect: async o => {
      assert.equal(o.managedHistory, true); assert.equal(o.translate, false); assert.equal(o.discover, false);
      assert.deepEqual(o.metadataNames, ['owner/a', 'owner/b']);
      current = { ...current, metadata: { pending: 0 }, metadataPendingRepositories: [] };
      return { requests: 2, exitCode: 0 };
    }, fill: async () => ({ requests: 0, updated: 0, reason: 'complete' }) });
  assert.equal(result.status, 'complete');
  assert.equal(result.recovery.complete, true);
  assert.equal(result.recovery.nextRunAt, null);
  assert.equal(planRecovery(current, { now, previous: result.recovery }).due, false);
});

test('单个历史延迟不饿死元数据队列，有进度时不扩大退避', async () => {
  const now = Date.parse('2026-11-10T05:00:00Z');
  let current = { ...pending, metadata: { pending: 2 }, metadataPendingRepositories: [{ fullName: 'owner/a' }, { fullName: 'owner/b' }] };
  const result = await runScheduledSync({ profile: 'recovery', now: () => now, inspect: async () => current, report: () => {},
    recoveryState: { target: pending.cutoff, stalledAttempts: 2, attemptCount: 2, pending: 1, metadata: { pending: 2 } },
    collect: async o => { assert.deepEqual(o.metadataNames, ['owner/delayed', 'owner/a', 'owner/b']);
      current = { ...current, metadata: { pending: 0 }, metadataPendingRepositories: [] };return { requests: 3, exitCode: 0 }; },
    fill: async () => ({ requests: 1, updated: 0, reason: 'upstream-delay' }) });
  assert.equal(result.coverageComplete, false);
  assert.equal(result.recovery.stalledAttempts, 0);
  assert.equal(result.recovery.nextRunAt, '2026-11-10T06:05:00.000Z');
});

test('补偿先复核缺口身份，确认404可解决缺口；不靠删除有效样本伪造覆盖', async () => {
  let current = { ...pending };
  const seen = [];
  const result = await runScheduledSync({ profile: 'recovery', now: () => NOW, inspect: async () => current, report: () => {},
    collect: async o => {
      seen.push('metadata'); assert.deepEqual(o.metadataNames, ['owner/delayed']);
      current = { ...current, available: 9, pending: 0, pendingRepositories: [] };
      return { requests: 1, exitCode: 1, unavailable: 1, failures: 0 };
    }, fill: async () => { seen.push('history'); return { requests: 0, reason: 'complete' }; } });
  assert.deepEqual(seen, ['metadata', 'history']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.recovery.complete, true);
});

test('跨统计日保留昨日未完成记录，不能用新日成功抹掉漏采', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-daily-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const yesterday = planRecovery(pending, { now: NOW });
  const today = planRecovery({ ...pending, pending: 0, cutoff: '2026-11-11T00:00:00.000Z' }, { now: Date.parse('2026-11-11T05:00:00Z') });
  await saveDailyState(root, today, yesterday);
  const old = JSON.parse(await readFile(join(root, 'daily-state/2026-11-10.json'), 'utf8'));
  assert.equal(old.status, 'missed'); assert.equal(old.complete, false);
  assert.equal(JSON.parse(await readFile(join(root, 'daily-state.json'), 'utf8')).complete, true);
});
