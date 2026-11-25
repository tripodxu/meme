# 0033：P5-04 微扰配对执行入口（07 §7）

- 日期：2026-11-05
- 作者：Runner 负责人
- 关联：P5-04（01 §8.1）、07 §7（微扰协议）、`changes/0031`–`0032`
- 性质：**Runner 层实现变更**；不改变规则、参数注册表、默认配置与引擎行为；
  新增本地格式 `perturbation-summary-v1`（不进 D1/R2 契约）

## 1. 结论先行

P5-04 的工程面落地：`src/runner/perturbation.ts` 提供「配对种子 + 共同随机数 + 微扰任务
生成」的**执行入口**——baseline 与 treatment 同 seed、同预注册检查点克隆（07 §7.2），
treatment 仅施加声明扰动，两侧各自续跑并产出配对机器可读摘要。
「实验只改变声明变量」由代码审计强制，不再依赖约定自觉。

## 2. 语义要点

- **声明扰动两种**（07 §7.3）：
  - `param`：配置字段相对扰动 `value × (1+δ)`；叶子路径 diff 审计
    `changedPaths` 必须恰为声明 field（违反即 INVARIANT_VIOLATED）；
    `population.*` 段拒绝（仅初始化语义，对检查点后续无效果）；
  - `wealth_absolute`：每个存活者 `value += ΔValue`（Value=0 也加），输入状态经
    `cloneSimState` 克隆隔离，不被修改。
- **克隆一致性**（07 §7.2）：两侧都从同一 `captureSnapshot` 的 `restoreSnapshot` 结果
  构造，克隆前哈希一致由构造保证并以单测固定（快照 round-trip 不改权威哈希）。
- **无效扰动**（07 §7.4）：round-trip 后 configHash/权威哈希不变 → `applied=false`、
  `invalid=true`，不产出 treatment 侧结论，不得报告为「无敏感性」。
- **首次偏离**：逐 tick 对比两侧 stats 行，`firstDivergenceTick` 是第一条不同 stats 行的
  tick（null = 检查点后全程一致，允许——小扰动可被离散阈值吸收）；事件级翻转与
  首次结构指纹偏离属 P6-03 实验分析。
- **确定性**：同一配对重复执行逐字一致（单测）；RNG 无状态寻址保证除声明变量外
  所有输入一致（07 §7.6 配对口径）。
- **摘要**：`perturbation-summary-v1` 含任务列表回显、逐对
  `{checkpointStateHash, declared, baseline, treatment, firstDivergenceTick, invalid}`。

## 3. 边界（07 §7 剩余项归属）

- 幅度阶梯（1e-6/1e-4/1e-2）扫描、≥30 配对种子、首次**事件翻转** tick 与首次结构
  指纹偏离 tick → P6-03 实验层（本入口提供 raw 配对数据）。
- 「固定决策日志重放」与「策略重跑」分开运行（07 §7.7）→ 前者已由 P2-06
  `ReplayPolicy` 支撑，接进微扰入口待 P5-02 live 管线一起设计。
- 微扰 run 的 kill 恢复走 P5-03 的 run 内检查点时，treatment 的起点是扰动后状态，
  检查点恢复语义需在 P6-03 开工前验证（当前微扰入口为一次性同步执行）。

## 4. 验证证据

- `test/unit/runner/perturbation.test.ts` 11 项：diff 审计、字段守卫（未登记/非数字/
  population.*）、哈希变化与克隆隔离、克隆前哈希一致、确定性逐字一致、checkpointTick
  越界、批处理摘要与 invalid 计数。
- 全套门禁：typecheck/typecheck:core/lint/format/test（626）/build 全绿。
