# 0003 P1 确定性核心落地

- 日期：2026-11-03
- 类型：新增能力（不改变既有契约的对外语义）
- 关联提交：P1-01 至 P1-10 系列提交（见 `docs/01-implementation-plan.md` §4 完成记录）

## 变更内容

1. **P1-01 可寻址随机源**：`R(seed,tick,agentId,eventTag,counter)`（SHA-256 长度前缀 + 高 53 位）与标准抽样（均匀索引、Fisher–Yates、加权、Box–Muller、有界拒绝截断分布）。`NUMERIC_CONSTANTS` 新增 `TWO_PI`、`REJECTION_ATTEMPT_LIMIT`（超限抛 `invariant_violated`）。
2. **P1-02 状态与哈希**：`SimState`（`stratify-state-v1`）、`decodeSimState` 导入边界校验（含 `configHash/paramsHash` 重算一致）、`initialPopulationHash`（agents+ties+seed）、`authoritativeStateHash`、`stratify-label-thresholds-v1` domain（labels-v3 阈值表）、全部 12 个 hash domain 的字段级 canonical 输入 schema、`RunIdentity/Ruleset` 类型。
3. **P1-03/P1-10**：合法行动枚举（固定排序 `accumulate<ascend<descend<compete`、净额费用含重返减免档位与开放度乘子、竞争候选两地址无放回抽样）、`mock-weighted-v1`/`random-uniform-v1` 策略、`openness.updateMode`（`dynamic|fixed`）进入 RunConfig/校验/注册表/`configHash/paramsHash`。
4. **P1-04–P1-07 引擎**：A→H 固定管线、事件日志（`stratify-event-v1`，seq 为 tick 内序号，`wealth_changed/class_ascended/class_descended/competition_resolved/agent_died/action_invalid/network_rewired`）、`ExecutionRecord` 分离记录、被动跌落最低层 streak 钳制、寿命损耗与死亡、网络重构（恢复旧边语义）、调整后 S、365 日 Mup/Mdown、慢变量 E/O 更新（`fixed` 时跳过 O 块）、`extinct/scheduled` 终态。
5. **P1-08 快照与回放**：`stratify-snapshot-v1`（stateHash 校验）、决策日志回放只使用 `selectedAction`、微扰克隆。
6. **P1-09 基准**：`scripts/benchmark.mjs`（40/200/1000 人 × 3650 tick mock），结果存 `docs/benchmarks/`。

## 实现澄清（不改变规则语义，均已在代码注释标注）

- 网络初始化的度目标取 `min(initialDegree, maxDegree)`，防止 `initialDegree > maxDegree` 时违反度上限不变量（03 §3.1 未禁止该组合）。
- 初始宏观值在网络初始化完成**之后**计算，使 `S/edgeCount` 与初始网络一致（03 §4.3 步骤 6/7 顺序的实现澄清）。
- 事件 `seq` 为 tick 内序号，与 `tick` 组成全局排序键；符合 04 §3.2 `recentEvents` 按 `(tick,seq)` 取最近 5 条的口径。
- `stratify-state-v1` 序列化包含 `configHash/paramsHash`，导入时重算校验一致，拒绝被篡改或跨配置拼接的状态。

## 兼容性与实验可比性

- 不存在旧版本仿真结果，无迁移负担。
- `configHash/paramsHash` 因 `openness.updateMode` 新增而变化（默认配置 `aaab5b…`/`2a0be8…`），golden fixture 已同步。
- 权威哈希承诺仍按 ADR-0001 仅限同版本 V8 运行时。
