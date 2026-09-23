import { getDashboardData, refreshDashboardData } from './src/data/github-data.js';

const displayNames = {
  ai: 'AI / ML',
  'developer-tools': '开发者工具',
  web: 'Web / 前端',
  infra: '基础设施',
  data: '数据工具',
  mobile: '移动开发',
  security: '安全',
  productivity: '效率工具',
};

const iconByCategory = { ai: '✦', 'developer-tools': '⌘', web: '◈', infra: '◌', data: '◫', mobile: '⌁', security: '⌑', productivity: '▣' };
const avatarClasses = ['a', 'b', 'c', 'd', 'e'];
let snapshot = getDashboardData();
let activeCategory = 'all';
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

function projectMatches(project) {
  if (activeCategory === 'frontend' && project.category !== 'web') return false;
  if (activeCategory === 'rust' && project.language !== 'Rust') return false;
  if (!['all', 'frontend', 'rust'].includes(activeCategory) && project.category !== activeCategory) return false;
  const query = $('#searchInput')?.value.trim().toLowerCase();
  if (!query) return true;
  return [project.fullName, project.name, project.description, project.language, project.categoryLabel, ...(project.topics || [])]
    .join(' ').toLowerCase().includes(query);
}

function avatarText(project) {
  return project.fullName.split('/')[0].slice(0, 2).toUpperCase();
}

function renderMetrics() {
  const stats = snapshot.stats;
  $('#trackedCount').textContent = formatNumber(1284 + (snapshot.tick || 0) * 2);
  $('#newToday').textContent = String(24 + (snapshot.tick || 0) % 5);
  $('#weeklyStars').textContent = formatStars(Math.round(stats.todayStars * 1.34));
  $('#lastUpdated').textContent = snapshot.tick ? '刚刚' : '2 分钟前';
  const date = new Date(snapshot.lastUpdated);
  $('#footerUpdated').textContent = `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderActivity() {
  const list = snapshot.dailyUpdated.filter(projectMatches).slice(0, 5);
  $('#activityList').innerHTML = list.map((project, index) => `
    <div class="activity-row" data-id="${project.id}">
      <div class="activity-badge ${index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'green' : ''}">${iconByCategory[project.category] || '◈'}</div>
      <div class="activity-info"><div class="activity-name"><span>${project.name}</span><span class="owner">${project.fullName.split('/')[0]}</span></div><div class="activity-desc">${project.description}</div></div>
      <div class="activity-meta"><strong>+${formatStars(project.todayStars)}</strong><span class="up">今日 Stars</span></div>
    </div>`).join('') || `<div class="empty-state">没有匹配的工程，换个关键词试试。</div>`;
}

function renderChart() {
  // A stable baseline with a small refresh-dependent lift keeps the chart feeling live.
  const values = [34, 48, 42, 69, 56, 82, 95].map((value, index) => Math.min(98, value + ((snapshot.tick || 0) * (index + 2)) % 7));
  $('.chart-bars').innerHTML = values.map((value, index) => `<div class="bar ${index === values.length - 1 ? 'today' : ''}" style="height:${value}%"><span>+${(value * 82).toLocaleString('en-US')}</span></div>`).join('');
}

function repoRow(project, index) {
  return `<div class="repo-row" data-id="${project.id}">
    <span class="repo-rank">${String(index + 1).padStart(2, '0')}</span>
    <span class="repo-avatar ${avatarClasses[index % avatarClasses.length]}">${avatarText(project)}</span>
    <div class="repo-details"><div class="repo-name"><strong>${project.name}</strong> <span>/ ${project.fullName.split('/')[0]}</span></div><div class="repo-desc">${project.description}</div></div>
    <div class="repo-stats"><span class="stars">★ ${formatStars(project.stars)}</span><span class="forks">⑂ ${formatStars(project.forks)}</span><span class="delta">+${formatStars(project.weekStars)}</span></div>
  </div>`;
}

function renderRankings() {
  const weekly = snapshot.weeklyTop10.filter(projectMatches).slice(0, 10);
  const monthly = snapshot.monthlyTop30.filter(projectMatches);
  $('#weeklyTable').innerHTML = weekly.map(repoRow).join('') || `<div class="empty-state">当前分类暂无榜单数据。</div>`;
  $('#monthlyTable').innerHTML = monthly.map(repoRow).join('');
  $('#loadMore').textContent = monthly.length > 5 ? `加载剩余 ${Math.max(0, monthly.length - 5)} 个工程 ↓` : '已展示全部工程';
}

function updateAll() {
  renderMetrics();
  renderActivity();
  renderChart();
  renderRankings();
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toastMessage').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function refresh() {
  const button = $('#refreshButton');
  button.classList.add('loading');
  button.querySelector('.refresh-icon').textContent = '↻';
  setTimeout(() => {
    snapshot = refreshDashboardData(snapshot);
    updateAll();
    button.classList.remove('loading');
    showToast('数据已更新 · 已同步最新变化');
  }, 650);
}

function setupEvents() {
  $('#refreshButton').addEventListener('click', refresh);
  $('#searchInput').addEventListener('input', updateAll);
  $('#loadMore').addEventListener('click', (event) => {
    $('.month-ranking').classList.toggle('expanded');
    event.currentTarget.innerHTML = $('.month-ranking').classList.contains('expanded') ? '收起月榜 <span>↑</span>' : `加载剩余 ${Math.max(0, snapshot.monthlyTop30.length - 5)} 个工程 <span>↓</span>`;
  });
  $('#themeToggle').addEventListener('click', () => {
    document.body.classList.toggle('light');
    $('#themeToggle').textContent = document.body.classList.contains('light') ? '☾' : '☼';
  });
  $$('.range-button').forEach((button) => button.addEventListener('click', () => {
    $$('.range-button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    showToast(`已切换至${button.textContent}视图`);
  }));
  $$('.category-tab').forEach((button) => button.addEventListener('click', () => {
    $$('.category-tab').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    activeCategory = button.dataset.category;
    $('.month-ranking').classList.remove('expanded');
    updateAll();
  }));
  $$('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => {
    $$('.nav-item[data-view]').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
  }));
}

updateAll();
setupEvents();

// Expose a tiny integration surface for a future backend or browser console.
window.githubPulse = { getSnapshot: () => snapshot, refresh };
