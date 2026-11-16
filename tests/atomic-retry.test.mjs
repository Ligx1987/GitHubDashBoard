import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteJson } from '../scripts/sync-github-data.mjs';

test('Windows短暂占用快照时重试原子替换，期间保留上一份完整文件', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pulse-atomic-retry-'));
  const file = join(root, 'snapshot.json'); fs.writeFileSync(file, '{"version":1}');
  const rename = fs.renameSync; let attempts = 0;
  fs.renameSync = (from, to) => {
    attempts++;
    if (attempts <= 2) {
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
      throw Object.assign(new Error('Windows sharing violation'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    atomicWriteJson(file, { version: 2 });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  } finally {
    fs.renameSync = rename; syncBuiltinESMExports(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('永久写入错误立即失败，保留旧文件并清理自身临时文件', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pulse-atomic-failure-'));
  const file = join(root, 'snapshot.json'); fs.writeFileSync(file, '{"version":1}');
  const rename = fs.renameSync; let attempts = 0;
  fs.renameSync = () => { attempts++; throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => atomicWriteJson(file, { version: 2 }), { code: 'EIO' });
    assert.equal(attempts, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
    assert.deepEqual(fs.readdirSync(root), ['snapshot.json']);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
});
