import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRepositoryRows, mergeRepositoryStates, reconcileRepositoryState } from '../src/data/repository-state.js';

const oldAt = '2026-10-26T12:00:00Z';
const newAt = '2026-10-28T02:00:00Z';
const row = (fullName, githubId, fetchedAt = oldAt, extra = {}) => ({
  fullName, id: fullName, githubId, fetchedAt, availability: 'available', description: 'Original', ...extra,
});
const activity = (fetchedAt, value) => ({ source: 'github-star-history', fetchedAt,
  weeks: [{ week: 1792886400, total: value * 7, days: Array(7).fill(value) }] });

test('同 GitHub ID 的改名按最新观察折叠并保留本地注解', () => {
  const before = [row('owner/old', 10, oldAt, { descriptionZh: '中文', descriptionZhAt: oldAt,
    descriptionZhProvider: 'google', categoryOverride: 'tools' })];
  const result = mergeRepositoryRows(before, [row('owner/new', 10, newAt, { stars: 20, descriptionZh: null })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].fullName, 'owner/new');
  assert.equal(result[0].descriptionZh, '中文');
  assert.equal(result[0].descriptionZhProvider, 'google');
  assert.equal(result[0].descriptionZhAt, oldAt);
  assert.equal(result[0].categoryOverride, 'tools');
  assert.equal(before[0].fullName, 'owner/old');
});

test('较旧 API 结果不会复活已确认不可访问的仓库', () => {
  const unavailable = row('owner/repo', 10, oldAt, { availability: 'unavailable', lastAttemptAt: newAt });
  const result = mergeRepositoryRows([unavailable], [row('owner/repo', 10, '2026-10-27T12:00:00Z')]);
  assert.equal(result[0].availability, 'unavailable');
  assert.equal(result[0].lastAttemptAt, newAt);
});

test('原文变化清除旧译文，缺失 ID 的同名响应保留已知身份', () => {
  const result = mergeRepositoryRows([row('owner/repo', 10, oldAt, { descriptionZh: '旧译文', descriptionZhProvider: 'google' })],
    [row('OWNER/Repo', null, newAt, { description: 'Changed' })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].githubId, 10);
  assert.equal(result[0].descriptionZh, null);
  assert.equal(result[0].descriptionZhProvider, null);
});

test('同名但不同有效 ID 不串接本地注解或历史', () => {
  const rows = [row('owner/reused', 10, oldAt, { descriptionZh: '属于旧仓库', categoryOverride: 'tools' }),
    row('owner/reused', 20, newAt)];
  const result = reconcileRepositoryState(rows, { history: { 'owner/reused': { '2026-10-26': 100 } },
    starActivity: { repositories: { 'owner/reused': activity(oldAt, 1) }, status: {} } });
  const current = result.projects.find(p => p.githubId === 20);
  assert.equal(current.descriptionZh, undefined);
  assert.equal(current.categoryOverride, undefined);
  assert.equal(result.history['owner/reused'], undefined);
  assert.equal(result.starActivity.repositories['owner/reused'], undefined);
});

test('改名将两类历史迁到新名称且不修改输入', () => {
  const rows = [row('owner/old', 10), row('owner/new', 10, newAt)];
  const history = { 'owner/old': { '2026-10-25': 10, '2026-10-26': 20 }, 'owner/new': { '2026-10-26': 22 } };
  const starActivity = { schemaVersion: 1, repositories: { 'owner/old': activity(oldAt, 1), 'owner/new': activity(newAt, 2) },
    status: { historyUnavailable: { 'owner/old': '2026-11-01T00:00:00Z' } } };
  const result = reconcileRepositoryState(rows, { history, starActivity });
  assert.deepEqual(result.projects.map(p => p.fullName), ['owner/new']);
  assert.deepEqual(result.history, { 'owner/new': { '2026-10-25': 10, '2026-10-26': 22 } });
  assert.deepEqual(Object.keys(result.starActivity.repositories), ['owner/new']);
  assert.equal(result.starActivity.repositories['owner/new'].fetchedAt, newAt);
  assert.equal(result.starActivity.repositories['owner/new'].weeks[0].total, 14);
  assert.equal(result.starActivity.status.historyUnavailable['owner/old'], undefined);
  assert.ok(history['owner/old']);
  assert.ok(starActivity.repositories['owner/old']);
});

test('无冲突的名称大小写变化也迁移历史，未知日期保持缺失', () => {
  const result = reconcileRepositoryState([row('Owner/Repo', null)], {
    history: { 'owner/repo': { '2026-10-25': 10 } },
    starActivity: { repositories: { 'owner/repo': activity(oldAt, 1) }, status: {} },
  });
  assert.deepEqual(result.history, { 'Owner/Repo': { '2026-10-25': 10 } });
  assert.equal(result.history['Owner/Repo']['2026-10-26'], undefined);
  assert.ok(result.starActivity.repositories['Owner/Repo']);
});

test('历史迁移使用调用者固定时钟，不受测试执行日期影响', () => {
  const anchor = Date.parse('2050-01-16T00:00:00Z');
  const weeks = Array.from({ length: 6 }, (_, i) => ({ week: (anchor - i * 7 * 86400000) / 1000,
    total: 7, days: Array(7).fill(1) }));
  const previous = { source: 'github-star-history', fetchedAt: '2050-01-20T02:00:00Z', weeks: weeks.slice(0, 1) };
  const candidate = { source: 'github-star-history', fetchedAt: '2050-01-21T02:00:00Z', weeks };
  const result = reconcileRepositoryState([row('owner/old', 10), row('owner/new', 10, newAt)], {
    now: Date.parse('2050-01-21T12:00:00Z'),
    starActivity: { repositories: { 'owner/old': previous, 'owner/new': candidate }, status: {} },
  });
  assert.equal(result.starActivity.repositories['owner/new'].fetchedAt, candidate.fetchedAt);
  assert.equal(result.starActivity.repositories['owner/new'].weeks.length, 6);
});

test('merge 之后再 reconcile 仍可通过持久化别名迁移旧键历史', () => {
  const merged = mergeRepositoryRows([row('owner/old', 10)], [row('owner/new', 10, newAt)]);
  const result = reconcileRepositoryState(merged, { history: { 'owner/old': { '2026-10-25': 10 } } });
  assert.deepEqual(merged[0].repositoryAliases, ['owner/old']);
  assert.deepEqual(result.history, { 'owner/new': { '2026-10-25': 10 } });
});

test('名称复用经过 merge 仍隔离旧历史，清理后允许新身份重新积累历史', () => {
  const merged = mergeRepositoryRows([
    row('owner/moved', 10, oldAt, { repositoryAliases: ['owner/reused'], descriptionZh: '旧译文' }),
  ], [row('owner/reused', 20, newAt)]);
  const first = reconcileRepositoryState(merged, { history: { 'owner/reused': { '2026-10-25': 100 } } });
  assert.equal(first.history['owner/reused'], undefined);
  assert.deepEqual(first.projects.find(p => p.githubId === 10).repositoryAliases, []);
  const next = reconcileRepositoryState(first.projects, { history: { 'owner/reused': { '2026-10-28': 5 } } });
  assert.deepEqual(next.history['owner/reused'], { '2026-10-28': 5 });
});

test('不同有效 ID 的同全名记录经 merge 后仍保留冲突证据供 reconcile 清理', () => {
  const merged = mergeRepositoryRows([row('owner/reused', 10, oldAt, { descriptionZh: '旧译文' })], [row('owner/reused', 20, newAt)]);
  const result = reconcileRepositoryState(merged, { history: { 'owner/reused': { '2026-10-25': 100 } } });
  assert.equal(result.history['owner/reused'], undefined);
  assert.deepEqual(result.projects.map(p => p.githubId), [20]);
});

test('旧磁盘别名重放不会再次清空新身份已积累的历史', () => {
  const staleDisk = row('owner/moved', 10, oldAt, { repositoryAliases: ['owner/reused'] });
  const first = reconcileRepositoryState([staleDisk, row('owner/reused', 20, newAt)], {
    history: { 'owner/reused': { '2026-10-25': 100 } },
  });
  const mergedAgain = mergeRepositoryRows(first.projects, [staleDisk]);
  const second = reconcileRepositoryState(mergedAgain, { history: { 'owner/reused': { '2026-10-28': 5 } } });
  assert.deepEqual(second.history['owner/reused'], { '2026-10-28': 5 });
  assert.deepEqual(second.projects.find(p => p.githubId === 10).repositoryAliases, []);
  assert.ok(second.projects.find(p => p.githubId === 10).repositoryAliasExclusions.includes('owner/reused'));
});

test('旧磁盘的原始旧名称同样不能越过已处理的身份冲突', () => {
  const cleaned = reconcileRepositoryState([
    row('owner/moved', 10, oldAt, { repositoryAliases: ['owner/reused'] }), row('owner/reused', 20, newAt),
  ]);
  const replayed = mergeRepositoryRows(cleaned.projects, [row('owner/reused', 10, '2026-10-25T12:00:00Z')]);
  const result = reconcileRepositoryState(replayed, { history: { 'owner/reused': { '2026-10-28': 5 } } });
  assert.deepEqual(result.history['owner/reused'], { '2026-10-28': 5 });
  assert.equal(result.projects.find(p => p.githubId === 10).fullName, 'owner/moved');
});

test('两轮状态合并不让旧盘同名仓库历史覆盖新 ID 的成功采样', () => {
  const staleDisk = { projects: [row('owner/reused', 10, oldAt)],
    history: { 'owner/reused': { '2026-10-28': 700 } },
    starActivity: { repositories: { 'owner/reused': activity(oldAt, 7) }, status: {} } };
  const first = mergeRepositoryStates(staleDisk, { projects: [row('owner/reused', 20, newAt)] });
  assert.equal(first.history['owner/reused'], undefined);
  assert.equal(first.starActivity.repositories['owner/reused'], undefined);
  const fresh = { ...first, history: { 'owner/reused': { '2026-10-28': 5 } },
    starActivity: { repositories: { 'owner/reused': activity(newAt, 2) }, status: {} } };
  const replayed = mergeRepositoryStates(fresh, staleDisk, { now: Date.parse('2026-10-28T12:00:00Z') });
  assert.deepEqual(replayed.projects.map(p => p.githubId), [20]);
  assert.deepEqual(replayed.history['owner/reused'], { '2026-10-28': 5 });
  assert.equal(replayed.starActivity.repositories['owner/reused'].weeks[0].days[0], 2);
  assert.equal(replayed.starActivity.repositories['owner/reused'].githubId, 20);
});

test('按源身份路由历史，使被复用名称的旧历史归还已经改名的原 ID', () => {
  const before = { projects: [row('owner/moved', 10, newAt), row('owner/reused', 20, newAt)],
    history: { 'owner/reused': { '2026-10-28': 5 } } };
  const disk = { projects: [row('owner/reused', 10, oldAt)], history: { 'owner/reused': { '2026-10-25': 100 } } };
  const merged = mergeRepositoryStates(before, disk);
  assert.deepEqual(merged.history['owner/moved'], { '2026-10-25': 100 });
  assert.deepEqual(merged.history['owner/reused'], { '2026-10-28': 5 });
});

test('官方记录携带不同有效 ID 时不会通过旧缓存兜底回到当前仓库', () => {
  const result = reconcileRepositoryState([row('owner/reused', 20, newAt)], {
    starActivity: { repositories: { 'owner/reused': { ...activity(oldAt, 7), githubId: 10 } }, status: {} },
  });
  assert.equal(result.starActivity.repositories['owner/reused'], undefined);
});
