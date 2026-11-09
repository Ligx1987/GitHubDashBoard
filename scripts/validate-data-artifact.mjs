// 发布失败批次的成功进度之前，验证三个文件均可被下一轮采集读取。
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStarWeeks } from '../src/data/star-activity.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));

export async function validateDataArtifact(directory) {
  const read = async file => {
    try { return JSON.parse(await readFile(join(directory, file), 'utf8')); }
    catch { throw new Error(`${file} 缺失或不是有效 JSON`); }
  };
  const [snapshot, history, activity] = await Promise.all([
    read('github-snapshot.json'), read('star-history.json'), read('star-activity.json'),
  ]);
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.projects)) throw new Error('仓库快照结构无效');
  for (const project of snapshot.projects) {
    if (!object(project) || !name(project.fullName) || !['available', 'unavailable', 'unverified'].includes(project.availability)
      || (project.availability === 'available' && !timestamp(project.fetchedAt))
      || project.private === true || ['private', 'internal'].includes(project.visibility)
      || ['stars', 'forks', 'openIssues', 'contributors'].some(field => project[field] != null && !count(project[field]))) {
      throw new Error('仓库快照含无效或非公开记录');
    }
  }
  if (snapshot.discoveryQueue !== undefined && (!Array.isArray(snapshot.discoveryQueue)
    || snapshot.discoveryQueue.some(p => !object(p) || !name(p.fullName)
      || (p.createdAt != null && !timestamp(p.createdAt))))) throw new Error('待入池候选队列无效');
  if (!object(history)) throw new Error('本地净增历史结构无效');
  for (const [fullName, samples] of Object.entries(history)) {
    if (!name(fullName) || !object(samples) || Object.entries(samples).some(([date, value]) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !count(value))) {
      throw new Error('本地净增历史含无效样本');
    }
  }
  if (activity?.schemaVersion !== 1 || !object(activity.repositories)) throw new Error('官方历史结构无效');
  for (const [fullName, record] of Object.entries(activity.repositories)) {
    if (!name(fullName) || record?.source !== 'github-star-history' || !timestamp(record.fetchedAt)) throw new Error('官方历史缺少可追溯来源');
    validateStarWeeks(record.weeks);
  }
  return { repositories: snapshot.projects.length, histories: Object.keys(activity.repositories).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateDataArtifact(resolve(process.argv[2] || 'src/data'));
    console.log(`数据产物校验通过：${result.repositories} 个仓库，${result.histories} 份官方历史。`);
  } catch (error) {
    console.error(`数据产物校验失败：${error.message}`);
    process.exitCode = 1;
  }
}
