import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillHistoryFiles, inspectHistoryFiles } from './fill-star-history.mjs';
import { planCapacity, coverageCompletion } from './scheduled-policy.mjs';
import { planRecovery, REGULAR_TIMES } from './recovery-policy.mjs';
import { acquireSyncLock, releaseSyncLock, runSync, parseArguments, atomicWriteJson } from './sync-github-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runScheduledSync({ profile = 'hot', budget = 4600, translateLimit = 250, harvest = false,
  maxRuntimeMs = 50 * 60000, now = () => Date.now(), fill = fillHistoryFiles, collect = runSync, report = console.log,
  inspect = inspectHistoryFiles, historyTimes, maxNewPerRound = 250, recoveryState = null, lastStartedAt = null, regularTimes = REGULAR_TIMES,
} = {}) {
  if (!['full', 'hot', 'recovery'].includes(profile) || !Number.isSafeInteger(budget) || budget <= 0) throw new Error('自动同步配置无效');
  const deadlineAt = now() + maxRuntimeMs;
  const initialState = await inspect();
  const capacity = planCapacity(initialState, { budget, now: now(), historyTimes, maxNewPerRound });
  report(JSON.stringify({ stage: 'capacity-preflight', ...capacity }));
  let remaining = capacity.effectiveBudget, exitCode = 0;
  const phases = [];
  const backfill = async stage => {
    if (remaining <= 0 || now() >= deadlineAt) return;
    const result = await fill({ maxRequests: remaining, batchSize: 500, maxRuntimeMs: deadlineAt - now(),
      onProgress: progress => report(JSON.stringify({ stage, ...progress })),
    });
    if (result.requests > remaining) throw new Error('历史补齐超出共享预算');
    remaining -= result.requests;
    if (result.reason === 'upstream-error') exitCode = 1;
    phases.push({ stage, requests: result.requests, updated: result.updated, reason: result.reason, before: result.before, after: result.after });
    report(JSON.stringify(phases.at(-1)));
    return result;
  };
  let initial;
  if (profile === 'recovery') {
    // 补偿仅复核缺口工程的可用性，不扩样、不翻译、不重刷已完整历史。
    const historyNames = (initialState.pendingRepositories || []).map(p => p.fullName);
    const names = [...new Set([...historyNames, ...(initialState.metadataPendingRepositories || []).map(p => p.fullName)])];
    const metadataBudget = Math.min(remaining, Math.max(Math.min(300, historyNames.length),
      remaining - Math.min(remaining, Math.ceil(initialState.pending * 1.1))));
    if (names.length && remaining > 0 && now() < deadlineAt) {
      const result = await collect({ ...parseArguments([]), discover: false, harvest: false,
        managedHistory: true, checkpoint: true, metadataNames: names, maxNewRepositories: 0,
        maxRuntimeMs: Math.max(0, deadlineAt - now()),
        limit: Math.min(metadataBudget, names.length), budget: metadataBudget, translate: false, translateLimit: 0, deadlineAt });
      if (result.requests > metadataBudget) throw new Error('补偿元数据超出共享预算');
      remaining -= result.requests;
      const resolved = result.unavailable > 0 && !result.failures;
      exitCode = resolved ? 0 : result.exitCode || 0;
      phases.push({ stage: 'metadata', ...result });
      report(JSON.stringify(phases.at(-1)));
    }
    initial = await backfill('history-after');
  } else initial = await backfill('history-before');
  // 接口要求冷却或持续失败时结束本轮，后续触发继续；不突破实际额度。
  if (profile !== 'recovery' && !['rate-limit', 'upstream-error', 'upstream-delay'].includes(initial?.reason) && remaining > 0 && now() < deadlineAt) {
    const admission = planCapacity(await inspect(), { budget, now: now(), historyTimes, maxNewPerRound });
    const canDiscover = profile === 'full' && admission.discoveryLimit > 0;
    const options = { ...parseArguments([]), limit: profile === 'full' ? 3000 : 300,
      discover: canDiscover, discoveryPages: 2, maxNewRepositories: canDiscover ? admission.discoveryLimit : 0,
      budget: Math.min(remaining, profile === 'full' ? remaining : 450),
      translateLimit: profile === 'full' ? translateLimit : 0, harvest: canDiscover && harvest,
      deadlineAt, managedHistory: true,
    };
    report(JSON.stringify({ stage: 'discovery-policy', enabled: canDiscover, maxNewRepositories: options.maxNewRepositories, reason: admission.discoveryReason }));
    const result = await collect(options);
    if (result.requests > options.budget) throw new Error('元数据采集超出共享预算');
    remaining -= result.requests;
    exitCode = Math.max(exitCode, result.exitCode || 0);
    phases.push({ stage: 'metadata', ...result });
    report(JSON.stringify(phases.at(-1)));
    await backfill('history-after');
  }
  const finalState = await inspect();
  const completion = coverageCompletion(finalState);
  const capacityAfter = planCapacity(finalState, { budget, now: now(), historyTimes, maxNewPerRound });
  const finalRound = capacity.finalHistoryRound;
  const recovery = planRecovery(finalState, { now: now(), previous: recoveryState,
    lastStartedAt: lastStartedAt || new Date(now()).toISOString(), attempted: profile === 'recovery', before: initialState, regularTimes });
  const status = exitCode ? 'failed' : capacity.effectiveBudget === 0 || initial?.reason === 'rate-limit' ? 'blocked'
    : recovery.complete && !completion.queuedCandidates && capacityAfter.capacityStatus === 'sufficient' ? 'complete' : 'partial';
  if (finalRound && !recovery.complete && !exitCode) exitCode = 2;
  const summary = { profile, budget, effectiveBudget: capacity.effectiveBudget,
    requests: capacity.effectiveBudget - remaining,
    remaining: budget - (capacity.effectiveBudget - remaining), usableRemaining: remaining,
    exitCode, status, coverageComplete: completion.complete, finalHistoryRound: finalRound, capacity, capacityAfter, completion, phases,
    recovery };
  recovery.lastRun = { at: new Date(now()).toISOString(), profile, exitCode, status, requests: summary.requests,
    reasons: phases.map(p => ({ stage: p.stage, reason: p.reason || p.result || null })) };
  report(JSON.stringify({ stage: 'complete', ...summary }));
  return summary;
}

export async function saveDailyState(directory, state, previous = null) {
  await mkdir(join(directory, 'daily-state'), { recursive: true });
  if (previous?.target && previous.target !== state.target && !previous.complete) {
    atomicWriteJson(join(directory, 'daily-state', previous.target.slice(0, 10) + '.json'), {
      ...previous, status: 'missed', closedAt: state.checkedAt, nextRunAt: null, reason: 'window-rolled-over-incomplete' });
  }
  atomicWriteJson(join(directory, 'daily-state', state.target.slice(0, 10) + '.json'), state);
  atomicWriteJson(join(directory, 'daily-state.json'), state);
}

async function main() {
  const lock = join(ROOT, 'src/data/.sync.lock');
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--profile') options.profile = args[++i];
      else if (args[i] === '--budget') options.budget = Number(args[++i]);
      else if (args[i] === '--translate-limit') options.translateLimit = Number(args[++i]);
      else if (args[i] === '--history-times') options.historyTimes = args[++i].split(',');
      else if (args[i] === '--regular-times') options.regularTimes = args[++i].split(',');
      else if (args[i] === '--watch') { options.watch = true; options.profile = 'recovery'; }
      else if (args[i] === '--max-new-per-round') options.maxNewPerRound = Number(args[++i]);
      else if (args[i] === '--max-runtime-minutes') {
        const minutes = Number(args[++i]);
        if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 50) throw new Error('运行时长必须为1至50分钟');
        options.maxRuntimeMs = minutes * 60000;
      }
      else if (args[i] === '--harvest') options.harvest = true;
      else throw new Error('无法识别自动同步参数：' + args[i]);
    }
    if (options.translateLimit !== undefined && (!Number.isSafeInteger(options.translateLimit) || options.translateLimit < 0)) throw new Error('翻译上限无效');
    if (!acquireSyncLock(lock)) console.log('已有采集器运行，本次自动同步跳过。');
    else {
      try {
        const directory = join(ROOT, '.scratch/scheduled-sync');
        await mkdir(directory, { recursive: true });
        const startPath = join(directory, 'last-start.json');
        let last = null;
        try { last = JSON.parse(await readFile(startPath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const startedAt = new Date().toISOString();
        let daily = null;
        try { daily = JSON.parse(await readFile(join(directory, 'daily-state.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (options.watch) {
          const state = await inspectHistoryFiles();
          const recovery = planRecovery(state, { previous: daily, lastStartedAt: last?.startedAt, regularTimes: options.regularTimes });
          if (!recovery.due) {
            await saveDailyState(directory, recovery, daily);
            const event = { at: startedAt, stage: 'coverage-watch', target: recovery.target, status: recovery.status,
              historyPending: recovery.pending, metadataPending: recovery.metadata?.pending || 0,
              attemptCount: recovery.attemptCount, nextRunAt: recovery.nextRunAt, reason: recovery.reason };
            await appendFile(join(directory, 'watchdog.jsonl'), JSON.stringify(event) + '\n');
            console.log(JSON.stringify(event));
            process.exitCode = 0;
            // 无缺口、冷却或主任务保护窗口内：不写实际启动记录，不消耗API预算。
            return;
          }
        }
        const previous = last ? Date.parse(last.startedAt) : null;
        if (last && !Number.isFinite(previous)) throw new Error('上轮启动记录无效，无法确认小时请求间隔');
        // 计划间隔65分钟，实际保护60分钟；余下5分钟容纳进程启动抖动。
        const nextAllowed = last ? previous + 60 * 60000 : 0;
        let result;
        if (nextAllowed > Date.parse(startedAt)) {
          const budget = options.budget ?? 4600;
          result = { profile: options.profile ?? 'hot', budget, requests: 0, remaining: budget, exitCode: 0,
            phases: [], status: 'skipped', coverageComplete: null, skipped: 'minimum-interval', nextAllowedAt: new Date(nextAllowed).toISOString() };
          console.log(JSON.stringify({ stage: 'complete', ...result }));
        } else {
          // 在整轮采集锁内记录实际启动，避免补触发或手动启动挤进同一小时。
          atomicWriteJson(startPath, { startedAt, profile: options.profile ?? 'hot' });
          result = await runScheduledSync({ ...options, recoveryState: daily, lastStartedAt: startedAt, report: line => {
            console.log(line);
            const event = JSON.parse(line);
            if (event.stage === 'capacity-preflight') atomicWriteJson(join(directory, 'capacity-preflight.json'), { at: new Date().toISOString(), ...event });
          } });
        }
        const record = { at: new Date().toISOString(), ...result };
        await appendFile(join(directory, 'coverage.jsonl'), JSON.stringify(record) + '\n');
        if (result.completion) atomicWriteJson(join(directory, 'latest-status.json'), record);
        if (result.recovery) await saveDailyState(directory, result.recovery, daily);
        process.exitCode = result.exitCode;
      } finally { releaseSyncLock(lock); }
    }
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
    const directory = join(ROOT, '.scratch/scheduled-sync');
    await mkdir(directory, { recursive: true });
    atomicWriteJson(join(directory, 'watchdog-error.json'), { at: new Date().toISOString(), message: error.message });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
