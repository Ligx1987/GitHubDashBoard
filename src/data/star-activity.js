// GitHub's daily star creations, separate from net changes in total stars.
// https://docs.github.com/en/rest/activity/starring#get-repository-star-history
const DAY = 86400000;
const NAME = /^[\w.-]+\/[\w.-]+$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => Number.isSafeInteger(value) && value > 0;
// 低星工程轮转更新；缓存保留实际完整日截止时间，不推进未采到的日期。
const LOW_STAR_STARS = 1000;
const LOW_STAR_RECORD_MAX_AGE_MS = 36 * 3600000;
const HISTORY_RETRY_MS = 3600000;
export const emptyStarActivity = () => ({ schemaVersion: 1, repositories: {}, status: {} });

export function validateStarWeeks(payload) {
  if (!Array.isArray(payload) || !payload.length || payload.length > 30) throw new Error('GitHub 历史数据为空或格式无效');
  const seen = new Set();
  const weeks = payload.map(row => {
    if (!row || !Number.isSafeInteger(row.week) || row.week <= 0 || !Number.isFinite(new Date(row.week * 1000).getTime()) ||
        !count(row.total) || !Array.isArray(row.days) || row.days.length !== 7 || !row.days.every(count) ||
        row.days.reduce((a, b) => a + b, 0) !== row.total || seen.has(row.week)) throw new Error('GitHub 历史周记录无效');
    seen.add(row.week);
    return { week: row.week, total: row.total, days: [...row.days] };
  }).sort((a, b) => b.week - a.week);
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i - 1].week - weeks[i].week < 6 * 86400) throw new Error('GitHub 历史统计周重叠');
  }
  return weeks;
}

export function summarizeStarActivity(record, { now = Date.now(), createdAt = null } = {}) {
  const unknown = { threeDayAdded: null, weekAdded: null, prevWeekAdded: null, monthAdded: null, addedDays: [], activityWindowEnd: null, activityFetchedAt: record?.fetchedAt || null };
  const fetched = Date.parse(record?.fetchedAt);
  if (record?.source !== 'github-star-history' || !Number.isFinite(fetched) || fetched > now) return unknown;
  let weeks;
  try { weeks = validateStarWeeks(record.weeks); } catch { return unknown; }
  const anchor = weeks[0].week * 1000;
  if (anchor > fetched) return unknown;
  // 周日接口可能仍以刚结束的一周开头；不要求存在尚无数据的新周。
  // 同时只使用采样时已结束的统计日，排除缓存中未结束日的占位零或部分计数。
  const end = Math.min(anchor + 7 * DAY, anchor + Math.floor((Math.min(now, fetched) - anchor) / DAY) * DAY);
  if (now - end >= 7 * DAY) return unknown;
  const values = new Map();
  for (const week of weeks) week.days.forEach((value, i) => values.set(week.week * 1000 + i * DAY, value));
  const created = Date.parse(createdAt);
  const days = Array.from({ length: 30 }, (_, i) => {
    const start = end - (30 - i) * DAY;
    // A repository cannot receive stars before it exists. Its creation day
    // still needs an actual response; gaps after creation remain unknown.
    const value = values.has(start) ? values.get(start) : Number.isFinite(created) && start + DAY <= created ? 0 : null;
    return { start, date: new Date(start).toISOString().slice(0, 10), value };
  });
  const sum = length => days.slice(-length).every(d => count(d.value)) ? days.slice(-length).reduce((n, d) => n + d.value, 0) : null;
  // The 7 complete days before the current week window; acceleration needs it.
  const previous = days.slice(-14, -7);
  const prevWeekAdded = previous.length === 7 && previous.every(d => count(d.value)) ? previous.reduce((n, d) => n + d.value, 0) : null;
  return { threeDayAdded: sum(3), weekAdded: sum(7), prevWeekAdded, monthAdded: sum(30), addedDays: days.slice(-7),
    activityWindowEnd: new Date(end).toISOString(), activityFetchedAt: record.fetchedAt };
}

export function buildAddedTrend(projects) {
  const eligible = projects.filter(p => p.weekAdded !== null && p.activityWindowEnd && p.addedDays?.length === 7);
  const end = eligible.map(p => p.activityWindowEnd).sort().at(-1);
  const comparable = eligible.filter(p => p.activityWindowEnd === end);
  if (!comparable.length) return { dates: [], values: Array(7).fill(null), coverage: Array(7).fill(0) };
  return { dates: comparable[0].addedDays.map(d => d.date),
    values: Array.from({ length: 7 }, (_, i) => comparable.reduce((n, p) => n + p.addedDays[i].value, 0)),
    coverage: Array(7).fill(comparable.length) };
}

// 保留原始观测，不混合不同采样时刻的周记录。尚有效的完整窗口不能被
// 较新的缺周响应抹掉；旧缓存过期后，允许真实的新部分历史恢复已有覆盖。
export function chooseStarActivityRecord(previous, candidate, { now = Date.now(), createdAt = null, githubId = null } = {}) {
  const conflicts = record => validId(githubId) && validId(record?.githubId) && record.githubId !== githubId;
  if (conflicts(previous)) previous = undefined;
  if (conflicts(candidate)) candidate = undefined;
  const valid = record => {
    const fetched = Date.parse(record?.fetchedAt);
    if (record?.source !== 'github-star-history' || !Number.isFinite(fetched) || fetched > now) return false;
    try { return validateStarWeeks(record.weeks)[0].week * 1000 <= fetched; } catch { return false; }
  };
  if (!valid(candidate)) return previous;
  if (!valid(previous)) return candidate;
  // 同名可被另一个仓库复用；旧身份的完整历史不能压过当前身份的部分历史。
  if (validId(previous.githubId) && validId(candidate.githubId) && previous.githubId !== candidate.githubId) return candidate;
  const oldSummary = summarizeStarActivity(previous, { now, createdAt });
  const newSummary = summarizeStarActivity(candidate, { now, createdAt });
  const fields = ['threeDayAdded', 'weekAdded', 'prevWeekAdded', 'monthAdded'];
  if (fields.some(field => count(oldSummary[field]) && !count(newSummary[field]))) return previous;
  if (fields.some(field => count(newSummary[field]) && !count(oldSummary[field]))) return candidate;
  const oldEnd = Date.parse(oldSummary.activityWindowEnd) || 0;
  const newEnd = Date.parse(newSummary.activityWindowEnd) || 0;
  if (oldEnd !== newEnd) return newEnd > oldEnd ? candidate : previous;
  return Date.parse(candidate.fetchedAt) >= Date.parse(previous.fetchedAt) ? candidate : previous;
}

export function mergeStarActivity(before = emptyStarActivity(), next = emptyStarActivity(), options = {}) {
  const repositories = { ...before.repositories };
  let retainedComplete = 0;
  for (const [name, record] of Object.entries(next.repositories || {})) {
    const previous = repositories[name];
    const chosen = chooseStarActivityRecord(previous, record, options);
    if (chosen === previous && record !== previous && Date.parse(record.fetchedAt) > Date.parse(previous?.fetchedAt)) retainedComplete++;
    if (chosen) repositories[name] = chosen;
    else delete repositories[name];
  }
  const latestStatus = Date.parse(next.status?.attemptedAt) >= Date.parse(before.status?.attemptedAt || 0) ? next.status : before.status;
  const status = { ...latestStatus };
  const historyAttempts = { ...before.status?.historyAttempts };
  for (const [name, attempt] of Object.entries(next.status?.historyAttempts || {})) {
    if (!historyAttempts[name] || Date.parse(attempt.at) >= Date.parse(historyAttempts[name].at)) historyAttempts[name] = attempt;
  }
  const historyUnavailable = { ...before.status?.historyUnavailable };
  for (const [name, until] of Object.entries(next.status?.historyUnavailable || {})) {
    if (!historyUnavailable[name] || Date.parse(until) > Date.parse(historyUnavailable[name])) historyUnavailable[name] = until;
  }
  for (const [name, until] of Object.entries(historyUnavailable)) {
    // 后续成功观测已经证明恢复可用，旧缓存不能重新加回七天冷却。
    if (Date.parse(repositories[name]?.fetchedAt) > Date.parse(until) - 7 * DAY) delete historyUnavailable[name];
  }
  status.historyAttempts = historyAttempts;
  status.historyUnavailable = historyUnavailable;
  status.queueTurns = { ...latestStatus?.queueTurns };
  for (const lane of ['recent', 'established']) {
    status.queueTurns[lane] = Math.max(before.status?.queueTurns?.[lane] || 0, next.status?.queueTurns?.[lane] || 0);
  }
  if (retainedComplete) {
    status.message = `较新历史缓存覆盖不足；合并时保留 ${retainedComplete} 个仍有效的完整历史缓存`;
    status.retainedComplete = retainedComplete;
  }
  return { schemaVersion: 1, repositories, status };
}

export async function refreshStarActivity(projects, cache = emptyStarActivity(), {
  token = '', signal, fetchImpl = fetch, now = () => Date.now(), limit = 40, ttlMs = 2 * 3600000,
  force = false, onProgress, maxRuntimeMs = 90000,
} = {}) {
  const start = now();
  const result = { schemaVersion: 1, repositories: { ...cache.repositories }, status: { ...cache.status } };
  // Repositories whose history endpoint answered 404 cool down for seven days;
  // otherwise a handful of dead names would head the queue and abort every
  // batch via the consecutive-failure cap, starving all live repositories.
  const historyUnavailable = { ...(cache.status?.historyUnavailable || {}) };
  const historyAttempts = { ...(cache.status?.historyAttempts || {}) };
  const queueTurns = { recent: 0, established: 0, nextLane: 'recent', ...cache.status?.queueTurns };
  for (const lane of ['recent', 'established']) {
    if (!Number.isSafeInteger(queueTurns[lane]) || queueTurns[lane] < 0) queueTurns[lane] = 0;
  }
  const recoveringWithToken = !!token && !cache.status?.authenticated;
  result.status = { ...result.status, historyUnavailable, historyAttempts, queueTurns };
  for (const project of projects) {
    if (!validId(project.githubId)) continue;
    const recordId = result.repositories[project.fullName]?.githubId;
    const attemptId = historyAttempts[project.fullName]?.githubId;
    const changedRecord = validId(recordId) && recordId !== project.githubId;
    const changedAttempt = validId(attemptId) && attemptId !== project.githubId;
    if (changedRecord) delete result.repositories[project.fullName];
    if (changedRecord || changedAttempt) {
      delete historyUnavailable[project.fullName];
      delete historyAttempts[project.fullName];
    }
  }
  // 身份隔离先于限额检查，避免无法请求时继续展示另一仓库的缓存。
  // A newly supplied token may recover from an unauthenticated quota block.
  if (!force && Date.parse(cache.status?.retryAfter) > start && (!token || cache.status?.authenticated)) return result;
  const pool = projects.filter(p => NAME.test(p.fullName || '') && p.availability === 'available')
    .filter(p => !(Date.parse(historyUnavailable[p.fullName]) > start))
    .filter(p => force || recoveringWithToken || !(Date.parse(historyAttempts[p.fullName]?.retryAfter) > start))
    .filter(p => { const previous = result.repositories[p.fullName]; return !previous || start - Date.parse(previous.fetchedAt) >= ttlMs || summarizeStarActivity(previous, { now: start, createdAt: p.createdAt }).monthAdded === null; });
  const recent = p => Number(Date.parse(p.createdAt) >= start - 31 * DAY && Date.parse(p.createdAt) <= start);
  // Repositories that were already hot keep priority so surge rankings and
  // acceleration badges never go stale behind the long tail.
  const hot = p => {
    const cached = result.repositories[p.fullName];
    if (!cached) return 0;
    const added = summarizeStarActivity(cached, { now: start, createdAt: p.createdAt }).weekAdded;
    return Number(added !== null && added >= 100);
  };
  const demoted = p => {
    if (!Number.isFinite(p.stars) || p.stars >= LOW_STAR_STARS) return false;
    const fetched = Date.parse(result.repositories[p.fullName]?.fetchedAt);
    return Number.isFinite(fetched) && start - fetched < LOW_STAR_RECORD_MAX_AGE_MS;
  };
  const lastServed = p => Math.max(Date.parse(result.repositories[p.fullName]?.fetchedAt) || 0, Date.parse(historyAttempts[p.fullName]?.at) || 0);
  const byOldest = (a, b) => lastServed(a) - lastServed(b) || (b.stars || 0) - (a.stars || 0) || a.fullName.localeCompare(b.fullName);
  const byPriority = (a, b) => hot(b) - hot(a) || Number(demoted(a)) - Number(demoted(b)) || byOldest(a, b);
  // New repositories and established ones refresh in separate lanes, merged
  // 1:1: new-project boards need fresh cohorts, but the surge board also needs
  // established breakouts — a new-first queue spent the whole daily allowance
  // on young repositories and emptied the surge board of anything >31 days.
  // 三日新建榜需要自己的覆盖，不能一直排在月内已有历史的热门工程之后。
  const threeDayCandidate = p => Number(Date.parse(p.createdAt) >= start - 3 * DAY && Date.parse(p.createdAt) < Math.floor(start / DAY) * DAY);
  const recentLane = pool.filter(recent).sort((a, b) => threeDayCandidate(b) - threeDayCandidate(a) || byPriority(a, b));
  const establishedLane = pool.filter(p => !recent(p)).sort(byPriority);
  const lanes = { recent: recentLane, established: establishedLane };
  const schedule = [];
  const remaining = { recent: recentLane.length, established: establishedLane.length };
  const batchLimit = Math.min(pool.length, Math.max(0, Math.floor(limit)));
  let nextLane = queueTurns.nextLane === 'established' ? 'established' : 'recent';
  while (schedule.length < batchLimit) {
    const lane = remaining[nextLane] ? nextLane : nextLane === 'recent' ? 'established' : 'recent';
    schedule.push(lane); remaining[lane]--;
    nextLane = lane === 'recent' ? 'established' : 'recent';
  }
  const selected = {};
  for (const lane of ['recent', 'established']) {
    const capacity = schedule.filter(value => value === lane).length;
    const priority = lanes[lane];
    const missing = priority.filter(p => !result.repositories[p.fullName]).sort(byOldest);
    const oldest = priority.filter(p => result.repositories[p.fullName]).sort(byOldest);
    const chosen = new Set();
    const indices = new Map();
    const take = list => {
      let index = indices.get(list) || 0;
      while (chosen.has(list[index]?.fullName)) index++;
      indices.set(list, index + 1);
      return list[index];
    };
    const turn = Number.isSafeInteger(queueTurns[lane]) ? queueTurns[lane] : 0;
    selected[lane] = [];
    for (let i = 0; i < capacity; i++) {
      // 每通道约三分之一请求用于最久未服务的工程。两次请求至少保底一次；
      // 单请求批次延续游标，三批内也有一次保底，不会一直只刷新热门工程。
      const fair = (turn + i) % 3 === 2 || (capacity === 2 && turn % 3 === 0 && i === 1);
      // 保底在缺失与最旧已有历史之间轮转，持续发现新工程也不会压住过期历史。
      const fillMissing = (Math.floor((turn + i) / 3) + Number(lane === 'established')) % 2 === 0;
      const project = fair ? take(fillMissing ? missing : oldest) || take(fillMissing ? oldest : missing) : take(priority);
      chosen.add(project.fullName); selected[lane].push(project);
    }
  }
  const queue = [];
  const laneIndices = { recent: 0, established: 0 };
  for (const lane of schedule) queue.push({ lane, project: selected[lane][laneIndices[lane]++] });
  if (!queue.length) return result;
  let updated = 0, requests = 0, failures = 0, message = '', retryAfter = null;
  let rateLimit = cache.status?.authenticated === !!token ? cache.status?.rateLimit || null : null;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const { lane, project } of queue) {
    if (signal?.aborted || now() - start >= maxRuntimeMs) { message ||= '历史请求超时或已取消；保留最近成功缓存'; break; }
    requests++;
    queueTurns[lane]++;
    queueTurns.nextLane = lane === 'recent' ? 'established' : 'recent';
    const identity = validId(project.githubId) ? { githubId: project.githubId } : {};
    historyAttempts[project.fullName] = { ...identity, at: new Date(now()).toISOString(), retryAfter: null };
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${project.fullName}/stargazers/history?per_page=6&page=1`,
        { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      const rateRemaining = response.headers.get('x-ratelimit-remaining');
      const rateReset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      if (rateRemaining !== null && Number.isSafeInteger(Number(rateRemaining))) {
        rateLimit = { remaining: Number(rateRemaining), resetAt: rateReset > 0 ? new Date(rateReset).toISOString() : null,
          resource: response.headers.get('x-ratelimit-resource') || 'core', observedAt: new Date(now()).toISOString() };
      }
      if (!response.ok) {
        if (response.status === 404) {
          // Permanent state, not a transient failure: cool the name down for
          // seven days and keep serving the rest of the queue.
          historyUnavailable[project.fullName] = new Date(start + 7 * DAY).toISOString();
          message ||= `${project.fullName} 的历史接口返回 404，已暂停七天；其余工程继续`;
          continue;
        }
        message = `GitHub 历史接口 HTTP ${response.status}${[403, 429].includes(response.status) ? '：访问或请求额度受限，可配置 Token 后刷新' : ''}；保留最近成功缓存`;
        failures++;
        historyAttempts[project.fullName].retryAfter = new Date(now() + HISTORY_RETRY_MS).toISOString();
        if ([401, 403, 429].includes(response.status)) {
          const seconds = Number(response.headers.get('retry-after'));
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          retryAfter = new Date(seconds > 0 ? now() + seconds * 1000 : reset > now() ? reset : now() + 3600000).toISOString();
          break;
        }
        if (failures >= 3) break;
        continue;
      }
      const weeks = validateStarWeeks(await response.json());
      const fetchedAt = new Date(now()).toISOString();
      const record = { source: 'github-star-history', ...identity, fetchedAt, weeks };
      // Empty/lagging current-week responses must not erase a working cache.
      if (summarizeStarActivity(record, { now: now(), createdAt: project.createdAt }).threeDayAdded === null) throw new Error('历史响应未覆盖最近完整统计日');
      if (chooseStarActivityRecord(result.repositories[project.fullName], record, { now: now(), createdAt: project.createdAt, githubId: project.githubId }) !== record) {
        throw new Error('历史响应覆盖退步；保留仍有效的完整历史缓存');
      }
      result.repositories[project.fullName] = record;
      delete historyUnavailable[project.fullName];
      updated++;
      onProgress?.(result);
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining !== null && Number(remaining) <= 5) {
        message = 'GitHub 历史请求额度接近耗尽；已保存成功结果，稍后继续';
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        retryAfter = new Date(reset > now() ? reset : now() + 3600000).toISOString();
        break;
      }
    } catch (error) {
      failures++;
      historyAttempts[project.fullName].retryAfter = new Date(now() + HISTORY_RETRY_MS).toISOString();
      message = `${error.name === 'AbortError' || error.name === 'TimeoutError' ? '历史请求超时' : error.message}；保留最近成功缓存`;
      if (signal?.aborted || failures >= 3) break;
    }
  }
  result.status = { ...result.status, attemptedAt: new Date(now()).toISOString(), updated, requests, failures, authenticated: !!token, retryAfter, rateLimit,
    historyUnavailable, historyAttempts, queueTurns,
    message: message || (pool.length > updated ? `本批更新 ${updated} 个工程；其余工程将在后续批次继续加载` : '') };
  return result;
}
