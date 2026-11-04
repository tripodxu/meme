# 0013：rules-v10 占用锚定（位置稀缺，D-12）

- 日期：2026-11-04
- 作者：核心/规则负责人（用户选择「占用锚定机制」后落地）
- 关联：D-11（v9 位移份额的负面结论）、D-12（占用锚定）
- 产物（均为**探索层**，07 §6.1，不得引用为 G1.5 确认证据）：
  - `out/p15-scarcity-explore.json`（15 cell × 4 种子 = 60 run）
  - `out/p15-scarcity-high-explore.json`（8 cell × 4 种子 = 32 run）
  - `out/p15-scarcity-transition-explore.json`（7 cell × 2 初值 × 4 种子 = 56 run）
  - `out/p15-scarcity-max-explore.json`（3 cell × 2 初值 × 4 种子 = 24 run）

## 1. 变更内容

**规则 9 新增 `ascent.scarcityWeight`（默认 0，域 [0,100]）**：

```text
target[c]   = (1/env0[c]) / Σ_j (1/env0[j])          # 机会隐含参照份额
pressure[c] = max(0, P[c]/target[c] − 1)             # P 为 tick 期初存活者占比
barrier(c)  = scarcityWeight × crossBase(c−1) × pressure[c]
上升余额门槛: value >= cost + cushion + barrier
```

- 壁垒不支付，只抬升余额门槛；`scarcityWeight=0` 时恒为 0，与 v9 逐位一致。
- `P` 在**行动循环之前**取一次快照（`classShareSnapshot`），枚举侧与引擎复核侧共享，
  避免行动顺序依赖（AGENTS 4）。
- `target` 由 `env0` 派生（env0 越高、目标占比越小），不使用初始名册，
  避免把结构写回人口（rule.md 26）。

## 2. 版本轴与兼容性

- `rulesVersion`: `rules-v9` → **`rules-v10`**
- `engineVersion`: `engine-v0.7.0` → **`engine-v0.8.0`**
- `configSchemaVersion`: `stratify-config-v4` → **`stratify-config-v5`**
  - v4 → v5 迁移：缺失 `ascent.scarcityWeight` 补 `0`，保持 v9 语义。
- 状态 schema 不变（无新增状态）。
- 默认 `scarcityWeight=0`：默认配置的**行为**与 v9/v8 一致（同种子 golden 的可观测
  stats 在 tick 0/1/10/120/400 与 mortality 逐项相同；`scarcityWeight=0` 时 barrier 恒 0、
  不消费新 RNG 地址）。注意 **`authoritativeStateHash` 不能跨版本比较**：
  该哈希包含完整 `RunConfig`（含 `rulesVersion`/schemaVersion/新字段），
  版本轴变化会让同一行为的 state hash 改变；跨版本等价性以 stats/决策/事件为准。
- engine golden 已按 artifacts §5 从 v9 改名滚到 v10 并重算，checkpoint 哈希不变。

## 3. 实现与测试

- `src/core/legal-actions.ts`：`computeAscendCrossBase`（费用基数抽出）、
  `classShareSnapshot`、`scarcityTargetShares`、`computeAscendBarrier`；
  `enumerateLegalActions` 把 barrier 计入 `canAscend`。
- `src/core/engine/engine.ts`：tick 期初取 `classSharesStart` 并传入行动执行；
  上升复核使用同一快照与 barrier。
- `src/core/params.ts`：`ascent.scarcityWeight` 注册（进 `paramsHash`）。
- 测试：`test/unit/engine/scarcity.test.ts`（6 项）：参照份额、w=0 恒零、
  壁垒公式、枚举侧排除、引擎复核拒绝、w=0 可正常升阶。
- 全量：`pnpm typecheck` / `lint` / `format` / `check:docs` / `test`（524 项）通过。

## 4. 探索结果（正面，但仍非 G1.5 判定）

### 4.1 三个参数区域的结构指纹（w3 均值）

| 区域                 | 参数               | P0        | P1        | P2        | P3        | P4        | 种子噪声 L1 | 初值差 L1 |
| -------------------- | ------------------ | --------- | --------- | --------- | --------- | --------- | ----------- | --------- |
| A 底重金字塔         | share=1，任意 w    | 0.54–0.56 | 0.36      | 0.03–0.04 | 0.02      | 0.02–0.03 | 0.10–0.22   | —         |
| B 上位中产           | share=0.5，w=10–15 | 0         | 0.13–0.25 | 0.42–0.49 | 0.18–0.25 | 0.10–0.13 | 0.20–0.31   | 0.13–0.27 |
| C 中产隆起（小底层） | share=0.5，w≥30    | 0.01–0.10 | 0.39–0.46 | 0.24–0.32 | 0.15–0.19 | 0.07–0.10 | 0.11–0.24   | 0.08–0.19 |

- **B/C 是两个平台，不是连续统上的任意两点**：P1（ic-default / ic-middle）随 w 的序列为
  `0.13/0.23 (10) → 0.20/0.25 (15) → 0.31/0.33 (20) → 0.35/0.38 (25) → 0.40/0.42 (30) →
0.40/0.43 (40) → 0.41/0.44 (50) → 0.41/0.46 (60) → 0.41/0.45 (80) → 0.40/0.42 (100)`；
  P2 同步从 0.49 降到 0.24–0.32。即 **w≤15 是一个平台、w≥30 是另一个平台、
  w≈20–30 是过渡带**（sigmoid 饱和），不是线性连续统。A（share=1）是第三个区域。
- **高权重恢复底层**：P0 从 0（w≤20）升到约 0.10（w=80–100），且同初值种子噪声
  降到 0.11–0.24，与区域 A 相当。
- **初值依赖小**：w≥30 时两初值终态 L1 差 0.08–0.19，远小于 v9 无锚定时 >1 的离散度；
  结构由参数决定，不是初始名册记忆。

### 4.2 仍未证明的部分

- **不是已证明的双稳态/迟滞**：每个参数组合仍只有一个吸引域；B/C 是参数轴上的
  两个平台，不是同一参数下的两个盆地。G1.5 的 k=2 硬门槛若把过渡带一起采样，
  仍会得到低 ARI（本探索 pooled k=2 median 0.17–0.26）；只在平台内采样时必须
  在预注册中说明「平台由探索轮发现、确认轮用新种子」，否则属事后择取。
- **底层只恢复到 ~10%**，未回到初始 45%；`w=100` 是当前参数域上限，
  继续提高是否会进一步恢复底层未验证。
- 因此本记录**不宣布 G1.5 通过**。若要把 A/B/C 作为三类结构提交确认，
  必须先在 07 §8.1 预注册「平台区域采样 + k 选择口径」，并说明探索/确认分离；
  该口径修订属规则评审会级决策。

### 4.3 平台区域的聚类检验（探索）

`out/p15-plateau-explore.json`：6 cell × 8 探索种子 = 48 run（A: share=1；
B: w=10/15；C: w=60/80/100）。按 07 §8.1 同一实现聚类（z-score pooled + Ward）：

| k   | 轮廓  | 分配                                    | 稳定性                   |
| --- | ----- | --------------------------------------- | ------------------------ |
| 2   | 0.549 | **A 单独一簇；B∪C 合一簇**              | ARI median=1.0 / min=1.0 |
| 3   | 0.347 | C 独立；B 有 3/16 与 5/16 点泄漏到 C 簇 | 边界不可复现             |

结论：v10 给出**两个**可复现宏观类别——底重金字塔（A）与底轻/中产（B∪C）；
`scarcityWeight` 只在第二类内部移动程度（P1 0.13→0.46），**不产生第三个稳定类别**。
B（w≤15）的种子噪声 0.30–0.37 明显高于 C（0.18–0.22），是 k=3 不稳定的直接原因。

## 5. 后续

1. **G1.5 路线（推荐先做）**：以「A vs B∪C」两区域为预注册网格
   （A: share=1；B/C: share=0.5，w=10/15/60/80/100），排除过渡带 w=20–30，
   用新种子（`p15r4-*`）跑确认轮。G1.5 的预注册要求是 **≥2 类**可复现聚类，
   两区域足够；k=2 硬门槛保持不变，不需要修订 07 §8.1。
2. **P6 路线（第三类）**：若需要 rule.md 57 的三类结构，必须在 B 与 C 之间
   制造更清晰的边界（降低 B 的种子噪声，或把壁垒函数改为凸性/叠加网络正反馈）；
   当前证据不支持三类。
3. 在确认轮通过前，P2–P6 继续搁置（AGENTS 9）。
