# P1.5 涌现分叉探索：参数路径迟滞与底层锁定（2026-11-04）

> **性质：探索层**（07 §6.1）。本文件只提出下一轮假设，不得引用为 G1.5 确认证据，
> 也不构成参数校准或“结构已涌现”的声明。种子 `p15b-*` 与 `p15-seed-*`、
> `p15r3-*`、`p15r4-*` 均不重叠；未使用确认轮产物。

## 1. 问题

W4 确认轮得到 A（share=1 闭合位移）vs B∪C（share=0.5 开放准入 + 占用锚定）两个
**参数体制**；同一参数组合下仍只观察到一个吸引域，未证明迟滞/双稳态。本轮直接检验：

> 在同一个终态参数 `(share=0.5, scarcityWeight=w_mid)` 下，从不同历史到达，
> 是否会收敛到显著不同的长期结构？

## 2. 设计

- **路径**（每 seed 三条）：
  - `up`：`w=0` 预热 1825 tick → `w=w_mid` 继续 1825 tick；
  - `down`：`w=100` 预热 1825 tick → `w=w_mid` 继续 1825 tick；
  - `control`：全程 `w=w_mid`。
- `share=0.5` 固定；`w_mid ∈ {20,25,30}`（W4 过渡带）。
- 初始阶级分布（同一 IC 内三条路径一致）：
  - `ic-default`：`[0.45,0.30,0.15,0.08,0.02]`
  - `ic-middle`：`[0.10,0.25,0.35,0.22,0.08]`
  - `ic-bottom`：`[0.60,0.25,0.10,0.04,0.01]`
- 种子：`p15b-seed-001…`；`ic-middle` 10 个，default/bottom 各 6 个。
- 决策：`mock-weighted-v1`（确定性基线；未接 Jev）。
- **主判据**：`lockedFraction`（末态 class0+class1 < 5% 的 run 比例）与 `mUp`
  （后段上升转移数）；**辅助**：class-share L1、P0。
  只看 P0 会漏掉「P0=0 但 P1 仍有 30%」的差异，因此不以 P0 单独判定。

## 3. 结果（1825 + 1825 tick）

### 3.1 底层锁定比例

| IC      | w_mid | up locked | down locked | control locked |
| ------- | ----- | --------- | ----------- | -------------- |
| middle  | 20    | 1.000     | 0           | 0              |
| middle  | 25    | 1.000     | 0           | 0              |
| middle  | 30    | 1.000     | 0           | 0              |
| default | 20    | 1.000     | 0           | 0              |
| default | 25    | 1.000     | 0           | 0              |
| default | 30    | 1.000     | 0           | 0              |
| bottom  | 20    | 0.833     | 0           | 0              |
| bottom  | 25    | 0.833     | 0           | 0              |
| bottom  | 30    | 0.833     | 0           | 0              |

`up` 的锁定是**底层两阶级同时抽空**；`down`/`control` 均保留 class1（约 0.17–0.45）。

### 3.2 后段流动性（mUp 均值）

| IC      | w_mid | up  | down | control |
| ------- | ----- | --- | ---- | ------- |
| middle  | 20    | 6.0 | 36.5 | 53.1    |
| middle  | 25    | 4.5 | 31.8 | 50.8    |
| middle  | 30    | 4.5 | 31.2 | 52.9    |
| default | 20    | 6.0 | 45.0 | 84.2    |
| default | 25    | 5.5 | 44.2 | 73.8    |
| default | 30    | 3.5 | 37.2 | 81.5    |
| bottom  | 20    | 3.0 | 53.0 | 109.8   |
| bottom  | 25    | 2.8 | 46.7 | 107.2   |
| bottom  | 30    | 2.5 | 43.8 | 102.2   |

- `up` 相对 `down` 的 mUp 差为 26.7–50.0，合并标准差 5.1–11.5，全部 `separated=true`。
- `down` 也低于 `control`（例如 middle/w=25：31.8 vs 50.8），即高壁垒历史留下
  **流动性疤痕**；class 分布相近时，mUp 仍显著偏低。
- P0 差≈0（±0.006），`separatedByP0=false`；class-share L1 在 middle/default 上
  因 `up` 内部 class2–4 重分配而噪声偏大，`separatedByL1=false`；bottom 的 L1 可分离。
  因此**锁定比例 + 流动性**是本轮的主证据，P0/L1 不能单独承担判定。

### 3.3 长期持续性（middle，1825 + 3650 tick，3 seeds）

| w_mid | up locked | up mUp | down mUp | control mUp |
| ----- | --------- | ------ | -------- | ----------- |
| 20    | 1.000     | 10.3   | 48.0     | 66.7        |
| 25    | 1.000     | 9.0    | 45.7     | 66.3        |
| 30    | 1.000     | 9.0    | 44.3     | 59.0        |

把后段延长到 3650 tick 后，`up` 仍锁定、`down` 的流动性仍低于 control。这说明
两个路径效应不是 1825 tick 内的短瞬态，至少在 5475 tick 视野内持续。

## 4. 机制

1. **底层抽空是吸收边界。** `w=0` 预热让 `share=0.5` 的开放准入把 class0/1 抽空，
   末态约 `[0,0.005,0.35,0.60,0.04]`。占用锚定只作用于「从 c 升到 c+1 时对 c+1
   的占用压力」；class0/1 为空后没有可上升的底层个体，之后再提高 w 也无法把
   底层“补回来”。这是**组成锁定**，不是对称双稳态势阱。
2. **高壁垒留下流动性疤痕。** `w=100` 预热保留底层但压低上升流；切回 w_mid 后
   mUp 仍只有 control 的约 60–70%，且长期不恢复。该效应独立于底层是否为空。
3. 因此可称为**路径依赖锁定 / 单向棘轮（hysteresis / one-way ratchet）**；
   “涌现”体现在集体组成阈值（底层抽空）产生了吸收态，但触发来自参数路径，
   不是自发对称破缺。**不宣布已确认分岔**。

### 4.1 机制消融与恢复（probe，3 seeds，w_mid=25，ic-middle）

| 条件                        | lockedFraction | mUp 均值 | 末态形态                           |
| --------------------------- | -------------- | -------- | ---------------------------------- |
| `share=0.5` 预热 → mid      | 1.000（3/3）   | 2.7      | 底层空，class2–4 随 seed 重分配    |
| `share=1` 预热 → mid        | 0（0/3）       | 37.7     | class1≈0.41–0.45，保留底层         |
| 锁定后 `w=0` 恢复 1825 tick | 1.000（3/3）   | 44.7     | 底层仍空；上层继续向 class3/4 重组 |

- 开放准入预热是锁定的必要条件：`share=1` 的 1:1 位移不抽空底层，随后切到
  `share=0.5` 也不锁定。
- 去掉占用锚定不能让底层恢复：没有 class0/1 个体可供上升；恢复期的 mUp 来自
  上层内部流动。“锁定”是**底层组成吸收边界**，不是全局冻结；上层仍继续重组，
  且末态高度依赖 seed。

## 5. 限制

- 只测 `share=0.5`、`w_mid=20/25/30`、w 两相极端 0/100；未扫 share、w 连续阈值。
- 只有 3 个阶级分布 IC，未做财富/网络/寿命维度的状态扰动；机制探针只有 3 seeds、
  单一 `w_mid=25`，恢复实验只试了 `w=0`。
- 只用 `mock-weighted-v1`；Jev live/random 策略可能改变流动性，结论不可直接外推。
- 有限视野（5475 tick）；锁定是否为真正吸收态需要更长跑或政策干预实验。
- 探索层无预注册、无 G1.5/P6 判定效力；种子与确认轮隔离。

## 6. 下一轮确认协议（建议）

1. **预注册**：≥3 IC（含 default/middle/bottom）、w_mid∈{20,25,30}、warmup=1825、
   后段≥3650、≥30 seeds；预注册 `lockedFraction` 与 `mUp gap` 的判据。
2. **硬门槛（建议）**：`up lockedFraction ≥ 0.80`、`down ≤ 0.20`、
   `mUp gap > 2×pooled SD`；同时报告 P0 与 class-share L1，不以 P0 单独判定。
3. **恢复/扰动**：锁定后尝试临时 `share=0`/`w=0`、或引入新个体（需核心支持），
   检验是否存在任何回到 middle/control 的通道；若无，明确记为吸收态。
4. **机制消融**：`displacementShare=1` vs 0.5，确认“开放准入抽空底层”是锁定的必要条件。
5. **策略敏感性**：mock vs random vs Jev（P2）三策略下重复；只有跨策略稳定才可
   讨论“结构涌现”，否则只是 mock 策略的路径效应。
6. 即使确认，这只是**路径依赖锁定**，不等于 P6-05 的 ≥3 类互异结构；两者分别判定。

## 7. 产物

- `out/p15-bifurcation-explore-middle.json`（150 run，10 seeds）
- `out/p15-bifurcation-explore-default.json`（90 run，6 seeds）
- `out/p15-bifurcation-explore-bottom.json`（90 run，6 seeds）
- `out/p15-bifurcation-long-middle.json`（45 run，3 seeds，后段 3650 tick）
- `out/p15-bifurcation-probe.json`（15 run，3 seeds；share 消融 + 锁定后恢复）
- 脚本 `scripts/p15-bifurcation-explore.mjs`；`runSingle` 的 `initialState`
  （续跑/多阶段路径）见 changes/0016。
