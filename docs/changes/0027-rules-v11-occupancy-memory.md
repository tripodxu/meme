# 0027：rules-v11 占用压力记忆（H=0 逐位退回 v10）

- 日期：2026-11-04
- 作者：核心/规则负责人
- 关联：W5 未通过（`changes/0025`/`0026`）；长视野探索与 W6 设计
  `docs/research/2026-11-04-p15-w6-longhorizon.design.json`
- 性质：规则实现 + 探索层结果；不构成 G1.5/P6-05 通过，也不构成参数校准

## 1. 问题

W5 在 3650 tick 未通过：C 类在 class-share 空间可见，但 `temporalConsistency`
不足，10950 探针把 C 映射到 3650 的 B 簇，得出“C 滑回 B”。根因是 rules-v10 的
占用壁垒只读**瞬时**阶级占比：目标阶级占比一旦回落到参照份额以下，壁垒立即归零，
C 只能作为慢收敛瞬态存在。

## 2. 变更

### 2.1 新参数

`ascent.occupancyMemoryDays`（H，days，整数，域 [0,365]，默认 0）：

```text
target[c]    = (1/env0[c]) / Σ_j (1/env0[j])
p_c(t)       = max(0, P_c(t)/target[c] − 1)
m_c(t)       = H == 0 ? p_c(t) : max(p_c(t), e^{-1/H}·m_c(t−1))
barrier(c)   = scarcityWeight × crossBase(c−1) × m_c(t)
上升余额门槛: value >= cost + cushion + barrier
```

`m_c` 是新增权威状态 `society.occupancyPressure[C]`：

- tick 0 由初始存活占比派生；
- 每 tick 结束、死亡结算后，用下一 tick 的存活占比与上一期记忆更新；
- 枚举侧与引擎复核侧共享同一 `m_c`，不按行动顺序重算；
- `H=0` 时 `m_c=p_c`，逐位退回 v10；`H>0` 时占比回落后按 `e^{-1/H}` 衰减。

该机制仍是**负反馈**：高占用抑制进入，不会自动维持高占用。有限 H 只能延迟混合，
不能仅凭公式推断会形成稳定第三盆地。

### 2.2 版本轴与兼容性

- `rulesVersion`: `rules-v10` → **`rules-v11`**
- `engineVersion`: `engine-v0.8.0` → **`engine-v0.9.0`**
- `configSchemaVersion`: `stratify-config-v5` → **`stratify-config-v6`**
  - v5 → v6 迁移：缺失 `ascent.occupancyMemoryDays` 补 `0`，保持 v10 语义。
- `stateSchemaVersion`: `stratify-state-v2` → **`stratify-state-v3`**
  - 增补 `society.occupancyPressure[C]`；旧快照按版本拒绝，不做静默补齐。
- `promptVersion` 不变（`prompt-v3`）。

`H=0` 的黄金对照：默认 40 人 mock 运行在 tick 0/1/10/120/400 的 stats 与
uniform/newborn 3650 死亡率，与 rules-v10 golden **逐项相同**；状态哈希变化仅来自
版本信封、config 新字段与 state 新字段，跨版本状态哈希不可直接比较。

## 3. 探索层结果

### 3.1 H 扫描（`out/p15-v11-ratchet-probe.json`）

6 cell × 5 seeds × 3650/10950 = 60 run。C-w60 在 3650 的 P1 随 H 略升
（H=0 0.409、H=365 0.450），但 10950 终态几乎重合：

| cell @10950 | P0  | P1    | P2    | P3    | P4    |
| ----------- | --- | ----- | ----- | ----- | ----- |
| C-H0        | 0   | 0.244 | 0.402 | 0.201 | 0.153 |
| C-H90       | 0   | 0.256 | 0.392 | 0.195 | 0.157 |
| C-H180      | 0   | 0.226 | 0.380 | 0.220 | 0.174 |
| C-H365      | 0   | 0.265 | 0.398 | 0.183 | 0.154 |

3650→10950 的 mean L1 漂移：C-H0 0.493、H90 0.456、H180 0.506、H365 0.482。
**H 没有把 C 钉住；它只改变过渡形态。** 因此不能把 rules-v11 当作第三类的成因。

### 3.2 30-seed 长视野复核（`out/p15-longhorizon-probe.json`）

复用 W5 的 `p15r5` 种子做探索复核（不是确认），3 cell × 30 seeds × 10950 = 90 run。
直接对**10950 终态 class-share** 聚类：

| k   | 轮廓  | ARI median/min | 簇组成                 |
| --- | ----- | -------------- | ---------------------- |
| 2   | 0.647 | 1.000/1.000    | A 30；B 30 + C 30      |
| 3   | 0.619 | 1.000/1.000    | A 30；B 30；C 30       |
| 4   | 0.573 | 0.838/0.654    | A 30；B 拆 11+19；C 30 |

10950 cell 均值：A `[0.524,0.313,0.063,0.047,0.053]`；
B `[0,0,0.388,0.401,0.211]`；C `[0,0.243,0.379,0.215,0.163]`。
B/C 的 L1 距离约 0.53，远大于 seed 噪声。**第三类在长视野终态存在，且与 B 分离。**
W5 的失败来自用 3650 的簇去映射 10950 的终态；这是分析口径错误，不是规则缺失。

## 4. W6 确认（changes/0028）

W6 设计已冻结在 `docs/research/2026-11-04-p15-w6-longhorizon.design.json`
（sha256 `04ed2dde…4820`）：全新 `p15r6` 种子、3 cell × 30 × 10950 终态
class-share、k=3、cell 纯度、B/C 质心 L1、10 seeds/cell × 14600 收敛。
结果 120 run，全部预注册 gate 通过（轮廓 0.638、ARI 0.997/0.938、
三簇 30/30/30、B/C L1 0.513、14600 同簇 29/30），判定为**三类候选通过**。

完整指标、边界与产物见 `changes/0028` 和
`docs/research/2026-11-04-p15-w6-longhorizon-result.md`；本记录不重复结果表。
第三类在 `H=0` 已出现，不能归因给 rules-v11 的占用记忆。

## 5. 测试与验证

- `test/unit/engine/scarcity.test.ts`：新增 H=0 压力等价、H>0 指数衰减、
  max 棘轮、引擎级“降阶后 H=0 可升 / H>0 被记忆壁垒拒绝”用例。
- `test/unit/engine/own-parity.test.ts`：v5 own 对照排除新字段，并断言 H=0 时
  `occupancyPressure` 等于终态瞬时压力。
- `test/unit/model/serialize.test.ts` / `test/unit/replay/snapshot.test.ts`：
  state v3 往返、快照恢复与哈希一致。
- `test/golden/*`：v11 config fixture、engine golden、参数快照滚版；
  v10 config fixture 保留只读，W4 预注册 manifest 冻结为
  `src/runner/legacy-w4-manifest.ts`，`ece0a98b…` 仍可复现。
- 全量 `pnpm test`、`typecheck`、`typecheck:core`、`lint`、`format`、
  `check:docs`、`build` 通过后提交。

## 6. 证据

- `out/p15-v11-ratchet-probe.json`（60 run，37,528 B，
  sha256 `3fd84a2c…c500`）
- `out/p15-longhorizon-probe.json`（90 run，36,645 B，
  sha256 `9541965f…b1d81`）
- W6 设计：`docs/research/2026-11-04-p15-w6-longhorizon.design.json`
  （sha256 `04ed2dde…4820`）
- W6 结果：`out/p15-w6-longhorizon.json`（120 run，34,041 B，
  sha256 `ea01c62a…d87a7`）
- 脚本：`scripts/p15-v11-ratchet-probe.mjs`、
  `scripts/p15-longhorizon-probe.mjs`、`scripts/p15-w6-longhorizon.mjs`
