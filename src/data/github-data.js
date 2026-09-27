import { DAY_MS, utcDate, validStarCount, calculateGrowth, buildTrendSeries } from './history.js';

/** Dashboard categories are our keyword rules, not GitHub's classifications. */
export const CATEGORY_META = [
  { id: 'ai', label: 'AI & 机器学习', color: '#8b5cf6' },
  { id: 'developer-tools', label: '开发者工具', color: '#22d3ee' },
  { id: 'web', label: 'Web & 前端', color: '#3b82f6' },
  { id: 'infra', label: '基础设施', color: '#f59e0b' },
  { id: 'data', label: '数据与分析', color: '#10b981' },
  { id: 'mobile', label: '移动开发', color: '#ec4899' },
  { id: 'security', label: '安全', color: '#ef4444' },
  { id: 'productivity', label: '效率工具', color: '#f97316' },
  { id: 'uncategorized', label: '未分类', color: '#94a3b8' },
];
const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_META.map((category) => [category.id, category]));
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const numberOrNull = (value) => validStarCount(value) ? value : null;
const known = (value) => typeof value === 'number' && Number.isFinite(value);
const isoOrNull = (value) => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value : null;
const timestampOrNull = (value) => typeof value === 'string' && value.includes('T') ? isoOrNull(value) : null;

export function classifyRepository(repository = {}) {
  const text = [repository.name, repository.description, repository.language, ...(Array.isArray(repository.topics) ? repository.topics : [])]
    .filter((value) => typeof value === 'string').join(' ').toLowerCase();
  const rules = [
    ['ai', /\b(ai|llm|gpt|machine.?learning|deep.?learning|nlp|transformer|agents?)\b/],
    ['security', /\b(security|vulnerabilit\w*|secret|sast|dast|scanner|supply.?chain|malware)\b/],
    ['mobile', /\b(android|ios|flutter|react.?native|mobile|swift|kotlin)\b/],
    ['data', /\b(data|analytics|database|sql|spark|airflow|etl|warehouse|olap|pandas)\b/],
    ['infra', /\b(kubernetes|docker|terraform|cloud|devops|monitoring|observability|prometheus|grafana)\b/],
    ['web', /\b(web|frontend|react|vue|svelte|next\.js|css|html|browser)\b/],
    ['developer-tools', /\b(devtools|developer.?tools|editor|vscode|lsp|ide|compiler|formatter|linter|debugger|package.?manager|runtime)\b/],
    ['productivity', /\b(productivity|utility|utilities|workflow|notes|terminal|cli|desktop)\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'uncategorized';
}

/** Unknown SPDX identifiers cannot imply permissive commercial terms. */
export function licenseRisk(license) {
  if (typeof license !== 'string' || !license.trim() || /^(NOASSERTION|NONE|UNLICENSED)$/i.test(license)) return 'unknown';
  if (/^(BUSL-|SSPL-|Elastic-|CC-BY-NC|LicenseRef-)/i.test(license)) return 'risky';
  if (/^(GPL-|AGPL-|LGPL-|CDDL-|EPL-|MPL-|OSL-|EUPL-)/i.test(license)) return 'copyleft';
  if (/^(MIT|Apache-2\.0|BSD-(2|3|4)-Clause|ISC|Unlicense|CC0-1\.0|0BSD|Zlib|BSL-1\.0|PostgreSQL|WTFPL)$/i.test(license)) return 'permissive';
  return 'unknown';
}

/**
 * Optional heuristic (not a GitHub metric): growth 40, forks 15, adoption 25,
 * recent push 10, license 10. Missing inputs keep the score unknown instead
 * of receiving a synthetic growth or activity score.
 */
export function scoreOpportunity(project, now = Date.now()) {
  const risk = licenseRisk(project.license);
  if (!known(project.stars) || !known(project.forks) || !known(project.weekStars)
      || !isoOrNull(project.pushedAt) || risk === 'unknown') return null;
  const sincePush = now - Date.parse(project.pushedAt);
  if (!Number.isFinite(sincePush) || sincePush < 0) return null;
  const stars = Math.max(1, project.stars);
  const velocity = Math.max(0, Math.min(40, project.weekStars / stars * 570));
  const ratio = stars / Math.max(1, project.forks);
  const forkHealth = Math.max(0, 15 - Math.abs(Math.log2(ratio / 8)) * 7.5);
  const adoption = Math.min(25, Math.log10(stars) * 5);
  const activity = Math.max(0, 10 - sincePush / DAY_MS);
  return Math.round(velocity + forkHealth + adoption + activity + ({ permissive: 10, copyleft: 6, risky: 2 }[risk]));
}

function normalizeProject(project) {
  const fullName = String(project.fullName || project.id || '');
  if (!FULL_NAME.test(fullName)) return null;
  const category = CATEGORY_BY_ID[project.category] ? project.category : classifyRepository(project);
  const meta = CATEGORY_BY_ID[category];
  const fetchedAt = timestampOrNull(project.fetchedAt);
  // A legacy registration without a traceable API sampling timestamp stays a
  // candidate. Its imported fields are retained for recovery, not ranked as
  // verified observations. A successful adapter response explicitly promotes
  // it to "available" with a real fetchedAt.
  const availability = project.availability === 'unavailable' ? 'unavailable'
    : fetchedAt && project.availability !== 'unverified' ? 'available' : 'unverified';
  return {
    ...project,
    id: fullName,
    fullName,
    name: typeof project.name === 'string' ? project.name : fullName.split('/')[1],
    description: typeof project.description === 'string' ? project.description : '',
    category,
    categoryLabel: meta.label,
    categoryColor: meta.color,
    language: typeof project.language === 'string' ? project.language : null,
    stars: numberOrNull(project.stars),
    forks: numberOrNull(project.forks),
    openIssues: numberOrNull(project.openIssues),
    contributors: numberOrNull(project.contributors),
    license: typeof project.license === 'string' ? project.license : null,
    createdAt: isoOrNull(project.createdAt),
    pushedAt: isoOrNull(project.pushedAt),
    updatedAt: isoOrNull(project.updatedAt),
    fetchedAt,
    topics: Array.isArray(project.topics) ? project.topics.filter((topic) => typeof topic === 'string') : [],
    htmlUrl: `https://github.com/${fullName}`,
    availability,
  };
}

export function projectMatches(project, { category = 'all', query = '' } = {}) {
  const selected = category === 'frontend' ? 'web' : category;
  const categoryMatches = selected === 'all' || (selected === 'rust' ? project.language === 'Rust' : project.category === selected);
  const term = String(query).trim().toLowerCase();
  const haystack = [project.fullName, project.name, project.description, project.originalDescription, project.language,
    project.categoryLabel, ...(project.topics || [])].filter(Boolean).join(' ').toLowerCase();
  return categoryMatches && (!term || haystack.includes(term));
}

export function selectProjects(snapshot, {
  category = 'all', query = '', field = 'stars', limit = 10, createdWithinDays, year, requireGrowth = false,
} = {}) {
  const now = snapshot.now ?? Date.now();
  const metric = (project) => ['pushedAt', 'updatedAt', 'createdAt'].includes(field)
    ? (project[field] ? Date.parse(project[field]) : null) : project[field];
  return snapshot.projects.filter((project) => {
    if (project.availability !== 'available' || !projectMatches(project, { category, query })) return false;
    if (!known(metric(project))) return false;
    if (requireGrowth && !known(project[['todayStars', 'weekStars', 'monthStars'].includes(field) ? field : 'weekStars'])) return false;
    if (createdWithinDays !== undefined) {
      const age = project.createdAt ? now - Date.parse(project.createdAt) : NaN;
      if (!Number.isFinite(age) || age < 0 || age > createdWithinDays * DAY_MS) return false;
    }
    if (year !== undefined && (!project.createdAt || new Date(project.createdAt).getUTCFullYear() !== Number(year))) return false;
    return true;
  }).sort((a, b) => metric(b) - metric(a) || (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName))
    .slice(0, Math.max(0, limit)).map((project, index) => ({ ...project, rank: index + 1 }));
}

function sumKnown(projects, field) {
  const rows = projects.filter((project) => known(project[field]));
  return rows.length ? rows.reduce((sum, project) => sum + project[field], 0) : null;
}

export function assembleSnapshot(projects, {
  now = Date.now(), history = {}, source = 'cached', fetchedAt = null, coverage = {}, warning = null,
} = {}) {
  const unique = new Map();
  for (const row of projects) {
    const project = normalizeProject(row);
    if (!project) continue;
    const sampled = project.fetchedAt ? Date.parse(project.fetchedAt) : NaN;
    // A stale sample is not a current week/month endpoint. Never re-anchor it
    // to page-load time, and never retain deltas supplied by a legacy seed.
    const current = Number.isFinite(sampled) && sampled <= now && utcDate(sampled) === utcDate(now);
    Object.assign(project, current && project.availability === 'available'
      ? calculateGrowth(history[project.fullName], project.stars, sampled)
      : { todayStars: null, weekStars: null, monthStars: null });
    project.ageDays = project.createdAt && Date.parse(project.createdAt) <= now ? Math.floor((now - Date.parse(project.createdAt)) / DAY_MS) : null;
    project.licenseRisk = licenseRisk(project.license);
    project.opportunityScore = scoreOpportunity(project, now);
    unique.set(project.fullName.toLowerCase(), project);
  }
  const all = [...unique.values()];
  const available = all.filter((project) => project.availability === 'available');
  const knownCount = (field) => available.filter((project) => known(project[field])).length;
  const dateCount = (field) => available.filter((project) => project[field] !== null).length;
  const snapshot = {
    now,
    source,
    lastUpdated: timestampOrNull(fetchedAt),
    history,
    warning,
    projects: all,
    coverage: {
      ...coverage,
      scope: 'tracked-sample',
      classification: 'custom-keyword-rules',
      registered: all.length,
      available: available.length,
      unavailable: all.filter((project) => project.availability === 'unavailable').length,
      unverified: all.filter((project) => project.availability === 'unverified').length,
      starsKnown: knownCount('stars'),
      createdAtKnown: dateCount('createdAt'),
      pushedAtKnown: dateCount('pushedAt'),
      growth: { today: knownCount('todayStars'), week: knownCount('weekStars'), month: knownCount('monthStars') },
    },
    categories: CATEGORY_META.map((category) => {
      const members = available.filter((project) => project.category === category.id);
      return { ...category, count: members.length, stars: sumKnown(members, 'stars'), weekStars: sumKnown(members, 'weekStars') };
    }),
    trendSeries: buildTrendSeries(available, history, now),
  };
  snapshot.dailyUpdated = available.filter((project) => project.pushedAt && now - Date.parse(project.pushedAt) >= 0 && now - Date.parse(project.pushedAt) <= DAY_MS)
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  snapshot.weeklyTop10 = selectProjects(snapshot, { field: 'weekStars', limit: 10, requireGrowth: true });
  snapshot.weeklyFastest = snapshot.weeklyTop10;
  snapshot.monthlyTop30 = selectProjects(snapshot, { field: 'monthStars', limit: 30, requireGrowth: true });
  snapshot.newWeeklyTop10 = selectProjects(snapshot, { createdWithinDays: 7 });
  snapshot.newMonthlyTop10 = selectProjects(snapshot, { createdWithinDays: 30 });
  snapshot.newQuarterlyTop10 = selectProjects(snapshot, { createdWithinDays: 90 });
  snapshot.opportunityTop10 = selectProjects(snapshot, { field: 'opportunityScore' });
  snapshot.stats = {
    projects: available.length,
    totalStars: sumKnown(available, 'stars'),
    todayStars: sumKnown(available, 'todayStars'),
    weekStars: sumKnown(available, 'weekStars'),
    monthStars: sumKnown(available, 'monthStars'),
    categories: snapshot.categories.filter((category) => category.count > 0).length,
    activeToday: dateCount('pushedAt') ? snapshot.dailyUpdated.length : null,
    newThisWeek: dateCount('createdAt') ? selectProjects(snapshot, { createdWithinDays: 7, limit: Infinity }).length : null,
    newThisMonth: dateCount('createdAt') ? selectProjects(snapshot, { createdWithinDays: 30, limit: Infinity }).length : null,
    newThisQuarter: dateCount('createdAt') ? selectProjects(snapshot, { createdWithinDays: 90, limit: Infinity }).length : null,
  };
  return snapshot;
}

/** Load actual saved observations; opening or refreshing never changes data. */
export async function loadDashboardData({ signal } = {}) {
  const urls = [new URL('./github-snapshot.json', import.meta.url), new URL('./star-history.json', import.meta.url)];
  const [saved, history] = await Promise.all(urls.map(async (url) => {
    const response = await fetch(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`读取数据失败：${url.pathname.split('/').pop()} (HTTP ${response.status})`);
    return response.json();
  }));
  if (!Array.isArray(saved.projects) || !history || typeof history !== 'object' || Array.isArray(history)) throw new Error('快照或历史文件格式无效');
  return assembleSnapshot(saved.projects, {
    history, source: saved.source || 'cached', fetchedAt: saved.fetchedAt,
    coverage: saved.coverage, warning: saved.warning || saved.warnings?.join('；') || null,
  });
}
export const refreshDashboardData = loadDashboardData;
export const snapshotFromProjects = assembleSnapshot;

/** Map only fields actually supplied by GitHub; contributors need a separate API. */
export function projectFromGitHub(item, fetchedAt) {
  if (item.private === true || ['private', 'internal'].includes(item.visibility)) throw new Error('看板仅接受公开 GitHub 仓库');
  const fullName = typeof item.full_name === 'string' ? item.full_name : '';
  if (!FULL_NAME.test(fullName)) throw new Error('GitHub 返回了无效仓库名称');
  return normalizeProject({
    id: fullName, fullName, name: item.name, description: item.description || '',
    descriptionSource: 'github-api', category: classifyRepository(item), language: item.language,
    stars: item.stargazers_count, forks: item.forks_count, openIssues: item.open_issues_count,
    license: item.license?.spdx_id ?? null, createdAt: item.created_at, pushedAt: item.pushed_at,
    updatedAt: item.updated_at, contributors: null, todayStars: null, weekStars: null, monthStars: null,
    topics: item.topics, fetchedAt, availability: 'available',
    owner: item.owner?.login || fullName.split('/')[0], avatarUrl: item.owner?.avatar_url || null,
  });
}

/**
 * Bounded Search API sample, sorted by total stars, not an exhaustive global
 * ranking. At most 4 queries × 2 pages by default. Truncation is reported;
 * incomplete_results rejects the refresh, preserving the previous snapshot.
 */
export async function fetchGitHubProjects({ queries = [], token, signal, maxPages = 2 } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const searchQueries = queries.length ? queries : ['stars:>1000'];
  if (searchQueries.length > 4) throw new Error('单次最多查询 4 个范围，以控制 GitHub Search 请求额度');
  const pages = Math.min(2, Math.max(1, Math.floor(maxPages) || 1));
  const projects = new Map();
  const queryCoverage = [];
  for (const query of searchQueries) {
    let received = 0;
    let total = 0;
    let usedPages = 0;
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL('https://api.github.com/search/repositories');
      url.search = new URLSearchParams({ q: `${query} is:public`, sort: 'stars', order: 'desc', per_page: '100', page: String(page) });
      const response = await fetch(url, { headers, signal });
      if (!response.ok) {
        const error = new Error(`GitHub API HTTP ${response.status}${response.status === 403 || response.status === 429 ? '：请求额度受限，请稍后重试' : ''}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload.incomplete_results) throw new Error('GitHub Search 返回了不完整结果，本次刷新未应用');
      if (!Array.isArray(payload.items) || !validStarCount(payload.total_count)) throw new Error('GitHub Search 返回格式无效');
      const fetchedAt = new Date().toISOString();
      total = payload.total_count;
      received += payload.items.length;
      usedPages = page;
      for (const item of payload.items) {
        if (item.private === true || ['private', 'internal'].includes(item.visibility)) continue;
        const project = projectFromGitHub(item, fetchedAt);
        projects.set(project.fullName.toLowerCase(), project);
      }
      if (payload.items.length < 100 || received >= Math.min(1000, total)) break;
    }
    queryCoverage.push({ query, matched: total, fetched: received, pages: usedPages, truncated: received < total });
  }
  const result = [...projects.values()];
  result.coverage = { scope: 'search-sample', sampledCount: result.length, queryCoverage, truncated: queryCoverage.some((query) => query.truncated) };
  return result;
}

/** Translation is an explicit opt-in action, never part of data refresh. */
export async function translateText(text, { signal, timeoutMs = 5000 } = {}) {
  const original = String(text || '');
  if (!original.trim() || /[一-龥]/.test(original)) return original;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('翻译请求超时')), timeoutMs);
  try {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.search = new URLSearchParams({ q: original.slice(0, 450), langpair: 'en|zh-CN' });
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`翻译 HTTP ${response.status}`);
    const payload = await response.json();
    const value = payload.responseData?.translatedText;
    if (typeof value !== 'string' || !value || Number(payload.responseStatus) !== 200 || payload.quotaFinished || /MYMEMORY WARNING/i.test(value)) throw new Error('翻译服务未返回可用结果');
    return value;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function translateProjects(projects, { signal, concurrency = 3 } = {}) {
  const pending = projects.filter((project) => project.description && !/[一-龥]/.test(project.description));
  let index = 0;
  let translated = 0;
  let serviceFailed = false;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), 4, pending.length) }, async () => {
    while (index < pending.length && !signal?.aborted && !serviceFailed) {
      const project = pending[index++];
      const original = project.originalDescription || project.description;
      try {
        const description = await translateText(original, { signal });
        project.originalDescription = original;
        project.description = description;
        project.translationSource = 'MyMemory (user requested)';
        translated += description !== original ? 1 : 0;
      } catch {
        // Preserve the original and avoid exhausting a provider that is down
        // or quota-limited with hundreds of repeated requests.
        serviceFailed = true;
      }
    }
  }));
  return { translated, total: pending.length };
}
