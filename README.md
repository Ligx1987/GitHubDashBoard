# GitHub Pulse

一个面向开源工程发现的 GitHub 看板（纯前端，零依赖），包含：

- **总览指标**：追踪中的工程数、今日活跃工程、本周新增 Stars、生态活跃指数
- **今日 / 本周 / 本月增长榜**：右上角时间范围可切换，列表按对应周期的 Star 增量排序
- **近一周 Star 增长走势**：7 天柱状图，由数据层聚合生成，非写死占位
- **分类探索**：8 个领域（AI/ML、开发者工具、Web/前端、基础设施、数据分析、移动开发、安全、效率工具），环形图 / 图例 / 分类聚焦卡均由数据驱动
- **年度榜 · 各分类 Top 10**：按自然年筛选（2022-2026 年份 chips 可切换，默认当前年），选中分类时展示该分类当年的明细 Top 10，"全部"时按 8 个分类并排展示紧凑小榜单。创建时间为各工程真实创建日期，演示数据覆盖 2022-2026（2026 批次为真实新建工程快照）
- **当年新增 · Top 10**：本周 / 本月 / 本季度（rolling 7/30/90 天）三个窗口的新建工程榜，按 Star 数排名；三个窗口时间段嵌套，但各榜独立取 Top 10，成员可能不同。演示数据的 2026 批次含 90 天内的新建工程，本月 / 本季度窗口有数据；本周窗口为空时展示解释与"接入 GitHub Token"引导，接入后即显示实时新建工程。想看涨星最快的工程，用增长榜的"今天 / 本周 / 本月"切换
- **商机榜 · Top 10**：按"周增速+采用度+Fork 健康+活跃度+License"五维启发式评分排序，标出 BUSL/SSPL 等许可证风险，展示贡献者与最近提交时间
- **搜索、分类筛选、暗色 / 亮色主题**（主题选择会记忆）、每 30 分钟自动后台同步、"x 分钟前"时间戳自动刷新

## 本地运行

```bash
npm run dev
```

然后打开 <http://localhost:4173>。

## 数据说明

数据逻辑位于 `src/data/github-data.js`，分两层：

1. **演示快照（默认）**：内置 1551 个代表性开源工程，含分类、Star/Fork、今日 / 近 7 天 / 近 30 天增量。创建时间为各工程的**真实创建日期**，因此 2022-2026 的年度榜反映真实历史分布；"立即更新"会做一次确定性的增量同步（模拟活跃度变化），每 30 分钟也会自动同步一次。2026 批次（1446 个）收录 2026-09-24 GitHub Search 快照中的全部已识别工程（按分类规则识别，未识别且不符合开发者工具特征的 22 个未收录，见仓库根目录 Excel），Stars/Forks/Issues 由 `scripts/sync-github-data.mjs` 定期回写为真实值，描述保留英文原文。其中含 90 天内新建的真实工程，因此本季度 / 本月新增榜在演示模式下有数据；本周窗口（7 天）仍为空，会显示解释文案和"接入 GitHub Token"引导按钮。
2. **GitHub 实时适配器**：在侧栏"GitHub Token（可选）"输入框填入 Token（或控制台执行 `githubPulse.setToken('ghp_你的token')`），"立即更新"会改为调用 GitHub Search API 拉取实时数据（未配置时自动回退到演示同步）。新增榜（7 / 30 / 90 天窗口）与年度榜（自然年 + 分类）都使用仓库真实的 `created_at` 在客户端过滤，并额外用一条 `created:>日期` 查询专门拉取近 90 天创建的高星工程；拉取到的英文描述会**实时翻译成中文**（免费的 MyMemory 接口，免密钥；翻译结果缓存在 localStorage 里，不重复消耗每日配额；接口不可用时自动保留英文原文，不影响同步）。Token 只保存在你自己的浏览器 localStorage 中：

   ```js
   // 浏览器控制台执行一次即可
   githubPulse.setToken('ghp_你的token')
   ```

   注意：Search API 有速率限制（未认证 10 次/分钟，认证 30 次/分钟），看板默认只用 4 个查询（3 个宽泛话题 + 1 个近 90 天新建工程专用）。想换 DeepL、百度等翻译服务时，替换 `src/data/github-data.js` 里的 `translateText` 函数即可（签名为 `(text, { signal, store }) => Promise<string>`）。

## 自动跟进 GitHub 变化

按投入从小到大三种方式：

1. **看板内置实时模式（零改动）**：侧栏"GitHub Token（可选）"填入 Token（或控制台执行 `githubPulse.setToken('ghp_你的token')`），"立即更新"即切换为 GitHub 实时数据，之后**每 30 分钟自动后台同步**。注意：实时模式展示的是搜索查询命中的工程集（不是种子里的 1551 个），且 Search API 无历史增量数据，增长榜会退回按总 Stars 排序；Token 只存在浏览器 localStorage 中。
2. **定时刷新演示种子**：`node scripts/sync-github-data.mjs` 逐个拉取 1551 个工程的当前 Stars/Forks/Issues 并回写 `src/data/github-data.js`；同时把每次结果记入 `src/data/star-history.json`，首次运行建立基线后，今日 / 近 7 天 / 近 30 天增量会逐步替换为真实差值（每天跑一次，连续跑满 7 / 30 天后周 / 月增量完全真实）。设置 `GITHUB_TOKEN` 环境变量可将 API 限额从约 60 提升到 5000 次/小时（脚本也会自动尝试 `gh auth token`）；没有 Token 时按小时预算部分更新，下次运行自动续跑。Windows 任务计划每天 09:00 执行（注意把 node 路径换成你机器上的实际路径）：
   ```cmd
   schtasks /Create /TN "GitHubDashBoard Sync" /TR "\"C:\Program Files\nodejs\node.exe\" \"E:\Project\GitHubDashBoard\scripts\sync-github-data.mjs\"" /SC DAILY /ST 09:00 /F
   ```
   常用参数：`--dry` 只打印不落盘，`--limit N` 只同步前 N 个工程（调试/试跑用）。
3. **推送到 GitHub 后**：仓库已附带 `.github/workflows/sync-data.yml`，推送到 GitHub 后每天定时运行上述脚本并自动提交结果，无需自己的服务器（`workflow_dispatch` 支持手动触发）。

## 结构

```
index.html            # 页面骨架（动态区域均为 JS 填充的容器）
styles.css            # 暗色/亮色主题、响应式布局
app.js                # 渲染与交互（指标、榜单、图表、同步循环）
src/data/github-data.js  # 数据层：种子数据、分类规则、榜单聚合、实时适配器
src/data/star-history.json  # 同步脚本记录的 Stars 历史（驱动真实增量）
scripts/sync-github-data.mjs  # 种子数据定时同步脚本
.github/workflows/sync-data.yml  # 推送 GitHub 后的每日自动同步
```

如需替换其他数据源，只需产出与 `getDashboardData()` 相同结构的数据（`projects` / `categories` / `weeklyTop10` / `monthlyTop10` / `quarterlyTop10` / `trendSeries` / `stats` / `lastUpdated`），渲染层无需改动。年度榜按 `createdAt` 的自然年与分类在客户端从 `projects` 直接计算，不需要额外字段。
