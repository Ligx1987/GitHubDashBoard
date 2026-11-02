import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateDataArtifact } from '../scripts/validate-data-artifact.mjs';

const workflow = readFileSync(new URL('../.github/workflows/sync-data.yml', import.meta.url), 'utf8');
const step = name => workflow.split(`- name: ${name}`)[1]?.split(/\r?\n      - /)[0] || '';
// 与 upload-artifact 的共同目录规则一致：包内根目录直接包含三个 JSON。
const artifact = 'UEsDBBQAAAAIAG2GXF2w2EzzhwAAAJ8AAAAUAAAAZ2l0aHViLXNuYXBzaG90Lmpzb24tjLEKwjAQQH/luDnFa0Qp2RxdnMRBcUjTq4mktiRXUUr/XQKOD957C2bnebAXTjmMLzRQK8ApjU92ktHAbcF+jvFkB0YD2IePzIk3iacRFeAjiJ/bY1dCvVWA9m1DtG2IQb4l+HPkYmexqUx3CrBncZ67gxRLk95XNVW6OVNjiAzRFdf7+gNQSwMEFAAAAAgAbYZcXVdx+sUlAAAAIwAAABEAAABzdGFyLWhpc3RvcnkuanNvbqtWSsusKCktStUvSi3IV7JSqFYyMjAy0zU00DUyV7JSMKmtBQBQSwMEFAAAAAgAbYZcXY0s3DapAAAA5AAAABIAAABzdGFyLWFjdGl2aXR5Lmpzb25Vjs0KwjAQhF9l2XOK2yJtzc13EA9KD7FdbfAnJdmgpeTdJfUkzGGZ+diZBUM/8tMc2QfrXqihVICeJxesOG85oIYFr/Yj0fMmB6sRXPQ9owa8WRnjpQhifDHaIM7PqACvLP3Iw14yU1FVFyUVVXugVhNpolOG3sz3XHBe1jO3N7uqbestkQIUJ+aBGhoFOJh5JUuVF/6pS11KCjCIkfjbG6fBCA/5YUpfUEsBAhQAFAAAAAgAbYZcXbDYTPOHAAAAnwAAABQAAAAAAAAAAAAAAIABAAAAAGdpdGh1Yi1zbmFwc2hvdC5qc29uUEsBAhQAFAAAAAgAbYZcXVdx+sUlAAAAIwAAABEAAAAAAAAAAAAAAIABuQAAAHN0YXItaGlzdG9yeS5qc29uUEsBAhQAFAAAAAgAbYZcXY0s3DapAAAA5AAAABIAAAAAAAAAAAAAAIABDQEAAHN0YXItYWN0aXZpdHkuanNvblBLBQYAAAAAAwADAMEAAADmAQAAAAA=';
const unzip = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/unzip.exe' : 'unzip';
const canUnzip = process.platform !== 'win32' || existsSync(unzip);
const temp = t => {
  const folder = mkdtempSync(join(tmpdir(), 'github-pulse-artifact-'));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
};
const condition = (name, context) => {
  const expression = step(name).match(/if:\s*(.+)/)?.[1]?.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  assert.ok(expression, `${name} 必须有显式发布条件`);
  return Function('steps', 'cancelled', 'success', `return (${expression});`)(context.steps, () => !!context.cancelled, () => context.steps.collect.outcome === 'success');
};

test('CI restores root-level artifact files to the collector data directory', { skip: !canUnzip }, t => {
  const folder = temp(t);
  writeFileSync(join(folder, 'data.zip'), Buffer.from(artifact, 'base64'));
  const directory = step('Restore data from the latest artifact').match(/mkdir\s+-p\s+(\S+)/)?.[1];
  assert.ok(directory);
  mkdirSync(join(folder, directory), { recursive: true });
  const command = step('Restore data from the latest artifact').match(/unzip\s+-o\s+data\.zip\s+-d\s+(\S+)/);
  assert.ok(command, '恢复步骤必须有可验证的解压目标');
  const result = spawnSync(unzip, ['-o', 'data.zip', '-d', command[1]], { cwd: folder, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const snapshotPath = join(folder, 'src/data/github-snapshot.json');
  assert.ok(existsSync(snapshotPath), '恢复后采集器必须能读取 src/data/github-snapshot.json');
  assert.equal(JSON.parse(readFileSync(snapshotPath, 'utf8')).projects[0].fullName, 'fixture/repo');
  assert.equal(JSON.parse(readFileSync(join(folder, 'src/data/star-history.json'), 'utf8'))['fixture/repo']['2026-10-27'], 4);
});

test('CI publishes validated checkpoints after collection failure while retaining the failed job', () => {
  const steps = { collect: { outcome: 'failure' }, validate: { outputs: { valid: 'true' } } };
  assert.equal(condition('Publish data as the latest artifact', { steps }), true);
  assert.equal(condition('Publish data as the latest artifact', { steps, cancelled: true }), false);
  steps.validate.outputs.valid = '';
  assert.equal(condition('Publish data as the latest artifact', { steps }), false);
  assert.doesNotMatch(step('Collect a bounded batch and discover new repositories'), /continue-on-error:\s*true/);
  assert.equal(condition('Validate recoverable data', { steps }), true);
  steps.collect.outcome = 'skipped';
  assert.equal(condition('Validate recoverable data', { steps }), false);
});

test('artifact validation keeps a partial checkpoint and rejects missing or corrupted files', async t => {
  const folder = temp(t);
  const files = {
    'github-snapshot.json': { schemaVersion: 1, projects: [{ fullName: 'fixture/repo', availability: 'unavailable', fetchedAt: '2026-10-27T08:00:00Z', stars: 10, nextRetryAt: '2026-11-04T08:00:00Z' }], sync: { result: 'failed' } },
    'star-history.json': { 'fixture/repo': { '2026-10-27': 10 } },
    'star-activity.json': { schemaVersion: 1, repositories: { 'fixture/repo': { source: 'github-star-history', fetchedAt: '2026-10-28T08:00:00Z', weeks: [{ week: 1792886400, total: 7, days: [1, 1, 1, 1, 1, 1, 1] }] } }, status: { updated: 1 } },
  };
  for (const [file, value] of Object.entries(files)) writeFileSync(join(folder, file), JSON.stringify(value));
  assert.deepEqual(await validateDataArtifact(folder), { repositories: 1, histories: 1 });
  writeFileSync(join(folder, 'star-activity.json'), '{');
  await assert.rejects(validateDataArtifact(folder), /star-activity.json/);
  writeFileSync(join(folder, 'star-activity.json'), JSON.stringify(files['star-activity.json']));
  files['star-activity.json'].repositories['fixture/repo'].weeks[0].total = 99;
  writeFileSync(join(folder, 'star-activity.json'), JSON.stringify(files['star-activity.json']));
  await assert.rejects(validateDataArtifact(folder), /历史周记录无效/);
  unlinkSync(join(folder, 'github-snapshot.json'));
  await assert.rejects(validateDataArtifact(folder), /github-snapshot.json/);
});
