# P1.5 路径依赖复制轮：全新种子下的锁定与流动性分离（2026-11-04）

> **性质：复制轮**（fresh-seed replication），不是 G1.5 确认轮，也不构成参数校准声明。
> 设计先于运行冻结：`docs/research/2026-11-04-p15-bifurcation-replication.design.json`，
> `sha256:e81c0ef78032d4e7e2191b2deb523b335894695940936ac6523f819b4349aedb`。
> 种子 `p15c-*` 与探索轮 `p15b-*`、确认轮 `p15r3/p15r4` 均不重叠。

## 1. 设计与门槛（运行前冻结）

- **条件**：`share=0.5`；`w_mid∈{20,25,30}`；`up` = w=0 预热 1825 tick → w_mid
  继续 1825 tick；`down` = w=100 预热 → w_mid；`control` = 全程 w_mid。
- **IC**：default `[0.45,0.30,0.15,0.08,0.02]`、middle `[0.10,0.25,0.35,0.22,0.08]`、
  bottom `[0.60,0.25,0.10,0.04,0.01]`。
- **种子**：`p15c-seed-001…010`（每个 IC 10 个）。
- **策略**：`mock-weighted-v1`；3650 tick 总视野。
- **per-cell 门槛**（9 个 IC × mid cell）：
  - `up lockedFraction ≥ 0.80`；
  - `down lockedFraction ≤ 0.20`；
  - `mUp gap > max(5, 2×pooled SD)`。
- **overall**：≥7/9 cell 通过全部 per-cell 门槛，且不存在
  `upLockedFraction < downLockedFraction` 的反向 cell。
- `lockedFraction` 定义：末态 `class0 + class1 < 5%` 的 run 比例；P0 与 class-share
  L1 仅作辅助，不单独判定。

## 2. 结果

| IC      | w_mid | up locked | down locked | control locked | mUp up | mUp down | gap  | pooled SD | 过门 |
| ------- | ----- | --------- | ----------- | -------------- | ------ | -------- | ---- | --------- | ---- |
| middle  | 20    | 1.000     | 0           | 0              | 2.8    | 43.5     | 40.7 | 6.20      | 是   |
| middle  | 25    | 1.000     | 0           | 0              | 2.8    | 38.6     | 35.8 | 6.89      | 是   |
| middle  | 30    | 1.000     | 0           | 0              | 2.8    | 37.5     | 34.7 | 6.41      | 是   |
| default | 20    | 1.000     | 0           | 0              | 10.1   | 47.1     | 37.0 | 10.48     | 是   |
| default | 25    | 1.000     | 0           | 0              | 10.5   | 43.9     | 33.4 | 8.91      | 是   |
| default | 30    | 1.000     | 0           | 0              | 9.3    | 38.9     | 29.6 | 8.78      | 是   |
| bottom  | 20    | 1.000     | 0           | 0.1            | 9.3    | 64.3     | 55.0 | 20.27     | 是   |
| bottom  | 25    | 1.000     | 0           | 0              | 9.3    | 63.8     | 54.5 | 18.58     | 是   |
| bottom  | 30    | 1.000     | 0           | 0              | 8.2    | 56.5     | 48.3 | 16.99     | 是   |

**判定：9/9 cell 通过全部 per-cell 门槛，0 个反向 cell；overall 门槛通过。**
P0 gap 全部≈0（−0.003…0），再次说明 P0 不能单独作为路径判据。

## 3. 结论与边界

- 探索轮（`p15b-*`，375 run）的路径依赖锁定在 **3 个 IC × 10 个全新种子**上复制成功：
  `up` 全部锁定、`down`/`control` 不锁定，mUp 差 29.6–55.0，均超过 2×pooled SD。
- 机制仍是**底层组成吸收边界 + 高壁垒后的流动性疤痕**：`up` 在无锚定预热中抽空
  class0/1，之后提高 w 无法补回；`down` 保留底层，但切回 w_mid 后流动性长期偏低。
- 这是**路径依赖锁定/单向棘轮**的复制，不是经典对称双稳态分岔的证明；没有
  证明两个对称势阱、临界慢化或自发对称破缺。
- 仍不构成 G1.5/P6 的统计验收：单策略（mock）、单 share、有限视野；
  未做恢复/扰动与 Jev 策略敏感性。P6-05 的 ≥3 类结构仍未满足。

## 4. 产物

- `out/p15-bifurcation-repl-middle.json`（150 run，sha256 `1d17b8ab…f884a3`）
- `out/p15-bifurcation-repl-default.json`（150 run，sha256 `121c6099…baee79a`）
- `out/p15-bifurcation-repl-bottom.json`（150 run，sha256 `36bef6e1…b2eeee`）
- 设计：`docs/research/2026-11-04-p15-bifurcation-replication.design.json`
  （`sha256:e81c0ef7…4349aedb`）
