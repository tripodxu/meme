# 0083 前端双界面架构重构与运行时卡顿治理

- 日期：2026-11-18
- 作者：施工代理执行
- 关联：changes/0070、changes/0082、docs/06 前端契约
- 性质：浏览器控制层与视图层重构及性能优化；不改核心规则、参数注册表、序列化 schema 或实验结论
- 影响范围：`src/app/*`、`src/ui/*`、`docs/guides/web-app.md`、单测与 jsdom E2E

## 1. 背景与性能根因

重构前浏览器工作台在大人口或长周期推进下存在四类明显卡顿：

1. **全树 DOM 拆除重建**：`StratifyApp.render()` 每次调用执行 `clear(this.root)`，高频重建整页 SVG/DOM，并导致检查器搜索输入框失焦与滚动重置。
2. **离线策略冗余重序列化**：`RunController.collectDecisions` 在 `mock`/`random` 离线策略下仍对每个存活个体执行 `buildDecisionState`（含重复 `Map` 构造，单决策周期退化为 `O(N^2)`）与纯 JS JCS SHA-256 哈希，且历史记录满额后调用 `Array.shift()` 触发 `O(M)` 平移。
3. **图表全量映射与展开风险**：总览页在 LTTB 降采样前对全量 `stats` 做 20 余次 `.map()`，且 `bounds()` 使用 `Math.min(...xValues)` 展开长数组。
4. **IndexedDB 主线程尖峰**：运行中每 2 秒克隆写入完整 Bundle，`list()` 调用 `store.getAll()` 反序列化全部历史巨型对象。

## 2. 重构内容

### 2.1 控制与存储层（`src/app`）

- **离线零哈希快路径**：`policyId !== 'jev_live'` 时跳过 `buildDecisionState` 与 JCS SHA-256，同步策略直接取值；`snapshot()` 改为增量维护 `aliveCount` 与 `cumulativeDeaths`；有界日志改为摊还批量裁剪替代 `shift()`。
- **沙盒化身与微扰分叉**：新增 `setAvatar` / `submitAvatarAction`（仅从 `enumerateLegalActions` 合法集合中提交选择，不改结算公式）与 `forkAgentValuePerturbation`（捕获检查点 `stateHash`，克隆并仅修改指定个体 `value`，保留原世界 Bundle 供对比）。
- **IndexedDB v2 元数据分表**：新增 `runs_meta` 对象仓库使 `list()` 仅读取轻量索引，运行期拉长自动保存间隔并在无 `indexedDB` 宿主安全降级。

### 2.2 双界面视图层（`src/ui`）

- **持久化反应式外壳**：顶栏 HUD、双界面切换胶囊、五工作区导航与底栏常驻 DOM，`requestAnimationFrame` 帧合并原地更新文本与状态，根治输入框失焦与按钮吞点击。
- **✦ 交互沙盒剧场**（`arena/living-canvas.ts` + `workspaces/sandbox.ts`）：五阶层动态生态 `<canvas>` 舞台（确定性黄金分割相位，零 `Math.random()`；支持「财富晋升阶梯」与「社会关系星群」双视图）、4 组未校准探索剧本、主角命运抉择行动卡、平行宇宙分叉与社会编年史。
- **◈ 精密科研试验台**：
  - **实验设置**：七维折叠参数组、实时 `F(hard)` 与阶级尺度微图、配置叶子 Diff、V8 运行时权威检测与 Live 规模估算；
  - **实时总览**：多评估窗口切换（`all / burnin / w1 / w2 / w3`）、五维均值雷达图、预降采样 10 类交互十字读数图表（消除 `Math.min(...arr)`）与分类事件流；
  - **个体检查器**：常驻零失焦检索/筛选/多维排序花名册（超 200 人自动分页）、O(1) `agentDetail`、决策 X 光、复式财富账本与自我中心网络 SVG；
  - **回放与对比**：支持外部导入或微扰基准对照，自动核对配置叶子 Diff、种子配对、首次偏离 Tick 与双宇宙叠加曲线，显式维持“描述性差异”科学护栏；
  - **实验管理**：IndexedDB 配额进度条、秒级本地实验表、Obsidian / Paper 双主题与失败诊断导出。

## 3. 兼容性与科学边界

- `rulesVersion`（`rules-v15`）、`CONFIG_SCHEMA_VERSION`（`stratify-config-v9`）、`STATE_SCHEMA_VERSION`（`stratify-state-v5`）、`PROMPT_VERSION`（`prompt-v3`）与 `stratify-web-run-v1` 导入导出格式均保持不变；历史 Bundle 与 IndexedDB v1 数据可正常读取。
- 核心引擎源码零改动，所有 golden 与覆盖率门禁不变。
- 本次变更纯属前端交互与工程性能优化，不构成科学验收或校准证据；G6 仍未通过。
