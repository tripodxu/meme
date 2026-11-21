# P6-03 微扰克隆与正常波动区间（2026-11-05）

- 预注册：`p6-perturbation-v1`，`sha256:6bd61532a7f475a3b16600cd5ef3513abd012779ce74da01244a5fc149484bca`
- experimentId：`p6-perturbation-6bd61532`
- 规则/引擎：`rules-v11` / `engine-v0.9.0`
- 规模：2 个体制 × 30 个新配对种子 × 10 个扰动 cell = 600 对；200 人 × 730 tick，
  检查点 tick 365，续跑窗口 [365,729]
- **声明：本轮是 exploratory；不构成确认、校准或 P6-05 的三类结构验收（AGENTS #9）。**

## 1. 预注册问题

07 §7 要求区分「扰动只改变轨迹」与「扰动改变窗口结构」，并给出正常波动区间。
本轮固定回答：

1. 在 stable（默认）与 critical（P6-02 最大联合条件）两个体制中，同一组小扰动
   （财富绝对 1e-6/1e-4/1e-2，`need.threshold` 与 `need.needMultiplier[1]` 相对
   1e-6/1e-4/1e-2）是否在 730 天内产生事件翻转？
2. 若产生，窗口 TV(P) 是否达到 07 §8 的 0.10 门槛并超出 baseline 跨种子 D95？
3. 首次事件翻转与首次结构指纹偏离分别发生在哪个 tick？
4. baseline 自身的正常波动区间（窗口 TV/D 与逐 tick TV 的 95 分位）是多少？

## 2. 设计

- **stable**：默认配置；**critical**：`need.threshold=0.9` +
  `need.needMultiplier=[1,1.5,1.5,1.5,1.5]` + `opportunity.env0=[1,2,3.5,5,7]` +
  `ascent.crossDays=[15,20,25,30]`（P6-02 top 联合条件；interaction，不得单轴归因）。
- 每个 (regime, seed) 只跑一次检查点（tick 365）与 baseline；10 个 treatment 全部从
  同一快照克隆，克隆前权威哈希一致；`control=0` 必须逐位一致。
- 事件签名 = 每 tick 死亡数 + 阶级转移矩阵计数；连续量（competitionLoss/Gain 等）
  的差异只计入轨迹偏离，不计入事件翻转。
- `firstStructuralDeviationTick` = 30 tick 尾随块均值 TV(P) 首次 ≥ 0.10 的 tick。
- 分类：`identical` / `absorbed`（730 天内零事件翻转，07 §7.5）/
  `trajectory-only` / `structural`（窗口 TV≥0.10 且窗口 D > baseline 跨种子 D95）。
- 严格结构证据（cell 级）：30 对全部有效、中位数 TV≥0.10、bootstrap CI 不跨 0、
  100% 超出 baseline D95。

## 3. 执行与正常波动区间

- 60 个 `(regime, seed)` 任务全部完成；每任务 1 次检查点 + 1 次 baseline + 10 次 treatment，
  共 720 run；wall **16.6 min**（预算 90 min）。
- **600 对全部有效**：`invalid=0`、`extinct=0`、`fallbackRate>0` 的 pair 为 0。
- `control=0` 在两个体制均 **30/30 逐位一致**（最终权威哈希相同、无 stats 偏离），
  检查点克隆与续跑确定性成立。

baseline 跨种子正常波动区间（30 个种子两两配对，435 对/体制）：

| 体制     | 窗口 TV 中位数 | 窗口 TV p95 | 逐 tick TV p95 | 窗口 D95 |
| -------- | -------------- | ----------- | -------------- | -------- |
| stable   | 0.0225         | 0.0477      | 0.0496         | 0.0855   |
| critical | 0.0170         | 0.0423      | 0.0428         | 0.0766   |

## 4. 各 cell 结果

分类计数按 30 个配对种子；`absorbed` = 730 天内零事件翻转（07 §7.5）；
`trajectory-only` = 有事件翻转但窗口 TV 未达 0.10 或未超出 baseline D95。
所有 cell 的 `structural=0`、`structuralEvidence=false`、`firstStructuralDeviationTick=null`。

### stable（默认配置）

| cell                              | identical | absorbed | trajectory | 窗口 TV 中位数 [CI]          | 最大 TV | D 中位数 | 事件翻转 tick 中位数 | 首次翻转中位数 |
| --------------------------------- | --------- | -------- | ---------- | ---------------------------- | ------- | -------- | -------------------- | -------------- |
| control=0                         | 30        | 0        | 0          | 0                            | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-6              | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-4              | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-2              | 0         | 29       | 1          | 0                            | 0.0020  | 0.000001 | 0                    | 450（仅 1 对） |
| param:need.threshold×1e-6         | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| param:need.threshold×1e-4         | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| param:need.threshold×1e-2         | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| param:need.needMultiplier[1]×1e-6 | 0         | 30       | 0          | 0                            | 0       | 0        | 0                    | —              |
| param:need.needMultiplier[1]×1e-4 | 0         | 28       | 2          | 0                            | 0.0024  | 0        | 0                    | 540            |
| param:need.needMultiplier[1]×1e-2 | 0         | 0        | 30         | 0.000865 [0.000357,0.001644] | 0.0073  | 0.00395  | 28                   | 450            |

### critical（P6-02 top 联合条件）

| cell                              | identical | absorbed | trajectory | 窗口 TV 中位数 [CI]         | 最大 TV | D 中位数 | 事件翻转 tick 中位数 | 首次翻转中位数 |
| --------------------------------- | --------- | -------- | ---------- | --------------------------- | ------- | -------- | -------------------- | -------------- |
| control=0                         | 30        | 0        | 0          | 0                           | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-6              | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-4              | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| wealth_absolute=1e-2              | 0         | 30       | 0          | 0                           | 0       | 0.000001 | 0                    | —              |
| param:need.threshold×1e-6         | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| param:need.threshold×1e-4         | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| param:need.threshold×1e-2         | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| param:need.needMultiplier[1]×1e-6 | 0         | 30       | 0          | 0                           | 0       | 0        | 0                    | —              |
| param:need.needMultiplier[1]×1e-4 | 0         | 28       | 2          | 0                           | 0.0019  | 0        | 0                    | 550            |
| param:need.needMultiplier[1]×1e-2 | 0         | 0        | 30         | 0.00162 [0.000368,0.002174] | 0.0055  | 0.00871  | 28                   | 430            |

## 5. 轨迹不同 vs 结构不同

- **没有任何 cell 达到结构证据**：600 对中最大窗口 TV 为 **0.00727**（stable 的
  `needMultiplier[1]×1e-2`），最大 D 为 **0.0299**；两者都远低于 07 §8 的 TV 门槛 0.10
  和各自体制的 baseline D95（0.0855 / 0.0766）。所有 cell 的 `beyondBaselineD95Rate=0`。
- **唯一在 30/30 对上产生事件翻转的 cell** 是 `need.needMultiplier[1]×1e-2`：
  stable 中位 28 个翻转 tick、首次翻转中位 tick 450；critical 中位 28、首次 430。
  事件确实被翻转，但窗口结构几乎不变（TV 中位数 0.000865 / 0.00162），只能判
  **trajectory-only**。
- 其余 cell 在 730 天内零事件翻转，按 07 §7.5 只能判 **被离散阈值吸收**，
  不能判「负反馈稳定」。stable 的 `wealth_absolute=1e-2` 有 1 对在 tick 450 翻转，
  `needMultiplier[1]×1e-4` 有 2 对翻转，但窗口 TV 仍 <0.003，均为 trajectory-only。
- **critical 没有表现出放大**：同一幅度下，critical 的 TV/D 与 stable 同量级，
  未越过 0.10；因此本轮不能支持「临界区小扰动更容易改变结构」的假设。
  该体制是 interaction，即使有差异也不得归因到单一参数（07 §6.3）。
- 结论：在本轮 730 tick 视野与 1e-6–1e-2 幅度内，两个体制的小扰动都被离散阈值
  或轨迹传播吸收，**没有结构改变证据**；不能据此声称「无敏感性」或「系统稳定」。

## 6. 限制与不能说的话

- 730 tick 视野；零事件翻转只能判「被离散阈值吸收」，不能判「负反馈稳定」（07 §7.5）。
- critical 体制是 interaction，任何差异不得归因到单一参数（07 §6.3）。
- 单种子配对内的轨迹差异不等于结构差异；结构判断以窗口 TV 与 baseline D95 为准。
- 本轮不构成确认、校准或 P6-05 三类结构验收（AGENTS #9）。

## 7. 复现与产物

```bash
pnpm build
node scripts/p6-perturbation.mjs --freeze
node scripts/p6-perturbation.mjs --run
node scripts/p6-perturbation.mjs --slim
node scripts/p6-perturbation.mjs --analyze
```

产物：`out/p6-perturbation-prereg.json`、`out/p6-perturbation-slim.json`、
`out/p6-perturbation-analysis.json`（artifacts 登记）。
