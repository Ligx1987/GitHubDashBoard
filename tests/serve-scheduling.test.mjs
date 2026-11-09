import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const enabled of [false, true]) {
  test(enabled ? '显式开启服务采集时共用协调器和小时保护' : '默认启动页面服务不额外发起采集', async t => {
    const root = mkdtempSync(join(tmpdir(), 'pulse-serve-schedule-'));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
      assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src/data'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'scripts/serve.mjs'), readFileSync(new URL('../scripts/serve.mjs', import.meta.url)));
    writeFileSync(join(root, 'src/data/github-snapshot.json'), '{}');
    for (const [file, marker] of [['sync-github-data.mjs', 'legacy'], ['sync-scheduled.mjs', 'scheduled']]) {
      writeFileSync(join(root, 'scripts', file), `import fs from 'node:fs';fs.writeFileSync('collector','${marker}');`);
    }
    const env = { ...process.env, PORT: '0' };
    delete env.GITHUB_PULSE_AUTOSYNC;
    if (enabled) env.GITHUB_PULSE_AUTOSYNC = '1';
    child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', data => { if (String(data).includes('GitHub Pulse:')) { clearTimeout(timer); resolveReady(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await new Promise(r => setTimeout(r, 600));
    if (enabled) assert.equal(readFileSync(join(root, 'collector'), 'utf8'), 'scheduled');
    else assert.equal(existsSync(join(root, 'collector')), false);
  });
}
