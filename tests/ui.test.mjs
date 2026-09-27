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

async function startApp({ projects, history = {}, liveFetch = async () => { throw new Error('offline test'); } }) {
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const document = { body: element(), hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {} };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  let fetchLive = liveFetch;
  let loadSaved = async () => data.assembleSnapshot(structuredClone(projects), { history: structuredClone(history), source: 'cached' });
  const window = {};
  const context = vm.createContext({
    ...data, document, window, sessionStorage: storage, localStorage: storage,
    loadDashboardData: (...args) => loadSaved(...args), fetchGitHubProjects: (...args) => fetchLive(...args),
    AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context, { filename: 'app.js' });
  await nextTurn(); // Let the application's initial automatic refresh settle.
  assert.equal(get('#refreshButton').disabled, false);
  return { get, app: window.githubPulse, setFetch: (fetcher) => { fetchLive = fetcher; }, setLoad: (loader) => { loadSaved = loader; } };
}
const rowCount = (html) => (html.match(/class="repo-row"/g) || []).length;

test('a real API-shaped repository with null contributors completes all rendering', async () => {
  const { projects, history } = fixtures();
  const ui = await startApp({ projects, history });
  assert.equal(ui.get('#trackedCount').textContent, '1');
  assert.equal(rowCount(ui.get('#opportunityTable').innerHTML), 1);
  assert.equal(rowCount(ui.get('#weeklyTable').innerHTML), 1);
  assert.equal(rowCount(ui.get('#repositoryTable').innerHTML), 1);
  assert.equal(ui.app.getSnapshot().projects[0].contributors, null);
});

test('external descriptions remain escaped text in every repository row', async () => {
  const fixture = fixtures();
  fixture.projects[0].description = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
  fixture.projects[0].language = '"><img src=x>';
  const ui = await startApp(fixture);
  for (const selector of ['#repositoryTable', '#weeklyTable', '#monthlyTable', '#activityList', '#opportunityTable']) {
    const html = ui.get(selector).innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
    assert.ok(html.includes('&amp; &lt;script&gt;bad()&lt;/script&gt;'));
    assert.ok(!html.includes('<img') && !html.includes('<script>'));
  }
});

test('monthly ranking renders 30 actual differences, including negative changes', async () => {
  const ui = await startApp(fixtures(35));
  const html = ui.get('#monthlyTable').innerHTML;
  assert.equal(rowCount(html), 30);
  assert.ok(html.includes('test/web-0'));
  assert.ok(html.includes('test/web-29'));
  assert.ok(!html.includes('test/web-30'));
  assert.ok(html.includes('negative">-29</span>'));
  assert.equal(rowCount(ui.get('#weeklyTable').innerHTML), 10);
});

test('category filtering precedes top-N selection even when global leaders are another category', async () => {
  const web = fixtures(12);
  const ai = fixtures(12, { category: 'ai', prefix: 'ai', baseStars: 100000 });
  const ui = await startApp({ projects: [...ai.projects, ...web.projects], history: { ...ai.history, ...web.history } });
  await ui.get('.category-tabs').emit('click', { target: { closest: () => ({ dataset: { category: 'web' } }) } });
  assert.equal(ui.get('#trackedCount').textContent, '12');
  assert.equal(rowCount(ui.get('#newProjectsTable').innerHTML), 10);
  assert.equal(rowCount(ui.get('#weeklyTable').innerHTML), 10);
  assert.ok(ui.get('#newProjectsTable').innerHTML.includes('test/web-11'));
  assert.ok(!ui.get('#newProjectsTable').innerHTML.includes('test/ai-'));
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
