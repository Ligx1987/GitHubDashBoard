# GitHub Pulse

一个面向开源工程发现的 GitHub 看板，包含：

- 今日新增与活跃工程
- 近一周涨星趋势
- AI / ML、前端、基础设施等分类探索
- Top 10 周榜与 Top 30 月榜
- 搜索、分类筛选、暗色 / 亮色主题、刷新状态

## 本地运行

```bash
npm run dev
```

然后打开 <http://localhost:4173>。

数据逻辑位于 `src/data/github-data.js`：当前默认使用稳定的演示快照，点击“立即更新”会模拟一次增量同步；模块同时提供了可选的 GitHub Search API 适配器，接入服务端 Token 后可以替换演示数据。
