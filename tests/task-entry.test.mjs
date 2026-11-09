import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('旧任务定义不能发起采集，新版标识可正常进入采集器', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'pulse-task-entry-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/scheduled-sync.ps1'), readFileSync(new URL('../scripts/scheduled-sync.ps1', import.meta.url)));
  writeFileSync(join(root, 'scripts/sync-task-config.psd1'), readFileSync(new URL('../scripts/sync-task-config.psd1', import.meta.url)));
  writeFileSync(join(root, 'scripts/sync-scheduled.mjs'), "import fs from 'node:fs'; fs.writeFileSync('invoked','yes');");
  const run = args => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/scheduled-sync.ps1'), ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_TOKEN: 'test-only-token' } });
  const old = run([]);
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.equal(existsSync(join(root, 'invoked')), false, '旧缓存XML不能绕过新版任务发起采集');
  assert.match(old.stdout, /retired-task-definition/);
  const current = run(['-ScheduleRevision', 'v2']);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.equal(existsSync(join(root, 'invoked')), true);
});
