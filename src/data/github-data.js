/**
 * GitHub dashboard data helpers.
 *
 * The dashboard can use this module in two ways:
 *  - `getDashboardData()` gives an immediately usable snapshot while the page
 *    is loading (or when a GitHub token is not configured).
 *  - `refreshDashboardData(previous)` advances the snapshot by a small,
 *    deterministic amount so a demo can show live updates without a backend.
 *
 * The shape returned here mirrors the fields returned by GitHub's REST API,
 * with a few computed fields (`todayStars`, `weekStars`, `monthStars`) used by
 * the ranking cards. Replacing the mock source with a GitHub API adapter does
 * not require changes in the rendering layer.
 */

const CATEGORY_META = [
  { id: 'ai', label: 'AI & 机器学习', color: '#8b5cf6' },
  { id: 'developer-tools', label: '开发者工具', color: '#22d3ee' },
  { id: 'web', label: 'Web & 前端', color: '#3b82f6' },
  { id: 'infra', label: '基础设施', color: '#f59e0b' },
  { id: 'data', label: '数据与分析', color: '#10b981' },
  { id: 'mobile', label: '移动开发', color: '#ec4899' },
  { id: 'security', label: '安全', color: '#ef4444' },
  { id: 'productivity', label: '效率工具', color: '#f97316' },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_META.map((item) => [item.id, item]));

/** Infer a dashboard category from GitHub's language and topic metadata. */
export function classifyRepository(repository = {}) {
  const haystack = [repository.name, repository.description, repository.language, ...(repository.topics || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const rules = [
    ['ai', /\b(ai|llm|gpt|machine.?learning|deep.?learning|nlp|transformer|agent|model)\b/],
    ['security', /\b(security|vulnerabilit|secret|sast|dast|scanner|supply.?chain|malware)\b/],
    ['mobile', /\b(android|ios|flutter|react.?native|mobile|swift|kotlin)\b/],
    ['data', /\b(data|analytics|database|sql|spark|airflow|etl|warehouse|olap|pandas)\b/],
    ['infra', /\b(kubernetes|docker|terraform|cloud|devops|monitoring|observability|prometheus|grafana)\b/],
    ['web', /\b(web|frontend|react|vue|svelte|next\.js|css|html|browser)\b/],
    ['productivity', /\b(productivity|utility|utilities|workflow|notes|terminal|cli|desktop)\b/],
  ];
  const matched = rules.find(([, pattern]) => pattern.test(haystack));
  return matched ? matched[0] : 'developer-tools';
}

// The values are a representative snapshot, not a claim about current GitHub
// counts. They are intentionally varied so every chart and ranking state is
// useful before a token-backed API is configured.
const PROJECT_SEEDS = [
  ['openai/whisper', 'Whisper', 'Robust Speech Recognition via Large-Scale Weak Supervision', 'ai', 'Python', 79500, 9200, 1100, 1320, 8400, 286, ['speech-to-text', 'audio', 'deep-learning']],
  ['ollama/ollama', 'Ollama', 'Get up and running with large language models locally.', 'ai', 'Go', 131200, 10400, 1840, 9200, 34600, 218, ['llm', 'local-ai', 'golang']],
  ['huggingface/transformers', 'Transformers', 'State-of-the-art Machine Learning for JAX, PyTorch and TensorFlow.', 'ai', 'Python', 137600, 24800, 760, 1180, 5200, 1420, ['nlp', 'transformers', 'pytorch']],
  ['langchain-ai/langchain', 'LangChain', 'Building applications with LLMs through composability.', 'ai', 'Python', 101900, 16200, 630, 1040, 4600, 1010, ['llm', 'agents', 'python']],
  ['microsoft/semantic-kernel', 'Semantic Kernel', 'Integrate cutting-edge LLM technology into your apps.', 'ai', 'C#', 21900, 3700, 220, 280, 1280, 510, ['ai', 'agents', 'dotnet']],
  ['microsoft/vscode', 'Visual Studio Code', 'Code editing. Redefined.', 'developer-tools', 'TypeScript', 168900, 30400, 126, 540, 1900, 2100, ['editor', 'electron', 'typescript']],
  ['neovim/neovim', 'Neovim', 'Hyperextensible Vim-based text editor.', 'developer-tools', 'Lua', 85000, 9800, 108, 430, 1480, 670, ['vim', 'editor', 'lua']],
  ['astral-sh/uv', 'uv', 'An extremely fast Python package and project manager.', 'developer-tools', 'Rust', 40500, 1500, 390, 760, 3200, 190, ['python', 'packaging', 'rust']],
  ['zed-industries/zed', 'Zed', 'High-performance, multiplayer code editor from the creators of Atom.', 'developer-tools', 'Rust', 53500, 3500, 410, 860, 3720, 340, ['editor', 'rust', 'collaboration']],
  ['denoland/deno', 'Deno', 'A modern runtime for JavaScript and TypeScript.', 'developer-tools', 'Rust', 102000, 5700, 180, 410, 1760, 620, ['javascript', 'typescript', 'runtime']],
  ['facebook/react', 'React', 'The library for web and native user interfaces.', 'web', 'JavaScript', 233700, 47700, 210, 500, 2140, 5400, ['react', 'javascript', 'frontend']],
  ['vercel/next.js', 'Next.js', 'The React Framework for the Web.', 'web', 'JavaScript', 130900, 28100, 520, 1150, 5100, 3880, ['react', 'nextjs', 'framework']],
  ['sveltejs/svelte', 'Svelte', 'Cybernetically enhanced web apps.', 'web', 'TypeScript', 81500, 4400, 150, 390, 1610, 760, ['svelte', 'frontend', 'compiler']],
  ['tailwindlabs/tailwindcss', 'Tailwind CSS', 'A utility-first CSS framework for rapidly building custom designs.', 'web', 'TypeScript', 87800, 4600, 260, 580, 2560, 750, ['css', 'tailwindcss', 'frontend']],
  ['vuejs/core', 'Vue', 'A progressive JavaScript framework for building user interfaces.', 'web', 'TypeScript', 210900, 33500, 140, 320, 1370, 4200, ['vue', 'javascript', 'frontend']],
  ['remix-run/remix', 'Remix', 'Build better websites with React.', 'web', 'TypeScript', 29500, 2700, 76, 180, 680, 460, ['react', 'web', 'framework']],
  ['kubernetes/kubernetes', 'Kubernetes', 'Production-Grade Container Scheduling and Management.', 'infra', 'Go', 113500, 41100, 96, 290, 1230, 820, ['kubernetes', 'containers', 'cloud']],
  ['docker/compose', 'Compose', 'Define and run multi-container applications with Docker.', 'infra', 'Go', 34500, 5200, 70, 260, 1100, 320, ['docker', 'containers', 'orchestration']],
  ['hashicorp/terraform', 'Terraform', 'Infrastructure as Code tool.', 'infra', 'Go', 44600, 9900, 120, 250, 980, 420, ['terraform', 'infrastructure', 'cloud']],
  ['grafana/grafana', 'Grafana', 'The open source analytics and interactive visualization web application.', 'infra', 'Go', 66100, 12600, 180, 460, 1840, 760, ['observability', 'monitoring', 'dashboards']],
  ['prometheus/prometheus', 'Prometheus', 'The Prometheus monitoring system and time series database.', 'infra', 'Go', 56400, 9200, 98, 270, 1150, 490, ['monitoring', 'metrics', 'kubernetes']],
  ['apache/airflow', 'Apache Airflow', 'Platform to programmatically author, schedule, and monitor workflows.', 'data', 'Python', 38200, 15100, 95, 310, 1290, 730, ['data-engineering', 'workflow', 'python']],
  ['dbt-labs/dbt-core', 'dbt Core', 'The data build tool.', 'data', 'Python', 10400, 2300, 88, 240, 1020, 310, ['analytics', 'sql', 'data-warehouse']],
  ['pandas-dev/pandas', 'pandas', 'Flexible and powerful data analysis / manipulation library for Python.', 'data', 'Python', 44700, 17800, 74, 180, 760, 1980, ['python', 'data-analysis', 'pandas']],
  ['duckdb/duckdb', 'DuckDB', 'An analytical in-process SQL OLAP database management system.', 'data', 'C++', 24800, 2200, 195, 430, 1870, 250, ['database', 'olap', 'analytics']],
  ['apache/spark', 'Apache Spark', 'Unified analytics engine for large-scale data processing.', 'data', 'Scala', 39300, 27800, 42, 120, 510, 1700, ['big-data', 'spark', 'scala']],
  ['facebook/react-native', 'React Native', 'A framework for building native applications with React.', 'mobile', 'TypeScript', 118800, 25300, 120, 300, 1250, 2440, ['react-native', 'ios', 'android']],
  ['flutter/flutter', 'Flutter', 'Build apps for any screen.', 'mobile', 'Dart', 169600, 28500, 130, 360, 1560, 2750, ['flutter', 'dart', 'mobile']],
  ['expo/expo', 'Expo', 'An open-source platform for making universal native apps.', 'mobile', 'TypeScript', 34200, 6200, 230, 510, 2180, 530, ['react-native', 'expo', 'ios']],
  ['supabase/supabase', 'Supabase', 'The open source Firebase alternative.', 'mobile', 'TypeScript', 79500, 7300, 390, 810, 3470, 980, ['postgres', 'backend', 'typescript']],
  ['appwrite/appwrite', 'Appwrite', 'Secure open-source backend server for web, mobile, and Flutter developers.', 'mobile', 'PHP', 46600, 4300, 180, 410, 1690, 580, ['backend', 'self-hosted', 'mobile']],
  ['ossf/scorecard', 'OpenSSF Scorecard', 'Security health metrics for open source.', 'security', 'Go', 8600, 1100, 52, 210, 850, 290, ['security', 'supply-chain', 'github-actions']],
  ['trufflesecurity/trufflehog', 'TruffleHog', 'Find credentials exposed in code.', 'security', 'Go', 17700, 2100, 230, 540, 2220, 170, ['security', 'secrets', 'scanning']],
  ['aquasecurity/trivy', 'Trivy', 'Find vulnerabilities, misconfigurations, secrets, SBOM in containers.', 'security', 'Go', 23800, 2400, 155, 380, 1540, 340, ['security', 'containers', 'scanner']],
  ['gitleaks/gitleaks', 'Gitleaks', 'Protect your secrets.', 'security', 'Go', 18800, 1900, 140, 360, 1480, 225, ['security', 'git', 'secrets']],
  ['laurent22/rsync', 'Rsync UI', 'A friendly interface for synchronizing files.', 'productivity', 'Rust', 6700, 420, 80, 210, 880, 105, ['productivity', 'desktop', 'rust']],
  ['microsoft/PowerToys', 'PowerToys', 'Windows system utilities to maximize productivity.', 'productivity', 'C#', 115900, 6810, 62, 170, 730, 390, ['windows', 'utilities', 'productivity']],
  ['jesseduffield/lazygit', 'lazygit', 'A simple terminal UI for git commands.', 'productivity', 'Go', 52900, 1900, 200, 490, 2050, 170, ['git', 'terminal', 'tui']],
  ['junegunn/fzf', 'fzf', 'A command-line fuzzy finder.', 'productivity', 'Go', 72100, 3000, 98, 260, 1060, 310, ['terminal', 'cli', 'go']],
];

const BASE_TIME = Date.now();

const hash = (value) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
};

const seededInt = (seed, min, max) => min + (hash(String(seed)) % (max - min + 1));

const isoHoursAgo = (hours, now = BASE_TIME) => new Date(now - hours * 3600 * 1000).toISOString();

const toProject = (seed, index, now) => {
  const [fullName, name, description, category, language, stars, forks, todayStars, weekStars, monthStars, openIssues, topics] = seed;
  const categoryMeta = CATEGORY_BY_ID[category];
  return {
    id: fullName,
    fullName,
    name,
    description,
    category,
    categoryLabel: categoryMeta.label,
    categoryColor: categoryMeta.color,
    language,
    stars,
    forks,
    openIssues,
    todayStars,
    weekStars,
    monthStars,
    contributors: Math.max(12, Math.round(stars / 135)),
    updatedAt: isoHoursAgo(seededInt(`${fullName}:${index}`, 1, 94), now),
    topics,
    rankSeed: seededInt(`${fullName}:rank`, 0, 1000),
    trend: weekStars >= 1000 ? 'up' : weekStars >= 400 ? 'steady' : 'rising',
  };
};

const by = (field) => (left, right) => right[field] - left[field];

const rank = (projects, field, limit) => projects
  .slice()
  .sort((left, right) => by(field)(left, right) || by('stars')(left, right))
  .slice(0, limit)
  .map((project, index) => ({ ...project, rank: index + 1 }));

const categorySummary = (projects) => CATEGORY_META.map((category) => {
  const grouped = projects.filter((project) => project.category === category.id);
  const stars = grouped.reduce((sum, project) => sum + project.stars, 0);
  const weekStars = grouped.reduce((sum, project) => sum + project.weekStars, 0);
  return { ...category, count: grouped.length, stars, weekStars };
});

/** Build all cards and lists consumed by the dashboard. */
export function getDashboardData({ now = Date.now(), tick = 0 } = {}) {
  const projects = PROJECT_SEEDS.map((seed, index) => toProject(seed, index, now));
  // Keep the demo changing between refreshes while preserving a stable order
  // when the same tick is requested (useful for SSR and visual regression).
  if (tick > 0) {
    projects.forEach((project, index) => {
      const delta = seededInt(`${project.id}:${tick}`, 0, Math.max(1, Math.round(project.weekStars * 0.025)));
      project.todayStars += delta;
      project.weekStars += delta * 2;
      project.monthStars += delta * 5;
      project.stars += delta;
      project.updatedAt = isoHoursAgo(seededInt(`${project.id}:${tick}:updated`, 0, 5), now);
    });
  }
  const todayUpdated = projects
    .filter((project) => project.todayStars > 0)
    .sort(by('todayStars'));
  const weeklyFastest = rank(projects, 'weekStars', 10);
  const monthlyTop = rank(projects, 'monthStars', 30);
  const totalStars = projects.reduce((sum, project) => sum + project.stars, 0);
  const totalTodayStars = projects.reduce((sum, project) => sum + project.todayStars, 0);

  return {
    projects,
    categories: categorySummary(projects),
    dailyUpdated: todayUpdated,
    weeklyFastest,
    weeklyTop10: weeklyFastest,
    monthlyTop30: monthlyTop,
    stats: {
      projects: projects.length,
      totalStars,
      todayStars: totalTodayStars,
      categories: CATEGORY_META.length,
      activeToday: todayUpdated.length,
    },
    lastUpdated: new Date(now).toISOString(),
  };
}

/**
 * Convenience helper for a polling loop. `previous` may be omitted for the
 * first call. The returned object is a fresh snapshot and is safe to put in
 * React/Vue state without mutating the previous value.
 */
export function refreshDashboardData(previous) {
  const tick = (previous?.tick || 0) + 1;
  const snapshot = getDashboardData({ now: Date.now(), tick });
  snapshot.tick = tick;
  return snapshot;
}

/**
 * Optional GitHub adapter. A token is only sent when explicitly supplied by
 * the caller; the browser should never hard-code a personal token.
 */
export async function fetchGitHubProjects({ queries = [], token, signal } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const searchQueries = queries.length ? queries : ['stars:>1000'];
  const responses = await Promise.all(searchQueries.map(async (query) => {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30`;
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
    return response.json();
  }));
  return responses.flatMap((response) => response.items || []).map((item) => {
    const category = classifyRepository(item);
    const categoryMeta = CATEGORY_BY_ID[category];
    return {
      id: item.full_name,
      fullName: item.full_name,
      name: item.name,
      description: item.description || '',
      category,
      categoryLabel: categoryMeta.label,
      categoryColor: categoryMeta.color,
      language: item.language || 'Other',
      stars: item.stargazers_count || 0,
      forks: item.forks_count || 0,
      openIssues: item.open_issues_count || 0,
      // Search API has no historical star delta. Keep zeroes explicit so a
      // caller can fill them from Events API or its own persisted snapshots.
      todayStars: 0,
      weekStars: 0,
      monthStars: 0,
      topics: item.topics || [],
      updatedAt: item.updated_at,
      htmlUrl: item.html_url,
      owner: item.owner?.login,
      avatarUrl: item.owner?.avatar_url,
    };
  });
}

export { CATEGORY_META };

export default {
  CATEGORY_META,
  getDashboardData,
  refreshDashboardData,
  fetchGitHubProjects,
};
