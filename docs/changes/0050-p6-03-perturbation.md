# 0050 P6-03 微扰克隆与正常波动区间

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：01 §9 P6-03、07 §7/§8、changes/0033（P5-04 微扰入口）、changes/0045/0046（P6-02）
- 规则/引擎：`rules-v11` / `engine-v0.9.0`；**无规则行为变化**
- 预注册：`p6-perturbation-v1`，`sha256:6bd61532a7f475a3b16600cd5ef3513abd012779ce74da01244a5fc149484bca`
- experimentId：`p6-perturbation-6bd61532`

## 1. 变更内容

新增 `src/runner/p6-perturbation.ts` 与 `scripts/p6-perturbation.mjs`：

- **两个体制**：`stable`（默认配置）与 `critical`（P6-02 TV(P) 最大的联合条件
  `threshold=0.9 + psi=flat + env0=expanded + crossDays=half`）。后者是 interaction，
  差异不得归因到单一参数（07 §6.3）。
- **10 个扰动 cell**：`control=0`（克隆对照）、`wealth_absolute` 三档
  （`1e-6/1e-4/1e-2`）、`need.threshold` 相对三档、`need.needMultiplier[1]` 相对三档。
  幅度阶梯按 07 §7.3/§7.5 冻结。
- **30 个新配对种子** `p6-perturb-seed-001…030`，与 Stage A/B、P6-02、p15 轮次不重叠
  （D-07 纪律）。200 人 × 730 tick，检查点 tick 365，续跑窗口 [365,729]。
- **每个 (regime, seed) 只跑一次检查点与 baseline**，所有 treatment 从同一快照克隆；
  克隆前权威哈希一致，`control=0` 必须逐位一致，否则响亮失败（07 §7.2）。
- **实验类型**：同检查点、同 mock 策略重跑（07 §7.7 的「微扰-策略重跑」），
  不复用固定决策日志，因此包含策略在新状态下的重新选择；本轮不混入 replay 样本。
- **事件级翻转**：事件签名固定为每 tick 的死亡数 + 阶级转移矩阵计数；
  `firstEventFlipTick/eventFlipTicks/flippedEventCount` 由纯函数计算。
- **结构偏离**：30 tick 尾随块均值的 TV(P) 首次 ≥ 0.10 的 tick
  （`firstStructuralDeviationTick`），避免把单日噪声当结构（07 §5）。
- **分类**（07 §7.5）：
  - `identical`：完整权威哈希一致（仅 δ=0 对照应如此）；
  - `absorbed`：730 天内零事件翻转，只能判「被离散阈值吸收」，不能判「负反馈稳定」；
  - `structural`：窗口 TV(P) ≥ 0.10 且窗口 D 超出 baseline 跨种子 D95；
  - 其余为 `trajectory-only`。
- **正常波动区间**：baseline 30 个种子的两两窗口 TV/D 分布（中位数、p95、D95）与逐 tick
  TV 的 p95；作为「结构不同」的参照。
- 新增 `test/unit/runner/p6-perturbation.test.ts`（12 项）：预注册哈希字段覆盖、
  体制/cell/种子/预算、事件翻转、尾随均值、逐 tick TV、分类与聚合。

## 2. 兼容性

- 不改变 `RunConfig`、`rules-v11`、参数注册表、`configHash/paramsHash`、状态或快照格式；
  既有 P6-01/P6-02 产物与判定不受影响。
- 新预注册 schema `p6-perturbation-v1` 使用既有 `stratify-preregistration` hash domain，
  预像字段显式列出并进哈希；不改 hash domain，不触发 golden 向量更新。
- `out/p6-perturbation-*` 为新增白名单产物，不改旧产物。
- **产物边界**：`artifactProfile=metrics-only`；本地 ledger 保存 baseline 逐 tick 阶级占比
  与逐对派生量，入库 slim 只保留聚合与逐对摘要，**不保存 treatment 的全部逐 tick 行**。
  需要重算 treatment 逐 tick 序列时必须按 §7 命令确定性重跑；不得把 slim 当作全量 tick 证据。

## 3. 实验可比性

- 新种子集，不与任何历史轮次共享；本轮只作 exploratory，不构成确认或校准。
- 分类与波动带口径在运行前冻结；任何口径调整必须新建 experimentId 并重跑。

## 4. 执行结果

- 60 个 `(regime, seed)` 任务全部完成；720 run，wall **16.6 min**；**600 对全部有效**
  （`invalid=0`、`extinct=0`、`fallback>0` 的 pair 为 0）。
- `control=0` 在两体制均 **30/30 逐位一致**，检查点克隆确定性成立。
- baseline 正常波动区间（435 对/体制）：stable 窗口 TV 中位数 0.0225、p95 0.0477、
  逐 tick TV p95 0.0496、D95 0.0855；critical 0.0170 / 0.0423 / 0.0428 / 0.0766。
- **没有任何 cell 达到结构证据**：600 对最大窗口 TV 0.00727、最大 D 0.0299，
  均低于 TV 门槛 0.10 与 baseline D95；所有 cell `beyondBaselineD95Rate=0`。
- 唯一 30/30 都产生事件翻转的是 `need.needMultiplier[1]×1e-2`（stable 首次翻转中位
  tick 450、critical 430；中位 28 个翻转 tick），但窗口 TV 仅 0.000865/0.00162 →
  `trajectory-only`。其余 cell 在 730 天内零事件翻转 → `absorbed`（07 §7.5）。
- 结论：本轮 730 tick、1e-6–1e-2 幅度内，两个体制的小扰动均被离散阈值或轨迹传播吸收，
  **无结构改变证据**；critical 未显示放大。详见 `docs/research/2026-11-05-p6-03-perturbation.md`。

## 5. 不能说的话

- 不能把 `absorbed` 说成「负反馈稳定」；07 §7.5 只允许「被离散阈值吸收」。
- 不能把任一 `structural` 分类说成确认效应或三类结构；P6-05 另有验收（AGENTS #9）。
- 不能把 `critical` 体制的差异归因到 threshold/psi/env0/crossDays 的单一轴。
