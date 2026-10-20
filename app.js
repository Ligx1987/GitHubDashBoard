import { CATEGORY_META, NEW_GROWTH_BOARDS, SURGE_BOARDS, selectNewProjectGrowth, selectSurgeProjects, selectYearlyTop30, discoverySearchPlan, assembleSnapshot, fetchGitHubProjects, loadDashboardData, translateProjects, refreshStarActivity, mergeStarActivity, emptyStarActivity, buildAddedTrend } from './src/data/github-data.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DAY = 86400000;
let discoveryYearCursor = 0;
const liveQueries = () => {
  const plan = discoverySearchPlan();
  const years = plan.filter(item => item.kind === 'year');
  return [...plan.slice(0, 3), years[discoveryYearCursor % years.length]].map(item => item.query);
};
const known = (value) => typeof value === 'number' && Number.isFinite(value);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => known(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
const delta = (value) => known(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '暂无基线';
const validDate = (value) => value && Number.isFinite(Date.parse(value));
const timeAgo = (value) => {
  if (!validDate(value)) return '采样时间未知';
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  return elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} 分钟前` : elapsed < DAY ? `${Math.floor(elapsed / 3600000)} 小时前` : `${Math.floor(elapsed / DAY)} 天前`;
};
const safeUrl = (project) => /^[-\w.]+\/[-\w.]+$/.test(project.fullName || '') ? `https://github.com/${project.fullName}` : 'https://github.com/';
const empty = (message, title = '暂无匹配工程') => `<div class="empty-state"><span class="empty-icon" aria-hidden="true">◷</span><strong class="empty-title">${esc(title)}</strong><span class="empty-copy">${esc(message)}</span></div>`;
let snapshot = null;
let category = 'all';
let browseLimit = 30;
let expandedActivity = false;
let surgeDays = 7;
let newDays = 7;
let busy = false;
let warning = '';
let toastTimer;
let liveCount = 0;
let token = '';
let retryHistoryWithNewToken = false;
let growthMode = 'added';
let activityLoading = false;
let activityCache = emptyStarActivity();
try {
  const cached = JSON.parse(localStorage.getItem('githubPulse.starActivity.v1') || 'null');
  if (cached?.schemaVersion === 1 && cached.repositories && !Array.isArray(cached.repositories)) activityCache = cached;
} catch { /* Ignore broken or unavailable optional cache. */ }
try {
  // Migrate the old persistent token into this tab's session; never render its value.
  token = sessionStorage.getItem('githubPulse.token') || localStorage.getItem('githubPulse.token') || '';
  if (token) sessionStorage.setItem('githubPulse.token', token);
  localStorage.removeItem('githubPulse.token');
  if (localStorage.getItem('githubPulse.theme') === 'light') document.body.classList.add('light');
} catch { /* Browser storage can be disabled. */ }

function projects() {
  const query = $('#searchInput').value.trim().toLowerCase();
  return (snapshot?.projects || []).filter((project) => project.availability === 'available')
    .filter((project) => category === 'all' || project.category === category)
    .filter((project) => !query || [project.fullName, project.name, project.description, project.descriptionZh, project.originalDescription, project.language, project.categoryLabel, ...(project.categoryTagLabels || []), ...(project.topics || [])].join(' ').toLowerCase().includes(query));
}
const sorted = (list, field, limit) => list.filter((project) => known(project[field])).slice().sort((a, b) => b[field] - a[field] || (b.stars || 0) - (a.stars || 0) || a.fullName.localeCompare(b.fullName)).slice(0, limit);
function row(project, index, field = 'stars') {
  const growth = ['weekStars', 'monthStars', 'threeDayAdded', 'weekAdded', 'monthAdded'].includes(field);
  const created = validDate(project.createdAt) ? project.createdAt.slice(0, 10) : '创建日期待核验';
  const sampled = field.endsWith('Added') ? `GitHub 历史 · ${timeAgo(project.activityFetchedAt)}` : validDate(project.fetchedAt) ? timeAgo(project.fetchedAt) : project.sampleDate ? `${project.sampleDate} 快照` : '采样时间未知';
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
    ? `<span class="accel-badge" title="本周官方新增达到上周 3 倍以上">🚀 ${project.accelerationRatio !== null ? `×${project.accelerationRatio >= 10 ? Math.round(project.accelerationRatio) : project.accelerationRatio.toFixed(1)}` : '新爆发'}</span>` : '';
  return `<a class="repo-row" href="${esc(safeUrl(project))}" target="_blank" rel="noopener noreferrer">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <div class="repo-details"><div class="repo-name"><strong>${esc(project.fullName)}</strong>${accel}</div><div class="repo-desc"${originalTooltip}>${esc(displayDescription)}</div><div class="repo-meta">${categoryChip}${categoryTags}<span class="lang-chip">${esc(project.language || '未知语言')}</span><span class="license-chip ${risk ? 'risky' : ''}">${esc(license)}</span></div><div class="repo-signals"><span class="created-date">创建于 ${esc(created)} · </span>采样于 ${esc(sampled)}${translated ? ' · 机器翻译' : ''}</div></div>
    <div class="repo-stats"><span class="stars" aria-label="${number(project.stars)} Stars"><span class="stars-icon" aria-hidden="true">☆</span>${number(project.stars)}</span><span class="forks" aria-label="${number(project.forks)} Forks">⑂ ${number(project.forks)}</span>${growth ? `<span class="delta ${project[field] < 0 ? 'negative' : ''}">${delta(project[field])}</span>` : ''}${field === 'opportunityScore' ? `<span class="score-badge">评分 ${number(project.opportunityScore)}</span>` : ''}</div>
  </a>`;
}
function renderMetrics(list) {
  const field = growthMode === 'added' ? 'weekAdded' : 'weekStars';
  const week = list.filter((p) => known(p[field]));
  const pushes = list.filter((p) => validDate(p.pushedAt));
  const recent = pushes.filter((p) => Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY);
  $('#trackedCount').textContent = number(list.length);
  $('#newToday').textContent = pushes.length ? number(recent.length) : '—';
  $('#activityCoverage').textContent = `${pushes.length}/${list.length} 个仓库有已核验的推送时间`;
  $('#weeklyStars').textContent = week.length ? delta(week.reduce((sum, p) => sum + p[field], 0)) : growthMode === 'added' ? '待获取' : '暂无基线';
  $('#growthMetricLabel').textContent = growthMode === 'added' ? '筛选样本 · 一周新增 Stars' : '筛选样本 · 一周净增 Stars';
  $('#growthCoverage').textContent = `覆盖 ${week.length}/${list.length} 个工程 · ${growthMode === 'added' ? 'GitHub 官方历史' : '本地快照差值'}`;
  const last = snapshot.lastUpdated || snapshot.fetchedAt;
  $('#lastUpdated').textContent = last ? `${timeAgo(last)}采样` : '采样时间未记录';
  $('#footerUpdated').textContent = validDate(last) ? new Date(last).toLocaleString('zh-CN', { hour12: false }) : '仅有历史日期，未记录准确时间';
  $('#sidebarUpdated').textContent = last ? `最近采样 ${timeAgo(last)}` : '采样时间未记录';
  $('#sourceLabel').textContent = busy ? '正在获取 GitHub 数据' : liveCount ? 'GitHub API · 部分样本已更新' : '已保存的 GitHub 快照';
  const base = liveCount ? `本次成功获取 ${liveCount} 个仓库；其余保留已保存快照。` : '当前展示已保存快照，刷新后获取公开 API 样本。';
  const notice = warning || (snapshot.warning ? '保存的快照包含未完成的采集批次；未更新项保留原采样状态。' : '');
  const truncation = snapshot.coverage?.truncated ? '搜索只取各范围前 100 个结果。' : '';
  const pending = snapshot.coverage?.unverified || 0;
  $('#dataStatus').textContent = `${notice ? `${notice} ` : ''}${base}${truncation}${pending ? `另有 ${pending} 个旧导入候选待核验，暂不参与统计。` : ''} 飙升榜对全部已收录工程按近 7/30 个完整统计日官方新增 Stars 排名，不限创建时间；增星主榜仅统计对应 3/7/30 个完整统计日内新建的工程。当前未结束统计日新建项次日再纳入。仅收录近三年创建的工程（滚动窗口，超龄自动移除），年度总星榜按窗口内 UTC 创建年份各取 Top30。浏览器每批发现三个近期窗口及一个年度，四个年度分批轮换。辅助净增不改变主榜。所有榜单均为已收录样本，非 GitHub 全站排名。`;
  $('#historyStatus').textContent = activityLoading ? '正在获取 GitHub 官方历史，成功记录会即时展示…' : activityCache.status?.message || '优先使用 GitHub 历史缓存；无需从零积累 7/30 天。';
  $('#dataStatus').classList.toggle('has-warning', !!notice);
  $('#provenanceDetails').classList.toggle('has-warning', !!notice);
  $('#provenanceSummary').textContent = notice ? '更新提示 · 查看数据说明' : '数据范围与统计口径';
}
function renderActivity(list) {
  const recent = list.filter((p) => validDate(p.pushedAt) && Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY).sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  $('#activityList').innerHTML = recent.slice(0, expandedActivity ? recent.length : 5).map((p, i) => `<div class="activity-item">${row(p, i)}<span class="activity-time">最近推送 ${esc(timeAgo(p.pushedAt))}</span></div>`).join('') || empty('当前采样中没有已核验的近 24 小时代码更新；这不代表 GitHub 上没有工程更新。');
  $('#activityExpand').textContent = expandedActivity ? '收起' : `查看全部 ${recent.length} 个`;
}
function renderChart(list) {
  const series = growthMode === 'added' ? buildAddedTrend(list) : assembleSnapshot(list, { history: snapshot.history || {}, now: Date.now() }).trendSeries;
  const values = series?.values || Array(7).fill(null);
  const dates = series?.dates || series?.labels || [];
  const counts = series?.coverage || [];
  const scale = Math.max(1, ...values.filter(known).map(Math.abs));
  $('#trendChart').innerHTML = values.map((value, i) => `<div class="observed-day"><span class="observed-number">${known(value) ? esc(delta(value)) : '—'}</span><div class="observed-track">${known(value) ? `<div class="observed-bar ${value < 0 ? 'negative' : ''}" style="height:${Math.max(2, Math.abs(value) / scale * 100)}%"></div>` : '<span class="missing-bar">缺测</span>'}</div><span>${esc(String(dates[i] || '').slice(-5))}</span><small>${number(counts[i] || 0)} 个样本</small></div>`).join('');
  $('#trendTitle').textContent = growthMode === 'added' ? '一周新增走势' : '一周净增走势';
  $('#trendPeriod').textContent = growthMode === 'added' ? 'GitHub 统计日' : 'UTC · 7 天';
  $('#trendNote').textContent = growthMode === 'added' ? '最近 7 个完整 GitHub 统计日的新增 Stars；仅汇总统计日界一致且历史完整的工程。缺测不补零。' : '逐日比较同一仓库相邻 UTC 日期的真实采样；负值为净减少。各日覆盖数量可能不同，缺测不补零。';
}
function renderCategories() {
  const all = (snapshot?.projects || []).filter((p) => p.availability === 'available');
  const groups = CATEGORY_META.map((meta) => ({ ...meta, count: all.filter((p) => p.category === meta.id).length }));
  $('#categoryTabs').innerHTML = [{ id: 'all', label: '全部', count: all.length }, ...groups].map((c) => `<button class="category-tab ${c.id === category ? 'active' : ''}" data-category="${esc(c.id)}" aria-pressed="${c.id === category}">${esc(c.label)} <span>${c.count}</span></button>`).join('');
}
function renderRankings(list) {
  const surgeConfig = SURGE_BOARDS.find((b) => b.days === surgeDays) || SURGE_BOARDS[0];
  const surge = selectSurgeProjects(snapshot, { ...surgeConfig, category, query: $('#searchInput').value });
  $('#surgeSubtitle').textContent = `近 ${surgeDays} 个完整统计日 · 不限创建时间 · 新增 Stars`;
  $('#surgeNote').textContent = surge.windowEnd
    ? `统计至 ${new Date(surge.windowEnd).toLocaleString('zh-CN', { hour12: false })}（不含）。GitHub 官方历史 · 覆盖 ${surge.coverage.eligible}/${surge.coverage.candidates} 个工程，待补 ${surge.coverage.pending} 个；其中 ${surge.coverage.accelerating} 个加速上升（🚀 本周新增 ≥ 上周 3 倍）。样本排行，非全站 Top。`
    : '等待官方统计日界；历史缓存就绪后自动排名。';
  $('#surgeBoardTable').innerHTML = surge.projects.map((p, i) => row(p, i, surgeConfig.field)).join('') || empty(
    activityLoading ? '正在获取官方历史，成功记录会即时展示。' : activityCache.status?.message || '已收录工程的完整官方历史待补齐；限额时可配置 Token 后重试。',
    '暂无历史完整的工程');
  const newConfig = NEW_GROWTH_BOARDS.find((b) => b.days === newDays) || NEW_GROWTH_BOARDS[1];
  const board = selectNewProjectGrowth(snapshot, { ...newConfig, category, query: $('#searchInput').value });
  const { field, coverage } = board;
  const window = board.windowStart ? `${new Date(board.windowStart).toLocaleString('zh-CN', { hour12: false })} 至 ${new Date(board.windowEnd).toLocaleString('zh-CN', { hour12: false })}` : '等待官方统计日界';
  $('#newSubtitle').textContent = `近 ${newDays} 个完整统计日新建 · 按窗口新增 Stars 排名`;
  $('#newNote').textContent = `${window}（结束时刻不含）。GitHub 官方历史 · 覆盖 ${coverage.eligible}/${coverage.candidates} 个新建工程，待补 ${coverage.pending} 个${coverage.windowPending ? `；另有 ${coverage.windowPending} 个近期工程等待确定日界` : ''}；当前筛选 ${coverage.createdAtUnknown} 个创建时间未知。样本排行，非全站 Top。`;
  $('#newBoardTable').innerHTML = board.projects.map((p, i) => row(p, i, field)).join('') || empty(
    activityLoading ? '正在获取官方历史，成功记录会即时展示。' : activityCache.status?.message || (coverage.candidates || coverage.windowPending ? '新建候选的完整官方历史待补齐；限额时可配置 Token 后重试。' : '当前窗口没有符合筛选条件且历史完整的新建工程。'),
    coverage.candidates || coverage.windowPending ? '新建工程历史待获取' : '暂无匹配的新建工程');
  $('#opportunityTable').innerHTML = sorted(list, 'opportunityScore', 10).map((p, i) => row(p, i, 'opportunityScore')).join('') || empty('研究评分所需的增长或活跃度数据不足，暂不排名。', '等待完整研究数据');
  renderYearly(list);
  const browse = list.slice().sort((a, b) => (known(b.weekAdded) ? b.weekAdded : -1) - (known(a.weekAdded) ? a.weekAdded : -1) || (known(b.stars) ? b.stars : -1) - (known(a.stars) ? a.stars : -1) || a.fullName.localeCompare(b.fullName)).slice(0, browseLimit);
  $('#repositoryTable').innerHTML = browse.map((p, i) => row(p, i, 'weekAdded')).join('') || empty('没有符合筛选条件的已收录工程。');
  $('#browseCount').textContent = `显示 ${browse.length} / ${list.length} 个`;
  $('#loadMore').hidden = browse.length >= list.length;
}
function renderYearly(list) {
  const groups = selectYearlyTop30(snapshot, { category, query: $('#searchInput').value });
  const openYears = new Set($$('#yearlyBoard details[open]').map(element => Number(element.dataset.year)));
  const initialized = $('#yearlyBoard').dataset.initialized === 'true';
  $('#yearlyBoard').innerHTML = groups.map((g, i) => `<details class="yearly-group" data-year="${g.year}" ${initialized ? openYears.has(g.year) ? 'open' : '' : i === 0 ? 'open' : ''}><summary class="yearly-group-head"><strong>${g.year} 年新建工程 <span class="top-badge">TOP 30</span></strong><span>${g.projects.length} / ${g.coverage.eligible} 个</span></summary><p class="panel-note">${i === 0 ? '本年度截至最近成功采样；' : ''}按当前累计 Stars 排序 · 当前筛选 ${g.coverage.candidates} 个该年工程 · ${g.coverage.candidates - g.coverage.eligible} 个总 Stars 待补</p>${g.projects.map((p, index) => row(p, index)).join('') || empty(`${g.year} 年暂无符合筛选且创建日期与总 Stars 已核验的工程。`)}</details>`).join('');
  $('#yearlyBoard').dataset.initialized = 'true';
}
function renderAll() {
  if (!snapshot) return;
  activityCache = mergeStarActivity(activityCache, snapshot.starActivity);
  snapshot = assembleSnapshot(snapshot.projects, { history: snapshot.history, starActivity: activityCache, fetchedAt: snapshot.lastUpdated, source: snapshot.source, coverage: snapshot.coverage, warning: snapshot.warning });
  const list = projects();
  renderMetrics(list); renderCategories(); renderActivity(list); renderChart(list); renderRankings(list);
}
function toast(message) { clearTimeout(toastTimer); $('#toastMessage').textContent = message; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function mergeRows(before, next) {
  const map = new Map(before.map((p) => [p.fullName.toLowerCase(), p]));
  const timestamp = (p) => Date.parse((p?.availability === 'unavailable' ? p.lastAttemptAt : null) || p?.fetchedAt || p?.sampleDate || '') || 0;
  for (const p of next) { const key = p.fullName.toLowerCase(); if (!map.has(key) || timestamp(p) >= timestamp(map.get(key))) map.set(key, p); }
  return [...map.values()];
}
async function refresh({ silent = false } = {}) {
  if (busy) return;
  busy = true; $('#refreshButton').disabled = true; $('#refreshButton').classList.add('loading');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    try {
      const saved = await loadDashboardData({ signal: controller.signal });
      if (!snapshot) snapshot = saved;
      else {
        const rows = mergeRows(snapshot.projects, saved.projects);
        const fetchedAt = [snapshot.lastUpdated, saved.lastUpdated].filter(validDate).sort().at(-1) || null;
        activityCache = mergeStarActivity(activityCache, saved.starActivity);
        snapshot = assembleSnapshot(rows, { history: saved.history, starActivity: activityCache, fetchedAt, source: snapshot.source, coverage: snapshot.coverage, warning: saved.warning });
      }
    } catch (error) { if (!snapshot) snapshot = assembleSnapshot([], { warning: error.message }); }
    renderAll();
    const rows = await fetchGitHubProjects({ token, queries: liveQueries(), maxPages: 1, signal: controller.signal });
    discoveryYearCursor += 1;
    if (!rows.length) throw new Error('GitHub 未返回可用仓库');
    const history = snapshot?.history || {};
    const next = assembleSnapshot(mergeRows(snapshot?.projects || [], rows), { history, source: 'live-sample', fetchedAt: new Date().toISOString(), coverage: rows.coverage || {} });
    next.history = history;
    snapshot = next;
    liveCount = rows.length;
    warning = rows.coverage?.warning || '';
    renderAll();
    if (!silent) toast(`已获取 ${rows.length} 个公开仓库，历史不足的指标保持未知。`);
  } catch (error) {
    warning = `更新未完成：${error.name === 'AbortError' ? '请求超时' : error.message}。保留最近可用快照。`;
    if (!silent) toast(warning);
    if (!snapshot) $('#dataStatus').textContent = warning;
  } finally {
    clearTimeout(timeout);
    if (snapshot?.projects.length) {
      activityLoading = true; renderAll();
      try {
        activityCache = await refreshStarActivity(snapshot.projects, activityCache, { token, force: retryHistoryWithNewToken, limit: token ? 120 : 40, maxRuntimeMs: 45000,
          onProgress: (cache) => { activityCache = cache; snapshot.starActivity = cache; renderAll(); } });
        snapshot.starActivity = activityCache;
        try { localStorage.setItem('githubPulse.starActivity.v1', JSON.stringify(activityCache)); } catch { /* Storage full or disabled: keep memory cache. */ }
      } catch { activityCache.status = { ...activityCache.status, message: '官方历史暂不可用；保留最近成功缓存' }; }
      activityLoading = false;
      retryHistoryWithNewToken = false;
    }
    busy = false; $('#refreshButton').disabled = false; $('#refreshButton').classList.remove('loading'); renderAll();
  }
}
function setToken(value) { const next = String(value || '').trim(); if (next && next !== token) retryHistoryWithNewToken = true; token = next; try { if (token) sessionStorage.setItem('githubPulse.token', token); else sessionStorage.removeItem('githubPulse.token'); } catch {} }
$('#refreshButton').addEventListener('click', () => {
  // The help page owns the token field now; pick up anything saved there in this tab.
  try { const stored = sessionStorage.getItem('githubPulse.token') || ''; if (stored !== token) setToken(stored); } catch { /* storage disabled */ }
  refresh();
});
$('#searchInput').addEventListener('input', () => { browseLimit = 30; renderAll(); });
$('#searchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#repositoryTable a')?.click(); });
$('#loadMore').addEventListener('click', () => { browseLimit += 30; renderRankings(projects()); });
$('#activityExpand').addEventListener('click', () => { expandedActivity = !expandedActivity; renderActivity(projects()); });
$('#categoryTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-category]'); if (button) { category = button.dataset.category; browseLimit = 30; renderAll(); } });
$('#surgeTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-days]'); if (!button) return; surgeDays = Number(button.dataset.days); $$('#surgeTabs .category-tab').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); }); renderAll(); });
$('#newTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-days]'); if (!button) return; newDays = Number(button.dataset.days); $$('#newTabs .category-tab').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); }); renderAll(); });
$('#growthMode').addEventListener('change', (event) => { growthMode = event.target.value === 'net' ? 'net' : 'added'; renderAll(); });
$('#themeToggle').addEventListener('click', () => { const light = document.body.classList.toggle('light'); try { localStorage.setItem('githubPulse.theme', light ? 'light' : 'dark'); } catch {} });
function syncNavigation() {
  const labels = { surging: '飙升榜', rankings: '新建工程榜', trend: '一周趋势', directory: '工程目录', more: '更多视角' };
  const hash = window.location?.hash.slice(1);
  const view = labels[hash] ? hash : 'surging';
  $$('.nav-item[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current');
  });
  $('.breadcrumb strong').textContent = labels[view];
}
window.addEventListener?.('hashchange', syncNavigation);
syncNavigation();
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });
$('#translateButton').addEventListener('click', async () => {
  if (!snapshot) return;
  const button = $('#translateButton'); button.disabled = true;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
  try { const result = await translateProjects(projects().slice(0, browseLimit), { signal: controller.signal }); renderAll(); toast(`已翻译 ${result.translated}/${result.total} 条描述（MyMemory）；未成功的保留原文。`); }
  catch { toast('翻译服务暂不可用，保留原文。'); }
  finally { clearTimeout(timeout); button.disabled = false; }
});
window.githubPulse = { getSnapshot: () => snapshot, refresh, setToken };
try { snapshot = await loadDashboardData(); renderAll(); } catch (error) { warning = `快照加载失败：${error.message}`; }
refresh({ silent: true });
setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, 30 * 60000);
setInterval(() => { if (snapshot && !busy) renderAll(); }, 60000);
