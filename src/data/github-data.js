import { DAY_MS, utcDate, validStarCount, calculateGrowth, buildTrendSeries } from './history.js';
import { emptyStarActivity, summarizeStarActivity, buildAddedTrend } from './star-activity.js';
export { refreshStarActivity, mergeStarActivity, emptyStarActivity, buildAddedTrend } from './star-activity.js';
export { buildTrendSeries } from './history.js';

/** Dashboard categories are weighted local rules, not GitHub's classifications. */
export const CATEGORY_VERSION = 2;
export const CATEGORY_META = [
  { id: 'ai', label: 'AI & 机器学习', color: '#8b5cf6' },
  { id: 'developer-tools', label: '开发者工具', color: '#22d3ee' },
  { id: 'web', label: 'Web & 前端', color: '#3b82f6' },
  { id: 'infra', label: '基础设施', color: '#f59e0b' },
  { id: 'data', label: '数据与分析', color: '#10b981' },
  { id: 'mobile', label: '移动开发', color: '#ec4899' },
  { id: 'security', label: '安全', color: '#ef4444' },
  { id: 'productivity', label: '效率工具', color: '#f97316' },
  { id: 'creative', label: '创意与设计', color: '#e879f9' },
  { id: 'knowledge', label: '知识与学习', color: '#a3e635' },
  { id: 'uncategorized', label: '未分类', color: '#94a3b8' },
];
export const NEW_GROWTH_BOARDS = [
  { id: 'threeDay', days: 3, field: 'threeDayAdded', limit: 10 },
  { id: 'weekly', days: 7, field: 'weekAdded', limit: 10 },
  { id: 'monthly', days: 30, field: 'monthAdded', limit: 30 },
];
// Surge boards rank all tracked repositories by recent official additions,
// regardless of creation date; this is where established-but-exploding
// projects surface. New-project boards remain the "rookie" view.
export const SURGE_BOARDS = [
  { id: 'surgeWeek', days: 7, field: 'weekAdded', limit: 30 },
  { id: 'surgeMonth', days: 30, field: 'monthAdded', limit: 30 },
];
// A repository is "accelerating" when this week's official additions reach at
// least 3x the previous week's, with a floor that filters out tiny-sample
// noise. A zero previous week counts as a fresh breakout once the floor is met.
export const ACCELERATION_MIN_WEEK_ADDED = 20;
export const ACCELERATION_RATIO = 3;
// Product scope: only repositories created within the rolling SCOPE_YEARS
// window are collected, ranked, and displayed. Older entries are pruned.
export const SCOPE_YEARS = 3;
export function scopeCutoffMs(now = Date.now()) {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - SCOPE_YEARS);
  return date.getTime();
}
export function withinScope(createdAt, now = Date.now()) {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || created >= scopeCutoffMs(now);
}
// Star bands for the surge discovery channel: recently pushed repositories per
// size tier, so an established project that only started trending last week is
// discovered without waiting for its total stars to enter a yearly Top 100.
export const SURGE_DISCOVERY_BANDS = ['50..500', '500..5000', '>5000'];

export function recentYears(now = Date.now()) {
  const current = new Date(now).getUTCFullYear();
  const first = new Date(scopeCutoffMs(now)).getUTCFullYear();
  return Array.from({ length: current - first + 1 }, (_, i) => current - i);
}

/** Bounded discovery candidates; ranking happens only after history is read. */
export function discoverySearchPlan(now = Date.now()) {
  const time = new Date(now).getTime();
  const date = value => new Date(value).toISOString().slice(0, 10);
  const pushedSince = date(time - 8 * DAY_MS); // one extra day for API day-boundary drift
  const cutoff = scopeCutoffMs(time);
  const cutoffYear = new Date(cutoff).getUTCFullYear();
  const currentYear = new Date(time).getUTCFullYear();
  return [
    ...[3, 7, 30].map(days => ({ id: `recent-${days}`, days, kind: 'recent',
      // Include one extra day so a non-UTC API day boundary is not lost.
      query: `created:${date(time - (days + 1) * DAY_MS)}..${date(time)} is:public` })),
    ...recentYears(time).map(year => ({ id: `year-${year}`, year, kind: 'year',
      query: `created:${year === cutoffYear ? date(cutoff) : `${year}-01-01`}..${year === currentYear ? date(time) : `${year}-12-31`} is:public` })),
    ...SURGE_DISCOVERY_BANDS.map(band => ({ id: `surge-${band.replace(/\D+/g, '-')}`, band, kind: 'surge',
      query: `stars:${band} pushed:>=${pushedSince} created:>=${date(cutoff)} is:public` })),
  ];
}
const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_META.map((category) => [category.id, category]));
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const numberOrNull = (value) => validStarCount(value) ? value : null;
const known = (value) => typeof value === 'number' && Number.isFinite(value);
const isoOrNull = (value) => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value : null;
const timestampOrNull = (value) => typeof value === 'string' && value.includes('T') ? isoOrNull(value) : null;

const CATEGORY_RULES = [
  ['ai', [/\b(ai|artificial intelligence|machine learning|deep learning|llm|large language models?|language models?|gpt|chatgpt|transformer|agents?|agentic|mcp|model context protocol|claude|anthropic|openai|deepseek|qwen|kimi|gemini|grok|chatglm|ollama|rag|embeddings?|vector search|diffusion|text-to-image|speech recognition|foundation models?|frontier models?|moe|prompting|inference|fine.?tun\w*|pytorch|tensorflow|hugging ?face|chatbot|copilot|codex)\b/, /人工智能|机器学习|深度学习|大模型|智能体|多模态|模型推理|微调/]],
  ['security', [/\b(security|vulnerabilit\w*|secrets?|credentials?|sast|dast|scanner|supply.?chain|malware|threat|exploit|pentest|osint|privacy|reverse.?engineer\w*|binary analysis|decompiler|disassembler|ctf|static analysis)\b/, /安全|漏洞|渗透|逆向|密钥|隐私/]],
  ['mobile', [/\b(android|ios|flutter|react.?native|mobile|carplay)\b/, /安卓|手机|移动端/]],
  ['data', [/\b(data|analytics|database|sql|spark|airflow|etl|warehouse|olap|pandas|crawler|scraper|scraping|datasets?|visualization|business intelligence|data engineering|data science|time series)\b/, /数据|爬虫|数据集|可视化/]],
  ['infra', [/\b(kubernetes|docker|terraform|cloud|devops|monitoring|observability|prometheus|grafana|containers?|virtualization|serverless|infrastructure|self.?hosted|homelab|proxy|dns|vmess|vless|trojan|shadowsocks|wireguard|hysteria|mtproto)\b/, /基础设施|云原生|容器|运维|自托管/]],
  ['web', [/\b(web|frontend|front.?end|react|vue|svelte|next\.?js|css|html|browser|website|webapp|web app|webgpu)\b/, /前端|网页|浏览器/]],
  ['developer-tools', [/\b(devtools|developer.?tools|code editor|text editor|vim|neovim|vscode|lsp|ide|compiler|formatter|linter|debugger|package(?:\s+and\s+project)?\s+manager|runtime|sdk|api client|code intelligence)\b/, /开发者工具|代码编辑器|包管理器/]],
  ['productivity', [/\b(productivity|utility|utilities|workflows?|automation|notes?|note.?taking|terminal|cli|desktop|launcher|clipboard|file manager|converter|office|microsoft word|pdf|documents?|spreadsheet|word processor|powerpoint|ppt|excel|mail|calendar|shell prompt|finance)\b/, /效率|工作流|笔记|终端|桌面|剪贴板|文件管理|转换|办公|文档|表格|演示/]],
  ['creative', [/\b(art|design|designer|photo|photography|image editing|image editor|video editing|video editor|animation|motion graphics|compositing|vector graphics|svg editor|cad|3d graphics|photoshop|illustrator|filmmaking|capcut|screen studio)\b/, /创意|设计|动画|图像|照片|视频编辑|绘画/]],
  ['knowledge', [/\b(guide|handbook|tutorial|course|book|learning|education|interview|cheatsheet|awesome|curriculum|roadmap|algorithm)\b/, /教程|指南|全书|阅读|学习|笔记|面试|书单|算法/]],
];
const CATEGORY_PRIORITY = new Map(CATEGORY_META.map((category, index) => [category.id, index]));

function sourceScore(text, patterns, weight) {
  if (!text) return 0;
  const matches = patterns.reduce((count, pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return count + (text.match(new RegExp(pattern.source, flags))?.length || 0);
  }, 0);
  return matches ? weight + Math.min(matches - 1, 2) : 0;
}

/**
 * Weighted domain classification: topics > description > name > language.
 * Language alone is intentionally below the primary threshold; Swift/Kotlin no
 * longer turn every macOS or server-side project into a mobile repository.
 */
export function classifyRepositoryDetails(repository = {}) {
  const topics = (Array.isArray(repository.topics) ? repository.topics : []).filter((topic) => typeof topic === 'string').join(' ').toLowerCase();
  const sources = [
    [topics, 5],
    [typeof repository.description === 'string' ? repository.description.toLowerCase() : '', 3],
    [[repository.name, repository.fullName].filter((value) => typeof value === 'string').join(' ').toLowerCase(), 2],
    [typeof repository.language === 'string' ? repository.language.toLowerCase() : '', 1],
  ];
  const scores = CATEGORY_RULES.map(([id, patterns]) => [
    id, sources.reduce((total, [text, weight]) => total + sourceScore(text, patterns, weight), 0),
  ]);
  const [category, score] = scores.reduce((best, current) => {
    if (current[1] > best[1]) return current;
    if (current[1] === best[1] && CATEGORY_PRIORITY.get(current[0]) < CATEGORY_PRIORITY.get(best[0])) return current;
    return best;
  }, ['uncategorized', 0]);
  const primary = score >= 2 ? category : 'uncategorized';
  const tags = scores.filter(([id, value]) => id !== primary && value >= 3 && value >= score * 0.4)
    .sort((a, b) => b[1] - a[1] || CATEGORY_PRIORITY.get(a[0]) - CATEGORY_PRIORITY.get(b[0]))
    .slice(0, 3).map(([id]) => id);
  return { category: primary, tags, score, scores: Object.fromEntries(scores), version: CATEGORY_VERSION };
}

export function classifyRepository(repository = {}) {
  return classifyRepositoryDetails(repository).category;
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
 * recent push 10, license 10. Growth uses the official one-week star additions
 * (`weekAdded`), which only needs the GitHub star-history response instead of
 * an exact local 7-day baseline. Missing inputs keep the score unknown instead
 * of receiving a synthetic growth or activity score.
 */
export function scoreOpportunity(project, now = Date.now()) {
  const risk = licenseRisk(project.license);
  if (!known(project.stars) || !known(project.forks) || !known(project.weekAdded)
      || !isoOrNull(project.pushedAt) || risk === 'unknown') return null;
  const sincePush = now - Date.parse(project.pushedAt);
  if (!Number.isFinite(sincePush) || sincePush < 0) return null;
  const stars = Math.max(1, project.stars);
  const velocity = Math.max(0, Math.min(40, project.weekAdded / stars * 570));
  const ratio = stars / Math.max(1, project.forks);
  const forkHealth = Math.max(0, 15 - Math.abs(Math.log2(ratio / 8)) * 7.5);
  const adoption = Math.min(25, Math.log10(stars) * 5);
  const activity = Math.max(0, 10 - sincePush / DAY_MS);
  return Math.round(velocity + forkHealth + adoption + activity + ({ permissive: 10, copyleft: 6, risky: 2 }[risk]));
}

function normalizeProject(project) {
  const fullName = String(project.fullName || project.id || '');
  if (!FULL_NAME.test(fullName)) return null;
  const classification = classifyRepositoryDetails(project);
  const override = CATEGORY_BY_ID[project.categoryOverride] ? project.categoryOverride : null;
  const storedCurrent = !override && project.categoryVersion === CATEGORY_VERSION && CATEGORY_BY_ID[project.category]
    ? project.category : null;
  const category = override || storedCurrent || classification.category;
  const meta = CATEGORY_BY_ID[category];
  const categoryTags = (storedCurrent === category && Array.isArray(project.categoryTags)
    ? project.categoryTags.filter((tag) => CATEGORY_BY_ID[tag] && tag !== category)
    : classification.tags).slice(0, 3);
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
    descriptionZh: typeof project.descriptionZh === 'string' && project.descriptionZh.trim() ? project.descriptionZh : null,
    descriptionZhAt: timestampOrNull(project.descriptionZhAt),
    category,
    categoryLabel: meta.label,
    categoryColor: meta.color,
    categoryTags,
    categoryTagLabels: categoryTags.map((tag) => CATEGORY_BY_ID[tag].label),
    categoryVersion: CATEGORY_VERSION,
    categorySource: override ? 'override' : 'rule',
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
  const haystack = [project.fullName, project.name, project.description, project.descriptionZh, project.originalDescription, project.language,
    project.categoryLabel, ...(project.categoryTagLabels || []), ...(project.topics || [])].filter(Boolean).join(' ').toLowerCase();
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
    if (requireGrowth && !known(project[['todayStars', 'weekStars', 'monthStars', 'threeDayAdded', 'weekAdded', 'monthAdded'].includes(field) ? field : 'weekStars'])) return false;
    if (createdWithinDays !== undefined) {
      const age = project.createdAt ? now - Date.parse(project.createdAt) : NaN;
      if (!Number.isFinite(age) || age < 0 || age > createdWithinDays * DAY_MS) return false;
    }
    if (year !== undefined && (!project.createdAt || new Date(project.createdAt).getUTCFullYear() !== Number(year))) return false;
    return true;
  }).sort((a, b) => metric(b) - metric(a) || (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName))
    .slice(0, Math.max(0, limit)).map((project, index) => ({ ...project, rank: index + 1 }));
}

/**
 * Use one API day boundary across all three boards, independent of filters.
 * The boundary is the modal (most common) window end, not the maximum: one
 * record with an abnormally fresh anchor must not push every other repository
 * into "pending". Ties resolve to the latest end.
 */
export function growthWindowEnd(snapshot) {
  const counts = new Map();
  for (const project of snapshot.projects) {
    if (project.availability !== 'available' || !project.activityWindowEnd) continue;
    counts.set(project.activityWindowEnd, (counts.get(project.activityWindowEnd) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [end, count] of counts) {
    if (count > bestCount || (count === bestCount && end > best)) { best = end; bestCount = count; }
  }
  return best;
}

/**
 * Surge boards: rank every available repository by official additions in the
 * current window, without any creation-date restriction. Only repositories
 * whose history ends at the common window boundary are ranked; the rest are
 * disclosed as pending rather than silently dropped from the denominator.
 */
export function selectSurgeProjects(snapshot, { field = 'weekAdded', limit = 30, category = 'all', query = '', windowEnd = growthWindowEnd(snapshot) } = {}) {
  const config = SURGE_BOARDS.find(board => board.field === field) || { field, limit };
  const list = snapshot.projects.filter(p => p.availability === 'available' && projectMatches(p, { category, query }));
  const eligible = list.filter(p => windowEnd && p.activityWindowEnd === windowEnd && known(p[field]));
  const projects = eligible.slice().sort((a, b) => b[field] - a[field] || (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName))
    .slice(0, limit ?? config.limit).map((p, i) => ({ ...p, rank: i + 1 }));
  return { ...config, limit: limit ?? config.limit, projects, windowEnd,
    coverage: { candidates: list.length, eligible: eligible.length, pending: list.length - eligible.length,
      accelerating: eligible.filter(p => p.accelerating).length } };
}

export function selectNewProjectGrowth(snapshot, { days, limit, category = 'all', query = '', windowEnd = growthWindowEnd(snapshot) } = {}) {
  const config = NEW_GROWTH_BOARDS.find(board => board.days === days);
  if (!config) throw new Error('Unsupported new-project growth window');
  const now = snapshot.now ?? Date.now();
  const end = windowEnd ? Date.parse(windowEnd) : NaN;
  const start = end - days * DAY_MS;
  const list = snapshot.projects.filter(p => p.availability === 'available' && projectMatches(p, { category, query }));
  const candidates = list.filter(p => {
    const created = Date.parse(p.createdAt);
    return Number.isFinite(end) && end <= now && created >= start && created < end;
  });
  const eligible = candidates.filter(p => p.activityWindowEnd === windowEnd && known(p[config.field]));
  const projects = eligible.slice().sort((a, b) => b[config.field] - a[config.field] || (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName))
    .slice(0, limit ?? config.limit).map((p, i) => ({ ...p, rank: i + 1 }));
  return { ...config, projects, windowStart: Number.isFinite(start) ? new Date(start).toISOString() : null, windowEnd,
    coverage: { candidates: candidates.length, eligible: eligible.length, pending: candidates.length - eligible.length,
      createdAtUnknown: list.filter(p => !p.createdAt).length,
      windowPending: !Number.isFinite(end) ? list.filter(p => p.createdAt && Date.parse(p.createdAt) >= now - (days + 1) * DAY_MS && Date.parse(p.createdAt) <= now).length : 0 } };
}

export function selectYearlyTop30(snapshot, { category = 'all', query = '' } = {}) {
  const now = snapshot.now ?? Date.now();
  const cutoff = scopeCutoffMs(now);
  const list = snapshot.projects.filter(p => p.availability === 'available' && projectMatches(p, { category, query }));
  return recentYears(now).map(year => {
    const candidates = list.filter(p => p.createdAt && Date.parse(p.createdAt) >= cutoff && Date.parse(p.createdAt) <= now && new Date(p.createdAt).getUTCFullYear() === year);
    const projects = selectProjects({ ...snapshot, projects: candidates }, { field: 'stars', year, limit: 30 });
    return { year, projects, coverage: { candidates: candidates.length, eligible: candidates.filter(p => known(p.stars)).length } };
  });
}

function sumKnown(projects, field) {
  const rows = projects.filter((project) => known(project[field]));
  return rows.length ? rows.reduce((sum, project) => sum + project[field], 0) : null;
}

export function assembleSnapshot(projects, {
  now = Date.now(), history = {}, starActivity = emptyStarActivity(), source = 'cached', fetchedAt = null, coverage = {}, warning = null,
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
    Object.assign(project, summarizeStarActivity(project.availability === 'available' ? starActivity.repositories?.[project.fullName] : null, { now, createdAt: project.createdAt }));
    // Acceleration: this week's additions vs. the previous complete week.
    // Unknown inputs stay unknown; a verified zero previous week counts as a
    // breakout once the minimum-volume floor is reached.
    project.accelerationRatio = known(project.weekAdded) && known(project.prevWeekAdded) && project.prevWeekAdded > 0
      ? project.weekAdded / project.prevWeekAdded : null;
    project.accelerating = known(project.weekAdded) && known(project.prevWeekAdded)
      && project.weekAdded >= Math.max(ACCELERATION_MIN_WEEK_ADDED, ACCELERATION_RATIO * project.prevWeekAdded);
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
    starActivity,
    warning,
    projects: all,
    coverage: {
      ...coverage,
      scope: 'tracked-sample',
      classification: `weighted-keyword-rules-v${CATEGORY_VERSION}`,
      registered: all.length,
      available: available.length,
      unavailable: all.filter((project) => project.availability === 'unavailable').length,
      unverified: all.filter((project) => project.availability === 'unverified').length,
      starsKnown: knownCount('stars'),
      createdAtKnown: dateCount('createdAt'),
      pushedAtKnown: dateCount('pushedAt'),
      growth: { today: knownCount('todayStars'), week: knownCount('weekStars'), month: knownCount('monthStars') },
      addedGrowth: { threeDay: knownCount('threeDayAdded'), week: knownCount('weekAdded'), month: knownCount('monthAdded') },
    },
    categories: CATEGORY_META.map((category) => {
      const members = available.filter((project) => project.category === category.id);
      return { ...category, count: members.length, stars: sumKnown(members, 'stars'), weekStars: sumKnown(members, 'weekStars') };
    }),
    trendSeries: buildTrendSeries(available, history, now),
    addedTrendSeries: buildAddedTrend(available),
  };
  snapshot.dailyUpdated = available.filter((project) => project.pushedAt && now - Date.parse(project.pushedAt) >= 0 && now - Date.parse(project.pushedAt) <= DAY_MS)
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  snapshot.weeklyTop10 = selectProjects(snapshot, { field: 'weekAdded', limit: 10, requireGrowth: true });
  snapshot.weeklyFastest = snapshot.weeklyTop10;
  snapshot.monthlyTop30 = selectProjects(snapshot, { field: 'monthAdded', limit: 30, requireGrowth: true });
  snapshot.newGrowthBoards = NEW_GROWTH_BOARDS.map(board => selectNewProjectGrowth(snapshot, board));
  snapshot.newThreeDayTop10 = snapshot.newGrowthBoards[0].projects;
  snapshot.newWeeklyTop10 = snapshot.newGrowthBoards[1].projects;
  snapshot.newMonthlyTop30 = snapshot.newGrowthBoards[2].projects;
  snapshot.surgeBoards = SURGE_BOARDS.map(board => selectSurgeProjects(snapshot, board));
  snapshot.surgeWeekTop30 = snapshot.surgeBoards[0].projects;
  snapshot.surgeMonthTop30 = snapshot.surgeBoards[1].projects;
  snapshot.yearlyTop30 = selectYearlyTop30(snapshot);
  snapshot.weeklyNetTop10 = selectProjects(snapshot, { field: 'weekStars', limit: 10, requireGrowth: true });
  snapshot.monthlyNetTop30 = selectProjects(snapshot, { field: 'monthStars', limit: 30, requireGrowth: true });
  snapshot.opportunityTop10 = selectProjects(snapshot, { field: 'opportunityScore' });
  snapshot.stats = {
    projects: available.length,
    totalStars: sumKnown(available, 'stars'),
    todayStars: sumKnown(available, 'todayStars'),
    weekStars: sumKnown(available, 'weekStars'),
    monthStars: sumKnown(available, 'monthStars'),
    weekAdded: sumKnown(available, 'weekAdded'),
    monthAdded: sumKnown(available, 'monthAdded'),
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
  const activityPromise = fetch(new URL('./star-activity.json', import.meta.url), { signal, cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (value?.schemaVersion !== 1 || !value.repositories || Array.isArray(value.repositories)) throw new Error('格式无效');
    return value;
  }).catch(() => ({ ...emptyStarActivity(), status: { message: '官方历史缓存暂不可用；将尝试直接获取 GitHub 历史数据' } }));
  const [saved, history] = await Promise.all(urls.map(async (url) => {
    const response = await fetch(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`读取数据失败：${url.pathname.split('/').pop()} (HTTP ${response.status})`);
    return response.json();
  }));
  if (!Array.isArray(saved.projects) || !history || typeof history !== 'object' || Array.isArray(history)) throw new Error('快照或历史文件格式无效');
  return assembleSnapshot(saved.projects, {
    history, starActivity: await activityPromise, source: saved.source || 'cached', fetchedAt: saved.fetchedAt,
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
  const classification = classifyRepositoryDetails({ ...item, fullName, description: item.description || '', topics: item.topics });
  return normalizeProject({
    id: fullName, fullName, name: item.name, description: item.description || '',
    descriptionSource: 'github-api', category: classification.category, categoryTags: classification.tags,
    categoryVersion: classification.version, language: item.language,
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

/**
 * Translation is an explicit opt-in action, never part of data refresh.
 * Provider chain: Google Translate's public endpoint first (far better
 * quality for technical prose), MyMemory as fallback. The winning provider
 * is reported so persisted translations can be selectively re-translated
 * when a better provider becomes available later.
 */
export async function translateWithProvider(text, { signal, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const original = String(text || '');
  if (!original.trim() || /[一-龥]/.test(original)) return { text: original, provider: 'none' };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('翻译请求超时')), timeoutMs);
  try {
    const googleUrl = `https://translate.googleapis.com/translate_a/single?${new URLSearchParams({
      client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: original.slice(0, 1500) })}`;
    try {
      const response = await fetchImpl(googleUrl, { signal: controller.signal });
      if (!response?.ok) throw new Error(`翻译 HTTP ${response?.status}`);
      const payload = await response.json();
      const value = (Array.isArray(payload?.[0]) ? payload[0] : []).map((segment) => segment?.[0] || '').join('');
      if (!value.trim()) throw new Error('翻译服务未返回可用结果');
      return { text: value, provider: 'google' };
    } catch (error) {
      if (signal?.aborted) throw error; // User cancellation must not trigger a fallback burst.
    }
    const url = new URL('https://api.mymemory.translated.net/get');
    url.search = new URLSearchParams({ q: original.slice(0, 450), langpair: 'en|zh-CN' });
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`翻译 HTTP ${response.status}`);
    const payload = await response.json();
    const value = payload.responseData?.translatedText;
    if (typeof value !== 'string' || !value || Number(payload.responseStatus) !== 200 || payload.quotaFinished || /MYMEMORY WARNING/i.test(value)) throw new Error('翻译服务未返回可用结果');
    return { text: value, provider: 'mymemory' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/** Translation is an explicit opt-in action, never part of data refresh. */
export async function translateText(text, options = {}) {
  return (await translateWithProvider(text, options)).text;
}

export async function translateProjects(projects, { signal, concurrency = 3 } = {}) {
  const pending = projects.filter((project) => project.description && !/[一-龥]/.test(project.description));
  let index = 0;
  let translated = 0;
  const providers = { google: 0, mymemory: 0 };
  let serviceFailed = false;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), 4, pending.length) }, async () => {
    while (index < pending.length && !signal?.aborted && !serviceFailed) {
      const project = pending[index++];
      const original = project.originalDescription || project.description;
      try {
        const { text: description, provider } = await translateWithProvider(original, { signal });
        project.originalDescription = original;
        project.description = description;
        project.translationSource = `${provider === 'google' ? 'Google 翻译' : 'MyMemory'} (user requested)`;
        if (description !== original) { translated += 1; if (provider !== 'none') providers[provider] = (providers[provider] || 0) + 1; }
      } catch {
        // Preserve the original and avoid exhausting a provider that is down
        // or quota-limited with hundreds of repeated requests.
        serviceFailed = true;
      }
    }
  }));
  return { translated, total: pending.length, providers };
}
