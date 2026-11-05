# 0051 P6-04a 五个必跑消融

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：01 §9 P6-04、07 §11、rule.md 58、changes/0036（D-04）、changes/0050（P6-03）
- 规则/引擎：`rules-v11` / `engine-v0.9.0`；**无规则行为变化**
- 预注册：`experiment-v2`（P6-04 消融），`sha256:c46c2aff831f7298228bf3e7fcef6154b0b9dc9d8f17d02f7a20f9993911110a`
- experimentId：`p6-ablation-c46c2aff`

## 1. 变更内容

新增 `src/runner/p6-ablation.ts` 与 `scripts/p6-ablation.mjs`：

- **baseline + 五个单轴消融**（07 §11、rule.md 58）：
  - `β=0`：`networkOpportunity.beta=0`，Opportunity 恒为 1，网络关系/竞争/S 保留；
  - `O` 固定：`openness.updateMode='fixed'`，停止制度更新；
  - `η=0`：`dynamics.congestionExponent=0`，Congestion=1；
  - `κ=0`：`dynamics.polarizationExponent=0`，Polarization=1；
  - `ψ=1`：`need.needMultiplier=[1,1,1,1,1]`，移除阶级持有成本。
- 每个消融 `design='single'`，`changedPaths` 恰好 1 项，由 `diffConfigPaths` 自动派生。
- 30 个新种子 `p6-ablation-seed-001…030`（D-07：不与 Stage A/B、P6-02/03、p15 重叠）；
  200 人 × 730 tick，warmup 365，w1 观测段 [365,729]；6 cell × 30 = 180 run。
- 主指标 TV(P)；结构显著退化的判定沿用 07 §8：中位数 ≥0.10、配对 bootstrap 95%
  区间不跨 0、100% 超出 baseline 跨种子 D95、60/60 完整、0 灭绝/回退。
- 方向预测只登记 07 §11 明示的一条：`ψ=1` 预期顶层塌缩显著增强（P4 下降，
  中位差 <0 且 ≥90% 配对同号）；其余消融不预设方向，避免事后挑选。
- 新增 `test/unit/runner/p6-ablation.test.ts`（7 项）：cell/changedPaths、种子/预算、
  哈希字段覆盖、ψ=1 方向预测、分项中位差与同号率判定。

## 2. 预算重冻结（D-04）

D-04 v1 的消融预算是 **120 run / 240 min / 512 MiB**；五个必跑消融 + baseline
需要 6 cell × 30 = **180 run**，超过该占位值。按 changes/0036 §1「换预算 = 新
experimentId」，本实验新建 `p6-ablation-c46c2aff`，预算重冻结为
**200 run / 240 min / 512 MiB**，并进入 `preregistrationHash`。实测 200 人 × 730 tick
约 2–3 s/run，180 run 约 10 min，240 min 有充足余量。

## 3. 兼容性

- 不改变 `RunConfig`、规则、参数注册表、`configHash/paramsHash`、状态或快照格式；
  既有 P6-01/P6-02/P6-03 产物与判定不受影响。
- 复用 `experiment-v2` 预注册 schema 与既有 hash domain；新增
  `WARMUP_DIAGNOSTICS` 文本登记（P6-04 档），不改变历史 manifest 的字面值或哈希。
- `out/p6-ablation-*` 为新增白名单产物，不改旧产物。

## 4. 执行结果

- 180/180 run 完成，0 失败/灭绝/回退，wall **10.2 min**；每 cell 30 对，w1 均
  365/365 tick；baseline D95 = **0.0668**。
- TV(P) 中位数：beta=0 **0.0195**（超 D95 0.800）、openness=fixed 0.0080（0）、
  eta=0 0.0063（0）、kappa=0 0.0106（0）、psi=1 **0.0824**（0.367）。
- **五个消融均未达到 `mechanismExplained`**（TV <0.10）。beta=0 的次要分项变化最大
  （ΔG -0.0596、ΔMup +0.1382），但主指标未达门槛，只能记为次要指标信号。
- **ψ=1 方向预测不成立**：P4 中位差 +0.0045、同号率 3.3%，顶层未塌缩；实际是
  P0/P1 下降、P2/P3 上升（底层/第二层推向中层）。
- 结论：本实验范围内五消融均无主指标意义的结构退化；不得说机制不存在或已被验证。
  详见 `docs/research/2026-11-05-p6-04-ablations.md`。

## 5. Jev/mock 对照（P6-04b）

**未运行**：旧 Jev Key 尚未轮换（docs/12 rev 24），在轮换、预算与重测信度完成前
不得发起 live 调用。07 §11 要求的 20 次重测信度（top-1 ≥0.70、ICC ≥0.50、
平均 TV ≤0.15）与 live 5–10 seeds × 40 人 × 730 tick 协议已记录在
`docs/research/2026-11-05-p6-04-ablations.md` §5；本轮不提供任何 live 数据，
也不得用 mock 消融代替 Jev 对照。

## 6. 不能说的话

- 不能把消融差异说成现实因果；只能说明机制在本实验范围内的解释力。
- 未达到 `mechanismExplained` 不等于机制不存在，只说明本视野/幅度下无显著结构退化。
- 不得声称已校准、结构已涌现或 G6 通过（P6-05 另有验收）。
