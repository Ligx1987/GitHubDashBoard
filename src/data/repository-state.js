import { chooseStarActivityRecord, mergeStarActivity } from './star-activity.js';

const NAME = /^[\w.-]+\/[\w.-]+$/;
const validId = value => Number.isSafeInteger(value) && value > 0;
const observedAt = row => Date.parse(row.availability === 'unavailable' ? row.lastAttemptAt || row.fetchedAt : row.fetchedAt) || 0;
const namesOf = row => [row.fullName, ...(Array.isArray(row.repositoryAliases) ? row.repositoryAliases : [])]
  .filter(name => typeof name === 'string' && NAME.test(name));
const defined = row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));

// 身份优先使用 GitHub 的稳定 ID；只有身份不冲突时才允许按全名回退。
function repositoryGroups(rows) {
  const validRows = rows.filter(row => row && NAME.test(row.fullName || ''));
  const exclusionsById = new Map();
  const latestById = new Map();
  for (const row of validRows) {
    if (!validId(row.githubId)) continue;
    if (!exclusionsById.has(row.githubId)) exclusionsById.set(row.githubId, new Set());
    for (const name of Array.isArray(row.repositoryAliasExclusions) ? row.repositoryAliasExclusions : []) {
      if (typeof name === 'string' && NAME.test(name)) exclusionsById.get(row.githubId).add(name.toLowerCase());
    }
    const latest = latestById.get(row.githubId);
    if (!latest || observedAt(row) >= observedAt(latest)) latestById.set(row.githubId, row);
  }
  const effectiveNames = row => namesOf(row).filter(name =>
    !exclusionsById.get(row.githubId)?.has(name.toLowerCase()) ||
    name.toLowerCase() === latestById.get(row.githubId)?.fullName.toLowerCase());
  const idsByName = new Map();
  for (const row of validRows) {
    if (!validId(row.githubId)) continue;
    for (const name of effectiveNames(row)) {
      const key = name.toLowerCase();
      if (!idsByName.has(key)) idsByName.set(key, new Set());
      idsByName.get(key).add(row.githubId);
    }
  }
  const groups = new Map();
  for (const row of validRows) {
    const name = row.fullName.toLowerCase();
    const ids = idsByName.get(name);
    // 同名曾属于不同 ID 时，无 ID 的观察无法证明属于哪一个，不能覆盖已知身份。
    if (!validId(row.githubId) && ids?.size > 1) continue;
    const id = validId(row.githubId) ? row.githubId : ids?.size === 1 ? [...ids][0] : null;
    const key = id === null ? `name:${name}` : `id:${id}`;
    if (!groups.has(key)) groups.set(key, { key, id, rows: [], names: new Set() });
    const group = groups.get(key);
    group.rows.push(row);
    for (const alias of effectiveNames(row)) group.names.add(alias);
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => observedAt(a) - observedAt(b));
    let merged = {};
    for (const row of group.rows) {
      const changed = typeof row.description === 'string' && typeof merged.description === 'string' && row.description !== merged.description;
      const next = { ...merged, ...defined(row) };
      if (changed) {
        next.descriptionZh = row.descriptionZh || null;
        next.descriptionZhAt = row.descriptionZh ? row.descriptionZhAt || null : null;
        next.descriptionZhProvider = row.descriptionZh ? row.descriptionZhProvider || null : null;
      } else if (!row.descriptionZh && merged.descriptionZh) {
        for (const field of ['descriptionZh', 'descriptionZhAt', 'descriptionZhProvider']) next[field] = merged[field];
      }
      if (merged.categoryOverride && !row.categoryOverride) next.categoryOverride = merged.categoryOverride;
      merged = next;
    }
    merged.githubId = group.id;
    merged.id = merged.fullName;
    merged.repositoryAliases = [...new Map([...group.names]
      .filter(name => name.toLowerCase() !== merged.fullName.toLowerCase())
      .map(name => [name.toLowerCase(), name])).values()];
    merged.repositoryAliasExclusions = [...(exclusionsById.get(group.id) || [])];
    group.project = merged;
  }
  // 名称被另一个 ID 重新使用时，仅展示该名称的最新已知所有者，不混入旧身份字段。
  const currentByName = new Map();
  for (const group of groups.values()) {
    const name = group.project.fullName.toLowerCase();
    const previous = currentByName.get(name);
    if (!previous || observedAt(group.project) >= observedAt(previous.project)) currentByName.set(name, group);
  }
  return { groups: [...currentByName.values()], allGroups: [...groups.values()], idsByName };
}

export function mergeRepositoryRows(before = [], next = []) {
  // 不同有效 ID 即使同名也不能在这里丢掉冲突证据；reconcile 会隔离旧历史并选当前所有者。
  return repositoryGroups([...before, ...next]).allGroups.map(group => group.project);
}

// 两类历史仍保留原有的观测值与采样时刻；这里只迁移有证据的身份别名。
export function reconcileRepositoryState(projects, {
  history = {}, starActivity = { schemaVersion: 1, repositories: {}, status: {} }, now = Date.now(),
} = {}) {
  const { groups, idsByName } = repositoryGroups(projects);
  const nextHistory = structuredClone(history);
  const nextActivity = structuredClone(starActivity);
  nextActivity.repositories ||= {};
  nextActivity.status ||= {};
  const destinations = new Map();
  const rowsByName = new Map();
  for (const group of groups) {
    for (const name of group.names) destinations.set(name.toLowerCase(), group);
    for (const row of group.rows) rowsByName.set(row.fullName.toLowerCase(), row);
  }
  const migrate = (entries, combine) => {
    const result = {};
    const sorted = Object.entries(entries || {}).sort(([a], [b]) =>
      observedAt(rowsByName.get(a.toLowerCase()) || {}) - observedAt(rowsByName.get(b.toLowerCase()) || {}));
    for (const [name, value] of sorted) {
      const key = name.toLowerCase();
      // 旧数据只有名称键、没有仓库 ID；名称冲突时不能把旧仓库历史送给新仓库。
      if (idsByName.get(key)?.size > 1) continue;
      const group = destinations.get(key);
      const destination = group?.project.fullName || name;
      const combined = combine(result[destination], value, group?.project);
      if (combined !== undefined) result[destination] = combined;
    }
    return result;
  };
  const migratedHistory = migrate(nextHistory, (previous, next) => ({ ...previous, ...next }));
  nextActivity.repositories = migrate(nextActivity.repositories, (previous, next, project) => {
    const matches = record => record && (!validId(record.githubId) || !validId(project?.githubId) || record.githubId === project.githubId);
    const oldRecord = matches(previous) ? previous : undefined;
    const newRecord = matches(next) ? next : undefined;
    return chooseStarActivityRecord(oldRecord, newRecord, { now, createdAt: project?.createdAt, githubId: project?.githubId }) || oldRecord || newRecord;
  });
  if (nextActivity.status.historyUnavailable) {
    nextActivity.status.historyUnavailable = migrate(nextActivity.status.historyUnavailable,
      (previous, next) => Date.parse(previous) > Date.parse(next) ? previous : next);
  }
  if (nextActivity.status.historyAttempts) {
    nextActivity.status.historyAttempts = migrate(nextActivity.status.historyAttempts,
      (previous, next) => Date.parse(previous?.at) > Date.parse(next?.at) ? previous : next);
  }
  const reconciledProjects = groups.map(group => {
    const conflictedAliases = group.project.repositoryAliases.filter(name => (idsByName.get(name.toLowerCase())?.size || 0) > 1);
    return { ...group.project,
      repositoryAliases: group.project.repositoryAliases.filter(name => !conflictedAliases.includes(name)),
      repositoryAliasExclusions: [...new Set([...group.project.repositoryAliasExclusions, ...conflictedAliases.map(name => name.toLowerCase())])],
    };
  });
  return { projects: reconciledProjects, history: migratedHistory, starActivity: nextActivity };
}

// 先保留每份来源的仓库身份，再合并它的名称键历史，防止旧磁盘同名数据污染新 ID。
export function mergeRepositoryStates(before = {}, next = {}, { now = Date.now() } = {}) {
  const rows = mergeRepositoryRows(before.projects || [], next.projects || []);
  const combinedGroups = repositoryGroups(rows);
  const projects = reconcileRepositoryState(rows, { now }).projects;
  const targets = repositoryGroups(projects).groups;
  const byId = new Map(targets.filter(group => group.id !== null).map(group => [group.id, group]));
  const byName = new Map(targets.flatMap(group => [...group.names].map(name => [name.toLowerCase(), group])));
  const daily = [];
  let starActivity = { schemaVersion: 1, repositories: {}, status: {} };
  for (const source of [before, next]) {
    const sourceState = repositoryGroups(source.projects || []);
    const sourceNames = new Map(sourceState.groups.flatMap(group => [...group.names].map(name => [name.toLowerCase(), group])));
    const destinationFor = (name, recordId = null) => {
      const key = name.toLowerCase();
      const sourceGroup = sourceNames.get(key);
      // 官方记录已经携带 ID 时，它比当前名称映射更可靠。
      if (validId(recordId)) return { target: byId.get(recordId), sourceGroup };
      if ((sourceState.idsByName.get(key)?.size || 0) > 1) return {};
      if (sourceGroup?.id !== null && sourceGroup?.id !== undefined) return { target: byId.get(sourceGroup.id), sourceGroup };
      if (!sourceGroup || (combinedGroups.idsByName.get(key)?.size || 0) > 1) return {};
      return { target: byName.get(key), sourceGroup };
    };
    for (const [name, values] of Object.entries(source.history || {})) {
      const { target, sourceGroup } = destinationFor(name);
      if (target) daily.push({ name: target.project.fullName, values, sampledAt: Date.parse(sourceGroup?.project.fetchedAt) || 0 });
    }
    const mappedActivity = { ...source.starActivity, schemaVersion: 1, repositories: {}, status: { ...source.starActivity?.status } };
    for (const [name, record] of Object.entries(source.starActivity?.repositories || {})) {
      const { target } = destinationFor(name, record.githubId);
      if (!target) continue;
      const bound = target.id === null ? record : { ...record, githubId: target.id };
      const current = mappedActivity.repositories[target.project.fullName];
      const chosen = chooseStarActivityRecord(current, bound, { now, createdAt: target.project.createdAt, githubId: target.id });
      if (chosen) mappedActivity.repositories[target.project.fullName] = chosen;
    }
    for (const field of ['historyUnavailable', 'historyAttempts']) {
      if (!source.starActivity?.status?.[field]) continue;
      mappedActivity.status[field] = {};
      for (const [name, value] of Object.entries(source.starActivity.status[field])) {
        const { target } = destinationFor(name, value?.githubId);
        if (!target) continue;
        const current = mappedActivity.status[field][target.project.fullName];
        if (!current || Date.parse(field === 'historyAttempts' ? value.at : value) >= Date.parse(field === 'historyAttempts' ? current.at : current)) {
          mappedActivity.status[field][target.project.fullName] = value;
        }
      }
    }
    starActivity = mergeStarActivity(starActivity, mappedActivity, { now });
  }
  const history = {};
  for (const item of daily.sort((a, b) => a.sampledAt - b.sampledAt)) history[item.name] = { ...history[item.name], ...item.values };
  return reconcileRepositoryState(projects, { history, starActivity, now });
}
