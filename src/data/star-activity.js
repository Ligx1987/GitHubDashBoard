// GitHub's daily star creations, separate from net changes in total stars.
// https://docs.github.com/en/rest/activity/starring#get-repository-star-history
const DAY = 86400000;
const NAME = /^[\w.-]+\/[\w.-]+$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
// Low-star repositories whose record is still young yield their lane slot to
// higher-star projects; with the one-day boundary grace their boards stay
// valid until the next pass, so the tail effectively refreshes every other
// day. Hot repositories (weekAdded >= 100) outrank this demotion.
const LOW_STAR_STARS = 1000;
const LOW_STAR_RECORD_MAX_AGE_MS = 36 * 3600000;
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
  if (anchor > fetched || now - anchor >= 7 * DAY) return unknown;
  // Preserve the API's day boundary, including a non-UTC offset. Never claim
  // exact rolling hours or infer missing days. Records fetched after the
  // PREVIOUS day boundary still qualify: their final window day may miss a
  // few late-night hours, but expiring them at 00:00 UTC knocked every
  // early-morning batch out of the boards each day.
  const end = anchor + Math.floor((now - anchor) / DAY) * DAY;
  if (fetched < end - DAY) return unknown;
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

export function mergeStarActivity(before = emptyStarActivity(), next = emptyStarActivity()) {
  const repositories = { ...before.repositories };
  for (const [name, record] of Object.entries(next.repositories || {})) {
    if (!repositories[name] || Date.parse(record.fetchedAt) >= Date.parse(repositories[name].fetchedAt)) repositories[name] = record;
  }
  const status = Date.parse(next.status?.attemptedAt) >= Date.parse(before.status?.attemptedAt || 0) ? next.status : before.status;
  return { schemaVersion: 1, repositories, status: status || {} };
}

export async function refreshStarActivity(projects, cache = emptyStarActivity(), {
  token = '', signal, fetchImpl = fetch, now = () => Date.now(), limit = 40, ttlMs = 2 * 3600000,
  force = false, onProgress, maxRuntimeMs = 90000,
} = {}) {
  const start = now();
  const result = { schemaVersion: 1, repositories: { ...cache.repositories }, status: { ...cache.status } };
  // A newly supplied token may recover from an unauthenticated quota block.
  if (!force && Date.parse(cache.status?.retryAfter) > start && (!token || cache.status?.authenticated)) return result;
  // Repositories whose history endpoint answered 404 cool down for seven days;
  // otherwise a handful of dead names would head the queue and abort every
  // batch via the consecutive-failure cap, starving all live repositories.
  const historyUnavailable = { ...(cache.status?.historyUnavailable || {}) };
  const pool = projects.filter(p => NAME.test(p.fullName || '') && p.availability === 'available')
    .filter(p => !(Date.parse(historyUnavailable[p.fullName]) > start))
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
  const byPriority = (a, b) => hot(b) - hot(a) || Number(demoted(a)) - Number(demoted(b)) || (Date.parse(result.repositories[a.fullName]?.fetchedAt) || 0) - (Date.parse(result.repositories[b.fullName]?.fetchedAt) || 0) || (b.stars || 0) - (a.stars || 0);
  // New repositories and established ones refresh in separate lanes, merged
  // 1:1: new-project boards need fresh cohorts, but the surge board also needs
  // established breakouts — a new-first queue spent the whole daily allowance
  // on young repositories and emptied the surge board of anything >31 days.
  const recentLane = pool.filter(recent).sort(byPriority);
  const establishedLane = pool.filter(p => !recent(p)).sort(byPriority);
  const queue = [];
  for (let i = 0; i < Math.max(recentLane.length, establishedLane.length); i++) {
    if (i < recentLane.length) queue.push(recentLane[i]);
    if (i < establishedLane.length) queue.push(establishedLane[i]);
  }
  if (!queue.length) return result;
  let updated = 0, requests = 0, failures = 0, message = '', retryAfter = null;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const project of queue.slice(0, Math.max(0, limit))) {
    if (signal?.aborted || now() - start >= maxRuntimeMs) { message ||= '历史请求超时或已取消；保留最近成功缓存'; break; }
    requests++;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${project.fullName}/stargazers/history?per_page=6&page=1`,
        { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
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
      const record = { source: 'github-star-history', fetchedAt, weeks };
      // Empty/lagging current-week responses must not erase a working cache.
      if (summarizeStarActivity(record, { now: now(), createdAt: project.createdAt }).threeDayAdded === null) throw new Error('历史响应未覆盖最近完整统计日');
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
      message = `${error.name === 'AbortError' || error.name === 'TimeoutError' ? '历史请求超时' : error.message}；保留最近成功缓存`;
      if (signal?.aborted || failures >= 3) break;
    }
  }
  result.status = { ...result.status, attemptedAt: new Date(now()).toISOString(), updated, requests, failures, authenticated: !!token, retryAfter,
    historyUnavailable,
    message: message || (queue.length > updated ? `本批更新 ${updated} 个工程；其余工程将在后续批次继续加载` : '') };
  return result;
}
