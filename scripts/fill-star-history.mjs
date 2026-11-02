import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSnapshot, growthWindowEnd } from '../src/data/github-data.js';
import { emptyStarActivity, refreshStarActivity } from '../src/data/star-activity.js';
import { acquireSyncLock, releaseSyncLock, atomicWriteJson, resolveToken } from './sync-github-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;

export function historyCoverage(projects, activity, now = Date.now()) {
  const snapshot = assembleSnapshot(projects, { now, starActivity: activity });
  const cutoff = growthWindowEnd(snapshot);
  const staleWindow = !cutoff || now - Date.parse(cutoff) >= DAY;
  const available = snapshot.projects.filter(p => p.availability === 'available');
  const pending = available.filter(p => staleWindow || p.activityWindowEnd !== cutoff || p.weekAdded === null || p.monthAdded === null);
  return { projects: available, activity: snapshot.starActivity, pending, report: {
    cutoff, staleWindow, available: available.length, pending: pending.length,
    weekEligible: snapshot.surgeBoards[0].coverage.eligible,
    monthEligible: snapshot.surgeBoards[1].coverage.eligible,
  } };
}

// 每轮只尝试同一工程一次；新日界后即使缓存未过 TTL，也必须补当期窗口。
export async function fillStarHistory(projects, activity = emptyStarActivity(), {
  token = '', maxRequests = 4600, batchSize = 500, maxRuntimeMs = 45 * 60000,
  now = () => Date.now(), fetchImpl = fetch, save = async () => {}, onProgress = () => {},
} = {}) {
  const started = now();
  let state = historyCoverage(projects, activity, now());
  const before = state.report;
  activity = state.activity;
  const attempted = new Set();
  let requests = 0, updated = 0, failures = 0, reason = 'complete';
  while (state.pending.length) {
    if (now() - started >= maxRuntimeMs) { reason = 'time-budget'; break; }
    if (requests >= maxRequests) { reason = 'request-budget'; break; }
    if (Date.parse(activity.status?.retryAfter) > now() && (!token || activity.status?.authenticated)) { reason = 'rate-limit'; break; }
    const candidates = state.pending.filter(p => !attempted.has(p.fullName))
      .filter(p => !(Date.parse(activity.status?.historyUnavailable?.[p.fullName]) > now()))
      .filter(p => !(Date.parse(activity.status?.historyAttempts?.[p.fullName]?.retryAfter) > now()));
    if (!candidates.length) { reason = 'cooldown-or-upstream-delay'; break; }
    const previous = activity;
    const next = await refreshStarActivity(candidates, activity, {
      token, now, fetchImpl, ttlMs: 0,
      limit: Math.min(batchSize, maxRequests - requests),
      maxRuntimeMs: Math.min(5 * 60000, maxRuntimeMs - (now() - started)),
    });
    const touched = candidates.filter(p => next.status?.historyAttempts?.[p.fullName] !== previous.status?.historyAttempts?.[p.fullName]
      || next.repositories[p.fullName] !== previous.repositories[p.fullName]);
    const count = touched.length;
    const changed = count > 0;
    for (const p of candidates) {
      if (next.status?.historyAttempts?.[p.fullName] !== previous.status?.historyAttempts?.[p.fullName]
        || next.repositories[p.fullName] !== previous.repositories[p.fullName]) attempted.add(p.fullName);
    }
    activity = next;
    requests += count;
    updated += changed ? next.status.updated || 0 : 0;
    failures += changed ? next.status.failures || 0 : 0;
    // 各批次持久化；限额、失败与不完整历史也保留已成功数据及冷却状态。
    await save(activity);
    state = historyCoverage(projects, activity, now());
    await onProgress({ requests, updated, failures, ...state.report });
    if (Date.parse(next.status?.retryAfter) > now()) { reason = 'rate-limit'; break; }
    if (!count) { reason = 'cooldown-or-upstream-delay'; break; }
    if (changed && next.status.failures && !next.status.updated) { reason = 'upstream-error'; break; }
  }
  await save(activity);
  return { activity, requests, updated, failures, reason, before, after: state.report };
}

// 调用者负责持锁，便于整个“补历史—采元数据—补新候选”共用一个锁。
export async function fillHistoryFiles(options = {}) {
  let saved = { projects: [] };
  try { saved = JSON.parse(await readFile(join(ROOT, 'src/data/github-snapshot.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(saved.projects)) throw new Error('仓库快照结构无效');
  let activity = emptyStarActivity();
  try { activity = JSON.parse(await readFile(join(ROOT, 'src/data/star-activity.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return fillStarHistory(saved.projects, activity, { token: resolveToken(), ...options,
    save: async cache => atomicWriteJson(join(ROOT, 'src/data/star-activity.json'), cache),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = join(ROOT, 'src/data/.sync.lock');
  if (!acquireSyncLock(lock)) console.log('已有采集器运行，本次历史补齐跳过。');
  else {
    try {
      const result = await fillHistoryFiles({ onProgress: progress => console.log(JSON.stringify(progress)) });
      console.log(JSON.stringify({ ...result, activity: undefined }));
      if (result.reason === 'upstream-error') process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { releaseSyncLock(lock); }
  }
}
