import { CATEGORY_META, assembleSnapshot, fetchGitHubProjects, loadDashboardData, translateProjects } from './src/data/github-data.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DAY = 86400000;
const liveQueries = () => ['stars:>1000', ...[7, 30, 90].map((days) => `created:>=${new Date(Date.now() - days * DAY).toISOString().slice(0, 10)} stars:>10`)];
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
let newDays = 7;
let year = new Date().getUTCFullYear();
let browseLimit = 30;
let expandedActivity = false;
let busy = false;
let warning = '';
let toastTimer;
let liveCount = 0;
let token = '';
try {
  // Migrate the old persistent token into this tab's session; never render its value.
  token = sessionStorage.getItem('githubPulse.token') || localStorage.getItem('githubPulse.token') || '';
  if (token) sessionStorage.setItem('githubPulse.token', token);
  localStorage.removeItem('githubPulse.token');
  if (localStorage.getItem('githubPulse.theme') === 'light') document.body.classList.add('light');
} catch { /* Browser storage can be disabled. */ }
$('#tokenInput').placeholder = token ? '本会话已配置 Token（可重新输入）' : '公开数据无需 Token';

function projects() {
  const query = $('#searchInput').value.trim().toLowerCase();
  return (snapshot?.projects || []).filter((project) => project.availability === 'available')
    .filter((project) => category === 'all' || project.category === category)
    .filter((project) => !query || [project.fullName, project.name, project.description, project.originalDescription, project.language, ...(project.topics || [])].join(' ').toLowerCase().includes(query));
}
const sorted = (list, field, limit) => list.filter((project) => known(project[field])).slice().sort((a, b) => b[field] - a[field] || (b.stars || 0) - (a.stars || 0) || a.fullName.localeCompare(b.fullName)).slice(0, limit);
function row(project, index, field = 'stars') {
  const growth = field === 'weekStars' || field === 'monthStars';
  const created = validDate(project.createdAt) ? project.createdAt.slice(0, 10) : '创建日期待核验';
  const sampled = validDate(project.fetchedAt) ? timeAgo(project.fetchedAt) : project.sampleDate ? `${project.sampleDate} 快照` : '采样时间未知';
  const license = project.license && project.license !== 'NOASSERTION' ? project.license : '许可证未知';
  const risk = project.licenseRisk === 'unknown' || project.licenseRisk === 'risky';
  return `<a class="repo-row" href="${esc(safeUrl(project))}" target="_blank" rel="noopener noreferrer">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <div class="repo-details"><div class="repo-name"><strong>${esc(project.fullName)}</strong></div><div class="repo-desc">${esc(project.description || '暂无描述')}</div><div class="repo-meta"><span class="lang-chip">${esc(project.language || '未知语言')}</span><span class="license-chip ${risk ? 'risky' : ''}">${esc(license)}</span></div><div class="repo-signals"><span class="created-date">创建于 ${esc(created)} · </span>采样于 ${esc(sampled)}${project.originalDescription ? ' · 机器翻译' : ''}</div></div>
    <div class="repo-stats"><span class="stars" aria-label="${number(project.stars)} Stars"><span class="stars-icon" aria-hidden="true">☆</span>${number(project.stars)}</span><span class="forks" aria-label="${number(project.forks)} Forks">⑂ ${number(project.forks)}</span>${growth ? `<span class="delta ${project[field] < 0 ? 'negative' : ''}">${delta(project[field])}</span>` : ''}${field === 'opportunityScore' ? `<span class="score-badge">评分 ${number(project.opportunityScore)}</span>` : ''}</div>
  </a>`;
}
function renderMetrics(list) {
  const week = list.filter((p) => known(p.weekStars));
  const pushes = list.filter((p) => validDate(p.pushedAt));
  const recent = pushes.filter((p) => Date.now() - Date.parse(p.pushedAt) >= 0 && Date.now() - Date.parse(p.pushedAt) <= DAY);
  const fresh = list.filter((p) => validDate(p.fetchedAt) && Date.now() - Date.parse(p.fetchedAt) >= 0 && Date.now() - Date.parse(p.fetchedAt) <= DAY);
  $('#trackedCount').textContent = number(list.length);
  $('#newToday').textContent = pushes.length ? number(recent.length) : '—';
  $('#activityCoverage').textContent = `${pushes.length}/${list.length} 个仓库有已核验的推送时间`;
  $('#weeklyStars').textContent = week.length ? delta(week.reduce((sum, p) => sum + p.weekStars, 0)) : '暂无基线';
  $('#growthCoverage').textContent = `仅统计 ${week.length}/${list.length} 个具备 7 天基线的仓库`;
  $('#freshCount').textContent = `${fresh.length}/${list.length}`;
  const last = snapshot.lastUpdated || snapshot.fetchedAt;
  $('#lastUpdated').textContent = last ? `${timeAgo(last)}采样` : '采样时间未记录';
  $('#footerUpdated').textContent = validDate(last) ? new Date(last).toLocaleString('zh-CN', { hour12: false }) : '仅有历史日期，未记录准确时间';
  $('#sourceLabel').textContent = busy ? '正在获取 GitHub 数据' : liveCount ? 'GitHub API · 部分样本已更新' : '已保存的 GitHub 快照';
  const base = liveCount ? `本次成功获取 ${liveCount} 个仓库；其余保留已保存快照。` : '当前展示已保存快照，刷新后获取公开 API 样本。';
  const notice = warning || (snapshot.warning ? '保存的快照包含未完成的采集批次；未更新项保留原采样状态。' : '');
  const truncation = snapshot.coverage?.truncated ? '搜索只取各范围前 100 个结果。' : '';
  const pending = snapshot.coverage?.unverified || 0;
  $('#dataStatus').textContent = `${notice ? `${notice} ` : ''}${base}${truncation}${pending ? `另有 ${pending} 个旧导入候选待核验，暂不参与统计。` : ''} 周/月榜按相隔 7/30 个 UTC 日期的采样净增排名，并非精确到小时；历史不足不参与。`;
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
  const series = assembleSnapshot(list, { history: snapshot.history || {}, now: Date.now() }).trendSeries;
  const values = series?.values || Array(7).fill(null);
  const dates = series?.dates || series?.labels || [];
  const counts = series?.coverage || [];
  const scale = Math.max(1, ...values.filter(known).map(Math.abs));
  $('#trendChart').innerHTML = values.map((value, i) => `<div class="observed-day"><span class="observed-number">${known(value) ? esc(delta(value)) : '—'}</span><div class="observed-track">${known(value) ? `<div class="observed-bar ${value < 0 ? 'negative' : ''}" style="height:${Math.max(2, Math.abs(value) / scale * 100)}%"></div>` : '<span class="missing-bar">缺测</span>'}</div><span>${esc(String(dates[i] || '').slice(-5))}</span><small>${number(counts[i] || 0)} 个样本</small></div>`).join('');
  $('#trendNote').textContent = '逐日比较同一仓库相邻 UTC 日期的真实采样；负值为净减少。各日覆盖数量可能不同，缺测不补零。';
}
function renderCategories() {
  const all = (snapshot?.projects || []).filter((p) => p.availability === 'available');
  const groups = CATEGORY_META.map((meta) => ({ ...meta, count: all.filter((p) => p.category === meta.id).length }));
  $('.category-tabs').innerHTML = [{ id: 'all', label: '全部', count: all.length }, ...groups].map((c) => `<button class="category-tab ${c.id === category ? 'active' : ''}" data-category="${esc(c.id)}" aria-pressed="${c.id === category}">${esc(c.label)} <span>${c.count}</span></button>`).join('');
  let cursor = 0;
  const stops = groups.filter((c) => c.count).map((c) => { const start = cursor; cursor += c.count / Math.max(1, all.length) * 100; return `${c.color} ${start}% ${cursor}%`; });
  $('.donut').style.background = stops.length ? `conic-gradient(${stops.join(',')})` : 'var(--border)';
  $('.donut-center strong').textContent = number(all.length);
  $('.legend').innerHTML = groups.filter((c) => c.count).map((c) => `<div><i class="legend-dot" style="background:${c.color}"></i><span>${esc(c.label)}</span><strong>${c.count}</strong></div>`).join('');
  const list = projects();
  $('#spotlightCard').innerHTML = `<div class="spotlight-content"><h3>${esc(category === 'all' ? '全部领域' : CATEGORY_META.find((c) => c.id === category)?.label)} <span>当前筛选 <strong>${list.length}</strong> 个</span></h3><p>具备一周净增基线 <strong>${list.filter((p) => known(p.weekStars)).length}</strong> 个 · 筛选同步作用于下方各榜单</p></div>`;
}
function renderRankings(list) {
  for (const [name, field, count] of [['weekly', 'weekStars', 10], ['monthly', 'monthStars', 30]]) {
    const eligible = list.filter((p) => known(p[field]));
    $(`#${name}Note`).textContent = `${eligible.length}/${list.length} 个仓库具备所需历史基线。按净增排序（含取消收藏），不是总 Stars 排名。`;
    $(`#${name}Table`).innerHTML = sorted(list, field, count).map((p, i) => row(p, i, field)).join('') || empty(`持续采样满 ${count === 10 ? 7 : 30} 天后可计算真实净增；已有历史可直接导入。`, '历史数据积累中');
  }
  const newest = list.filter((p) => validDate(p.createdAt) && Date.now() - Date.parse(p.createdAt) >= 0 && Date.now() - Date.parse(p.createdAt) <= newDays * DAY);
  $('#newProjectsTable').innerHTML = sorted(newest, 'stars', 10).map((p, i) => row(p, i)).join('') || empty('当前筛选没有该时间范围内已核验的新建工程。');
  $('#opportunityTable').innerHTML = sorted(list, 'opportunityScore', 10).map((p, i) => row(p, i, 'opportunityScore')).join('') || empty('研究评分所需的增长或活跃度数据不足，暂不排名。', '等待完整研究数据');
  renderYearly(list);
  const browse = list.slice().sort((a, b) => (known(b.stars) ? b.stars : -1) - (known(a.stars) ? a.stars : -1) || a.fullName.localeCompare(b.fullName)).slice(0, browseLimit);
  $('#repositoryTable').innerHTML = browse.map((p, i) => row(p, i)).join('') || empty('没有符合筛选条件的已收录工程。');
  $('#browseCount').textContent = `显示 ${browse.length} / ${list.length} 个`;
  $('#loadMore').hidden = browse.length >= list.length;
}
function renderYearly(list) {
  const years = Array.from(new Set([new Date().getUTCFullYear(), ...((snapshot?.projects || []).filter((p) => validDate(p.createdAt)).map((p) => new Date(p.createdAt).getUTCFullYear()))])).sort((a, b) => b - a);
  $('#yearChips').innerHTML = `<label for="yearSelect">创建年份 </label><select id="yearSelect" aria-label="选择创建年份">${years.map((value) => `<option value="${value}" ${value === year ? 'selected' : ''}>${value} 年</option>`).join('')}</select>`;
  const matches = list.filter((p) => validDate(p.createdAt) && new Date(p.createdAt).getUTCFullYear() === year);
  const groups = CATEGORY_META.filter((c) => category === 'all' || category === c.id).map((c) => ({ ...c, rows: sorted(matches.filter((p) => p.category === c.id), 'stars', 10) })).filter((g) => g.rows.length);
  $('#yearlyBoard').innerHTML = groups.length ? `<div class="yearly-grid">${groups.map((g) => `<div class="yearly-group"><div class="yearly-group-head"><strong>${esc(g.label)}</strong><span>${g.rows.length} 个</span></div>${g.rows.map((p, i) => `<a class="yearly-row" href="${esc(safeUrl(p))}" target="_blank" rel="noopener noreferrer"><span class="repo-rank">${i + 1}</span><span class="yearly-name">${esc(p.fullName)}</span><span class="yearly-stars">★ ${number(p.stars)}</span></a>`).join('')}</div>`).join('')}</div>` : empty(`${year} 年暂无符合筛选且创建日期已核验的工程。`);
}
function renderAll() {
  if (!snapshot) return;
  snapshot = assembleSnapshot(snapshot.projects, { history: snapshot.history, fetchedAt: snapshot.lastUpdated, source: snapshot.source, coverage: snapshot.coverage, warning: snapshot.warning });
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
        snapshot = assembleSnapshot(rows, { history: saved.history, fetchedAt, source: snapshot.source, coverage: snapshot.coverage, warning: saved.warning });
      }
    } catch (error) { if (!snapshot) snapshot = assembleSnapshot([], { warning: error.message }); }
    renderAll();
    const rows = await fetchGitHubProjects({ token, queries: liveQueries(), maxPages: 1, signal: controller.signal });
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
    clearTimeout(timeout); busy = false; $('#refreshButton').disabled = false; $('#refreshButton').classList.remove('loading'); renderAll();
  }
}
function setToken(value) { token = String(value || '').trim(); try { if (token) sessionStorage.setItem('githubPulse.token', token); else sessionStorage.removeItem('githubPulse.token'); } catch {} }
$('#refreshButton').addEventListener('click', () => { if ($('#tokenInput').value) { setToken($('#tokenInput').value); $('#tokenInput').value = ''; $('#tokenInput').placeholder = '本会话已配置 Token'; } refresh(); });
$('#tokenInput').addEventListener('change', (event) => setToken(event.target.value));
$('#searchInput').addEventListener('input', () => { browseLimit = 30; renderAll(); });
$('#searchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#repositoryTable a')?.click(); });
$('#loadMore').addEventListener('click', () => { browseLimit += 30; renderRankings(projects()); });
$('#activityExpand').addEventListener('click', () => { expandedActivity = !expandedActivity; renderActivity(projects()); });
$('.category-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-category]'); if (button) { category = button.dataset.category; browseLimit = 30; renderAll(); } });
$('.saved-group').addEventListener('click', (event) => { const button = event.target.closest('a'); if (!button) return; category = button.dataset.category || 'all'; $('#searchInput').value = button.dataset.search || ''; browseLimit = 30; renderAll(); });
$('.period-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-days]'); if (button) { newDays = Number(button.dataset.days); $$('.period-tab').forEach((b) => b.classList.toggle('active', b === button)); renderRankings(projects()); } });
$('#yearChips').addEventListener('change', (event) => { year = Number(event.target.value); renderYearly(projects()); });
$('#themeToggle').addEventListener('click', () => { const light = document.body.classList.toggle('light'); try { localStorage.setItem('githubPulse.theme', light ? 'light' : 'dark'); } catch {} });
function syncNavigation() {
  const labels = { overview: '工程总览', rising: '每日更新', rankings: '涨星榜单', directory: '工程目录' };
  const hash = window.location?.hash.slice(1);
  const view = labels[hash] ? hash : 'overview';
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
