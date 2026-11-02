import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillHistoryFiles } from './fill-star-history.mjs';
import { acquireSyncLock, releaseSyncLock, runSync, parseArguments } from './sync-github-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runScheduledSync({ profile = 'hot', budget = 4600, translateLimit = 250, harvest = false,
  maxRuntimeMs = 50 * 60000, now = () => Date.now(), fill = fillHistoryFiles, collect = runSync, report = console.log,
} = {}) {
  if (!['full', 'hot'].includes(profile) || !Number.isSafeInteger(budget) || budget <= 0) throw new Error('自动同步配置无效');
  const deadlineAt = now() + maxRuntimeMs;
  let remaining = budget, exitCode = 0;
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
  const initial = await backfill('history-before');
  // 接口要求冷却或持续失败时结束本轮，后续触发继续；不突破实际额度。
  if (!['rate-limit', 'upstream-error'].includes(initial?.reason) && remaining > 0 && now() < deadlineAt) {
    const options = { ...parseArguments([]), limit: profile === 'full' ? 3000 : 300,
      discover: profile === 'full', discoveryPages: 2,
      budget: Math.min(remaining, profile === 'full' ? remaining : 450), translateLimit, harvest: profile === 'full' && harvest,
      deadlineAt,
    };
    const result = await collect(options);
    if (result.requests > options.budget) throw new Error('元数据采集超出共享预算');
    remaining -= result.requests;
    exitCode = Math.max(exitCode, result.exitCode || 0);
    phases.push({ stage: 'metadata', ...result });
    await backfill('history-after');
  }
  const summary = { profile, budget, requests: budget - remaining, remaining, exitCode, phases };
  report(JSON.stringify({ stage: 'complete', ...summary }));
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = join(ROOT, 'src/data/.sync.lock');
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--profile') options.profile = args[++i];
      else if (args[i] === '--budget') options.budget = Number(args[++i]);
      else if (args[i] === '--translate-limit') options.translateLimit = Number(args[++i]);
      else if (args[i] === '--harvest') options.harvest = true;
      else throw new Error('无法识别自动同步参数：' + args[i]);
    }
    if (options.translateLimit !== undefined && (!Number.isSafeInteger(options.translateLimit) || options.translateLimit < 0)) throw new Error('翻译上限无效');
    if (!acquireSyncLock(lock)) console.log('已有采集器运行，本次自动同步跳过。');
    else {
      try {
        await mkdir(join(ROOT, '.scratch/scheduled-sync'), { recursive: true });
        const result = await runScheduledSync(options);
        await appendFile(join(ROOT, '.scratch/scheduled-sync/coverage.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n');
        process.exitCode = result.exitCode;
      } finally { releaseSyncLock(lock); }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
