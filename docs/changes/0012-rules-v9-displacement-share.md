# 0012：rules-v9 位移准入份额（D-11）

- 日期：2026-11-04
- 作者：核心/规则负责人（用户确认后落地）
- 关联：D-09（位移准入）、D-10（判据重推定）、D-11（位移份额）
- 产物：`out/p15-displacement-explore.json`（60 run，探索层）、
  `out/p15-balance-explore.json`（48 run，探索层）；
  **两者均不构成 G1.5 证据**（07 §6.1 探索/确认分离）。

## 1. 变更内容

**规则 9 新增 `ascent.displacementShare`（默认 1，域 [0,1]）**：

```text
'class' 参照系下，上升执行时：
  share = 1          → 完全按 v8：对决目标阶级在位者，胜则升阶、败者降级（逐位不变）
  0 < share < 1      → 先按 R(seed,tick,agentId,'displacement_admit',0) 判定：
                       u < share 走位移；否则走开放准入（不挤下在位者，目标阶级净 +1）
  share = 0          → 完全开放准入（不消费 displacement 相关地址）
'own' 参照系不读取该参数，与 v5 逐位一致（G-D）。
```

目的：v8 的 1:1 位移使阶级占比成为守恒量（上升/下降逐层近似相等），
经济参数只能改变环流速度、无法改变稳态分布——这是 W2 26 cell 排成连续统、
k=2 ARI 仅 0.415 的结构性原因。`displacementShare` 打破精确守恒，
使阶级占比重新成为可由参数移动的平衡量，从而让「参数区域产生不同结构」
（rule.md 57）重新具备可检验性。

## 2. 版本轴与兼容性

- `rulesVersion`: `rules-v8` → **`rules-v9`**
- `engineVersion`: `engine-v0.6.0` → **`engine-v0.7.0`**
- `configSchemaVersion`: `stratify-config-v3` → **`stratify-config-v4`**
  - v3 → v4 迁移：缺失 `ascent.displacementShare` 补 `1`，保持 v8 语义；
    旧配置可继续读取，不默认开启新机制。
- `stateSchemaVersion` 不变（`stratify-state-v2`，无新增状态）。
- 默认 `displacementShare=1`：默认配置的**行为**与 v8 一致（同种子 golden 的可观测
  stats 与 mortality 逐项相同；`share=1` 不消费 `displacement_admit` 地址）。
  注意 `authoritativeStateHash` 包含完整 `RunConfig`，不能跨版本按哈希比较等价性。
  `configHash`/`paramsHash` 因新字段与新注册参数改变，历史 golden 不可直接比较。
- `test/fixtures/engine/mock-run-rules-v8.json` 按 artifacts §5 的
  「engine golden 改名前滚」约定 `git mv` 为 `mock-run-rules-v9.json` 并重算；
  checkpoint 状态哈希不变（默认 share=1 不消费新 RNG 地址）。
- `test/fixtures/config/default-rules-v9.json` 为累加式新增；v8 配置 fixture 保留只读。

## 3. 实现与测试

- 引擎：`src/core/engine/engine.ts` 位移分支按 `displacementShare` 分派；
  `share=1` 不消费 `displacement_admit` 地址（逐位不变），`share=0` 不消费位移地址。
- RNG：新增冻结 tag `displacement_admit`（`src/core/rng/tags.ts`）。
- 注册表：`ascent.displacementShare`（`src/core/params.ts`，进 `paramsHash`）。
- 测试：`test/unit/engine/displacement.test.ts` 新增
  「share=0 开放准入、在位者不动」「share=1 与 v8 一致」两条接线测试；
  `test/golden/config-default.test.ts` 断言默认值为 1；
  `test/unit/config/defaults.test.ts` 同步默认值形状。
- 全量：`pnpm typecheck` / `pnpm lint` / `pnpm format` / `pnpm test`（518 项）全部通过。

## 4. 探索结果（非判定，负面结论）

### 4.1 单轴扫描 `displacementShare ∈ {1,0.75,0.5,0.25,0}`

`out/p15-displacement-explore.json`，2 种初始分布 × 6 探索种子 × 3650 tick：

| share | P0   | P1   | P2        | P3        | P4        | 同初值种子噪声 L1 |
| ----- | ---- | ---- | --------- | --------- | --------- | ----------------- |
| 1     | 0.56 | 0.36 | 0.03      | 0.02      | 0.03      | 0.14–0.19         |
| 0.75  | 0    | 0    | 0.15–0.25 | 0.60–0.64 | 0.15–0.21 | 1.02–1.04         |
| 0.5   | 0    | 0    | 0.16–0.28 | 0.54–0.77 | 0.07–0.17 | 0.59–1.19         |
| 0.25  | 0    | 0    | 0.03–0.08 | 0.69–0.83 | 0.14–0.23 | 0.53–0.94         |
| 0     | 0    | 0    | 0.01–0.16 | 0.62–0.77 | 0.22–0.23 | 0.73–1.25         |

要点：

- `share=1`：底重稳态，转移逐层近似相等（如 810/815、309/316），**守恒**。
- `share<1`：净上行流出现，底层在前 3650 tick 内被抽空（P0=P1=0），
  系统棘轮到中/高层；**同参数不同种子的结构离散度 >1（L1）**，被种子噪声主导，
  不满足 rule.md 27「稳定参数区域小扰动应被吸收」。
- 单轴扫描没有给出稳定、非退化的第二结构；这是**负面结果**。

### 4.2 位移份额 × 拥挤负反馈交互

`out/p15-balance-explore.json`（share∈{0.75,0.5} × η∈{1,2,3} × congestionMin∈{0.2,0.05}，
48 run）：所有组合的 P0 仍为 0；部分组合 P1 恢复至 0.19–0.72，
但同初值种子噪声仍为 0.09–1.55，多数组合由噪声主导。**强拥挤负反馈不能替代 1:1 位移提供的下行流。**

### 4.3 机制结论

v8 的 1:1 位移同时承担了两个职责：下行通道与分布锚定。把它按份额放松后，
上行流由「可负担」驱动、下行流失去对应通道，系统进入**棘轮**而非第二个稳态。
因此 `displacementShare` 是一个有效的诊断/消融参数，但**不是**产生参数区域多结构的机制。

## 5. 后续决策项（未定）

1. 需要一个**占用锚定**的新机制（例如按目标阶级占比递增的进入壁垒/位置稀缺定价），
   而不是继续放松位移；该机制须作为独立规则版本（rules-v10）与独立预注册。
2. 或者按 route C 修订章程目标（承认当前机制家族只产生单一稳态），
   需 00 章程 + ADR 级变更。
3. 在决策前，**不得**把本记录的探索产物引用为 G1.5 证据，也不得据此宣称参数已校准。
