import { CATEGORY_META, NEW_GROWTH_BOARDS, SURGE_BOARDS, growthWindowEnd, selectNewProjectGrowth, selectSurgeProjects, selectYearlyTop30, discoverySearchPlan, assembleSnapshot, fetchGitHubProjects, loadDashboardData, translateProjects, refreshStarActivity, mergeStarActivity, mergeRepositoryStates, emptyStarActivity } from './src/data/github-data.js';

/* ============================================================
 * 常量
 * ============================================================ */
const DAY = 86400000;
const PAGE_SIZE = 15;
const BOARD_PREVIEW = 5;

/* ============================================================
 * 单一状态对象：所有可变状态集中在这里，避免顶层散落 let
 * ============================================================ */
const S = {
  snapshot: null,
  category: 'all',
  browsePage: 1,
  activityLimit: 5,
  expandedBoards: { surge: false, new: false },
  openRowDetails: new Set(),
  surgeDays: 7,
  newDays: 7,
  busy: false,
  warning: '',
  toastTimer: undefined,
  liveCount: 0,
  token: '',
  retryHistoryWithNewToken: false,
  activityLoading: false,
  activityCache: emptyStarActivity(),
  hasRendered: false,
  discoveryYearCursor: 0,
  searchTimer: undefined,
};
try {
  const cached = JSON.parse(localStorage.getItem('githubPulse.starActivity.v1') || 'null');
  if (cached?.schemaVersion === 1 && cached.repositories && !Array.isArray(cached.repositories)) S.activityCache = cached;
} catch { /* Ignore broken or unavailable optional cache. */ }
try {
  // Migrate the old persistent token into this tab's session; never render its value.
  S.token = sessionStorage.getItem('githubPulse.token') || localStorage.getItem('githubPulse.token') || '';
  if (S.token) sessionStorage.setItem('githubPulse.token', S.token);
  localStorage.removeItem('githubPulse.token');
  if (localStorage.getItem('githubPulse.theme') === 'light') document.body.classList.add('light');
} catch { /* Browser storage can be disabled. */ }

/* ============================================================
 * DOM 与格式化工具（纯函数，不读 S）
 * ============================================================ */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const known = (value) => typeof value === 'number' && Number.isFinite(value);
const validDate = (value) => value && Number.isFinite(Date.parse(value));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => known(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
const delta = (value) => known(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '暂无基线';
const compact = (value) => known(value) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const cutoffLabel = (value) => validDate(value) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '待获取';
const icon = (name) => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const timeAgo = (value) => {
  if (!validDate(value)) return '采样时间未知';
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  return elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} 分钟前` : elapsed < DAY ? `${Math.floor(elapsed / 3600000)} 小时前` : `${Math.floor(elapsed / DAY)} 天前`;
};
const safeUrl = (project) => /^[-\w.]+\/[-\w.]+$/.test(project.fullName || '') ? `https://github.com/${project.fullName}` : 'https://github.com/';
const empty = (message, title = '暂无匹配工程') => `<div class="empty-state"><strong class="empty-title">${esc(title)}</strong><span class="empty-copy">${esc(message)}</span></div>`;
const renderedMarkup = new WeakMap();
const markup = (selector, html) => { const element = $(selector); if (renderedMarkup.get(element) !== html) { element.innerHTML = html; renderedMarkup.set(element, html); } };
function toast(message) { clearTimeout(S.toastTimer); $('#toastMessage').textContent = message; $('#toast').classList.add('show'); S.toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }

/* ============================================================
 * 候选查询与列表过滤
 * ============================================================ */
const liveQueries = () => {
  const plan = discoverySearchPlan();
  const years = plan.filter(item => item.kind === 'year');
  return [...plan.slice(0, 3), years[S.discoveryYearCursor % years.length]].map(item => item.query);
};
function projects() {
  const query = $('#searchInput').value.trim().toLowerCase();
  return (S.snapshot?.projects || []).filter((project) => project.availability === 'available')
    .filter((project) => S.category === 'all' || project.category === S.category)
    .filter((project) => !query || [project.fullName, project.name, project.description, project.descriptionZh, project.originalDescription, project.language, project.categoryLabel, ...(project.categoryTagLabels || []), ...(project.topics || [])].join(' ').toLowerCase().includes(query));
}
const sorted = (list, field, limit) => list.filter((project) => known(project[field])).slice().sort((a, b) => b[field] - a[field] || (b.stars || 0) - (a.stars || 0) || a.fullName.localeCompare(b.fullName)).slice(0, limit);
function directoryProjects(list) {
  const end = growthWindowEnd(S.snapshot);
  const comparableGrowth = project => end && project.activityWindowEnd === end && known(project.weekAdded) ? project.weekAdded : -1;
  return list.slice().sort((a, b) => comparableGrowth(b) - comparableGrowth(a) || (known(b.stars) ? b.stars : -1) - (known(a.stars) ? a.stars : -1) || a.fullName.localeCompare(b.fullName));
}

/* ============================================================
 * 单行仓库渲染
 * ============================================================ */
function row(project, index, field = 'stars', scope = 'directory') {
  const detailKey = `${scope}:${project.fullName}`;
  const growth = ['weekStars', 'monthStars', 'threeDayAdded', 'weekAdded', 'monthAdded'].includes(field);
  const created = validDate(project.createdAt) ? project.createdAt.slice(0, 10) : '创建日期待核验';
  const sampled = field.endsWith('Added') ? `GitHub 历史 · ${timeAgo(project.activityFetchedAt)} · 统计截至 ${cutoffLabel(project.activityWindowEnd)}` : validDate(project.fetchedAt) ? timeAgo(project.fetchedAt) : project.sampleDate ? `${project.sampleDate} 快照` : '采样时间未知';
  const license = project.license && project.license !== 'NOASSERTION' ? project.license : '许可证未知';
  const risk = project.licenseRisk === 'unknown' || project.licenseRisk === 'risky';
  // Persisted Chinese description first; the original stays as a tooltip.
  const displayDescription = project.descriptionZh || project.description || '暂无描述';
  const translated = Boolean(project.descriptionZh || project.originalDescription);
  const originalTooltip = translated && project.description ? ` title="${esc(project.description)}"` : '';
  const categoryChip = project.categoryLabel
    ? `<span class="category-chip" style="--category-color:${esc(project.categoryColor)}">${esc(project.categoryLabel)}</span>` : '';
  const categoryTags = (project.categoryTagLabels || []).map((label) => `<span class="category-tag">${esc(label)}</span>`).join('');
  const accel = project.accelerating
    ? `<span class="accel-badge" title="本周官方新增达到上周 3 倍以上">${icon('rise')} ${project.accelerationRatio !== null ? `×${project.accelerationRatio >= 10 ? Math.round(project.accelerationRatio) : project.accelerationRatio.toFixed(1)}` : '新爆发'}</span>` : '';
  const baseGrowthLabel = { weekAdded: '7 日新增', monthAdded: '30 日新增', threeDayAdded: '3 日新增', weekStars: '7 日净增', monthStars: '30 日净增' }[field];
  const staleGrowth = scope === 'directory' && known(project[field]) && project.activityWindowEnd !== growthWindowEnd(S.snapshot);
  const growthLabel = staleGrowth ? `缓存 ${baseGrowthLabel} · 截至 ${cutoffLabel(project.activityWindowEnd)}` : baseGrowthLabel;
  return `<article class="repo-row">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <div class="repo-details"><div class="repo-name"><a class="repo-link" href="${esc(safeUrl(project))}" target="_blank" rel="noopener noreferrer">${esc(project.fullName)}</a>${accel}</div><div class="repo-desc"${originalTooltip}>${esc(displayDescription)}</div><div class="repo-meta">${categoryChip}<span class="lang-chip">${esc(project.language || '未知语言')}</span><span class="license-chip ${risk ? 'risky' : ''}">${esc(license)}</span></div>
      <details class="repo-extra" data-project="${esc(project.fullName)}" data-key="${esc(detailKey)}"${S.openRowDetails.has(detailKey) ? ' open' : ''}><summary aria-label="${esc(project.fullName)} 的详情与原文">详情${translated ? '与原文' : ''}${icon('chevron')}</summary><div class="repo-extra-body"><p>${esc(displayDescription)}</p>${translated && project.description ? `<p>原文：${esc(project.description)}</p>` : ''}${categoryTags ? `<div class="repo-meta">${categoryTags}</div>` : ''}<p class="repo-signals">创建于 ${esc(created)} · 采样于 ${esc(sampled)}${translated ? ' · 机器翻译' : ''} · Forks ${number(project.forks)}</p></div></details>
    </div>
    <div class="repo-stats">${growth ? `<span class="delta ${project[field] < 0 ? 'negative' : ''}"><span class="delta-label">${growthLabel}</span>${known(project[field]) ? delta(project[field]) : '—'}</span>` : ''}${field === 'opportunityScore' ? `<span class="score-badge">评分 ${number(project.opportunityScore)}</span>` : ''}<span class="stars">${number(project.stars)} Stars</span><span class="forks">${number(project.forks)} Forks</span></div>
  </article>`;
}

/* ============================================================
 * 面板渲染（按从上到下的页面顺序）
 * ============================================================ */
function renderMetrics(list) {
  const end = growthWindowEnd(S.snapshot);
  const week = list.filter((p) => p.activityWindowEnd === end && known(p.weekAdded));
  const pushes = list.filter((p) => validDate(p.pushedAt));
  const recent = pushes.filter((p) => Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY);
  $('#trackedCount').textContent = number(list.length);
  $('#newToday').textContent = pushes.length ? number(recent.length) : '—';
  $('#activityCoverage').textContent = `${pushes.length}/${list.length} 个仓库有已核验的推送时间`;
  $('#weeklyStars').textContent = week.length ? delta(week.reduce((sum, p) => sum + p.weekAdded, 0)) : '待获取';
  $('#growthMetricLabel').textContent = `一周新增 Stars · 截至 ${cutoffLabel(end)}`;
  $('#growthCoverage').textContent = `${number(week.length)} / ${number(list.length)} 个工程有完整历史${list.length ? ` · 覆盖 ${(week.length / list.length * 100).toFixed(1)}%` : ''}`;
  $('#mobileMetricSummary').textContent = `${compact(list.length)} 个工程 · 历史覆盖 ${list.length ? (week.length / list.length * 100).toFixed(1) : '0'}%`;
  const last = S.snapshot.lastUpdated || S.snapshot.fetchedAt;
  $('#lastUpdated').textContent = last ? `${timeAgo(last)}采样` : '采样时间未记录';
  $('#footerUpdated').textContent = validDate(last) ? new Date(last).toLocaleString('zh-CN', { hour12: false }) : '仅有历史日期，未记录准确时间';
  $('#sidebarUpdated').textContent = last ? `最近采样 ${timeAgo(last)}` : '采样时间未记录';
  $('#sourceLabel').textContent = S.busy ? '正在获取 GitHub 数据' : S.liveCount ? 'GitHub API · 部分样本已更新' : '已保存的 GitHub 快照';
  const base = S.liveCount ? `本次成功获取 ${S.liveCount} 个仓库；其余保留已保存快照。` : '当前展示已保存快照，刷新后获取公开 API 样本。';
  const notice = S.warning || (S.snapshot.warning ? '保存的快照包含未完成的采集批次；未更新项保留原采样状态。' : '');
  const truncation = S.snapshot.coverage?.truncated ? '搜索只取各范围前 100 个结果。' : '';
  const pending = S.snapshot.coverage?.unverified || 0;
  $('#dataStatus').textContent = `${notice ? `${notice} ` : ''}${base}${truncation}${pending ? `另有 ${pending} 个旧导入候选待核验，暂不参与统计。` : ''} 飙升榜对全部已收录工程按榜单截止时刻前 7/30 个完整统计日官方新增 Stars 排名，不限创建时间；新建榜仅统计对应 3/7/30 个完整统计日内新建的工程。未结束统计日不纳入；缓存按真实完整日截止时间展示，七天以上旧历史不参与。仅收录近三年创建的工程，年度总星榜按 UTC 创建年份各取 Top30。所有榜单均为已收录样本，非 GitHub 全站排名。`;
  $('#historyStatus').textContent = S.activityLoading ? '正在获取 GitHub 官方历史，成功记录会即时展示…' : S.activityCache.status?.message || '优先使用 GitHub 历史缓存；无需从零积累 7/30 天。';
  $('#dataStatus').classList.toggle('has-warning', !!notice);
  $('#provenanceDetails').classList.toggle('has-warning', !!notice);
  $('#provenanceSummary').textContent = notice ? '更新提示 · 查看数据说明' : '数据范围与统计口径';
}
function renderActivity(list) {
  const recent = list.filter((p) => validDate(p.pushedAt) && Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY).sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  markup('#activityList', recent.slice(0, S.activityLimit).map((p, i) => `<div class="activity-item">${row(p, i, 'stars', 'activity')}<span class="activity-time">最近推送 ${esc(timeAgo(p.pushedAt))}</span></div>`).join('') || empty('当前采样中没有已核验的近 24 小时代码更新；这不代表 GitHub 上没有工程更新。'));
  $('#activityExpand').hidden = recent.length <= 5;
  $('#activityExpand').textContent = S.activityLimit >= recent.length ? '收起' : `再显示 ${Math.min(30, recent.length - S.activityLimit)} 个`;
}
function renderCategories() {
  const all = (S.snapshot?.projects || []).filter((p) => p.availability === 'available');
  const groups = CATEGORY_META.map((meta) => ({ ...meta, count: all.filter((p) => p.category === meta.id).length }));
  markup('#categoryTabs', [{ id: 'all', label: '全部', count: all.length }, ...groups].map((c) => `<button class="category-tab ${c.id === S.category ? 'active' : ''}" data-category="${esc(c.id)}" aria-pressed="${c.id === S.category}">${esc(c.label)} <span>${c.count}</span></button>`).join(''));
}
function renderBoard(selector, buttonSelector, entries, field, expanded, limit, fallback) {
  markup(selector, entries.slice(0, expanded ? limit : BOARD_PREVIEW).map((p, i) => row(p, i, field, selector.slice(1))).join('') || fallback);
  const button = $(buttonSelector);
  button.hidden = entries.length <= BOARD_PREVIEW;
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? '收起为前 5 名' : `查看完整 Top${limit}（共 ${entries.length} 个）`;
}
function renderDirectory(list) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  S.browsePage = Math.min(Math.max(S.browsePage, 1), pages);
  const offset = (S.browsePage - 1) * PAGE_SIZE;
  const browse = directoryProjects(list).slice(offset, offset + PAGE_SIZE);
  markup('#repositoryTable', browse.map((p, i) => row(p, offset + i, 'weekAdded')).join('') || empty('没有符合筛选条件的已收录工程。'));
  $('#browseCount').textContent = list.length ? `${offset + 1}–${offset + browse.length} / ${number(list.length)} 个` : '0 个工程';
  $('#pageStatus').textContent = `第 ${S.browsePage} / ${pages} 页`;
  $('#previousPage').disabled = S.browsePage <= 1;
  $('#loadMore').disabled = S.browsePage >= pages;
  $('#loadMore').hidden = pages <= 1;
  $('#previousPage').hidden = pages <= 1;
}
function renderRankings(list) {
  const surgeConfig = SURGE_BOARDS.find((b) => b.days === S.surgeDays) || SURGE_BOARDS[0];
  const surge = selectSurgeProjects(S.snapshot, { ...surgeConfig, category: S.category, query: $('#searchInput').value });
  $('#surgeSubtitle').textContent = `${S.surgeDays} 日增星 · 截至 ${cutoffLabel(surge.windowEnd)} · ${surge.coverage.eligible}/${surge.coverage.candidates} 个可排名 · 样本榜`;
  $('#surgeNote').textContent = surge.windowEnd
    ? `统计至 ${new Date(surge.windowEnd).toLocaleString('zh-CN', { hour12: false })}（不含）。GitHub 官方历史 · 覆盖 ${surge.coverage.eligible}/${surge.coverage.candidates} 个工程，待补 ${surge.coverage.pending} 个；其中 ${surge.coverage.accelerating} 个加速上升（🚀 本周新增 ≥ 上周 3 倍）。样本排行，非全站 Top。`
    : '等待官方统计日界；历史缓存就绪后自动排名。';
  renderBoard('#surgeBoardTable', '#surgeExpand', surge.projects, surgeConfig.field, S.expandedBoards.surge, surgeConfig.limit, empty(
    S.activityLoading ? '正在获取官方历史，成功记录会即时展示。' : S.activityCache.status?.message || '已收录工程的完整官方历史待补齐；限额时可配置 Token 后重试。',
    '暂无历史完整的工程'));
  const newConfig = NEW_GROWTH_BOARDS.find((b) => b.days === S.newDays) || NEW_GROWTH_BOARDS[1];
  const board = selectNewProjectGrowth(S.snapshot, { ...newConfig, category: S.category, query: $('#searchInput').value });
  const { field, coverage } = board;
  const window = board.windowStart ? `${new Date(board.windowStart).toLocaleString('zh-CN', { hour12: false })} 至 ${new Date(board.windowEnd).toLocaleString('zh-CN', { hour12: false })}` : '等待官方统计日界';
  $('#newSubtitle').textContent = `${S.newDays} 日内新建 · 截至 ${cutoffLabel(board.windowEnd)} · ${coverage.eligible}/${coverage.candidates} 个可排名 · 样本榜`;
  $('#newNote').textContent = `${window}（结束时刻不含）。GitHub 官方历史 · 覆盖 ${coverage.eligible}/${coverage.candidates} 个新建工程，待补 ${coverage.pending} 个${coverage.windowPending ? `；另有 ${coverage.windowPending} 个近期工程等待确定日界` : ''}；当前筛选 ${coverage.createdAtUnknown} 个创建时间未知。样本排行，非全站 Top。`;
  renderBoard('#newBoardTable', '#newExpand', board.projects, field, S.expandedBoards.new, newConfig.limit, empty(
    S.activityLoading ? '正在获取官方历史，成功记录会即时展示。' : S.activityCache.status?.message || (coverage.candidates || coverage.windowPending ? '新建候选的完整官方历史待补齐；限额时可配置 Token 后重试。' : '当前窗口没有符合筛选条件且历史完整的新建工程。'),
    coverage.candidates || coverage.windowPending ? '新建工程历史待获取' : '暂无匹配的新建工程'));
  markup('#opportunityTable', sorted(list, 'opportunityScore', 10).map((p, i) => row(p, i, 'opportunityScore', 'opportunity')).join('') || empty('研究评分所需的增长或活跃度数据不足，暂不排名。', '等待完整研究数据'));
  renderYearly(list);
  renderDirectory(list);
}
function renderYearly(list) {
  const groups = selectYearlyTop30(S.snapshot, { category: S.category, query: $('#searchInput').value });
  const openYears = new Set($$('#yearlyBoard details[open]').map(element => Number(element.dataset.year)));
  const initialized = $('#yearlyBoard').dataset.initialized === 'true';
  markup('#yearlyBoard', groups.map((g, i) => `<details class="yearly-group" data-year="${g.year}" ${initialized ? openYears.has(g.year) ? 'open' : '' : i === 0 ? 'open' : ''}><summary class="yearly-group-head"><strong>${g.year} 年新建工程 <span class="top-badge">TOP 30</span></strong><span>${g.projects.length} / ${g.coverage.eligible} 个</span></summary><p class="panel-note">${i === 0 ? '本年度截至最近成功采样；' : ''}按当前累计 Stars 排序 · 当前筛选 ${g.coverage.candidates} 个该年工程 · ${g.coverage.candidates - g.coverage.eligible} 个总 Stars 待补</p>${g.projects.map((p, index) => row(p, index, 'stars', `year-${g.year}`)).join('') || empty(`${g.year} 年暂无符合筛选且创建日期与总 Stars 已核验的工程。`)}</details>`).join(''));
  $('#yearlyBoard').dataset.initialized = 'true';
}
function renderAll() {
  if (!S.snapshot) return;
  // 原生 details 的 toggle 事件可能晚于数据进度回调，直接保留当前展开状态。
  S.openRowDetails.clear();
  $$('.repo-extra[open]').forEach(details => S.openRowDetails.add(details.dataset.key));
  const focusedDetails = document.activeElement?.closest?.('.repo-extra');
  const focusedProject = focusedDetails?.dataset.project;
  const focusedRegion = focusedDetails?.closest('.ranking-table, .activity-list')?.id;
  // 数据补齐会改变上方榜单高度，保持正在阅读的区域在原位置。
  const readingAnchor = S.hasRendered && window.scrollY > 0
    ? $$('.surge-panel, #rankings, #directory, #morePanel').find(element => element.getBoundingClientRect().bottom > $('.topbar').getBoundingClientRect().bottom)
    : null;
  const anchorTop = readingAnchor?.getBoundingClientRect().top;
  S.activityCache = mergeStarActivity(S.activityCache, S.snapshot.starActivity);
  S.snapshot = assembleSnapshot(S.snapshot.projects, { history: S.snapshot.history, starActivity: S.activityCache, fetchedAt: S.snapshot.lastUpdated, source: S.snapshot.source, coverage: S.snapshot.coverage, warning: S.snapshot.warning });
  S.activityCache = S.snapshot.starActivity;
  const list = projects();
  renderMetrics(list); renderCategories(); renderActivity(list); renderRankings(list);
  if (readingAnchor) {
    const shift = readingAnchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(shift) > 1) window.scrollBy({ top: shift, behavior: 'instant' });
  }
  if (focusedRegion && focusedProject) $$(`#${focusedRegion} .repo-extra`).find(details => details.dataset.project === focusedProject)?.querySelector('summary')?.focus({ preventScroll: true });
  S.hasRendered = true;
}

/* ============================================================
 * 数据刷新
 * ============================================================ */
async function refresh({ silent = false } = {}) {
  if (S.busy) return;
  S.busy = true; $('#refreshButton').disabled = true; $('#refreshButton').classList.add('loading');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    try {
      const saved = await loadDashboardData({ signal: controller.signal });
      if (!S.snapshot) S.snapshot = saved;
      else {
        const merged = mergeRepositoryStates({ ...S.snapshot, starActivity: S.activityCache }, saved);
        const fetchedAt = [S.snapshot.lastUpdated, saved.lastUpdated].filter(validDate).sort().at(-1) || null;
        S.snapshot = assembleSnapshot(merged.projects, { history: merged.history, starActivity: merged.starActivity, fetchedAt, source: S.snapshot.source, coverage: S.snapshot.coverage, warning: saved.warning });
        S.activityCache = S.snapshot.starActivity;
      }
    } catch (error) { if (!S.snapshot) S.snapshot = assembleSnapshot([], { warning: error.message }); }
    renderAll();
    const rows = await fetchGitHubProjects({ token: S.token, queries: liveQueries(), maxPages: 1, signal: controller.signal });
    S.discoveryYearCursor += 1;
    if (!rows.length) throw new Error('GitHub 未返回可用仓库');
    const merged = mergeRepositoryStates({ ...S.snapshot, starActivity: S.activityCache }, { projects: rows });
    const next = assembleSnapshot(merged.projects, { history: merged.history, starActivity: merged.starActivity, source: 'live-sample', fetchedAt: new Date().toISOString(), coverage: rows.coverage || {} });
    S.snapshot = next;
    S.activityCache = next.starActivity;
    S.liveCount = rows.length;
    S.warning = rows.coverage?.warning || '';
    renderAll();
    if (!silent) toast(`已获取 ${rows.length} 个公开仓库，历史不足的指标保持未知。`);
  } catch (error) {
    S.warning = `更新未完成：${error.name === 'AbortError' ? '请求超时' : error.message}。保留最近可用快照。`;
    if (!silent) toast(S.warning);
    if (!S.snapshot) $('#dataStatus').textContent = S.warning;
  } finally {
    clearTimeout(timeout);
    if (S.snapshot?.projects.length) {
      S.activityLoading = true; renderAll();
      try {
        S.activityCache = await refreshStarActivity(S.snapshot.projects, S.activityCache, { token: S.token, force: S.retryHistoryWithNewToken, limit: S.token ? 120 : 40, maxRuntimeMs: 45000,
          onProgress: (cache) => { S.activityCache = cache; S.snapshot.starActivity = cache; renderAll(); } });
        S.snapshot.starActivity = S.activityCache;
        try { localStorage.setItem('githubPulse.starActivity.v1', JSON.stringify(S.activityCache)); } catch { /* Storage full or disabled: keep memory cache. */ }
      } catch { S.activityCache.status = { ...S.activityCache.status, message: '官方历史暂不可用；保留最近成功缓存' }; }
      S.activityLoading = false;
      S.retryHistoryWithNewToken = false;
    }
    S.busy = false; $('#refreshButton').disabled = false; $('#refreshButton').classList.remove('loading'); renderAll();
  }
}
function setToken(value) { const next = String(value || '').trim(); if (next && next !== S.token) S.retryHistoryWithNewToken = true; S.token = next; try { if (S.token) sessionStorage.setItem('githubPulse.token', S.token); else sessionStorage.removeItem('githubPulse.token'); } catch {} }

/* ============================================================
 * 事件绑定
 * ============================================================ */
$('#refreshButton').addEventListener('click', () => {
  // The help page owns the token field now; pick up anything saved there in this tab.
  try { const stored = sessionStorage.getItem('githubPulse.token') || ''; if (stored !== S.token) setToken(stored); } catch { /* storage disabled */ }
  refresh();
});
function resetBrowsing() { S.browsePage = 1; S.activityLimit = 5; S.expandedBoards.surge = false; S.expandedBoards.new = false; }
$('#searchInput').addEventListener('input', () => { clearTimeout(S.searchTimer); S.searchTimer = setTimeout(() => { resetBrowsing(); renderAll(); }, 150); });
$('#searchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#repositoryTable a')?.click(); });
function changePage(direction) {
  S.browsePage += direction;
  renderDirectory(projects());
  $('#directory').scrollIntoView?.({ block: 'start' });
  $('#directory').focus({ preventScroll: true });
}
$('#loadMore').addEventListener('click', () => changePage(1));
$('#previousPage').addEventListener('click', () => changePage(-1));
$('#activityExpand').addEventListener('click', () => {
  const count = projects().filter(p => validDate(p.pushedAt) && Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY).length;
  S.activityLimit = S.activityLimit >= count ? 5 : S.activityLimit + 30;
  renderActivity(projects());
});
$('#categoryTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-category]'); if (button) { S.category = button.dataset.category; resetBrowsing(); renderAll(); $(`#categoryTabs [data-category="${S.category}"]`)?.focus({ preventScroll: true }); } });
$('#surgeTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-days]'); if (!button) return; S.surgeDays = Number(button.dataset.days); S.expandedBoards.surge = false; $$('#surgeTabs .category-tab').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); }); renderAll(); });
$('#newTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-days]'); if (!button) return; S.newDays = Number(button.dataset.days); S.expandedBoards.new = false; $$('#newTabs .category-tab').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); }); renderAll(); });
for (const [key, table, trigger, heading] of [['surge', '#surgeBoardTable', '#surgeExpand', '#surging'], ['new', '#newBoardTable', '#newExpand', '#rankings']]) {
  $(trigger).addEventListener('click', () => {
    S.expandedBoards[key] = !S.expandedBoards[key];
    renderRankings(projects());
    if (S.expandedBoards[key]) $(table).querySelector?.('.repo-row:nth-child(6) .repo-link')?.focus();
    else { $(heading).scrollIntoView?.({ block: 'start' }); $(heading).focus({ preventScroll: true }); }
  });
}
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (details.matches?.('.repo-extra')) {
    if (details.open) S.openRowDetails.add(details.dataset.key);
    else S.openRowDetails.delete(details.dataset.key);
  }
}, true);
$('#themeToggle').addEventListener('click', () => { const light = document.body.classList.toggle('light'); try { localStorage.setItem('githubPulse.theme', light ? 'light' : 'dark'); } catch {} });
$('#translateButton').addEventListener('click', async () => {
  if (!S.snapshot) return;
  const button = $('#translateButton'); button.disabled = true;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
  try { const result = await translateProjects(directoryProjects(projects()).slice((S.browsePage - 1) * PAGE_SIZE, S.browsePage * PAGE_SIZE), { signal: controller.signal }); renderAll();
    const used = Object.entries(result.providers || {}).filter(([, n]) => n).map(([name]) => name === 'google' ? 'Google 翻译' : 'MyMemory');
    toast(`已翻译 ${result.translated}/${result.total} 条描述${used.length ? `（${used.join('、')}）` : ''}；未成功的保留原文。`); }
  catch { toast('翻译服务暂不可用，保留原文。'); }
  finally { clearTimeout(timeout); button.disabled = false; }
});

/* ============================================================
 * 导航（hash / 滚动 / 响应式）
 * ============================================================ */
const viewLabels = { surging: '飙升榜', rankings: '新建工程榜', directory: '工程目录', more: '更多视角' };
function markNavigation(view) {
  $$('.nav-item[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current');
  });
  $('.breadcrumb strong').textContent = viewLabels[view];
}
function syncNavigation() {
  const hash = window.location?.hash.slice(1);
  if (hash === 'trend') window.history?.replaceState(null, '', '#surging');
  const view = viewLabels[hash] ? hash : 'surging';
  if (view === 'more') $('#morePanel').open = true;
  markNavigation(view);
}
window.addEventListener?.('hashchange', syncNavigation);
syncNavigation();
function alignInitialNavigation() {
  const view = window.location?.hash.slice(1);
  if (S.snapshot && viewLabels[view]) $(`#${view}`).scrollIntoView?.({ block: 'start', behavior: 'instant' });
}
window.addEventListener?.('load', () => window.requestAnimationFrame?.(alignInitialNavigation), { once: true });
// 按实际滚动位置更新导航，不向浏览器历史追加滚动记录。
if (window.requestAnimationFrame) {
  let scrollScheduled = false;
  const updateNavigation = () => {
    scrollScheduled = false;
    const offset = $('.topbar').getBoundingClientRect().bottom + 32;
    let view = 'surging';
    for (const id of Object.keys(viewLabels)) {
      if ($(`#${id}`).getBoundingClientRect().top <= offset) view = id;
    }
    markNavigation(view);
  };
  window.addEventListener('scroll', () => {
    if (!scrollScheduled) { scrollScheduled = true; window.requestAnimationFrame(updateNavigation); }
  }, { passive: true });
}
if (window.matchMedia) {
  const mobile = window.matchMedia('(max-width: 700px)');
  const updateMetrics = () => { $('#metricsDisclosure').open = !mobile.matches; };
  updateMetrics();
  mobile.addEventListener('change', updateMetrics);
}
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');
if (!isMac) $('#searchKbd').textContent = 'Ctrl K';
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });

/* ============================================================
 * 启动与对外 API
 * ============================================================ */
window.githubPulse = { getSnapshot: () => S.snapshot, refresh, setToken };
try {
  S.snapshot = await loadDashboardData(); renderAll();
  // 快照就绪后再定位深链接，避免占位内容被榜单撑开后锚点偏移。
  alignInitialNavigation();
} catch (error) { S.warning = `快照加载失败：${error.message}`; }
refresh({ silent: true });
setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, 30 * 60000);
setInterval(() => { if (S.snapshot && !S.busy) renderAll(); }, 60000);
