import {
  getDashboardData,
  refreshDashboardData,
  snapshotFromProjects,
  fetchGitHubProjects,
  translateProjects,
} from './src/data/github-data.js';

const iconByCategory = { ai: '✦', 'developer-tools': '⌘', web: '◈', infra: '◌', data: '◫', mobile: '⌁', security: '⌑', productivity: '▣' };
const avatarClasses = ['a', 'b', 'c', 'd', 'e'];
const PERIODS = { today: '今日', week: '本周', month: '本月' };
const PERIOD_FIELD = { today: 'todayStars', week: 'weekStars', month: 'monthStars' };
const SYNC_INTERVAL_MINUTES = 30;
const DAY_MS = 24 * 3600 * 1000;
const toISODate = (time) => new Date(time).toISOString().slice(0, 10);
// Broad live queries used when a GitHub token is configured; keep the list
// small because the Search API is rate-limited. The single `created:` query
// surfaces new repos for the whole rolling quarter; the 7/30/90-day windows
// are filtered client-side from each repo's `createdAt`.
const buildLiveQueries = (now = Date.now()) => [
  'stars:>10000',
  'topic:llm stars:>1000',
  'topic:kubernetes stars:>1000',
  `created:>${toISODate(now - 90 * DAY_MS)} stars:>100`,
];

let snapshot = getDashboardData();
let activeCategory = 'all';
let activePeriod = 'today';
let activeWindow = 'week';
const YEAR_CHOICES = [2022, 2023, 2024, 2025, 2026];
let activeYear = Math.min(Math.max(new Date().getFullYear(), YEAR_CHOICES[0]), YEAR_CHOICES[YEAR_CHOICES.length - 1]);
// 当年新增榜的三个窗口（rolling 7/30/90 天），统一 Top 10。
// 演示数据全部使用真实创建日期，2026 批次中含 90 天内的工程，窗口为空时
// 展示解释文案 + 接入 Token 的引导按钮。
const NEW_WINDOWS = {
  week: { list: 'weeklyTop10', field: 'weekStars', days: 7 },
  month: { list: 'monthlyTop10', field: 'monthStars', days: 30 },
  quarter: { list: 'quarterlyTop10', field: 'monthStars', days: 90 },
};
const TOKEN_CTA = '<button class="empty-cta" data-action="connect-token">接入 GitHub Token</button>';
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat('en-US', { notation: value > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
const formatStars = (value) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : value.toLocaleString('en-US');
const timeAgo = (iso) => {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
};
const getToken = () => localStorage.getItem('githubPulse.token') || window.GITHUB_PULSE_TOKEN || '';

function projectMatches(project) {
  if (activeCategory !== 'all' && project.category !== activeCategory) return false;
  const query = $('#searchInput')?.value.trim().toLowerCase();
  if (!query) return true;
  return [project.fullName, project.name, project.description, project.language, project.categoryLabel, ...(project.topics || [])]
    .join(' ').toLowerCase().includes(query);
}

function avatarText(project) {
  return project.fullName.split('/')[0].slice(0, 2).toUpperCase();
}

/* ------------------------------ metrics ------------------------------ */

function renderMetrics() {
  const stats = snapshot.stats;
  $('#trackedCount').textContent = formatNumber(stats.projects);
  $('#newToday').textContent = String(stats.activeToday);
  $('#weeklyStars').textContent = formatStars(stats.weekStars);
  $('#lastUpdated').textContent = timeAgo(snapshot.lastUpdated);
  const date = new Date(snapshot.lastUpdated);
  $('#footerUpdated').textContent = `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

/* --------------------------- category panel --------------------------- */

function renderCategoryTabs() {
  const tabs = [
    { id: 'all', label: '全部', count: snapshot.stats.projects },
    ...snapshot.categories.map((category) => ({ id: category.id, label: category.label, count: category.count })),
  ];
  $('.category-tabs').innerHTML = tabs.map((tab) => `
    <button class="category-tab ${tab.id === activeCategory ? 'active' : ''}" data-category="${tab.id}">${tab.label} <span>${tab.count}</span></button>`).join('');
  $$('.category-tab').forEach((button) => button.addEventListener('click', () => {
    activeCategory = button.dataset.category;
    renderAll();
  }));
}

function renderCategoryVisual() {
  const grouped = snapshot.categories.filter((category) => category.count > 0);
  const total = snapshot.stats.projects;
  let accumulator = 0;
  const stops = grouped.map((category) => {
    const from = (accumulator / total) * 100;
    accumulator += category.count;
    return `${category.color} ${from}% ${(accumulator / total) * 100}%`;
  }).join(', ');
  $('.donut').style.background = `conic-gradient(${stops})`;
  $('.donut-center strong').textContent = formatNumber(total);

  const top = grouped.slice().sort((left, right) => right.count - left.count).slice(0, 5);
  const restCount = total - top.reduce((sum, category) => sum + category.count, 0);
  const rows = top.map((category) => ({ label: category.label, count: category.count, color: category.color }));
  if (restCount > 0) rows.push({ label: '其他', count: restCount, color: '#32435d' });
  $('.legend').innerHTML = rows.map((row) => `
    <div><i class="legend-dot" style="background:${row.color}"></i><span>${row.label}</span><strong>${row.count}</strong><em>${((row.count / total) * 100).toFixed(1)}%</em></div>`).join('');
}

function renderSpotlight() {
  const totalWeek = snapshot.stats.weekStars || 1;
  let badge = '全部领域';
  let title;
  let body;
  let metaGrowth;
  if (activeCategory === 'all') {
    const leader = snapshot.categories.slice().sort((left, right) => right.weekStars - left.weekStars)[0];
    badge = '全景';
    title = `${leader.label}本周领跑`;
    body = `过去 7 天，${leader.label}分类贡献了 <strong>${Math.round((leader.weekStars / totalWeek) * 100)}%</strong> 的新增 Stars。`;
    metaGrowth = `+${formatStars(leader.weekStars)} 本周 Stars`;
  } else {
    const category = snapshot.categories.find((item) => item.id === activeCategory);
    badge = category.label;
    title = `${category.label}分类动态`;
    body = `该分类下共有 <strong>${category.count}</strong> 个追踪中的工程，过去 7 天新增 Stars 占全站的 <strong>${Math.round((category.weekStars / totalWeek) * 100)}%</strong>。`;
    metaGrowth = `+${formatStars(category.weekStars)} 本周 Stars`;
  }
  $('#spotlightCard').innerHTML = `
    <div class="spotlight-top"><span class="spotlight-label">CATEGORY SPOTLIGHT</span><span class="spotlight-badge">${badge}</span></div>
    <div class="spotlight-content"><div class="spotlight-icon">${activeCategory === 'all' ? '✦' : iconByCategory[activeCategory] || '◈'}</div>
      <div><h3>${title}</h3><p>${body}</p><div class="spotlight-meta"><span>${snapshot.stats.projects} 个工程</span><span>·</span><span class="positive">${metaGrowth}</span></div></div></div>
    <div class="spotlight-bar"><span style="width:${Math.max(8, Math.round(((activeCategory === 'all'
      ? snapshot.categories.slice().sort((left, right) => right.weekStars - left.weekStars)[0].weekStars
      : snapshot.categories.find((item) => item.id === activeCategory).weekStars) / totalWeek) * 100))}%"></span></div>`;
}

/* ------------------------- activity + trend chart ------------------------- */

function renderActivity() {
  const field = PERIOD_FIELD[activePeriod];
  const periodLabel = PERIODS[activePeriod];
  $('#activityTitle').textContent = `${periodLabel}增长最快`;
  const list = snapshot.projects
    .filter((project) => project[field] > 0)
    .filter(projectMatches)
    .sort((left, right) => right[field] - left[field])
    .slice(0, 5);
  $('#activityList').innerHTML = list.map((project, index) => `
    <a class="activity-row" href="${project.htmlUrl}" target="_blank" rel="noopener noreferrer" data-id="${project.id}">
      <div class="activity-badge ${index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'green' : ''}">${iconByCategory[project.category] || '◈'}</div>
      <div class="activity-info"><div class="activity-name"><span>${project.name}</span><span class="owner">${project.fullName.split('/')[0]}</span></div><div class="activity-desc">${project.description}</div></div>
      <div class="activity-meta"><strong>+${formatStars(project[field])}</strong><span class="up">${periodLabel} Stars</span><span class="ago">${timeAgo(project.updatedAt)}</span></div>
    </a>`).join('') || `<div class="empty-state">没有匹配的工程，换个关键词试试。</div>`;
}

function renderChart() {
  const { labels, values } = snapshot.trendSeries;
  const niceMax = Math.max(1000, Math.ceil(Math.max(...values, 1) / 1000) * 1000);
  const tickCount = 4;
  $('.y-axis').innerHTML = Array.from({ length: tickCount + 1 }, (_, index) => {
    const value = (niceMax * (tickCount - index)) / tickCount;
    return `<span>+${formatStars(Math.round(value))}</span>`;
  }).join('');
  $('.chart-labels').innerHTML = labels.map((label) => `<span>${label}</span>`).join('');
  $('.chart-bars').innerHTML = values.map((value, index) => `
    <div class="bar ${index === values.length - 1 ? 'today' : ''}" style="height:${Math.max(4, (value / niceMax) * 100)}%"><span>+${formatStars(value)}</span></div>`).join('');
}

/* ------------------------------ rankings ------------------------------ */

const scoreClass = (score) => (score >= 75 ? '' : score >= 50 ? 'mid' : 'low');
const scoreBadge = (project) => `<span class="score-badge ${scoreClass(project.opportunityScore)}" title="商机评分 ${project.opportunityScore}/100：周增速+采用度+Fork 健康+活跃度+License">商 ${project.opportunityScore}</span>`;
const licenseChip = (project) => `<span class="license-chip ${project.licenseRisk === 'risky' ? 'risky' : ''}" title="开源许可证">${project.license}</span>`;
const createdChip = (project) => {
  if (!project.createdAt) return '';
  const created = new Date(project.createdAt).getTime();
  const days = Math.round((Date.now() - created) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return '';
  // 近三个月内的工程用相对时间，更早的用绝对年月（年度榜里全是老工程）。
  const label = days > 90 ? `${new Date(created).toISOString().slice(0, 7)} 创建` : days === 0 ? '今天创建' : `${days} 天前创建`;
  return `<span class="created-chip" title="仓库创建时间">${label}</span>`;
};
const langChip = (project) => `<span class="lang-chip" title="主要编程语言">${project.language}</span>`;

function repoRow(project, index, field) {
  return `<a class="repo-row" href="${project.htmlUrl}" target="_blank" rel="noopener noreferrer" data-id="${project.id}">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <span class="repo-avatar ${avatarClasses[index % avatarClasses.length]}">${avatarText(project)}</span>
    <div class="repo-details"><div class="repo-name"><strong>${project.name}</strong> <span>/ ${project.fullName.split('/')[0]}</span></div><div class="repo-desc">${project.description}</div></div>
    <div class="repo-stats"><span class="stars">★ ${formatStars(project.stars)}</span><span class="forks">⑂ ${formatStars(project.forks)}</span><span class="delta">+${formatStars(project[field])}</span>${langChip(project)}${createdChip(project)}${scoreBadge(project)}${licenseChip(project)}</div>
  </a>`;
}

function oppRow(project, index) {
  return `<a class="repo-row opp-row" href="${project.htmlUrl}" target="_blank" rel="noopener noreferrer" data-id="${project.id}">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <span class="repo-avatar ${avatarClasses[index % avatarClasses.length]}">${avatarText(project)}</span>
    <div class="repo-details">
      <div class="repo-name"><strong>${project.name}</strong> <span>/ ${project.fullName.split('/')[0]}</span></div>
      <div class="repo-desc">${project.description}</div>
      <div class="repo-signals">贡献者 ${formatStars(project.contributors)} · 最近提交 ${timeAgo(project.pushedAt)} · ${project.license}</div>
    </div>
    <div class="repo-stats"><span class="delta">+${formatStars(project.weekStars)}/周</span>${scoreBadge(project)}</div>
  </a>`;
}

// 空态引导：滚动到侧栏的 Token 输入框、聚焦并闪烁提示。
function promptForToken() {
  const input = $('#tokenInput');
  if (!input) return;
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus();
  input.classList.remove('flash');
  void input.offsetWidth;
  input.classList.add('flash');
  setTimeout(() => input.classList.remove('flash'), 1600);
}

// 年度榜：按自然年从全量工程里筛（客户端计算，实时模式同样生效）。
// 选中具体分类时渲染该分类当年的 Top 10 明细表；"全部"时渲染每个
// 有数据分类的紧凑 Top 10 小列表网格。年份 chips 与全局分类切换都会
// 触发重渲染。
function renderYearly() {
  $('#yearChips').innerHTML = YEAR_CHOICES.map((year) => `<button class="year-chip ${year === activeYear ? 'active' : ''}" data-year="${year}">${year}</button>`).join('');
  $$('.year-chip').forEach((button) => button.addEventListener('click', () => {
    activeYear = Number(button.dataset.year);
    renderYearly();
  }));
  const yearProjects = snapshot.projects
    .filter((project) => {
      const created = new Date(project.createdAt).getTime();
      return Number.isFinite(created) && new Date(created).getFullYear() === activeYear;
    })
    .filter(projectMatches);
  if (activeCategory !== 'all') {
    const meta = snapshot.categories.find((category) => category.id === activeCategory);
    const list = yearProjects
      .filter((project) => project.category === activeCategory)
      .sort((left, right) => right.stars - left.stars)
      .slice(0, 10);
    const label = meta ? meta.label : activeCategory;
    const emptyState = list.length ? '' : `<div class="empty-state">${getToken()
      ? `${activeYear} 年「${label}」暂无收录工程（实时模式下稍后再试）。`
      : `演示数据暂无 ${activeYear} 年「${label}」分类的工程 —— 接入 GitHub Token 同步实时数据${TOKEN_CTA}`}</div>`;
    $('#yearlyBoard').innerHTML = list.length
      ? `<div class="yearly-single-head">${activeYear} 年 · ${label} Top ${list.length}</div><div class="ranking-table">${list.map((project, index) => repoRow(project, index, 'weekStars')).join('')}</div>`
      : emptyState;
    $('#yearlyBoard .empty-cta')?.addEventListener('click', promptForToken);
    return;
  }
  const groups = snapshot.categories
    .map((category) => ({
      ...category,
      projects: yearProjects.filter((project) => project.category === category.id).sort((left, right) => right.stars - left.stars).slice(0, 10),
    }))
    .filter((group) => group.projects.length > 0);
  const emptyBoard = `<div class="empty-state">${getToken()
    ? `${activeYear} 年暂无收录工程（实时模式下稍后再试）。`
    : `演示数据暂无 ${activeYear} 年收录的工程 —— 接入 GitHub Token 同步实时数据${TOKEN_CTA}`}</div>`;
  $('#yearlyBoard').innerHTML = groups.length ? `<div class="yearly-grid">${groups.map((group) => `
    <div class="yearly-group">
      <div class="yearly-group-head"><span class="legend-dot" style="background:${group.color}"></span><strong>${group.label}</strong><span>${group.projects.length} 个工程</span></div>
      ${group.projects.map((project, index) => `<a class="yearly-row" href="${project.htmlUrl}" target="_blank" rel="noopener noreferrer" title="${project.fullName}"><span class="repo-rank">${String(index + 1).padStart(2, '0')}</span><span class="yearly-name">${project.name}</span><span class="yearly-stars">★ ${formatStars(project.stars)}</span></a>`).join('')}
    </div>`).join('')}</div>` : emptyBoard;
  $('#yearlyBoard .empty-cta')?.addEventListener('click', promptForToken);
}

// 当年新增榜：本周 / 本月 / 本季度（rolling 7/30/90 天）三个窗口，各取 Top 10。
// 演示数据的 2026 批次含 90 天内的新工程，空窗口（如本周）给解释文案 + 接入 Token 引导。
function renderNewProjects() {
  const config = NEW_WINDOWS[activeWindow];
  $$('.period-tab').forEach((button) => button.classList.toggle('active', button.dataset.window === activeWindow));
  const list = snapshot[config.list].filter(projectMatches);
  $('#newProjectsTable').innerHTML = list.length ? list.map((project, index) => repoRow(project, index, config.field)).join('') : `<div class="empty-state">${getToken()
    ? '本窗口暂无新建工程（实时模式下稍后再试）。'
    : `演示数据不含 ${config.days} 天内新建的真实工程 —— 接入 GitHub Token 后，此处展示实时新建工程${TOKEN_CTA}`}</div>`;
  $('#newProjectsTable .empty-cta')?.addEventListener('click', promptForToken);
}

function renderOpportunity() {
  const opportunity = snapshot.opportunityTop10.filter(projectMatches);
  $('#opportunityTable').innerHTML = opportunity.map(oppRow).join('') || `<div class="empty-state">当前分类暂无商机评分数据。</div>`;
}

/* ------------------------------ rendering ------------------------------ */

function renderAll() {
  renderMetrics();
  renderCategoryTabs();
  renderCategoryVisual();
  renderSpotlight();
  renderActivity();
  renderChart();
  renderYearly();
  renderNewProjects();
  renderOpportunity();
}

/* ------------------------------ interaction ------------------------------ */

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toastMessage').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function applySnapshot(next, message, { silent } = {}) {
  snapshot = next;
  renderAll();
  if (!silent) showToast(message);
}

function simulateSync(message, options) {
  applySnapshot(refreshDashboardData(snapshot), message, options);
}

async function refresh({ silent } = {}) {
  const button = $('#refreshButton');
  button.classList.add('loading');
  const token = getToken();
  let finished = false;
  if (token) {
    try {
      const projects = await fetchGitHubProjects({ token, queries: buildLiveQueries() });
      let message = '已同步 GitHub 实时数据';
      try {
        const { translated, total } = await translateProjects(projects);
        if (total > 0) message += ` · ${translated}/${total} 条描述已译为中文`;
      } catch (error) {
        console.warn('Description translation skipped:', error);
      }
      const next = snapshotFromProjects(projects);
      next.tick = (snapshot.tick || 0) + 1;
      finished = true;
      applySnapshot(next, message, { silent });
    } catch (error) {
      console.warn('Live sync failed, falling back to demo sync:', error);
    }
  }
  if (!finished) simulateSync(token ? '实时接口不可用，已回退到演示同步' : '数据已更新 · 已同步最新变化', { silent });
  button.classList.remove('loading');
}

function setupEvents() {
  $('#refreshButton').addEventListener('click', () => refresh());
  $('#searchInput').addEventListener('input', renderAll);
  $('#searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = $('#newProjectsTable .repo-row');
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
    }
  });
  $$('.period-tab').forEach((button) => button.addEventListener('click', () => {
    activeWindow = button.dataset.window;
    renderNewProjects();
  }));
  // 侧栏 Token 输入框：失焦或回车即保存（走 githubPulse.setToken 同一通道）。
  const saveToken = () => window.githubPulse.setToken($('#tokenInput').value.trim());
  $('#tokenInput').addEventListener('change', saveToken);
  $('#tokenInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveToken();
  });
  $$('.text-button').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.action === 'view-all') $('#rankings').scrollIntoView({ behavior: 'smooth' });
  }));
  $$('.saved-group .nav-item').forEach((item) => item.addEventListener('click', () => {
    if (item.dataset.category) activeCategory = item.dataset.category;
    if (item.dataset.search !== undefined) {
      $('#searchInput').value = item.dataset.search;
      activeCategory = 'all';
    }
    renderAll();
    $('#rising').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#themeToggle').addEventListener('click', () => {
    const light = document.body.classList.toggle('light');
    $('#themeToggle').textContent = light ? '☾' : '☼';
    localStorage.setItem('githubPulse.theme', light ? 'light' : 'dark');
  });
  $$('.range-button').forEach((button) => button.addEventListener('click', () => {
    $$('.range-button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    activePeriod = button.dataset.range;
    renderActivity();
  }));
  $$('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => {
    $$('.nav-item[data-view]').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
  }));
}

/* --------------------------------- boot --------------------------------- */

if (localStorage.getItem('githubPulse.theme') === 'light') {
  document.body.classList.add('light');
  $('#themeToggle').textContent = '☾';
}

// 回填已保存的 Token（localStorage），实时模式恢复无缝。
const savedToken = localStorage.getItem('githubPulse.token');
if (savedToken && $('#tokenInput')) $('#tokenInput').value = savedToken;

renderAll();
setupEvents();

// The UI promises a sync every 30 minutes; keep that promise with a silent
// background refresh plus a periodic "x 分钟前" refresh of the timestamp.
setInterval(() => refresh({ silent: true }), SYNC_INTERVAL_MINUTES * 60 * 1000);
setInterval(() => { $('#lastUpdated').textContent = timeAgo(snapshot.lastUpdated); }, 45 * 1000);

// Integration surface for a future backend or the browser console:
//   githubPulse.setToken('<ghp_...>')  -> 后续“立即更新”走 GitHub 实时数据
window.githubPulse = {
  getSnapshot: () => snapshot,
  refresh,
  setToken: (token) => {
    if (token) localStorage.setItem('githubPulse.token', token);
    else localStorage.removeItem('githubPulse.token');
  },
};
