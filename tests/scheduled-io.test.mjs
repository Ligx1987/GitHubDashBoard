import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, expired) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-scheduled-io-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src/data'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  copyFileSync(new URL('../scripts/sync-github-data.mjs', import.meta.url), join(root, 'scripts/sync-github-data.mjs'));
  for (const name of ['github-data.js', 'star-activity.js', 'history.js', 'repository-state.js']) {
    copyFileSync(new URL('../src/data/' + name, import.meta.url), join(root, 'src/data', name));
  }
  const old = new Date(Date.now() - 86400000).toISOString();
  writeFileSync(join(root, 'src/data/github-snapshot.json'), JSON.stringify({ schemaVersion: 1, fetchedAt: old, projects: [{
    fullName: 'test/repo', githubId: 1, stars: 10, availability: 'available', fetchedAt: old, createdAt: '2024-01-01T00:00:00Z',
  }] }));
  writeFileSync(join(root, 'src/data/star-history.json'), '{}');
  writeFileSync(join(root, 'runner.mjs'), `
import {runSync,parseArguments} from './scripts/sync-github-data.mjs';
let calls=0;
globalThis.fetch=async url=>{
  calls++;
  if(${expired})throw new Error('expired deadline must not request');
  const date=new Date(); date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-date.getUTCDay());
  const body=url.includes('/stargazers/history')?Array.from({length:6},(_,i)=>({week:(date.getTime()-i*7*86400000)/1000,total:7,days:Array(7).fill(1)})):
    {id:1,full_name:'test/repo',stargazers_count:12,private:false,created_at:'2024-01-01T00:00:00Z'};
  return new Response(JSON.stringify(body),{status:200});
};
const result=await runSync({...parseArguments([]),discover:false,translate:true,limit:1,budget:100,translateLimit:0,${expired ? 'deadlineAt:Date.now()-1' : ''}});
console.log(JSON.stringify({result,calls}));
`);
  const child = spawnSync(process.execPath, ['runner.mjs'], { cwd: root, env: { ...process.env, GITHUB_TOKEN: 'test-only-token' }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  return { root, old, ...result };
}

test('真实采集入口准确返回历史与元数据总请求数供共享预算扣减', t => {
  const actual = fixture(t, false);
  assert.equal(actual.calls, 2);
  assert.equal(actual.result.requests, 2);
  assert.equal(actual.result.exitCode, 0);
  const saved = JSON.parse(readFileSync(join(actual.root, 'src/data/github-snapshot.json'), 'utf8'));
  assert.equal(saved.projects[0].stars, 12);
});

test('整轮截止后真实采集入口不请求网络、不伪造成功采样时刻', t => {
  const actual = fixture(t, true);
  assert.equal(actual.calls, 0);
  assert.equal(actual.result.requests, 0);
  assert.equal(actual.result.exitCode, 1);
  const saved = JSON.parse(readFileSync(join(actual.root, 'src/data/github-snapshot.json'), 'utf8'));
  assert.equal(saved.fetchedAt, actual.old);
  assert.equal(saved.projects[0].stars, 10);
});
