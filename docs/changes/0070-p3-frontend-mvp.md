# 0070 P3 前端交互 MVP 落地

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0008（P6 停止后转工程轨道）、docs/06、docs/guides/frontend-design.md
- 性质：工程交付；不改规则、参数、schema 或实验结论
- 影响范围：`src/app`、`src/ui`、`index.html`、`vite.config.ts`、测试与文档

## 1. 交付

### P3-01 RunController

- 12 态状态机：`idle/invalid/ready/running/awaiting_decision/settling_tick/paused/
cancelling/cancelled/completed/failed/replaying`。
- 单推进循环 + `generation`；暂停/重置/停止使旧异步响应失效。
- 时间片调度：默认每片 10ms，片间 `setTimeout(0)` 让出主线程；后台标签页不依赖
  `requestAnimationFrame`。速度档只改变片间节奏，不改变结算语义。
- 只调用 `src/core` 与 `src/decision`；不复制任何结算公式。
- 自动记录 stats/events/decisions/executions，均设有界上限；决策日志超限时标记
  `decisionsTruncated`。

### P3-02 设置与预检

- 9 个预设（演示、标准、结构实验提示、5 个消融、D2 未验证），全部标记“未校准”。
- 参数表单覆盖人口、tick、决策间隔、seed、年龄模式、开放度、位移份额、占用锚定、
  行为特质 sigma/sensitivity；实时更新 configHash/paramsHash 预览。
- 启动前 `validateRunConfig` 校验；非法输入显示路径化错误并阻止启动。
- live 规模静态调用上界与超限提示；`jev_live` 选项禁用并说明需 P4 代理。

### P3-03 总览

- KPI：存活、G、Mup、Mdown、S、O、Top10%、累计死亡。
- 图表：阶级堆叠（含存活总数说明）、财富 Gini/Top10、双向流动、网络结构、
  开放度/E、竞争损失/获得、寿命与按阶级死亡、转移矩阵、行动分布、事件流。
- 每张卡片有标题、窗口/单位说明、空态；无连边显示 `edgeCount=0`，不把 S 设为 1。
- 图表使用 LTTB 按像素宽度降采样；导出保留原始统计。

### P3-04 个体检查器

- 搜索/存活/阶级筛选，名册与详情分开。
- 属性卡：Value/need/needRatio/寿命/classAge/baselineSum/ge/hard/特质/升降 tick。
- 决策卡：legal action 概率、selectedAction、policyVersion、source、fallback。
- 执行卡：核心 `ExecutionRecord`（tick/status/reason）。
- 事件账本、关系邻居；界面只读，微扰必须走专门 fork。
- 不显示任何 Key/token。

### P3-05 本地存储、导入导出与回放

- 导出 `stratify-web-run-v1` bundle：config、初始/最终快照、stats、events、
  decisions、identity hashes。
- 导入先校验 schema、配置与快照 hash；失败不覆盖当前实验。
- 从初始快照按已保存 `selectedAction` 回放；不调用策略；缺失决策记
  `replay_invalid` 并安全回退。
- IndexedDB 每 2 秒至多保存一次完整 bundle；实验管理页可载入/删除/清除。
- 单次对比只标“描述性差异”，不提供显著性结论。

### P3-06/P3-07 响应式、可访问性与降采样

- 375px 视口无横向溢出；桌面 12 列、移动单列；关键按钮保留。
- 键盘：`1–5` 切工作区、`Space` 暂停/继续、`N` 单步、`E` 导出。
- 深色/纸质双主题；`aria` 标签、焦点可见、`prefers-reduced-motion`。
- LTTB 单测覆盖首尾保留、阈值、尖峰保留。
- 新增 `test/e2e/p3-web.e2e.test.ts`（jsdom）：覆盖启动到完成、总览图表、
  个体筛选与决策/执行卡、导出导入回放、主题/键盘、非法导入不覆盖。

## 2. 验证

- `pnpm typecheck`、`pnpm lint`、`pnpm test`（71 文件 / 826 测试）通过；
  `pnpm test:e2e`（5 项 jsdom DOM E2E）通过。
- `pnpm format`、`pnpm check:docs`、`pnpm check:secrets` 通过。
- 浏览器手动 E2E（Vite 5180）：
  1. 默认预设 40 人/120 tick 从开始跑到 completed，无控制台错误；
  2. 单步、暂停/继续、重置可用；
  3. 总览 10 张图渲染，阶级堆叠 5 层，空态正确；
  4. 个体检查器 40 行名册，详情/决策/执行/账本/关系显示；
  5. 导出 bundle 后导入并从 tick 0 回放到 120，`replay_invalid=0`，
     终点 Gini 与原 run 一致；
  6. 375px 视口 `scrollWidth=375`，无横向溢出；
  7. Paper 主题切换、键盘 `1` 切到设置页生效。

## 3. 未完成 / 限制

- **真实浏览器自动化 E2E 尚未接入**：已有 jsdom DOM E2E（`pnpm test:e2e`）
  与真实 Chromium 手动验证，但仓库仍未引入 Playwright/Puppeteer；后续进入
  发布硬化（P7）时必须补真实浏览器自动化或明确豁免。
- `jev_live` 未接线：需要 P4 Worker 代理、内存 Key 与预算/取消；当前 UI
  明确禁用，不会静默降级为 mock。
- IndexedDB 刷新恢复为手动载入，不自动覆盖当前实验；这是有意的防误恢复。
- 1000 人/3650 tick 可在浏览器运行但较慢；结构实验仍建议本地 runner。
- G6 未通过，P3 只是可运行/可回放/可检查的工程界面，不是校准证据。
