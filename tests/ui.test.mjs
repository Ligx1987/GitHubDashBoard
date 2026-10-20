import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as data from '../src/data/github-data.js';
import { previousUtcDate } from '../src/data/history.js';

// Execute the actual application module against a minimal rendering sink.
// This covers data-to-HTML and failure behavior; browser layout is tested separately.
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\s*/m, '');

function element() {
  const classes = new Set();
  const handlers = new Map();
  return {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); return force; },
    },
    addEventListener(name, callback) { handlers.set(name, callback); },
    async emit(name, event = {}) { return handlers.get(name)?.({ target: this, ...event }); },
    focus() {}, click() {},
  };
}

function fixtures(count = 1, { category = 'web', prefix = 'web', baseStars = 1000 } = {}) {
  const now = Date.now();
  const projects = Array.from({ length: count }, (_, index) => ({
    fullName: `test/${prefix}-${index}`, name: `${prefix}-${index}`, description: 'A public repository',
    stars: baseStars + index, forks: 125, contributors: null, license: 'MIT', category,
    createdAt: new Date(now - 2 * 86400000).toISOString(),
    pushedAt: new Date(now - 3600000).toISOString(), fetchedAt: new Date(now - 60000).toISOString(),
  }));
  const history = Object.fromEntries(projects.map((project, index) => [project.fullName, {
    [previousUtcDate(now, 1)]: project.stars - 1,
    [previousUtcDate(now, 7)]: project.stars - 10 - index,
    [previousUtcDate(now, 30)]: project.stars + index,
  }]));
  return { projects, history };
}

function officialHistory(projects) {
  const now = Date.now();
  const date = new Date(now); date.setUTCHours(0, 0, 0, 0);
  const anchor = date.getTime() - date.getUTCDay() * 86400000;
  return { schemaVersion: 1, repositories: Object.fromEntries(projects.map((p, i) => [p.fullName, {
    source: 'github-star-history', fetchedAt: new Date(now).toISOString(),
    weeks: Array.from({ length: 6 }, (_, offset) => {
      const week = anchor - offset * 7 * 86400000;
      const days = Array.from({ length: 7 }, (_, day) => week + (day + 1) * 86400000 <= Date.parse(p.createdAt) ? 0 : i + 1);
      return { week: week / 1000, total: days.reduce((a, b) => a + b, 0), days };
    }),
  }])), status: {} };
}

async function startApp({ projects, history = {}, starActivity = officialHistory(projects), mode = 'added', liveFetch = async () => { throw new Error('offline test'); } }) {
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const document = { body: element(), hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {} };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  let fetchLive = liveFetch;
  let loadSaved = async () => data.assembleSnapshot(structuredClone(projects), { history: structuredClone(history), starActivity, source: 'cached' });
  const window = {};
  const context = vm.createContext({
    ...data, document, window, sessionStorage: storage, localStorage: storage,
    loadDashboardData: (...args) => loadSaved(...args), fetchGitHubProjects: (...args) => fetchLive(...args),
    refreshStarActivity: async (_projects, cache) => cache,
    AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context, { filename: 'app.js' });
  await nextTurn(); // Let the application's initial automatic refresh settle.
  // The original regressions below explicitly exercise the retained net mode.
  if (mode === 'net') await get('#growthMode').emit('change', { target: { value: 'net' } });
  assert.equal(get('#refreshButton').disabled, false);
  return { get, app: window.githubPulse, setFetch: (fetcher) => { fetchLive = fetcher; }, setLoad: (loader) => { loadSaved = loader; } };
}
const rowCount = (html) => (html.match(/class="repo-row"/g) || []).length;

test('default UI renders surge board and tabbed new-project board; auxiliary net mode never changes them', async () => {
  const { projects } = fixtures(35);
  const now = Date.now();
  const date = new Date(now); date.setUTCHours(0, 0, 0, 0);
  const anchor = date.getTime() - date.getUTCDay() * 86400000;
  const starActivity = { schemaVersion: 1, repositories: Object.fromEntries(projects.map((p, i) => [p.fullName, {
    source: 'github-star-history', fetchedAt: new Date(now).toISOString(),
    weeks: Array.from({ length: 6 }, (_, offset) => ({ week: (anchor - offset * 7 * 86400000) / 1000, total: 7 * (i + 1), days: Array(7).fill(i + 1) })),
  }])), status: {} };
  const ui = await startApp({ projects, starActivity, mode: 'added' });
  assert.equal(rowCount(ui.get('#surgeBoardTable').innerHTML), 30);
  assert.ok(ui.get('#surgeBoardTable').innerHTML.includes('test/web-34'));
  assert.match(ui.get('#surgeNote').textContent, /GitHub 官方历史/);
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 10); // default 7-day tab
  assert.match(ui.get('#newNote').textContent, /GitHub 官方历史/);
  await ui.get('#newTabs').emit('click', { target: { closest: () => ({ dataset: { days: '30' } }) } });
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 30);
  assert.ok(ui.get('#newBoardTable').innerHTML.includes('test/web-34'));
  assert.ok(!ui.get('#newBoardTable').innerHTML.includes('test/web-0<'));
  await ui.get('#newTabs').emit('click', { target: { closest: () => ({ dataset: { days: '3' } }) } });
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 10);
  await ui.get('#surgeTabs').emit('click', { target: { closest: () => ({ dataset: { days: '30' } }) } });
  assert.equal(rowCount(ui.get('#surgeBoardTable').innerHTML), 30);
  await ui.get('#growthMode').emit('change', { target: { value: 'net' } });
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 10);
  assert.match(ui.get('#trendTitle').textContent, /净增/);
  assert.match(ui.get('#newNote').textContent, /GitHub 官方历史/);
});

test('unavailable official history reports fetching failure instead of instructing a 30-day wait', async () => {
  const ui = await startApp({ ...fixtures(), mode: 'added', starActivity: { schemaVersion: 1, repositories: {},
    status: { attemptedAt: new Date().toISOString(), message: 'GitHub 历史接口 HTTP 403：请求额度受限' } } });
  assert.match(ui.get('#historyStatus').textContent, /403/);
  assert.match(ui.get('#newBoardTable').innerHTML, /403/);
  assert.ok(!ui.get('#newBoardTable').innerHTML.includes('持续采样满'));
  assert.equal(rowCount(ui.get('#repositoryTable').innerHTML), 1);
});

test('repository directory carries a persistent three-year scope hint', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const directory = html.slice(html.indexOf('id="directory"'), html.indexOf('id="repositoryTable"'));
  assert.match(directory, /仅收录近三年创建的工程/);
  assert.match(directory, /scope-badge/);
});

test('UI renders four annual Top30 sections and excludes old fast-growing projects from new boards', async () => {
  const fresh = fixtures(35);
  const year = new Date().getUTCFullYear();
  const annual = fixtures(35, { prefix: 'annual', baseStars: 90000 });
  annual.projects.forEach(p => { p.createdAt = `${year - 1}-06-01T00:00:00Z`; });
  const old = fixtures(1, { prefix: 'old', baseStars: 1000000 });
  old.projects[0].createdAt = `${year - 6}-01-01T00:00:00Z`;
  const projects = [...fresh.projects, ...annual.projects, ...old.projects];
  const ui = await startApp({ projects });
  assert.ok(!ui.get('#newBoardTable').innerHTML.includes('test/old-0'));
  // The surge board has no creation window: an old project with fresh growth belongs there.
  assert.ok(ui.get('#surgeBoardTable').innerHTML.includes('test/old-0'));
  const html = ui.get('#yearlyBoard').innerHTML;
  assert.equal((html.match(/<details /g) || []).length, 4);
  assert.equal(rowCount(html), 60);
  assert.ok(html.includes(`data-year="${year - 3}"`));
  assert.ok(!html.includes(`data-year="${year - 4}"`));
  assert.ok(html.includes('test/annual-34'));
  assert.ok(!html.includes('test/annual-0<'));
});

test('browser refresh discovers three recent cohorts and rotates one of four annual cohorts per batch', async () => {
  const queries = [];
  const ui = await startApp({ ...fixtures(), liveFetch: async options => {
    queries.push(options.queries);
    return fixtures().projects;
  } });
  for (let i = 0; i < 4; i++) await ui.app.refresh({ silent: true });
  assert.ok(queries.every(batch => batch.length === 4));
  assert.equal(new Set(queries.map(batch => batch[3])).size, 4);
  assert.equal(new Set(queries[0].slice(0, 3)).size, 3);
});

test('a real API-shaped repository with null contributors completes all rendering', async () => {
  const { projects, history } = fixtures();
  const ui = await startApp({ projects, history });
  assert.equal(ui.get('#trackedCount').textContent, '1');
  assert.equal(rowCount(ui.get('#opportunityTable').innerHTML), 1);
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 1);
  assert.equal(rowCount(ui.get('#repositoryTable').innerHTML), 1);
  assert.equal(ui.app.getSnapshot().projects[0].contributors, null);
});

test('external descriptions remain escaped text in every repository row', async () => {
  const fixture = fixtures();
  fixture.projects[0].description = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
  fixture.projects[0].language = '"><img src=x>';
  const ui = await startApp(fixture);
  for (const selector of ['#repositoryTable', '#newBoardTable', '#surgeBoardTable', '#activityList', '#opportunityTable']) {
    const html = ui.get(selector).innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
    assert.ok(html.includes('&amp; &lt;script&gt;bad()&lt;/script&gt;'));
    assert.ok(!html.includes('<img') && !html.includes('<script>'));
  }
});

test('monthly new-project tab uses additions while auxiliary chart retains negative net changes', async () => {
  const ui = await startApp(fixtures(35));
  await ui.get('#newTabs').emit('click', { target: { closest: () => ({ dataset: { days: '30' } }) } });
  const html = ui.get('#newBoardTable').innerHTML;
  assert.equal(rowCount(html), 30);
  assert.ok(html.includes('test/web-34'));
  assert.ok(html.includes('test/web-29'));
  assert.ok(!html.includes('test/web-0<'));
  assert.ok(!html.includes('negative'));
  await ui.get('#growthMode').emit('change', { target: { value: 'net' } });
  assert.match(ui.get('#trendNote').textContent, /负值为净减少/);
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 30);
  await ui.get('#newTabs').emit('click', { target: { closest: () => ({ dataset: { days: '7' } }) } });
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 10);
});

test('category filtering precedes top-N selection even when global leaders are another category', async () => {
  const web = fixtures(12);
  const ai = fixtures(12, { category: 'ai', prefix: 'ai', baseStars: 100000 });
  const ui = await startApp({ projects: [...ai.projects, ...web.projects], history: { ...ai.history, ...web.history } });
  await ui.get('#categoryTabs').emit('click', { target: { closest: () => ({ dataset: { category: 'web' } }) } });
  assert.equal(ui.get('#trackedCount').textContent, '12');
  assert.equal(rowCount(ui.get('#newBoardTable').innerHTML), 10);
  assert.ok(ui.get('#newBoardTable').innerHTML.includes('test/web-11'));
  assert.ok(!ui.get('#newBoardTable').innerHTML.includes('test/ai-'));
});

test('failed live and snapshot refresh preserve the last real observations without simulated increments', async () => {
  const fixture = fixtures();
  const live = { ...fixture.projects[0], stars: 4321, fetchedAt: new Date().toISOString() };
  const ui = await startApp({ ...fixture, liveFetch: async () => [live] });
  assert.equal(ui.app.getSnapshot().projects[0].stars, 4321);
  const before = ui.app.getSnapshot().projects.map((project) => ({ name: project.fullName, stars: project.stars, fetchedAt: project.fetchedAt }));
  ui.setFetch(async () => { throw new Error('GitHub API HTTP 403'); });
  ui.setLoad(async () => { throw new Error('Snapshot network unavailable'); });
  await ui.app.refresh();
  const after = ui.app.getSnapshot().projects.map((project) => ({ name: project.fullName, stars: project.stars, fetchedAt: project.fetchedAt }));
  assert.deepEqual(after, before);
  assert.match(ui.get('#dataStatus').textContent, /403/);
  assert.match(ui.get('#dataStatus').textContent, /保留最近可用快照/);
  assert.equal(ui.get('#refreshButton').disabled, false);
});

test('persisted Chinese descriptions render by default with the original preserved as tooltip', async () => {
  const fixture = fixtures();
  fixture.projects[0].descriptionZh = '一个公开的仓库';
  const ui = await startApp(fixture);
  const html = ui.get('#repositoryTable').innerHTML;
  assert.ok(html.includes('一个公开的仓库'));
  assert.ok(html.includes('机器翻译'));
  assert.ok(html.includes('title="A public repository"'));
});

test('repository rows expose primary and secondary classification labels', async () => {
  const fixture = fixtures();
  Object.assign(fixture.projects[0], {
    fullName: 'morluto/rea', name: 'rea', category: 'mobile', categoryVersion: 1,
    description: 'Reverse engineer anything with agents, from app behavior down to native binaries.',
    topics: ['agent-skills', 'ai-agents', 'binary-analysis', 'claude-code', 'cli', 'developer-tools', 'llm', 'mcp', 'reverse-engineering', 'static-analysis'],
  });
  const ui = await startApp(fixture);
  const html = ui.get('#repositoryTable').innerHTML;
  assert.ok(html.includes('AI &amp; 机器学习'));
  assert.ok(html.includes('安全'));
  assert.ok(html.includes('开发者工具'));
  ui.get('#searchInput').value = '安全';
  await ui.get('#searchInput').emit('input');
  assert.equal(ui.get('#trackedCount').textContent, '1');
  assert.ok(ui.get('#repositoryTable').innerHTML.includes('morluto/rea'));
});

test('unknown Stars remain browsable and a newer unavailable observation removes an old live row', async () => {
  const fixture = fixtures();
  fixture.projects.push({ fullName: 'test/unknown-stars', stars: null, contributors: null, fetchedAt: new Date().toISOString() });
  const ui = await startApp(fixture);
  assert.equal(rowCount(ui.get('#repositoryTable').innerHTML), 2);
  assert.ok(ui.get('#repositoryTable').innerHTML.includes('test/unknown-stars'));
  assert.equal(ui.get('#loadMore').hidden, true);
  const gone = { ...fixture.projects[0], fetchedAt: null, availability: 'unavailable', lastAttemptAt: new Date().toISOString() };
  ui.setLoad(async () => data.assembleSnapshot([gone, fixture.projects[1]], { history: fixture.history }));
  await ui.app.refresh({ silent: true });
  assert.equal(ui.get('#trackedCount').textContent, '1');
  assert.equal(rowCount(ui.get('#repositoryTable').innerHTML), 1);
  assert.ok(!ui.get('#repositoryTable').innerHTML.includes('test/web-0'));
});
