# 0045：P6-02 多参数 factorial 探索预注册

- 日期：2026-11-05
- 作者：Runner/实验负责人（严格口径恢复）
- 关联：P6-02（01 §9）、07 §6.2/§6.3/§9、changes/0037/0038/0043、`docs/research/2026-11-05-p6-02-factorial-explore.md`
- 性质：**探索性实验预注册**；不修改规则、参数默认值或既有实验判定

## 1. 设计

以 P6-01 Stage A 单参数结果给出的高低水平做 2^5 全因子（07 §6.3「小型 factorial」）：

| 轴             | 低水平（默认）             | 高水平（Stage A 已扫描档）      |
| -------------- | -------------------------- | ------------------------------- |
| needThreshold  | 0.5                        | 0.9（Stage B 已确认的单轴效应） |
| needMultiplier | `[1,1.3,1.8,2.5,3.5]`      | flat `[1,1.5,1.5,1.5,1.5]`      |
| env0           | `[1,1.5,2.2,3.2,4.5]`      | expanded `[1,2,3.5,5,7]`        |
| crossDays      | `[30,40,50,60]`            | half `[15,20,25,30]`            |
| decay          | `[1.3,1.15,1.0,0.88,0.75]` | steeper `[2.0,1.6,1.2,0.9,0.7]` |

- 32 个 cell：baseline 1 个、single 5 个、interaction 26 个；`design` 与 `changedPaths` 数量由代码派生并校验（07 §6.2/§6.3）。
- 人口 200、730 tick、warmup 365、w1 观测段 `[365,729]`；30 个**新**种子 `p6-factorial-seed-001…030`（D-07：不复用 Stage A/B 或 p15 种子）。
- 主指标 `TV(P)`；每个 cell 与 baseline 做 30 配对，bootstrap 区间由 `evaluateStageA` 计算；同时报告超 baseline 波动带比例。
- 预算 `P6_FACTORIAL_BUDGET = { maxRuns: 1000, maxWallMinutes: 180, maxStorageBytes: 256 MiB }`，进预注册哈希；换预算 = 新 experimentId。

**冻结标识**：`p6-factorial-eaf53b7b`，`preregistrationHash = sha256:eaf53b7b319e10831933de47d586038ca1fd37628f2df318c72a6f599a34d453`。

## 2. 判读纪律

- 本实验是**探索扫描**，不是确认轮：所有 cell 结论只标 exploratory，不宣称确认、校准或结构涌现（AGENTS #9、07 §9）。
- interaction cell 只回答「该联合条件下结构是否可达/不可达」，不得写成「参数 a 使结构变化」（07 §6.3）；单轴因果证据只来自 5 个 single cell。
- baseline 同时作为稳定区参照：其跨种子波动带用于判断各联合格点的差异是否超出正常波动。
- 结构变化较大的格点只用于下一轮细化取样，不得事后改门槛/窗口/种子。

## 3. 兼容性与可比性

- 新 `experimentId` 与新种子集，不与 Stage A/B 产物混比；`rulesVersion`/`engineVersion`/配置默认值不变。
- 既有 P6-01 判定（needThreshold=0.9 确认；其余未确认/exploratory）不受本实验影响。
- 产物：`out/p6-factorial-prereg.json`、`out/p6-factorial-summary.json`、`out/p6-factorial-slim.json`、`out/p6-factorial-analysis.json`；入库前登记 sha256（见 artifacts）。

## 4. 执行与验证

- 实现：`src/runner/p6-factorial.ts`（manifest/cells/哈希）、`scripts/p6-factorial.mjs`（freeze/run/slim/analyze）。
- 测试：`test/unit/runner/p6-factorial.test.ts` 5 项（32 cell 结构、design 自洽、代表性 changedPaths、种子/视野/预算、哈希确定性）。
- 执行结果与判读：见 `docs/research/2026-11-05-p6-02-factorial-explore.md`（运行完成后更新，未完成前不得引用数字）。
