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
 * the ranking cards. `createdAt` drives the weekly/monthly/quarterly
 * new-project rankings and the per-category yearly boards; demo seeds carry
 * each project's real creation date (year-month precision), and the live
 * adapter uses GitHub's `created_at`. Replacing the mock source with a GitHub
 * API adapter does not require changes in the rendering layer.
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

// Stars/forks/open-issues counts are refreshed from GitHub by
// scripts/sync-github-data.mjs (see README "自动跟进 GitHub 变化"); between
// runs they are a snapshot, not a claim about current counts. The values stay
// intentionally varied so every chart and ranking state is useful before a
// token-backed live API is configured. The trailing field is each
// project's REAL creation date, so the yearly boards (2022-2026) reflect when
// these projects actually appeared and the year chips never disagree with
// GitHub. The 2026 section holds real repos created in 2026 (top-starred per
// category from a GitHub Search snapshot taken on 2026-09-24; stars/forks/
// issues are real as of that date, the today/week/month deltas are synthesized
// because the snapshot carries no history, and descriptions stay in their
// original English). Since some 2026 repos are younger than 90 days, the
// weekly/monthly/quarterly new-project boards now populate in demo mode too.
const PROJECT_SEEDS = [
  ['openai/whisper', 'Whisper', 'OpenAI 开源的多语言语音识别模型，语音转文字', 'ai', 'Python', 109527, 13285, 0, 2100, 2350, 151, 'MIT', ['speech-to-text', 'audio', 'deep-learning'], '2022-09-21'],
  ['ollama/ollama', 'Ollama', '在本地一键运行各类开源大语言模型', 'ai', 'Go', 181544, 17983, 0, 7400, 7800, 4064, 'MIT', ['llm', 'local-ai', 'golang'], '2023-06-15'],
  ['huggingface/transformers', 'Transformers', 'Hugging Face 预训练模型库，支持 PyTorch/TensorFlow/JAX', 'ai', 'Python', 166572, 34661, 60, 380, 1500, 2390, 'Apache-2.0', ['nlp', 'transformers', 'pytorch'], '2018-10-11'],
  ['langchain-ai/langchain', 'LangChain', '基于大语言模型构建应用的编排开发框架', 'ai', 'Python', 146954, 24587, 1500, 6800, 7400, 560, 'MIT', ['llm', 'agents', 'python'], '2022-10-17'],
  ['microsoft/semantic-kernel', 'Semantic Kernel', '微软出品的 LLM 集成 SDK，把 AI 能力嵌入应用', 'ai', 'C#', 28593, 4786, 640, 2900, 3200, 318, 'MIT', ['ai', 'agents', 'dotnet'], '2023-03-17'],
  ['microsoft/vscode', 'Visual Studio Code', '微软开源的轻量强大的代码编辑器', 'developer-tools', 'TypeScript', 192830, 43009, 126, 540, 1900, 21151, 'MIT', ['editor', 'electron', 'typescript'], '2015-11-18'],
  ['neovim/neovim', 'Neovim', '可高度扩展的 Vim 编辑器升级版', 'developer-tools', 'Lua', 102540, 7131, 108, 430, 1480, 1917, 'NOASSERTION', ['vim', 'editor', 'lua'], '2014-11-10'],
  ['astral-sh/uv', 'uv', '极快的 Python 包管理器和项目管理工具', 'developer-tools', 'Rust', 90116, 3606, 2100, 2200, 2250, 2918, 'Apache-2.0', ['python', 'packaging', 'rust'], '2024-02-26'],
  ['zed-industries/zed', 'Zed', 'Atom 原班团队打造的高性能协作代码编辑器', 'developer-tools', 'Rust', 53500, 3500, 1600, 4300, 4700, 340, 'GPL-3.0', ['editor', 'rust', 'collaboration'], '2023-08-30'],
  ['denoland/deno', 'Deno', '现代化的 JavaScript/TypeScript 运行时，Node 的替代品', 'developer-tools', 'Rust', 102000, 5700, 300, 1400, 1550, 620, 'MIT', ['javascript', 'typescript', 'runtime'], '2018-05-15'],
  ['facebook/react', 'React', 'Meta 开源的构建网页与原生界面的 UI 库', 'web', 'JavaScript', 233700, 47700, 210, 500, 2140, 5400, 'MIT', ['react', 'javascript', 'frontend'], '2013-05-24'],
  ['vercel/next.js', 'Next.js', '基于 React 的全栈 Web 开发框架', 'web', 'JavaScript', 130900, 28100, 30, 240, 980, 3880, 'MIT', ['react', 'nextjs', 'framework'], '2016-10-25'],
  ['sveltejs/svelte', 'Svelte', '编译型前端框架，代码量少、运行性能好', 'web', 'TypeScript', 81500, 4400, 18, 140, 560, 760, 'MIT', ['svelte', 'frontend', 'compiler'], '2016-11-20'],
  ['tailwindlabs/tailwindcss', 'Tailwind CSS', '原子化工具类 CSS 框架，快速搭建自定义界面', 'web', 'TypeScript', 87800, 4600, 28, 220, 900, 750, 'MIT', ['css', 'tailwindcss', 'frontend'], '2017-10-25'],
  ['vuejs/core', 'Vue', '渐进式 JavaScript 前端框架', 'web', 'TypeScript', 210900, 33500, 140, 320, 1370, 4200, 'MIT', ['vue', 'javascript', 'frontend'], '2013-07-29'],
  ['remix-run/remix', 'Remix', '基于 React 的全栈 Web 框架（现归 Shopify）', 'web', 'TypeScript', 29500, 2700, 12, 90, 380, 460, 'MIT', ['react', 'web', 'framework'], '2021-11-22'],
  ['kubernetes/kubernetes', 'Kubernetes', '生产级容器编排与调度系统，云原生基础设施核心', 'infra', 'Go', 113500, 41100, 96, 290, 1230, 820, 'Apache-2.0', ['kubernetes', 'containers', 'cloud'], '2014-06-07'],
  ['docker/compose', 'Compose', '用 YAML 定义并运行多容器 Docker 应用', 'infra', 'Go', 34500, 5200, 10, 80, 320, 320, 'Apache-2.0', ['docker', 'containers', 'orchestration'], '2014-07-29'],
  ['hashicorp/terraform', 'Terraform', '基础设施即代码（IaC）工具，用配置管理云资源', 'infra', 'Go', 44600, 9900, 120, 250, 980, 420, 'BUSL-1.1', ['terraform', 'infrastructure', 'cloud'], '2014-07-19'],
  ['grafana/grafana', 'Grafana', '开源数据可视化与监控面板', 'infra', 'Go', 66100, 12600, 180, 460, 1840, 760, 'AGPL-3.0', ['observability', 'monitoring', 'dashboards'], '2013-12-11'],
  ['prometheus/prometheus', 'Prometheus', '监控告警系统与时序数据库', 'infra', 'Go', 56400, 9200, 98, 270, 1150, 490, 'Apache-2.0', ['monitoring', 'metrics', 'kubernetes'], '2012-11-24'],
  ['apache/airflow', 'Apache Airflow', '数据工作流编排与调度平台', 'data', 'Python', 38200, 15100, 95, 310, 1290, 730, 'Apache-2.0', ['data-engineering', 'workflow', 'python'], '2014-10-08'],
  ['dbt-labs/dbt-core', 'dbt Core', '数据仓库中的数据转换与建模工具', 'data', 'Python', 10400, 2300, 120, 800, 2900, 310, 'Apache-2.0', ['analytics', 'sql', 'data-warehouse'], '2016-07-08'],
  ['pandas-dev/pandas', 'pandas', 'Python 最常用的数据分析与处理库', 'data', 'Python', 44700, 17800, 74, 180, 760, 1980, 'BSD-3-Clause', ['python', 'data-analysis', 'pandas'], '2009-08-20'],
  ['duckdb/duckdb', 'DuckDB', '进程内分析型 SQL 数据库（OLAP），轻量高性能', 'data', 'C++', 24800, 2200, 820, 3500, 3800, 250, 'MIT', ['database', 'olap', 'analytics'], '2018-06-26'],
  ['apache/spark', 'Apache Spark', '大规模数据统一分析计算引擎', 'data', 'Scala', 39300, 27800, 42, 120, 510, 1700, 'Apache-2.0', ['big-data', 'spark', 'scala'], '2010-07-16'],
  ['facebook/react-native', 'React Native', '用 React 构建原生移动应用的跨端框架', 'mobile', 'TypeScript', 118800, 25300, 120, 300, 1250, 2440, 'MIT', ['react-native', 'ios', 'android'], '2015-01-09'],
  ['flutter/flutter', 'Flutter', '谷歌跨平台 UI 框架，一套代码跑多端', 'mobile', 'Dart', 169600, 28500, 130, 360, 1560, 2750, 'BSD-3-Clause', ['flutter', 'dart', 'mobile'], '2014-10-23'],
  ['expo/expo', 'Expo', 'React Native 应用的开发、构建与部署平台', 'mobile', 'TypeScript', 49000, 6200, 320, 1900, 4200, 530, 'MIT', ['react-native', 'expo', 'ios'], '2015-04-17'],
  ['supabase/supabase', 'Supabase', '开源 Firebase 替代品，基于 Postgres 的后端服务', 'mobile', 'TypeScript', 79500, 7300, 1300, 5600, 6100, 980, 'Apache-2.0', ['postgres', 'backend', 'typescript'], '2019-10-12'],
  ['appwrite/appwrite', 'Appwrite', '开源后端服务（BaaS），面向 Web/移动/Flutter 开发者', 'mobile', 'PHP', 46600, 4300, 260, 1300, 2900, 580, 'BSD-3-Clause', ['backend', 'self-hosted', 'mobile'], '2019-08-13'],
  ['ossf/scorecard', 'OpenSSF Scorecard', '开源项目供应链安全健康度评分工具', 'security', 'Go', 8600, 1100, 90, 560, 2000, 290, 'Apache-2.0', ['security', 'supply-chain', 'github-actions'], '2020-09-25'],
  // 原始仓库 2017 年；按 2022 年 v3 重写计
  ['trufflesecurity/trufflehog', 'TruffleHog', '扫描代码与历史中泄露的密钥和凭证', 'security', 'Go', 52000, 2100, 340, 1900, 4300, 170, 'AGPL-3.0', ['security', 'secrets', 'scanning'], '2022-01-12'],
  ['aquasecurity/trivy', 'Trivy', '容器镜像漏洞、配置错误与敏感信息扫描器', 'security', 'Go', 23800, 2400, 35, 260, 1050, 340, 'Apache-2.0', ['security', 'containers', 'scanner'], '2019-04-11'],
  ['gitleaks/gitleaks', 'Gitleaks', 'Git 仓库敏感信息泄露检测工具', 'security', 'Go', 18800, 1900, 22, 160, 650, 225, 'MIT', ['security', 'git', 'secrets'], '2017-03-02'],
  ['laurent22/rsync', 'Rsync UI', '文件同步工具 Rsync 的图形化界面', 'productivity', 'Rust', 6700, 420, 110, 600, 2300, 105, 'MIT', ['productivity', 'desktop', 'rust'], '2023-07-14'],
  ['microsoft/PowerToys', 'PowerToys', '微软官方 Windows 效率工具集（窗口管理、批量改名等）', 'productivity', 'C#', 115900, 6810, 20, 150, 620, 390, 'MIT', ['windows', 'utilities', 'productivity'], '2019-05-15'],
  ['jesseduffield/lazygit', 'lazygit', 'Git 命令的终端图形界面，操作更省心', 'productivity', 'Go', 52900, 1900, 26, 200, 820, 170, 'MIT', ['git', 'terminal', 'tui'], '2018-08-08'],
  ['junegunn/fzf', 'fzf', '命令行模糊搜索神器，文件/历史记录秒搜', 'productivity', 'Go', 72100, 3000, 98, 260, 1060, 310, 'MIT', ['terminal', 'cli', 'go'], '2013-08-16'],
  ['ggml-org/llama.cpp', 'llama.cpp', '纯 C/C++ 实现的大模型本地推理引擎，让 LLM 跑在普通电脑上', 'ai', 'C++', 72000, 8200, 45, 300, 1100, 980, 'MIT', ['llm', 'inference', 'ggml'], '2023-02-26'],
  ['AUTOMATIC1111/stable-diffusion-webui', 'Stable Diffusion web UI', 'Stable Diffusion AI 绘画的经典网页操作界面', 'ai', 'Python', 145000, 17600, 380, 2100, 2350, 3200, 'AGPL-3.0', ['stable-diffusion', 'webui', 'generative-ai'], '2022-08-22'],
  ['comfyanonymous/ComfyUI', 'ComfyUI', '节点式 AI 图像/视频生成工作流界面，可自由拼装流程', 'ai', 'Python', 64000, 6800, 1900, 5400, 5900, 640, 'GPL-3.0', ['stable-diffusion', 'diffusion', 'gui'], '2023-01-15'],
  ['tokio-rs/tokio', 'Tokio', 'Rust 异步编程的运行时基础设施', 'developer-tools', 'Rust', 27000, 2500, 110, 800, 1700, 620, 'MIT', ['rust', 'async', 'runtime'], '2016-02-25'],
  ['rust-lang/rust-analyzer', 'rust-analyzer', 'Rust 语言服务器，为 IDE 提供智能补全和跳转', 'developer-tools', 'Rust', 14000, 1200, 130, 900, 1600, 1500, 'Apache-2.0', ['rust', 'lsp', 'ide'], '2020-01-20'],
  ['BurntSushi/ripgrep', 'ripgrep', '速度极快的递归文本内容搜索工具（grep 替代品）', 'developer-tools', 'Rust', 49000, 1900, 20, 150, 600, 210, 'MIT', ['search', 'regex', 'cli'], '2016-04-12'],
  ['cli/cli', 'GitHub CLI', 'GitHub 官方命令行工具，终端里管仓库/PR/Issue', 'developer-tools', 'Go', 38000, 5100, 25, 190, 760, 640, 'MIT', ['github', 'cli', 'go'], '2019-09-17'],
  ['axios/axios', 'Axios', '浏览器和 Node.js 常用的 Promise HTTP 请求库', 'web', 'JavaScript', 106000, 11000, 110, 290, 880, 420, 'MIT', ['http', 'client', 'javascript'], '2014-08-24'],
  ['solidjs/solid', 'Solid', '不依赖虚拟 DOM 的高性能前端 UI 库', 'web', 'TypeScript', 31000, 900, 780, 3300, 3600, 210, 'MIT', ['reactivity', 'frontend', 'jsx'], '2016-04-22'],
  ['storybookjs/storybook', 'Storybook', 'UI 组件独立开发、测试和文档化工作台', 'web', 'TypeScript', 85000, 9300, 22, 170, 680, 1600, 'MIT', ['ui', 'components', 'workshop'], '2016-03-16'],
  ['withastro/astro', 'Astro', '以速度为卖点的内容型网站全栈框架', 'web', 'TypeScript', 48000, 2500, 940, 3900, 4300, 620, 'MIT', ['astro', 'ssg', 'web'], '2021-03-09'],
  ['argoproj/argo-cd', 'Argo CD', 'Kubernetes 声明式 GitOps 持续交付工具', 'infra', 'Go', 17000, 5300, 150, 850, 2900, 760, 'Apache-2.0', ['gitops', 'kubernetes', 'cd'], '2018-03-13'],
  ['istio/istio', 'Istio', '服务网格：连接、保护、治理和观测微服务', 'infra', 'Go', 36000, 7600, 12, 95, 380, 1500, 'Apache-2.0', ['service-mesh', 'kubernetes', 'microservices'], '2016-12-05'],
  ['helm/helm', 'Helm', 'Kubernetes 应用的包管理器', 'infra', 'Go', 26000, 4800, 10, 80, 320, 680, 'Apache-2.0', ['kubernetes', 'package-manager', 'helm'], '2015-10-15'],
  ['pola-rs/polars', 'Polars', 'Rust 编写的高性能 DataFrame 数据分析库', 'data', 'Rust', 31000, 2000, 30, 220, 900, 1900, 'MIT', ['dataframe', 'rust', 'analytics'], '2020-08-18'],
  ['ClickHouse/ClickHouse', 'ClickHouse', '实时分析型列式数据库，查询速度极快', 'data', 'C++', 38000, 6500, 25, 180, 720, 2600, 'Apache-2.0', ['database', 'analytics', 'olap'], '2016-06-17'],
  ['sigstore/cosign', 'Cosign', '容器镜像签名与验证工具，保障软件供应链安全', 'security', 'Go', 4700, 520, 130, 750, 2000, 270, 'Apache-2.0', ['security', 'signing', 'containers'], '2021-03-30'],
  ['sharkdp/bat', 'bat', '带语法高亮和 Git 集成的 cat 增强版文件查看器', 'productivity', 'Rust', 50000, 1500, 15, 110, 450, 120, 'MIT', ['terminal', 'rust', 'cli'], '2018-01-08'],
  ['CompVis/stable-diffusion', 'Stable Diffusion', 'Stability AI 开源的潜在扩散文本到图像生成模型', 'ai', 'Python', 68000, 9800, 15, 110, 450, 480, 'OpenRAIL-M', ['stable-diffusion', 'diffusion', 'generative-ai'], '2022-08-10'],
  ['starship/starship', 'Starship', '极简、高速、可高度定制的终端提示符', 'productivity', 'Rust', 46000, 1500, 18, 140, 560, 410, 'ISC', ['shell', 'prompt', 'rust'], '2019-04-23'],
  // ---- 2024-2025 年 ----
  ['DavidHDev/react-bits', 'React Bits', '面向 React 的动画组件与背景特效合集', 'web', 'JavaScript', 12000, 260, 290, 1300, 2600, 120, 'MIT', ['react', 'animation', 'components'], '2024-07-19'],
  ['charmbracelet/crush', 'Crush', 'Charm 出品的终端 AI 编码助手，可接多家模型', 'developer-tools', 'Go', 11000, 140, 320, 1500, 3000, 95, 'MIT', ['ai', 'terminal', 'cli'], '2025-03-05'],
  ['pydantic/pydantic-ai', 'PydanticAI', '基于 Pydantic 的类型安全 AI 智能体框架', 'ai', 'Python', 16000, 520, 380, 1900, 3900, 140, 'MIT', ['ai-agents', 'pydantic', 'python'], '2024-11-14'],
  ['vllm-project/production-stack', 'vLLM Production Stack', 'vLLM 官方出品的生产部署参考架构与 Helm 套件', 'infra', 'Python', 9000, 320, 140, 680, 1400, 88, 'Apache-2.0', ['llm', 'kubernetes', 'vllm'], '2024-11-08'],
  ['openai/openai-agents-python', 'OpenAI Agents SDK', 'OpenAI 出品的轻量智能体框架，支持多 Agent 工作流', 'ai', 'Python', 20000, 900, 460, 2300, 4800, 180, 'MIT', ['ai-agents', 'llm', 'workflows'], '2025-03-11'],
  ['google-gemini/gemini-cli', 'Gemini CLI', 'Google 开源的终端 AI 编程助手，基于 Gemini 模型', 'developer-tools', 'TypeScript', 55000, 640, 620, 2600, 5400, 240, 'Apache-2.0', ['ai', 'cli', 'coding-agent'], '2025-06-25'],
  ['volcengine/verl', 'verl', '字节开源的大模型 RL 训练框架，擅长 Agent 强化学习', 'ai', 'Python', 26000, 780, 420, 2100, 4500, 160, 'Apache-2.0', ['rl', 'llm', 'agents'], '2024-07-10'],
  ['microsoft/agent-framework', 'Agent Framework', '微软统一的智能体开发框架，融合 Semantic Kernel 与 AutoGen', 'ai', 'Python', 14000, 380, 130, 640, 1700, 84, 'MIT', ['agents', 'llm', 'autogen'], '2025-09-15'],
  // ---- 2023-2025 年 ----
  ['nuejs/nue', 'Nue', '贴近 Web 标准的现代前端框架，强调渐进增强与极致性能', 'web', 'JavaScript', 7400, 180, 80, 380, 1100, 58, 'MIT', ['frontend', 'framework', 'web-standards'], '2023-09-12'],
  ['tconbeer/harlequin', 'Harlequin', '运行在终端里的 SQL IDE，支持 DuckDB 与 ClickHouse', 'developer-tools', 'Python', 3900, 90, 60, 300, 850, 48, 'MIT', ['sql', 'terminal', 'duckdb'], '2023-03-21'],
  ['NVIDIA/dynamo', 'Dynamo', 'NVIDIA 开源的 LLM 推理服务框架，支持推理阶段解耦', 'infra', 'Python', 12900, 780, 170, 840, 2300, 92, 'Apache-2.0', ['llm', 'inference', 'serving'], '2025-02-24'],
  ['huggingface/smolagents', 'smolagents', 'Hugging Face 极简智能体框架，核心逻辑不足千行', 'ai', 'Python', 6800, 410, 180, 900, 2400, 105, 'Apache-2.0', ['agents', 'llm', 'huggingface'], '2024-12-09'],
  ['deepseek-ai/DeepSeek-R1', 'DeepSeek-R1', 'DeepSeek 开源的推理大模型，强化学习驱动思维链', 'ai', 'Python', 9100, 620, 220, 1100, 2900, 130, 'MIT', ['llm', 'reasoning', 'open-model'], '2025-01-20'],
  ['tensorzero/tensorzero', 'TensorZero', '面向生产环境的 LLM 应用栈，统一网关与优化回路', 'infra', 'Rust', 5600, 210, 90, 460, 1300, 62, 'Apache-2.0', ['llm', 'gateway', 'observability'], '2024-09-10'],
  ['daytonaio/daytona', 'Daytona', '开源的开发环境管理器，秒级创建隔离的开发容器', 'developer-tools', 'Go', 9500, 210, 130, 640, 1700, 75, 'AGPL-3.0', ['dev-environment', 'containers', 'development'], '2024-04-16'],
  ['QwenLM/Qwen3', 'Qwen3', '通义千问 Qwen3 开源大模型权重与推理代码', 'ai', 'Python', 7800, 540, 160, 820, 2300, 96, 'Apache-2.0', ['llm', 'qwen', 'open-model'], '2025-04-28'],
  // ---- 2025 年 ----
  ['openai/codex', 'Codex CLI', 'OpenAI 开源的终端 AI 编程助手', 'ai', 'Rust', 16800, 1300, 90, 620, 2400, 320, 'Apache-2.0', ['ai', 'cli', 'coding-agent'], '2025-04-16'],
  ['bytedance/UI-TARS', 'UI-TARS', '字节开源的多模态 GUI 智能体，能操作桌面与浏览器', 'ai', 'Python', 6300, 380, 70, 380, 1500, 85, 'Apache-2.0', ['agents', 'gui', 'multimodal'], '2025-01-20'],
  ['sst/opencode', 'opencode', '终端里的开源 AI 编程助手，支持多家模型', 'developer-tools', 'TypeScript', 16200, 420, 110, 640, 2500, 290, 'MIT', ['ai', 'cli', 'coding'], '2025-05-08'],
  ['voideditor/void', 'Void', '开源的 AI 原生代码编辑器（VS Code 分支）', 'developer-tools', 'TypeScript', 8600, 260, 80, 460, 1800, 140, 'MIT', ['editor', 'ai', 'vscode'], '2025-05-29'],
  ['Yonom/assistant-ui', 'assistant-ui', 'React 的 AI 聊天界面组件库，可对接任意后端', 'web', 'TypeScript', 7800, 190, 60, 380, 1400, 95, 'MIT', ['react', 'ai', 'chat-ui'], '2024-06-05'],
  ['janhq/jan', 'Jan', '离线优先的开源 AI 助手桌面应用', 'productivity', 'TypeScript', 34200, 2100, 55, 380, 1500, 240, 'AGPL-3.0', ['ai', 'desktop', 'llm'], '2023-11-06'],
  ['vllm-project/aibrix', 'AIBrix', '构建在 Kubernetes 上的 LLM 推理基础设施', 'infra', 'Python', 4700, 220, 40, 260, 950, 66, 'Apache-2.0', ['llm', 'kubernetes', 'inference'], '2024-06-24'],
  ['kgateway-dev/kgateway', 'kgateway', '基于 Envoy 的 Kubernetes 网关（Gloo 网关演进版）', 'infra', 'Go', 4300, 260, 25, 170, 700, 58, 'Apache-2.0', ['kubernetes', 'gateway', 'envoy'], '2024-11-18'],
  ['promptfoo/promptfoo', 'promptfoo', '对 LLM 应用做红队测试、评估与提示词迭代', 'security', 'TypeScript', 6200, 510, 45, 290, 1150, 180, 'MIT', ['llm', 'security', 'evals'], '2023-06-14'],
  ['dlt-hub/dlt', 'dlt', 'Python 写的轻量 ELT 数据管道框架', 'data', 'Python', 15800, 740, 35, 220, 880, 210, 'Apache-2.0', ['etl', 'data-pipeline', 'python'], '2022-07-27'],
  ['shorebirdtech/shorebird', 'Shorebird', 'Flutter 应用的代码热更新服务与命令行', 'mobile', 'Dart', 3600, 120, 20, 130, 520, 34, 'Apache-2.0', ['flutter', 'code-push', 'mobile'], '2023-02-14'],
  ['chdb-io/chdb', 'chDB', '嵌入式 ClickHouse 引擎的 SQL 分析库', 'data', 'C++', 3000, 110, 15, 95, 380, 42, 'Apache-2.0', ['olap', 'clickhouse', 'embedded'], '2023-10-07'],
  // ---- 2024 年 ----
  ['xai-org/grok-1', 'grok-1', 'xAI 开源的 314B MoE 大模型权重', 'ai', 'Python', 9200, 700, 30, 200, 800, 65, 'Apache-2.0', ['llm', 'open-model', 'moe'], '2024-03-17'],
  ['microsoft/PyRIT', 'PyRIT', '微软开源的生成式 AI 安全红队测试框架', 'security', 'Python', 4600, 380, 20, 140, 560, 130, 'MIT', ['ai-security', 'red-team', 'llm'], '2024-02-22'],
  ['grafana/alloy', 'Alloy', 'Grafana 开源的可观测性数据收集器（OTel 发行版）', 'infra', 'Go', 9100, 590, 28, 180, 720, 210, 'Apache-2.0', ['opentelemetry', 'monitoring', 'collector'], '2024-01-16'],
  ['unitycatalog/unitycatalog', 'Unity Catalog', 'Databricks 开源的 AI 与数据资产目录治理工具', 'data', 'Java', 3400, 260, 15, 100, 420, 88, 'Apache-2.0', ['data-catalog', 'governance', 'unity'], '2024-06-27'],
  ['openbao/openbao', 'OpenBao', 'Linux Foundation 维护的 Vault 开源分支', 'infra', 'Go', 5200, 290, 18, 120, 480, 95, 'MPL-2.0', ['secrets', 'security', 'vault'], '2024-11-12'],
  ['lancedb/lancedb', 'LanceDB', '面向 AI 应用的嵌入式多模态向量数据库', 'data', 'Rust', 5900, 240, 22, 150, 600, 120, 'Apache-2.0', ['vector-database', 'embeddings', 'ai'], '2023-03-03'],
  ['mendableai/firecrawl', 'Firecrawl', '面向 LLM 的网页抓取与结构化数据提取 API', 'web', 'TypeScript', 6300, 310, 25, 160, 640, 90, 'MIT', ['scraping', 'llm', 'api'], '2024-04-16'],
  ['livekit/livekit', 'LiveKit', '开源的实时音视频通话与流媒体基础设施', 'mobile', 'Go', 14800, 1200, 40, 280, 1100, 320, 'Apache-2.0', ['webrtc', 'real-time', 'audio-video'], '2021-07-19'],
  // ---- 2023 年 ----
  ['Significant-Gravitas/Auto-GPT', 'Auto-GPT', '让 GPT-4 自主拆解并执行目标的早期自治智能体', 'ai', 'Python', 173000, 12000, 25, 150, 600, 2100, 'MIT', ['autonomous-agents', 'gpt', 'ai'], '2023-03-16'],
  ['continuedev/continue', 'Continue', 'IDE 里的开源 AI 编码助手，支持自定义模型', 'developer-tools', 'TypeScript', 26600, 2100, 30, 210, 840, 460, 'Apache-2.0', ['ai', 'ide', 'coding'], '2023-05-17'],
  ['paradedb/paradedb', 'ParadeDB', '基于 PostgreSQL 的开源分析型搜索引擎', 'data', 'Rust', 6400, 150, 14, 95, 380, 75, 'AGPL-3.0', ['postgres', 'elasticsearch', 'analytics'], '2023-04-04'],
  ['protectai/llm-guard', 'LLM Guard', '保护 AI 应用的安全工具集，扫描提示词与输出', 'security', 'Python', 3400, 190, 12, 85, 340, 60, 'Apache-2.0', ['llm', 'security', 'guardrails'], '2023-08-01'],
  // ---- 补录：2022/2025 年的真实工程 ----
  ['denoland/fresh', 'Fresh', 'Deno 的全栈 Web 框架，Islands 架构服务端渲染', 'web', 'TypeScript', 12400, 320, 18, 120, 470, 95, 'MIT', ['deno', 'ssr', 'web-framework'], '2022-06-22'],
  ['opencost/opencost', 'OpenCost', 'Kubernetes 集群与工作负载的成本监控工具', 'infra', 'Go', 5600, 280, 15, 100, 420, 85, 'Apache-2.0', ['kubernetes', 'cost', 'monitoring'], '2022-06-21'],
  ['usememos/memos', 'Memos', '开源自托管的轻量备忘录与笔记服务', 'productivity', 'Go', 38000, 2100, 40, 280, 1150, 210, 'MIT', ['notes', 'self-hosted', 'memo'], '2022-06-19'],
  ['t3-oss/t3chat', 't3chat', 'T3 技术栈开源的 AI 聊天全栈应用', 'web', 'TypeScript', 6200, 190, 60, 380, 1500, 95, 'MIT', ['ai', 'nextjs', 'chat'], '2025-03-10'],
  ['lynx-family/lynx', 'Lynx', '字节开源的跨端 UI 框架，一套代码渲染移动端与 Web', 'mobile', 'C++', 9400, 260, 90, 560, 2200, 120, 'Apache-2.0', ['cross-platform', 'ui-framework', 'mobile'], '2025-03-05'],
  ['google/langextract', 'LangExtract', 'Google 开源的 LLM 信息抽取库，从非结构化文本提取结构化数据', 'data', 'Python', 3100, 140, 40, 260, 1050, 60, 'Apache-2.0', ['llm', 'nlp', 'extraction'], '2025-05-15'],
  // ---- 2026 年（GitHub 真实数据快照 2026-09-24，按分类取高星代表）----
  ['affaan-m/ECC', 'ECC', 'The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond.', 'ai', 'JavaScript', 266216, 39784, 44, 1231, 9000, 223, 'MIT', ['ai-agents', 'anthropic', 'claude', 'claude-code', 'developer-tools', 'llm', 'mcp', 'productivity'], '2026-01-18'],
  ['DietrichGebert/ponytail', 'ponytail', 'Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote.', 'ai', 'JavaScript', 145049, 7773, 167, 936, 3399, 302, 'MIT', ['agent-skills', 'ai-agents', 'claude', 'claude-code', 'claude-code-plugin', 'cursor-rules', 'developer-tools', 'llm', 'prompt-engineering', 'yagni'], '2026-06-12'],
  ['Graphify-Labs/graphify', 'graphify', 'Turn any codebase, with its docs, SQL schemas, configs, and PDFs, into a queryable knowledge graph. A /graphify skill for Claude Code, Cursor, Codex, and Gemini CLI: local deterministic AST parsing, every edge explained, no vector store.', 'ai', 'Python', 120936, 11662, 0, 2, 461, 1442, 'Apache-2.0', ['ai-agents', 'antigravity', 'ast', 'claude-code', 'code-analysis', 'code-search', 'codex', 'cursor', 'developer-tools', 'gemini', 'graphrag', 'knowledge-graph', 'leiden', 'llm', 'mcp', 'openclaw', 'rag', 'skills', 'tree-sitter'], '2026-04-03'],
  ['JuliusBrussee/caveman', 'caveman', '🪨 why use many token when few token do trick. Viral skill + proxy for coding agents that cuts 65% of tokens by talking like a caveman.', 'ai', 'Go', 107575, 6234, 87, 472, 4369, 129, 'NOASSERTION', ['ai', 'anthropic', 'caveman', 'claude', 'claude-code', 'llm', 'meme', 'prompt-engineering', 'skill', 'tokens'], '2026-04-04'],
  ['nexu-io/open-design', 'open-design', '🎨 Best DeepSeek Harness Design Plugin. The open-source Claude Design alternative. 🖥️ Local-first desktop app. 🖼️ Your coding agent becomes the design engine: prototypes, landing pages, dashboards, slides, images & video — real files, HTML/PDF/PPTX/MP4 export. 🤖 Claude Code / Codex / Cursor / DeepSeek Harness / OpenCode & 20+ CLIs via BYOK.', 'ai', 'TypeScript', 97839, 11351, 58, 1025, 4462, 1106, 'Apache-2.0', ['agent-skills', 'ai-design', 'byok', 'claude-code-for-design', 'claude-design', 'codex-design', 'coding-agents', 'cursor-design', 'deepseek', 'deepseek-harness', 'design-systems', 'desktop-app', 'dsh', 'dsh-plugin', 'figma-alternative', 'hermes-agent', 'local-first', 'prototyping', 'ui-generator', 'vibe-coding'], '2026-04-28'],
  ['karpathy/autoresearch', 'autoresearch', 'AI agents running research on single-GPU nanochat training automatically', 'ai', 'Python', 96682, 13522, 18, 793, 4328, 194, 'NOASSERTION', [], '2026-03-06'],
  ['Leonxlnx/taste-skill', 'taste-skill', 'Taste-Skill - gives your AI good taste. stops the AI from generating boring, generic slop ', 'ai', 'JavaScript', 89624, 6094, 55, 675, 3164, 70, 'MIT', ['agent', 'ai', 'claude', 'claude-code', 'codex', 'coding', 'design', 'frontend', 'lowcode', 'nocode', 'skill', 'skills', 'vibecoding'], '2026-02-19'],
  ['koala73/worldmonitor', 'worldmonitor', 'Real-time global intelligence dashboard. AI-powered news aggregation, geopolitical monitoring, and infrastructure tracking in a unified situational awareness interface', 'ai', 'TypeScript', 87290, 13292, 1, 8, 422, 347, 'AGPL-3.0', ['agent', 'ai', 'dashboard', 'geopolitics', 'mcp', 'mcp-server', 'monitoring', 'news', 'opensource', 'osint', 'palantir', 'situation'], '2026-01-08'],
  ['Panniantong/Agent-Reach', 'Agent-Reach', 'Give your AI agent eyes to see the entire internet. Read & search Twitter, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu — one CLI, zero API fees.', 'ai', 'Python', 85111, 7471, 64, 609, 4908, 162, 'MIT', ['agent-infrastructure', 'ai-agent', 'ai-search', 'automation', 'bilibili', 'claude-code', 'cli', 'cursor', 'free-api', 'llm-tools', 'mcp', 'python', 'reddit-scraper', 'twitter-scraper', 'web-scraper', 'xiaohongshu', 'youtube-transcript'], '2026-02-24'],
  ['Egonex-AI/Understand-Anything', 'Understand-Anything', 'Graphs that teach > graphs that impress. Turn any code into an interactive knowledge graph you can explore, search, and ask questions about. Works with Claude Code, Codex, Cursor, Copilot, Gemini CLI, and more.', 'ai', 'TypeScript', 83905, 7071, 215, 1101, 4638, 304, 'MIT', ['antigravity-skills', 'business-knowledge', 'claude-code', 'claude-skills', 'codebase-analysis', 'codex', 'codex-skills', 'developer-tools-ai-agent', 'gemini-cli-skills', 'karpathy-llm-wiki', 'knowledge-base', 'knowledge-graph', 'memory', 'opencode-skills', 'pi-agent', 'understandcode', 'vibe-coding'], '2026-03-15'],
  ['rtk-ai/rtk', 'rtk', 'CLI proxy that reduces LLM token consumption by 60-90% on common dev commands. Single Rust binary, zero dependencies', 'ai', 'Rust', 81591, 5161, 74, 1248, 4645, 1574, 'Apache-2.0', ['agentic-coding', 'ai-coding', 'anthropic', 'claude-code', 'cli', 'command-line-tool', 'cost-reduction', 'developer-tools', 'llm', 'open-source', 'productivity', 'rust', 'token-optimization'], '2026-01-22'],
  ['stablyai/orca', 'orca', 'Orca is the ADE for working with a fleet of parallel agents. Run any coding agent with your own subscription. Available on desktop, mobile and remote runtime.', 'ai', 'TypeScript', 76647, 5020, 11, 211, 2523, 6684, 'MIT', ['ade', 'agent-ide', 'ai-agents', 'claude-code', 'cli', 'codex', 'cursor-agent', 'devtools', 'ghostty', 'ide', 'mobile-app', 'opencode', 'orchestration', 'parallel-agents', 'pi', 'terminal', 'worktrees', 'yc-backed'], '2026-03-17'],
  ['headroomlabs-ai/headroom', 'headroom', 'Compress tool outputs, logs, files, and RAG chunks before they reach the LLM. 20% fewer tokens for coding agents, 60-95% fewer tokens for JSON, same answers. Library, proxy, MCP server.', 'ai', 'Python', 73658, 5683, 30, 191, 1003, 709, 'Apache-2.0', ['agent', 'ai', 'anthropic', 'claude-code', 'compression', 'context-engineering', 'context-window', 'cursor', 'fastapi', 'langchain', 'llm', 'mcp', 'openai', 'prompt-engineering', 'proxy', 'python', 'rag', 'token-optimization', 'tokens', 'typescript'], '2026-01-07'],
  ['career-ops-hq/career-ops', 'career-ops', 'Open-source AI job search: scan job portals, evaluate listings into a structured A-H report with a global 1-5 score, tailor your CV, track applications — runs locally in your AI coding CLI (Claude Code, Codex, OpenCode, Antigravity…)', 'ai', 'JavaScript', 72534, 13645, 67, 282, 1320, 629, 'MIT', ['ai-agent', 'ai-job-search', 'ats', 'career', 'careerops', 'claude-code', 'cli', 'cover-letter', 'cv', 'interview-prep', 'job-application', 'job-hunting', 'job-search', 'job-tracker', 'jobsearch', 'jobseekers', 'local-first', 'open-source', 'resume', 'resume-builder'], '2026-04-04'],
  ['tt-a1i/archify', 'archify', 'Agent skill for beautiful, verifiable architecture, workflow, sequence, data-flow, and lifecycle diagrams—self-contained HTML with motion and crisp export.', 'ai', 'JavaScript', 70650, 4749, 11, 807, 2523, 160, 'MIT', ['agent-skills', 'architecture-as-code', 'architecture-diagram', 'claude-skill', 'code-visualization', 'codex', 'coding-agents', 'data-flow-diagram', 'deepseek-harness', 'developer-tools', 'diagram-as-code', 'diagrams', 'diagrams-as-code', 'dsh-plugin', 'mermaid-alternative', 'opencode', 'sequence-diagram', 'software-architecture', 'system-design', 'text-to-diagram'], '2026-04-15'],
  ['diegosouzapw/OmniRoute', 'OmniRoute', 'Never stop coding. Free MIT AI gateway: one endpoint, 359 providers (150+ free), 1200+ models Kimi, Claude, GPT, Gemini, GLM, DeepSeek, MiniMax. Works with Claude Code, Codex, Cursor, OpenCode, Cline & Copilot. Quota-aware auto-fallback, RTK+Caveman compression saves 15-95% tokens, MCP/A2A, Desktop/PWA. Built by hundreds of contributors', 'ai', 'TypeScript', 69633, 9882, 6, 36, 429, 627, 'MIT', ['a2a', 'ai-agents', 'ai-gateway', 'anthropic', 'claude', 'claude-code', 'cline', 'codex', 'copilot', 'cursor', 'deepseek', 'free-ai', 'gemini', 'kimi', 'llm-gateway', 'mcp', 'openai', 'openai-proxy', 'qwen', 'token-saver'], '2026-02-13'],
  ['ZhuLinsen/daily_stock_analysis', 'daily_stock_analysis', 'LLM 驱动的多市场股票智能分析系统：多源行情、实时新闻、决策看板与自动推送，支持零成本定时运行。  LLM-powered multi-market stock analysis system with multi-source market data, real-time news, decision dashboard, automated notifications, and cost-free scheduled runs.', 'ai', 'Python', 65541, 54778, 11, 42, 493, 48, 'MIT', ['a-stock', 'ai-agent', 'aigc', 'llm', 'quant', 'quantitative-finance', 'quantitative-trading'], '2026-01-10'],
  ['mvanhorn/last30days-skill', 'last30days-skill', 'AI agent skill that researches any topic across Reddit, X, YouTube, HN, Polymarket, and the web - then synthesizes a grounded summary', 'ai', 'Python', 62723, 5460, 52, 314, 1426, 120, 'MIT', ['ai-prompts', 'ai-skill', 'bluesky', 'claude', 'claude-code', 'clawhub', 'deep-research', 'hackernews', 'instagram', 'openclaw', 'polymarket', 'recency', 'reddit', 'research', 'social-media', 'tiktok', 'trends', 'twitter', 'web-search', 'youtube'], '2026-01-23'],
  ['calesthio/OpenMontage', 'OpenMontage', 'World\'s first open-source, agentic video production system. 12 production pipelines, 100+ tools, 700+ agent skill and production-knowledge files. Turn your AI coding assistant into a full video production studio.', 'ai', 'Python', 61060, 7765, 46, 253, 945, 331, 'AGPL-3.0', ['agent', 'agentic-ai', 'ai', 'claude', 'copilot', 'cursor', 'elevenlabs', 'ffmpeg', 'flux', 'image-generation', 'open-source', 'openai', 'python', 'remotion', 'stable-diffusion', 'text-to-speech', 'text-to-video', 'video-generation', 'video-production'], '2026-03-29'],
  ['MemPalace/mempalace', 'mempalace', 'The best-benchmarked open-source AI memory system. And it\'s free.', 'ai', 'Python', 59255, 7567, 6, 68, 284, 748, 'MIT', ['ai', 'chromadb', 'llm', 'mcp', 'memory', 'python'], '2026-04-05'],
  ['rohitg00/ai-engineering-from-scratch', 'ai-engineering-from-scratch', 'Learn it. Build it. Ship it for others.', 'ai', 'Python', 55785, 9851, 15, 241, 906, 59, 'MIT', ['agents', 'ai', 'ai-agents', 'ai-engineering', 'computer-vision', 'course', 'deep-learning', 'from-scratch', 'generative-ai', 'llm', 'machine-learning', 'mcp', 'nlp', 'python', 'reinforcement-learning', 'rust', 'swarm-intelligence', 'transformers', 'tutorial', 'typescript'], '2026-03-18'],
  ['jamiepine/voicebox', 'voicebox', 'The open-source AI voice studio. Clone, dictate, create.', 'ai', 'TypeScript', 55539, 6924, 15, 63, 463, 703, 'MIT', ['ai', 'cuda', 'mlx', 'qwen3-tts', 'qwen3-tts-ui', 'voice-ai', 'voice-clone', 'whisper'], '2026-01-25'],
  ['VoltAgent/awesome-openclaw-skills', 'awesome-openclaw-skills', 'The awesome collection of OpenClaw skills. 5,400+ skills filtered and categorized from the official OpenClaw Skills Registry.🦞', 'ai', 'Other', 52756, 5044, 9, 101, 752, 4, 'MIT', ['agent-skills', 'awesome', 'awesome-list', 'awesome-lists', 'clawd', 'clawdbot', 'clawdbot-skill', 'clawdhub', 'moltbot', 'moltbot-skills', 'openclaw', 'openclaw-skills'], '2026-01-25'],
  ['heygen-com/hyperframes', 'hyperframes', 'Write HTML. Render video. Built for agents.', 'ai', 'TypeScript', 52687, 4814, 52, 334, 2222, 201, 'Apache-2.0', ['ai', 'animation', 'ffmpeg', 'framework', 'gsap', 'html', 'mcp', 'puppeteer', 'rendering', 'typescript', 'video'], '2026-03-10'],
  ['blader/humanizer', 'humanizer', 'Agent skill that removes signs of AI-generated writing from text', 'ai', 'Python', 51685, 4138, 22, 136, 701, 25, 'MIT', ['agent-skills', 'ai-writing', 'claude-code', 'codex', 'cursor', 'prompt-engineering', 'writing-tools'], '2026-01-18'],
  ['multica-ai/multica', 'multica', 'Make humans and AI agents work as one team — open-source and self-hostable.', 'ai', 'Go', 51240, 6638, 12, 277, 779, 1672, 'NOASSERTION', [], '2026-01-13'],
  ['ayghri/i-have-adhd', 'i-have-adhd', 'A skill to stop your coding agent from burying the answer. ADHD-friendly output.', 'ai', 'Python', 50719, 2927, 16, 166, 938, 70, 'MIT', ['adhd', 'claude-', 'claude-code-plugin', 'claude-skills', 'developer-tools', 'productivity'], '2026-05-13'],
  ['HKUDS/CLI-Anything', 'CLI-Anything', '"CLI-Anything: Making ALL Software Agent-Native" -- CLI-Hub: https://clianything.cc/', 'ai', 'Python', 49962, 4602, 17, 98, 1104, 108, 'Apache-2.0', [], '2026-03-08'],
  ['Imbad0202/academic-research-skills', 'academic-research-skills', 'Academic Research Skills for Claude Code: research → write → review → revise → finalize', 'ai', 'Python', 49305, 3819, 10, 220, 1319, 34, 'NOASSERTION', ['academic-pipeline', 'academic-writing', 'ai-research', 'claude', 'claude-code', 'literature-review', 'peer-review', 'prompt-engineering'], '2026-02-26'],
  ['kepano/obsidian-skills', 'obsidian-skills', 'Agent skills for Obsidian. Teach your agent to use Obsidian CLI and open formats including Markdown, Bases, JSON Canvas.', 'ai', 'Other', 48815, 3478, 5, 25, 263, 73, 'MIT', ['agents', 'agentskills', 'bases', 'claude', 'clawdbot', 'cli', 'codex', 'defuddle', 'hermes', 'jsoncanvas', 'knap', 'markdown', 'md', 'obsidian', 'openclaw', 'opencode', 'skills'], '2026-01-02'],
  ['VoltAgent/awesome-design-md', 'awesome-design-md', 'A collection of DESIGN.md files analysis by popular brand design systems. Drop one into your project and let coding agents generate a matching UI.', 'developer-tools', 'Other', 117551, 13173, 2, 3, 3524, 311, 'MIT', ['awesome-list', 'design-md', 'design-system', 'design-tokens', 'figma', 'google-stitch', 'landing-page', 'vibe-coding', 'vibe-design', 'vibecoding'], '2026-03-31'],
  ['openai/symphony', 'symphony', 'Symphony turns project work into isolated, autonomous implementation runs, allowing teams to manage work instead of supervising coding agents.', 'developer-tools', 'Elixir', 27381, 2837, 57, 266, 1227, 8, 'Apache-2.0', [], '2026-02-26'],
  ['browser-use/video-use', 'video-use', 'Edit videos with coding agents', 'developer-tools', 'Python', 26529, 3168, 19, 146, 1175, 118, 'MIT', [], '2026-04-12'],
  ['edwardkim/rhwp', 'rhwp', '아래한글 hwp viewer and editor by rust and wasm', 'developer-tools', 'Rust', 3848, 727, 3, 21, 64, 112, 'MIT', ['hwp', 'hwpx', 'rust'], '2026-03-27'],
  ['NVlabs/cuda-oxide', 'cuda-oxide', 'cuda-oxide is a Rust-to-CUDA compiler that lets you write (SIMT) GPU kernels in safe(ish), idiomatic Rust. It compiles standard Rust code directly to PTX — no DSLs, no foreign language bindings, just Rust.', 'developer-tools', 'Rust', 3577, 282, 2, 9, 28, 54, 'Apache-2.0', ['async', 'compiler-backend', 'cuda', 'gpu', 'heterogeneous-computing', 'high-performance-computing', 'nvidia', 'programming-languages', 'rust'], '2026-04-22'],
  ['getopenscreen/openscreen', 'openscreen', 'Record your screen, ship a demo. Free and open-source, GPU-accelerated, no watermarks, no subscriptions. Windows, macOS, Linux. Actively maintained.', 'developer-tools', 'TypeScript', 3188, 201, 5, 22, 194, 49, 'MIT', ['cross-platform', 'electron', 'ffmpeg', 'open-source', 'product-demo', 'rust', 'screen-capture', 'screen-recorder', 'screen-recording', 'screen-studio', 'screencast', 'speech-to-text', 'typescript', 'video-editing', 'video-editor', 'wayland', 'wgpu', 'whisper'], '2026-03-14'],
  ['Sidenai/sidex', 'sidex', 'VS Code rebuilt on Tauri. Same architecture, 96% smaller. Early release.', 'developer-tools', 'TypeScript', 3003, 246, 2, 12, 52, 51, 'MIT', ['code-editor', 'electron-alternative', 'ide', 'monaco-editor', 'open-source', 'open-source-project', 'rust', 'tauri', 'typescript', 'vscode'], '2026-03-31'],
  ['HakanSeven12/OpenCADStudio', 'OpenCADStudio', 'A CAD application built with Rust — 2D/3D drawing, DWG/DXF support, and GPU-accelerated rendering', 'developer-tools', 'Rust', 2247, 227, 2, 12, 127, 199, 'GPL-3.0', ['cad', 'dwg', 'dwg-compatible', 'dwg-editor', 'dwg-files', 'dwg-parser', 'dwg-reader', 'dwg-support', 'dwg-viewer', 'dwg-writer', 'dxf', 'dxf-compatible', 'dxf-editor', 'dxf-files', 'dxf-parser', 'dxf-reader', 'dxf-support', 'dxf-viewer', 'dxf-writer', 'rust'], '2026-03-22'],
  ['kunchenguid/treehouse', 'treehouse', 'Manage worktrees without managing worktrees.', 'developer-tools', 'Go', 1766, 191, 1, 3, 95, 12, 'MIT', ['agents', 'coding', 'git', 'worktree'], '2026-03-14'],
  ['ivov/lisette', 'lisette', 'A little language inspired by Rust that compiles to Go', 'developer-tools', 'Rust', 1499, 38, 2, 11, 80, 2, 'MIT', ['compiler', 'go', 'programming-language', 'rust'], '2026-03-21'],
  ['devframes/devframe', 'devframe', 'Framework-neutral foundation for building generic DevTools.', 'developer-tools', 'TypeScript', 573, 21, 1, 7, 27, 14, 'MIT', ['devframe', 'devtools', 'framework', 'framework-agnostic'], '2026-05-07'],
  ['netz888/zhong-wechat-wmpf-debugger', 'zhong-wechat-wmpf-debugger', 'WeChatOpenDevTool 微信小程序强制开启开发者工具', 'developer-tools', 'Python', 112, 12, 2, 8, 17, 11, 'NOASSERTION', ['debugger', 'devtools', 'f12', 'miniapp', 'nodejs', 'python', 'wechat', 'windows', 'wmpf'], '2026-06-07'],
  ['the0807/git-graph-plus', 'git-graph-plus', '💻 A modern Git visualization tool for VS Code. Understand your commit history, manage branches, and work with Git more intuitively.', 'developer-tools', 'TypeScript', 94, 23, 1, 5, 26, 40, 'Apache-2.0', ['branch-management', 'commit-history', 'developer-tools', 'devtools', 'git', 'git-graph', 'git-tools', 'version-control', 'visualization', 'vscode', 'vscode-extension'], '2026-03-14'],
  ['zhishile/codex-auth-helper', 'codex-auth-helper', 'Codex登陆助手：安全地在本地导出您的已登录 ChatGPT 会话配置，生成符合 Codex 规范的 auth.json 本地备份文件。', 'web', 'CSS', 16532, 639, 3, 16, 283, 81, 'NOASSERTION', [], '2026-06-02'],
  ['lnkiai/m3e-canvas', 'm3e-canvas', 'Sketch Material 3 Expressive screens in the browser and turn them into vibe-coding prompts.', 'web', 'TypeScript', 8093, 849, 5, 95, 424, 5, 'MIT', ['design-tool', 'material-3-expressive', 'material-design', 'material3', 'nextjs', 'prompt', 'react', 'vibe-coding'], '2026-09-02'],
  ['joeseesun/qiaomu-anything-to-notebooklm', 'qiaomu-anything-to-notebooklm', 'Claude Skill: Multi-source content processor for NotebookLM. Supports WeChat articles, web pages, YouTube, PDF, Markdown, search queries → Podcast/PPT/MindMap/Quiz etc.', 'web', 'Python', 6148, 665, 7, 79, 370, 6, 'MIT', ['automation', 'claude', 'mcp', 'notebooklm', 'skill'], '2026-01-25'],
  ['MengTo/threeui', 'threeui', 'Open-source ThreeUI Community catalog with live interactive components and complete Community source.', 'web', 'HTML', 6131, 590, 0, 48, 136, 9, 'MIT', ['react', 'shaders', 'threejs', 'ui-components', 'webgl'], '2026-08-21'],
  ['srizzon/git-city', 'git-city', 'Your GitHub profile as a 3D pixel art building in an interactive city', 'web', 'TypeScript', 5787, 291, 4, 28, 261, 29, 'AGPL-3.0', ['3d', 'github', 'nextjs', 'pixel-art', 'react', 'react-three-fiber', 'supabase', 'three-js', 'threejs', 'typescript', 'visualization'], '2026-02-20'],
  ['asciimoo/hister', 'hister', 'Your own search engine', 'web', 'Go', 5629, 241, 9, 37, 171, 64, 'AGPL-3.0', ['browser-history', 'go', 'golang', 'history', 'index', 'mcp', 'mcp-server', 'personal-search', 'personal-search-engine', 'privacy', 'search', 'search-engine', 'semantic-search', 'web'], '2026-01-04'],
  ['Achilng/floral-notepaper', 'floral-notepaper', '花笺，轻量优雅的跨平台桌面便签工具，支持 Markdown 编辑与预览', 'web', 'Rust', 5279, 305, 8, 50, 245, 138, 'MIT', ['macos', 'markdown', 'note-taking', 'react', 'rust', 'sticky-notes', 'tauri', 'windows'], '2026-04-26'],
  ['DavidHDev/canvas-ui', 'canvas-ui', 'A library of creative canvas components. Real HTML with WebGL effects running over it. React, Vue, Svelte, vanilla.', 'web', 'TypeScript', 4677, 232, 2, 69, 171, 4, 'NOASSERTION', ['animation', 'canvas', 'component-library', 'components', 'creative-coding', 'design-engineering', 'frontend', 'glsl', 'nextjs', 'react', 'shadcn', 'shaders', 'svelte', 'threejs', 'typescript', 'ui', 'ui-library', 'vue', 'weggl'], '2026-07-16'],
  ['guokaigdg/animal-island-ui', 'animal-island-ui', 'A Kawaii React UI component library  一个可爱的 React UI 组件库', 'web', 'TypeScript', 4659, 14, 5, 29, 83, 4, 'NOASSERTION', ['component-library', 'react', 'typescript', 'ui-components', 'ui-design'], '2026-04-12'],
  ['crafter-station/petdex', 'petdex', 'A public gallery of animated pets for Codex, Claude Code, DeepSeek Harness, Hermes, OpenCode, Gemini CLI, and more.', 'web', 'TypeScript', 4153, 207, 13, 56, 243, 28, 'MIT', ['claude-code', 'clerk', 'cli', 'codex', 'developer-tools', 'drizzle-orm', 'dsh-plugin', 'mascot', 'neon', 'nextjs', 'pixel-art', 'postgres', 'react', 'sprites', 'tailwindcss', 'vercel'], '2026-05-02'],
  ['Hypostasis-Cat/HypoMux', 'HypoMux', 'CN Windows 多网卡聚合与网络加速工具。一键融合有线、Wi-Fi、热点等连接，实现多路径传输与智能流量调度。 EN Windows multi-NIC network accelerator. Combine Ethernet, Wi-Fi, hotspots and more for multi-path transmission and smart traffic routing.', 'web', 'Go', 3632, 129, 0, 10, 26, 14, 'AGPL-3.0', ['fluent', 'go', 'network', 'react', 'wails-v3', 'wails3', 'windows-10', 'windows-11'], '2026-06-11'],
  ['cpaczek/skylight', 'skylight', 'Project the aircraft passing overhead onto your ceiling in real time, from an RTL-SDR — with a live sky layer (sun, moon, stars, ISS) and where each plane is headed.', 'web', 'TypeScript', 3296, 401, 0, 21, 86, 2, 'MIT', ['ads-b', 'aircraft', 'art-installation', 'flight-tracker', 'projector', 'raspberry-pi', 'react', 'rtl-sdr', 'typescript'], '2026-06-02'],
  ['zenbu-labs/terminal-browser', 'terminal-browser', 'A browser inside your terminal', 'web', 'TypeScript', 3221, 153, 4, 16, 109, 67, 'MIT', ['browser', 'claude-code', 'claude-code-plugin', 'claude-skills', 'cli', 'codex', 'herdr-plugin', 'rust', 'terminal', 'web'], '2026-07-06'],
  ['gkurt/tegaki', 'tegaki', 'Handwriting animation for the web. Supports any font or text.', 'web', 'TypeScript', 3098, 119, 5, 68, 190, 4, 'MIT', ['animation', 'calligraphy', 'cursive', 'font', 'handwriting', 'react', 'stroke-order', 'text-animation'], '2026-03-28'],
  ['jimuzhe/tiez-clipboard', 'tiez-clipboard', 'TieZ 是一款基于 Tauri 的跨平台剪贴板管理器 / A cross-platform clipboard manager with history, tags, sync, privacy protection, and fast daily workflows.', 'web', 'TypeScript', 2862, 136, 0, 18, 139, 55, 'GPL-3.0', ['clipboard-manager', 'desktop-app', 'macos', 'mqtt', 'react', 'rust', 'tauri', 'webdav', 'windows'], '2026-03-09'],
  ['floci-io/floci', 'floci', 'Light, fluffy, and always free - The AWS Local Emulator alternative', 'infra', 'Java', 25399, 2749, 25, 248, 839, 112, 'MIT', ['aws', 'aws-emulation', 'devops', 'docker', 'ec2', 'ecs', 'localstack', 's3', 'sqs', 'testcontainers'], '2026-02-18'],
  ['caamer20/Telegram-Drive', 'Telegram-Drive', 'Turn your Telegram account into an unlimited, secure cloud storage drive. an Open-source desktop app built with Tauri, Rust, and React.', 'infra', 'TypeScript', 5186, 792, 0, 7, 199, 0, 'NOASSERTION', ['open-source', 'react', 'rust', 'tauri', 'telegram', 'telegramapi', 'typescript'], '2026-01-23'],
  ['CJackHwang/ds2api', 'ds2api', 'DeepSeek-Compatible Middleware Interface: A technical exploration project in Go, focusing on high-concurrency protocol adaptation. It serves as a reference implementation for converting diverse web protocols into standardized formats.', 'infra', 'Go', 4742, 1645, 2, 9, 142, 30, 'AGPL-3.0', ['api', 'claude-api', 'deepseek', 'deepseek-api', 'docker', 'freeapi', 'go', 'openai-api', 'proxy', 'proxy-server', 'react', 'vercel', 'vercel-deployment', 'zeabur'], '2026-01-21'],
  ['ministackorg/ministack', 'ministack', 'Ministack: Free, open-source local AWS emulator - 60+ services, Terraform compatible, real databases. Free forever. MIT   licensed.', 'infra', 'Python', 4677, 458, 0, 15, 199, 17, 'MIT', ['aws', 'aws-emulator', 'aws-local', 'aws-sdk', 'devtools', 'docker', 'dynamodb', 'ec2', 'emulator', 'lambda', 'localstack', 'localstack-alternative', 'ministack', 'mock-aws', 'open-source', 'python', 's3', 'sqs', 'terraform'], '2026-03-24'],
  ['nklmilojevic/sofka', 'sofka', 'A Kubernetes TUI, reimagined in Rust - built on kube-rs and ratatui, async-first from the ground up.', 'infra', 'Rust', 1438, 64, 3, 26, 71, 2, 'Apache-2.0', ['argocd', 'devops', 'eks', 'flux', 'fluxcd', 'gke', 'k8s', 'k9s', 'k9s-alternative', 'kube-rs', 'kubectl', 'kubernetes', 'ratatui', 'sre', 'tui'], '2026-07-01'],
  ['rohitg00/k8sgames', 'k8sgames', 'Learn Kubernetes by playing. Deploy pods, fix CrashLoopBackOff, type real kubectl commands: 3D browser game, no install needed.', 'infra', 'JavaScript', 1369, 188, 4, 18, 60, 12, 'Apache-2.0', ['browser-game', 'cka', 'cloud-native', 'containers', 'devops', 'education', 'games', 'gamification', 'k8s', 'k8sgames', 'kubectl', 'kubernetes', 'kubernetes-learning', 'learning', 'simulation', 'sre', 'threejs'], '2026-02-15'],
  ['transmute-app/transmute', 'transmute', 'Self hosted file converter and compression tool for images, video, audio, json, excel and more. Supports over 3,000 conversions!', 'infra', 'Python', 1357, 94, 2, 16, 67, 18, 'MIT', ['audio-converter', 'convert', 'docker', 'fastapi', 'file-converter', 'image-converter', 'pdf-converter', 'python', 'react', 'self-hosted', 'vite'], '2026-02-17'],
  ['berbicanes/apiark', 'apiark', 'Privacy-first API platform built with Tauri v2. No login, no cloud, ~60 MB RAM. A lightweight Postman alternative.', 'infra', 'TypeScript', 1278, 79, 0, 11, 41, 53, 'MIT', ['api-client', 'desktop-app', 'developer-tools', 'rust', 'tauri', 'typescript'], '2026-03-04'],
  ['4q4r/telemt-docker', 'telemt-docker', 'Secure multi-arch (amd64/arm64) Docker image for Telemt — a fast Rust-based MTProxy (MTProto) server, shipped as a static binary in a distroless non-root container.', 'infra', 'Dockerfile', 1255, 57, 0, 9, 30, 1, 'GPL-3.0', ['docker', 'mtproto-proxy', 'mtproxy', 'rust', 'telegram'], '2026-01-28'],
  ['bulwarkmail/webmail', 'webmail', 'Self-hosted JMAP webmail for Stalwart Mail Server. Mail, calendar, contacts, and files in one client.', 'infra', 'TypeScript', 1196, 195, 0, 11, 50, 147, 'NOASSERTION', ['calendar', 'contacts', 'docker', 'email', 'email-client', 'groupware', 'jmap', 'mail', 'nextjs', 'privacy', 'pwa', 'react', 'self-hosted', 'stalwart', 'tailwindcss', 'typescript', 'webmail'], '2026-03-13'],
  ['bilawalsidhu/gods-eye-view', 'gods-eye-view', 'A spy satellite simulator in your browser, except the data is real. Live open source spatial intelligence on a photorealistic 3D globe.', 'data', 'JavaScript', 41940, 8535, 68, 286, 1560, 235, 'NOASSERTION', ['3d-globe', 'cesium', 'flight-tracking', 'geospatial', 'geospatial-intelligence', 'gis', 'osint', 'photogrammetry', 'satellite-tracking', 'spatial-intelligence', 'webgl', 'worldview'], '2026-06-22'],
  ['hello245m/free-stockdb', 'free-stockdb', '面向 A 股日K、分钟K与ETF分钟数据的本地量化引擎，集成增量同步、本地缓存、复权、批量查询、回测与指标计算。', 'data', 'HTML', 2689, 399, 6, 22, 74, 4, 'MIT', ['a-share', 'algorithmic-trading', 'backtesting', 'china-stock-market', 'kline', 'local-first', 'market-data', 'mcp', 'quant-research', 'quantitative-finance', 'stock-data', 'stock-market', 'technical-analysis', 'time-series-database'], '2026-05-08'],
  ['talivia-group/talivia', 'talivia', 'Open-source, self-hosted revenue-first analytics for founders: web analytics, Session Replay, revenue attribution, and customer revenue integrations. datafast alternative', 'data', 'TypeScript', 2393, 135, 5, 49, 150, 0, 'MIT', ['analytics', 'bing', 'datafast', 'dodopayments', 'google-search', 'lemonsqueezy', 'polar', 'product-analytics', 'revenue-analytics', 'revenue-attribution', 'session-replay', 'stripe', 'web-analytics'], '2026-07-29'],
  ['bklit/bklit-ui', 'bklit-ui', 'Open-source UI & Charts library', 'data', 'TypeScript', 1678, 109, 0, 3, 54, 7, 'MIT', ['base-ui', 'baseui', 'bklit', 'chart', 'charts', 'data-visualization', 'motion', 'react', 'shadcn', 'shadcn-registry', 'shadcn-ui', 'shadcnui', 'typescript', 'ui', 'visx'], '2026-01-19'],
  ['arpanghosh8453/open-dronelog', 'open-dronelog', 'Drone Log analyzer: A high-performance universal dashboard application for organizing and analyzing DJI/Litchi flight logs privately in one place. Supports plugin for custom flight log formats. Built with Tauri v2, DuckDB, and React.', 'data', 'TypeScript', 1538, 213, 1, 7, 8, 31, 'AGPL-3.0', ['dashboard', 'data-analysis', 'data-visualization', 'database', 'desktop', 'dji', 'docker', 'drone', 'duckdb', 'flight', 'linux', 'logs', 'macos', 'react', 'self-hosted', 'statistics', 'tauri', 'uav', 'windows'], '2026-02-06'],
  ['DuarteSantos8/openGym', 'openGym', 'Self-hosted gym & body-weight tracker — plan routines, log workouts (supersets, warm-ups, cardio), see which muscles are trained, fatigued or detrained, import from FitNotes/Strong/Hevy, passkey login. Your data, your server.', 'data', 'JavaScript', 1296, 306, 1, 2, 22, 138, 'AGPL-3.0', ['bodyweight', 'docker', 'fitness', 'fitness-tracker', 'gym', 'health', 'mcp', 'nodejs', 'passkeys', 'progressive-web-applications', 'pwa', 'react', 'self-hosted', 'self-hosting', 'vite', 'webauthn', 'weightlifting', 'workout-tracker'], '2026-07-18'],
  ['ModernRelay/omnigraph', 'omnigraph', 'Lakehouse native graph engine with git-style workflows', 'data', 'Rust', 1196, 256, 0, 5, 47, 67, 'MIT', ['apache-arrow', 'context-graph', 'datafusion', 'graph-database', 'knowledge-graph', 'lakehouse', 'lance', 'mcp', 'rust', 's3', 'versioning'], '2026-04-10'],
  ['TanStack/charts', 'charts', 'A tiny TypeScript visualization grammar for responsive, accessible, server-rendered charts—powered by granular D3 primitives.', 'data', 'TypeScript', 758, 45, 2, 8, 29, 12, 'MIT', ['accessible-charts', 'charting-library', 'charts', 'd3', 'data-visualization', 'dataviz', 'grammar-of-graphics', 'javascript', 'octane', 'react', 'responsive-charts', 'ssr', 'svg', 'tanstack', 'typescript', 'visualization'], '2026-07-28'],
  ['royalbhati/sqltoerdiagram', 'sqltoerdiagram', 'ER diagram generator. Paste CREATE TABLE statements and get a clean, interactive ERD — runs 100% in your browser, nothing uploaded', 'data', 'HTML', 624, 62, 1, 6, 20, 1, 'MIT', ['data-modeling', 'database', 'database-schema', 'dbdiagram', 'dbml', 'developer-tools', 'diagram', 'entity-relationship-diagram', 'er-diagram', 'erd', 'mysql', 'open-source', 'postgresql', 'schema', 'sql', 'sql-parser', 'sqlite', 'vanilla-js', 'visualization', 'vite'], '2026-06-14'],
  ['OpenLabs-so/openanalytics', 'openanalytics', 'Open-source, privacy-first and cookieless web analytics with revenue attribution and an MCP server.', 'data', 'TypeScript', 561, 47, 0, 13, 33, 0, 'AGPL-3.0', ['agpl', 'analytics', 'clickhouse', 'cookieless', 'google-analytics-alternative', 'mcp-server', 'nextjs', 'open-source', 'plausible-alternative', 'privacy', 'privacy-first', 'self-hosted', 'typescript', 'web-analytics'], '2026-08-11'],
  ['RavelloH/InsightFlare', 'InsightFlare', 'A powerful, privacy-friendly open source web analytics tool that runs entirely on Cloudflare.', 'data', 'TypeScript', 500, 13, 0, 3, 21, 1, 'MIT', ['analytics', 'cloudflare', 'cloudflare-workers', 'cookieless', 'durable-objects', 'edge-computing', 'gdpr-compliant', 'nextjs', 'privacy-first', 'react', 'serverless', 'typescript', 'web-analytics'], '2026-02-28'],
  ['SouravRoy-ETL/slothdb', 'slothdb', 'An experimental embedded SQL engine in C++20. Query Parquet, CSV, JSON, Arrow, Avro, SQLite, and Excel files directly with SQL, in-process. Early-stage.', 'data', 'C++', 413, 5, 1, 8, 12, 5, 'MIT', ['analytics', 'arrow', 'avro', 'columnar-database', 'cplusplus', 'cpp', 'csv', 'database', 'dataframe', 'duckdb', 'embedded-database', 'natural-language-sql', 'olap', 'parquet', 'python', 'query-engine', 'sql', 'wasm'], '2026-04-15'],
  ['hasaneyldrm/exercises-dataset', 'exercises-dataset', '1,324-exercise fitness dataset — animation GIFs, 180×180 thumbnails, muscle-group & equipment data, and step-by-step instructions in 6 languages. The exercise data layer behind the LogPress app.', 'mobile', 'HTML', 22246, 2844, 39, 273, 1101, 49, 'NOASSERTION', ['dataset', 'exercise-database', 'exercises', 'fitness', 'fitness-app', 'gym', 'json', 'logpress', 'react-native', 'workout'], '2026-03-18'],
  ['vorssaint/vorssaint-utils', 'vorssaint-utils', 'Free and open-source macOS menu bar toolkit.', 'mobile', 'Swift', 21098, 773, 6, 40, 224, 507, 'GPL-3.0', ['alt-tab', 'app-uninstaller', 'appkit', 'finder', 'free', 'keep-awake', 'mac-os', 'menu-bar', 'menubar', 'open-source', 'swift', 'swift-ui', 'system-monitor', 'uninstaller', 'volume-mixer', 'window-switcher'], '2026-06-12'],
  ['rorkai/App-Store-Connect-CLI', 'App-Store-Connect-CLI', 'Fast, scriptable CLI for the App Store Connect API. Automate TestFlight, builds, submissions, signing, analytics, screenshots, subscriptions, and more', 'mobile', 'Go', 7336, 622, 0, 46, 259, 49, 'MIT', ['app-store-connect', 'apple', 'automation', 'cicd', 'cli', 'command-line-tool', 'developer-tools', 'devops', 'go', 'golang', 'ios', 'macos', 'swift', 'testflight', 'xcode'], '2026-01-20'],
  ['tiajinsha/JKVideo', 'JKVideo', '高颜值第三方 B 站 React Native 客户端', 'mobile', 'TypeScript', 4995, 2849, 9, 41, 153, 6, 'MIT', ['android', 'danmaku', 'dash', 'expo', 'react-native', 'typescript', 'video-player', 'zustand'], '2026-03-06'],
  ['PerryTS/perry', 'perry', 'A native TypeScript/JavaScript compiler written in Rust. Compiles TypeScript/JavaScript directly to executables using SWC and LLVM.', 'mobile', 'Rust', 4888, 162, 6, 44, 224, 279, 'MIT', ['android', 'compile', 'harmonyos', 'ios', 'llvm', 'macos', 'native', 'smc', 'typescript', 'watchos', 'windows'], '2026-01-19'],
  ['mayukh4/linux-android', 'linux-android', 'Turn an old Android phone into a GPU-accelerated Linux desktop (XFCE4 / KDE Plasma / LXQt / MATE) or a Home Assistant smart home server — using Termux. No root, no PC, no cloud.', 'mobile', 'Shell', 3560, 266, 0, 15, 177, 3, 'MIT', ['adreno', 'android', 'bash-script', 'desktop-environment', 'gpu-acceleration', 'home-assistant', 'kde-plasma', 'linux', 'linux-on-android', 'lxqt', 'mesa', 'no-root', 'proot-distro', 'self-hosted', 'smart-home', 'termux', 'termux-x11', 'turnip', 'vulkan', 'xfce'], '2026-03-01'],
  ['software-mansion/argent', 'argent', 'An agentic toolkit to control, debug, and profile iOS and Android apps. Made by Software Mansion.', 'mobile', 'TypeScript', 2883, 121, 1, 4, 71, 333, 'Apache-2.0', ['agentic', 'android', 'ios', 'react-native'], '2026-02-23'],
  ['Shrey113/Android-Dex', 'Android-Dex', 'Universal Samsung DeX alternative for all Android devices. Run Android apps on Windows, Linux & macOS with resizable windows, advanced FPS gaming controls, and high-performance wireless ADB mirroring.', 'mobile', 'HTML', 2655, 202, 1, 2, 67, 24, 'NOASSERTION', ['adb', 'android-dex', 'android-gaming', 'desktop', 'desktop-environment', 'flutter', 'game', 'keymapper', 'samsung-devices', 'samsung-dex', 'scrcpy', 'scrcpy-gui', 'screen-mirroring', 'wireless-debugging'], '2026-02-02'],
  ['yjeanrenaud/yj_nearbyglasses', 'yj_nearbyglasses', 'attempting to detect smart glasses nearby and warn you', 'mobile', 'Kotlin', 2374, 98, 4, 18, 121, 14, 'AGPL-3.0', ['android', 'android-app', 'meta', 'privacy', 'privacy-protection', 'ray-ban-meta-smart-glasses', 'self-defense', 'smartglasses', 'smartphone'], '2026-02-11'],
  ['ravindu644/Droidspaces-OSS', 'Droidspaces-OSS', 'A lightweight, LXC-like container runtime for Android and Linux. Run full Linux distributions natively with zero performance penalty', 'mobile', 'Kotlin', 2217, 214, 1, 2, 94, 3, 'GPL-3.0', ['android', 'containerization', 'docker', 'droidspaces', 'kernelsu', 'lxc', 'namespaces', 'rooting'], '2026-02-18'],
  ['pass-with-high-score/blockads-android', 'blockads-android', 'Block ads system-wide on Android using local VPN-based DNS filtering. No root needed. No data collection.', 'mobile', 'Kotlin', 2063, 116, 0, 5, 9, 69, 'GPL-3.0', ['adblocker', 'android', 'block-ads', 'blockads', 'dns', 'dns-filter', 'firewall', 'go-mobile', 'golang', 'https-filtering', 'jetpack-compose', 'kotlin', 'no-root', 'privacy', 'root', 'vpn', 'wireguard'], '2026-02-10'],
  ['kitsumed/ShizuCallRecorder', 'ShizuCallRecorder', 'ShizuCallRecorder empowers ADB through Shizuku to record phone calls on non-rooted device!', 'mobile', 'Kotlin', 1587, 61, 0, 6, 47, 15, 'GPL-3.0', ['adb', 'android', 'call-recording', 'callrecorder', 'no-root', 'privacy', 'scrcpy', 'shizuku'], '2026-05-14'],
  ['anthropics/defending-code-reference-harness', 'defending-code-reference-harness', 'Skills for threat modeling, scanning, triage, patching, plus an autonomous scanning harness you can /customize', 'security', 'Python', 7515, 618, 8, 39, 121, 23, 'NOASSERTION', ['security'], '2026-05-22'],
  ['AdventDevInc/kudu', 'kudu', 'Free Windows, Mac and Linux cleaner, scanner, and more.', 'security', 'TypeScript', 3568, 292, 0, 22, 136, 0, 'MIT', ['ccleaner-alternative', 'cleaner', 'free', 'hardening', 'kudu', 'linux-cleaner', 'mac-cleaner', 'malware-detection', 'open-source', 'pc-optimization', 'performance', 'privacy', 'scanner', 'security', 'startup-manager', 'system-cleaner', 'system-maintenance', 'windows-cleaner'], '2026-03-14'],
  ['RevylAI/greenlight', 'greenlight', 'Pre-submission compliance scanner for the Apple App Store and Google Play. Scans code, privacy manifests, Android manifests, and IPA/APK/AAB binaries against the review guidelines. Offline, no account.', 'security', 'Go', 2434, 147, 3, 10, 111, 7, 'MIT', ['android', 'app-store', 'app-store-review', 'cli', 'compliance', 'devtools', 'expo', 'golang', 'google-play', 'ios', 'mobile', 'react-native', 'static-analysis', 'swift'], '2026-02-11'],
  ['betterleaks/betterleaks', 'betterleaks', 'Find leaked secrets everywhere.', 'security', 'Go', 2012, 143, 5, 20, 90, 106, 'MIT', ['cicd', 'credentials', 'developer-tools', 'devops', 'devsecops', 'dynamic-analysis', 'git', 'github', 'gitleaks', 'go', 'golang', 'sast', 'secret', 'secrets', 'secrets-detection', 'secrets-management', 'secrets-scanning', 'security', 'security-tools', 'static-analysis'], '2026-02-03'],
  ['JesseCHale/HaleHound-CYD', 'HaleHound-CYD', 'ESP32-DIV HaleHound Edition for Cheap Yellow Display - Multi-protocol offensive security toolkit', 'security', 'Other', 1740, 137, 0, 22, 98, 4, 'NOASSERTION', ['bluetooth', 'cc1101', 'cheap-yellow-display', 'cyd', 'defcon', 'defcon33', 'defcon34', 'esp32', 'esp32-diy', 'hacking', 'nrf24l01', 'offensive-security', 'pentest', 'security', 'security-tools', 'subghz', 'wifi'], '2026-02-17'],
  ['kulikov0/whitelist-bypass', 'whitelist-bypass', 'Tunneling data over webrtc to bypass censorship  ', 'security', 'Go', 1671, 104, 3, 15, 59, 25, 'MIT', ['anticensorship', 'go', 'golang', 'security', 'tunneling'], '2026-03-19'],
  ['potatameister/PaperKnife', 'PaperKnife', 'Privacy-first PDF utility (Zero-Server Architecture). Merge, split, compress, and edit PDFs 100% locally on your device. No uploads, no servers, no tracking.', 'security', 'TypeScript', 1465, 102, 0, 6, 73, 47, 'AGPL-3.0', ['android', 'capacitor', 'f-droid', 'offline-first', 'open-source', 'pdf', 'pdf-manipulation', 'pdf-tools', 'privacy', 'react', 'security', 'typescript', 'zero-server'], '2026-01-26'],
  ['anonvector/SlipNet', 'SlipNet', 'Android VPN client with DNS tunneling (DNSTT, NoizDNS & Slipstream), NaiveProxy, SSH, Tor, and DoH support — featuring a built-in DNS scanner.', 'security', 'C', 1433, 137, 1, 12, 60, 38, 'AGPL-3.0', ['android', 'dnstt', 'kotlin', 'slipstream', 'tunneling'], '2026-02-01'],
  ['anywhere-labs/dsh-desktop', 'dsh-desktop', '为 DeepSeek Harness (DSH) 插件生态打造的现代化桌面端解决方案。万物皆「插件」，桌面本身也是「插件」。', 'productivity', 'TypeScript', 28724, 1365, 0, 19, 178, 351, 'MIT', ['cordis', 'cordis-plugin', 'deepseek', 'deepseek-harness', 'desktop', 'dsh', 'dsh-plugin', 'dsh-plugin-desktop'], '2026-08-13'],
  ['jarrodwatts/claude-hud', 'claude-hud', 'A Claude Code plugin that shows what\'s happening - context usage, active tools, running agents, and todo progress', 'productivity', 'JavaScript', 28137, 1301, 26, 252, 1663, 32, 'MIT', ['anthropic', 'claude', 'claude-code', 'cli', 'plugin', 'statusline', 'typescript'], '2026-01-02'],
  ['refactoringhq/tolaria', 'tolaria', 'Desktop app to manage markdown knowledge bases', 'productivity', 'TypeScript', 19876, 1383, 61, 311, 884, 69, 'AGPL-3.0', [], '2026-02-14'],
  ['Kuberwastaken/claurst', 'claurst', 'Agentic Coding for Builders who Ship', 'productivity', 'Rust', 10306, 7733, 13, 50, 189, 33, 'GPL-3.0', ['claude', 'claude-code', 'claurst', 'cli', 'codex', 'gemini', 'rust', 'tui'], '2026-03-31'],
  ['modem-dev/hunk', 'hunk', 'Review-first terminal diff viewer for agentic coders', 'productivity', 'TypeScript', 9370, 308, 12, 56, 156, 169, 'MIT', ['agents', 'cli', 'code-review', 'diff', 'git', 'jj', 'jujutsu', 'sapling', 'terminal', 'tui'], '2026-03-17'],
  ['TomBadash/Mouser', 'Mouser', 'A lightweight, open-source, fully local alternative to Logitech Options+ for remapping Logitech HID++ mice.', 'productivity', 'Python', 5261, 199, 10, 86, 276, 126, 'MIT', ['automation', 'controler', 'free', 'linux', 'linux-app', 'logi', 'logitech', 'logitech-options', 'macos', 'macos-app', 'mouse', 'mouse-remapping', 'mx-master', 'mx-master-3s', 'mx-master-4', 'open-source', 'productivity', 'python'], '2026-02-24'],
  ['Tianyu199509/DeskBox', 'DeskBox', 'A free, open-source Windows desktop organizer with native-feeling WinUI 3 widgets.', 'productivity', 'C#', 5096, 280, 19, 98, 261, 72, 'GPL-3.0', ['desktop-cleanup', 'desktop-organizer', 'desktop-widget', 'desktop-widgets', 'dotnet10', 'file-management', 'file-organization', 'file-organizer', 'open-source', 'productivity', 'tray-app', 'windows', 'windows-11', 'windows-app-sdk', 'windows-desktop', 'windows-tool', 'winui', 'winui-3', 'winui3'], '2026-06-11'],
  ['fallow-rs/fallow', 'fallow', 'Codebase intelligence for TypeScript and JavaScript. Free static analysis of code and styles: unused code, duplication, circular deps, complexity hotspots, architecture boundaries, design-system drift. Optional paid runtime layer (Fallow Runtime): hot-path review and cold-path deletion evidence from real production traffic.', 'productivity', 'Rust', 4843, 163, 2, 58, 226, 44, 'MIT', ['cli', 'code-duplication', 'code-quality', 'codebase-intelligence', 'copy-paste-detection', 'dead-code', 'developer-tools', 'duplicate-code', 'javascript', 'linter', 'oxc', 'runtime-intelligence', 'rust', 'static-analysis', 'typescript', 'unused-code', 'unused-dependencies', 'unused-exports'], '2026-03-17'],
  ['Jia-Ethan/codex-keysmith', 'codex-keysmith', 'Versioned Codex instruction deployment with preview, ownership manifests, hook isolation, scenario evaluation, and recovery.', 'productivity', 'Python', 4585, 717, 1, 3, 32, 6, 'MIT', ['cli', 'codex', 'codex-cli', 'configuration-management', 'developer-tools', 'local-first', 'prompt-engineering', 'python'], '2026-06-28'],
  ['crmne/spotifast', 'spotifast', 'Spotify, native and fast. One lightweight Rust app for your whole library, local playback, and Spotify Connect on Linux, macOS, and Windows.', 'productivity', 'Rust', 4559, 209, 2, 29, 220, 42, 'MIT', ['audio', 'cross-platform', 'desktop-app', 'egui', 'gui', 'librespot', 'linux', 'macos', 'mpris', 'music', 'music-player', 'rust', 'spotify', 'spotify-client', 'spotify-connect', 'windows'], '2026-08-27'],
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
  const [fullName, name, description, category, language, stars, forks, todayStars, weekStars, monthStars, openIssues, license, topics, createdDate = '2018-01-15'] = seed;
  const categoryMeta = CATEGORY_BY_ID[category];
  const createdAt = `${createdDate}T00:00:00Z`;
  const created = new Date(createdAt).getTime();
  const ageDays = Number.isFinite(created) ? Math.max(0, Math.round((now - created) / DAY_MS)) : 3650;
  return {
    id: fullName,
    fullName,
    name,
    description,
    htmlUrl: `https://github.com/${fullName}`,
    category,
    categoryLabel: categoryMeta.label,
    categoryColor: categoryMeta.color,
    language,
    stars,
    forks,
    openIssues,
    license,
    todayStars,
    weekStars,
    monthStars,
    ageDays,
    createdAt,
    contributors: Math.max(12, Math.round(stars / 135)),
    updatedAt: isoHoursAgo(seededInt(`${fullName}:${index}`, 1, 94), now),
    pushedAt: isoHoursAgo(seededInt(`${fullName}:pushed`, 0, 72), now),
    topics,
    rankSeed: seededInt(`${fullName}:rank`, 0, 1000),
    trend: weekStars >= 1000 ? 'up' : weekStars >= 400 ? 'steady' : 'rising',
  };
};

const by = (field) => (left, right) => right[field] - left[field];

/** License risk tier for commercial use: BUSL/SSPL-style terms are the red flag. */
const RISKY_LICENSE = /^(BUSL|SSPL|Elastic-|CC-BY-NC|LicenseRef-)/;
const COPYLEFT_LICENSE = /^(GPL|AGPL|LGPL|CDDL|EPL-)/;
export function licenseRisk(license = '') {
  if (RISKY_LICENSE.test(license)) return 'risky';
  if (COPYLEFT_LICENSE.test(license)) return 'copyleft';
  return 'permissive';
}

const LICENSE_SCORE = { permissive: 10, copyleft: 6, risky: 2 };

/**
 * Business-opportunity heuristic (0-100), transparent on purpose so scores
 * can be tuned or explained:
 *   增速 40  — weekly star growth rate (hot projects grow ~1-7%/week)
 *   Fork 15  — stars/fork ratio health, ideal band around 8
 *   采用 25  — log-scale adoption from total stars
 *   活跃 10  — decays with days since the last push
 *   License 10 — permissive 10 / copyleft 6 / BUSL-SSPL 2
 */
export function scoreOpportunity(project, now = Date.now()) {
  const stars = Math.max(1, project.stars || 0);
  const weeklyGrowthPct = ((project.weekStars || 0) / stars) * 100;
  const velocity = Math.min(40, weeklyGrowthPct * 5.7);
  const forkRatio = stars / Math.max(1, project.forks || 1);
  const forkHealth = Math.max(0, 15 - Math.abs(Math.log2(forkRatio / 8)) * 7.5);
  const adoption = Math.min(25, Math.log10(stars) * 5);
  const daysSincePush = Math.max(0, (now - new Date(project.pushedAt || now).getTime()) / DAY_MS);
  const activity = Math.max(0, 10 - daysSincePush);
  const license = LICENSE_SCORE[licenseRisk(project.license)];
  return Math.round(velocity + forkHealth + adoption + activity + license);
}

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

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_MS = 24 * 3600 * 1000;
/** True when `iso` is a timestamp within the last `days` days (inclusive). */
const withinDays = (iso, days, now) => {
  const created = new Date(iso).getTime();
  return Number.isFinite(created) && now - created >= 0 && now - created <= days * DAY_MS;
};
// Rough intra-week shape of open-source activity: build-up towards the weekend,
// strongest at the end of the window. Refreshed with a small seeded jitter so
// the chart still moves between syncs without changing shape randomly.
const WEEKDAY_WEIGHTS = [0.1, 0.11, 0.12, 0.14, 0.17, 0.15, 0.21];

/** Seven-day aggregate star-addition series ending at `now`, for the trend chart. */
const buildTrendSeries = (projects, now, tick = 0) => {
  const totalWeek = projects.reduce((sum, project) => sum + project.weekStars, 0);
  const cursor = new Date(now);
  const labels = Array.from({ length: 7 }, (_, index) => {
    const offset = 6 - index;
    if (offset === 0) return '今天';
    const day = new Date(cursor.getTime() - offset * DAY_MS);
    return WEEKDAY_LABELS[(day.getDay() + 6) % 7];
  });
  const values = WEEKDAY_WEIGHTS.map((weight, index) => {
    const jitter = tick ? ((hash(`trend:${tick}:${index}`) % 5) - 2) / 100 : 0;
    return Math.max(0, Math.round(totalWeek * (weight + jitter)));
  });
  return { labels, values };
};

/** Assemble every card/list/chart consumed by the dashboard from project rows. */
const assembleSnapshot = (projects, now, tick = 0) => {
  const scored = projects.map((project) => ({
    ...project,
    opportunityScore: scoreOpportunity(project, now),
    licenseRisk: licenseRisk(project.license),
  }));
  const todayUpdated = scored
    .filter((project) => project.todayStars > 0)
    .sort(by('todayStars'));
  const weeklyFastest = rank(scored, 'weekStars', 10);
  const createdWithin7 = scored.filter((project) => withinDays(project.createdAt, 7, now));
  const createdWithin30 = scored.filter((project) => withinDays(project.createdAt, 30, now));
  const createdWithin90 = scored.filter((project) => withinDays(project.createdAt, 90, now));
  const weeklyNew = rank(createdWithin7, 'stars', 10);
  const monthlyNew = rank(createdWithin30, 'stars', 10);
  const quarterlyNew = rank(createdWithin90, 'stars', 10);
  const opportunityTop = rank(scored, 'opportunityScore', 10);
  const totalStars = scored.reduce((sum, project) => sum + project.stars, 0);
  const totalTodayStars = scored.reduce((sum, project) => sum + project.todayStars, 0);
  const totalWeekStars = scored.reduce((sum, project) => sum + project.weekStars, 0);

  return {
    projects: scored,
    categories: categorySummary(scored),
    dailyUpdated: todayUpdated,
    // weekStars-based ranking across every tracked project (近一周涨星最快).
    weeklyFastest,
    // New-project rankings: only repos created within the last 7 / 30 / 90
    // days, each window ranked independently by total stars (时间段嵌套，
    // 但各榜单独取 Top 10，成员可能不同——窄榜成员被宽榜挤出去很正常).
    weeklyTop10: weeklyNew,
    monthlyTop10: monthlyNew,
    quarterlyTop10: quarterlyNew,
    opportunityTop10: opportunityTop,
    trendSeries: buildTrendSeries(scored, now, tick),
    stats: {
      projects: scored.length,
      totalStars,
      todayStars: totalTodayStars,
      weekStars: totalWeekStars,
      categories: CATEGORY_META.length,
      activeToday: todayUpdated.length,
      newThisWeek: createdWithin7.length,
      newThisMonth: createdWithin30.length,
      newThisQuarter: createdWithin90.length,
    },
    lastUpdated: new Date(now).toISOString(),
  };
};

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
  return assembleSnapshot(projects, now, tick);
}

/**
 * Build a dashboard snapshot from live GitHub API rows (see
 * `fetchGitHubProjects`). Star deltas stay at whatever the caller set, so the
 * rankings degrade gracefully to total stars when no history is available.
 */
export function snapshotFromProjects(projects, { now = Date.now() } = {}) {
  return assembleSnapshot(projects, now, 0);
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
      license: item.license?.spdx_id || 'NOASSERTION',
      pushedAt: item.pushed_at || item.updated_at,
      // Real creation date drives the weekly/monthly new-project rankings;
      // fall back to "just now" when the API omits it so the repo still counts.
      createdAt: item.created_at || new Date().toISOString(),
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
  }).filter((project, index, projects) => projects.findIndex((other) => other.id === project.id) === index);
}

/**
 * Real-time description translation (English -> Simplified Chinese).
 *
 * Uses MyMemory's free anonymous endpoint (no API key, CORS-enabled). Results
 * are cached in localStorage so repeated syncs do not re-hit the daily quota.
 * To switch providers (DeepL, Google, self-hosted LibreTranslate...), replace
 * `translateText` with any function of the same signature.
 */
const TRANSLATE_ENDPOINT = 'https://api.mymemory.translated.net/get';
const TRANSLATE_CACHE_KEY = 'githubPulse.translations';
const TRANSLATE_MAX_CACHE = 1000;
const hasChinese = (text) => /[一-龥]/.test(text || '');

const readTranslationCache = () => {
  try { return JSON.parse(localStorage.getItem(TRANSLATE_CACHE_KEY) || '{}'); } catch { return {}; }
};
const persistTranslationCache = (store) => {
  try { localStorage.setItem(TRANSLATE_CACHE_KEY, JSON.stringify(store)); } catch { /* storage full: keep in-memory only */ }
};

/**
 * Translate a single English string. Throws when the provider is unreachable
 * or the daily quota is exhausted; callers keep the original text then.
 */
export async function translateText(text, { signal, store = readTranslationCache() } = {}) {
  const source = (text || '').trim();
  if (!source || hasChinese(source)) return source;
  if (store[source]) return store[source];
  // MyMemory rejects overly long segments; GitHub descriptions are short anyway.
  const url = `${TRANSLATE_ENDPOINT}?q=${encodeURIComponent(source.slice(0, 450))}&langpair=${encodeURIComponent('en|zh-CN')}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`translation HTTP ${response.status}`);
  const payload = await response.json();
  const translated = payload?.responseData?.translatedText || '';
  const rejected = payload?.responseStatus === 403 || payload?.quotaFinished || /MYMEMORY WARNING/i.test(translated);
  if (!translated || rejected) throw new Error('translation quota exhausted');
  store[source] = translated;
  if (Object.keys(store).length <= TRANSLATE_MAX_CACHE) persistTranslationCache(store);
  return translated;
}

/**
 * Translate every English description on freshly fetched projects, in small
 * parallel batches. Any failure (network/quota) keeps the original English
 * text, so a live sync never breaks because the translator is down. Once the
 * quota error is seen, remaining items are skipped instead of hammering the API.
 * Resolves to `{ translated, total }` for UI feedback.
 */
export async function translateProjects(projects, { signal, concurrency = 4 } = {}) {
  const store = readTranslationCache();
  const pending = projects.filter((project) => project.description && !hasChinese(project.description));
  let cursor = 0;
  let quotaExhausted = false;
  let translated = 0;
  const worker = async () => {
    while (cursor < pending.length && !quotaExhausted) {
      const project = pending[cursor];
      cursor += 1;
      try {
        project.description = await translateText(project.description, { signal, store });
        translated += 1;
      } catch (error) {
        if (/quota/i.test(error.message)) quotaExhausted = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) || 1 }, worker));
  persistTranslationCache(store);
  return { translated, total: pending.length };
}

export { CATEGORY_META };

export default {
  CATEGORY_META,
  getDashboardData,
  refreshDashboardData,
  snapshotFromProjects,
  fetchGitHubProjects,
  translateText,
  translateProjects,
  licenseRisk,
  scoreOpportunity,
};
