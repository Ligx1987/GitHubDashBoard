import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src/data'), { recursive: true });
  mkdirSync(join(root, '.scratch/scheduled-sync'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const n of ['sync-github-data.mjs', 'sync-scheduled.mjs', 'fill-star-history.mjs', 'scheduled-policy.mjs', 'recovery-policy.mjs'])
    copyFileSync(new URL('../scripts/' + n, import.meta.url), join(root, 'scripts', n));
  for (const n of ['github-data.js', 'star-activity.js', 'history.js', 'repository-state.js'])
    copyFileSync(new URL('../src/data/' + n, import.meta.url), join(root, 'src/data', n));
  const now = new Date().toISOString();
  writeFileSync(join(root, 'src/data/github-snapshot.json'), JSON.stringify({ schemaVersion: 1, projects: [{
    fullName: 'test/repo', githubId: 1, availability: 'available', stars: 1, fetchedAt: now, createdAt: now.slice(0, 4) + '-01-01T00:00:00Z',
  }] }));
  writeFileSync(join(root, 'src/data/star-history.json'), '{}');
  const anchor = new Date(); anchor.setUTCHours(0, 0, 0, 0); anchor.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
  writeFileSync(join(root, 'src/data/star-activity.json'), JSON.stringify({ schemaVersion: 1, repositories: { 'test/repo': {
    source: 'github-star-history', githubId: 1, fetchedAt: now,
    weeks: Array.from({ length: 6 }, (_, i) => ({ week: (anchor.getTime() - i * 7 * 86400000) / 1000, total: 7, days: Array(7).fill(1) })),
  } }, status: {} }));
  writeFileSync(join(root, 'reject.mjs'), "import fs from 'node:fs';globalThis.fetch=async()=>{fs.writeFileSync('network-used','yes');throw Error('watch must not request');};");
  return { root, run: () => spawnSync(process.execPath, ['--import', './reject.mjs', 'scripts/sync-scheduled.mjs', '--watch'], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_TOKEN: 'test-only-token' },
  }) };
}

test('真实守护入口在每日验收完整后零请求，不污染最近实际启动时间', t => {
  const { root, run } = fixture(t);
  const result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, 'network-used')), false);
  assert.equal(existsSync(join(root, '.scratch/scheduled-sync/last-start.json')), false);
  const daily = JSON.parse(readFileSync(join(root, '.scratch/scheduled-sync/daily-state.json'), 'utf8'));
  assert.equal(daily.complete, true); assert.equal(daily.nextRunAt, null);
  assert.equal(existsSync(join(root, 'src/data/.sync.lock')), false);
});

test('真实守护重启后保留未来重试点，不请求网络也不覆盖实际轮次状态', t => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, 'src/data/star-activity.json'), '{"schemaVersion":1,"repositories":{},"status":{}}');
  const target = new Date(); target.setUTCHours(0, 0, 0, 0);
  const due = new Date(Date.now() + 3 * 3600000).toISOString();
  writeFileSync(join(root, '.scratch/scheduled-sync/daily-state.json'), JSON.stringify({ target: target.toISOString(), attemptCount: 2, nextRunAt: due }));
  writeFileSync(join(root, '.scratch/scheduled-sync/latest-status.json'), '{"status":"failed"}');
  for (let i = 0; i < 2; i++) { const result = run(); assert.equal(result.status, 0, result.stdout + result.stderr); }
  assert.equal(existsSync(join(root, 'network-used')), false);
  assert.equal(JSON.parse(readFileSync(join(root, '.scratch/scheduled-sync/daily-state.json'), 'utf8')).attemptCount, 2);
  assert.equal(readFileSync(join(root, '.scratch/scheduled-sync/latest-status.json'), 'utf8'), '{"status":"failed"}');
});
