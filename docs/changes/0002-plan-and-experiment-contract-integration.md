# 0002 计划、实验与可复现性契约整合

- 日期：2026-11-02
- 作者：徐鼎（评审与整合执行：Claude Code）
- 关联：[第二轮契约与架构评审](../reviews/2026-11-02-contract-architecture-review.md)
- 受影响版本：无代码/行为变更；`rulesVersion`、`CONFIG_SCHEMA_VERSION` 不变；新增 P1/P4 任务

## 变更

1. **阶段依赖**：P2-07 改为 VPS 直连真实冒烟；Worker 同源代理拆到 P4-08。P5-01 mock 批跑只依赖 P1，P6 的 mock 路径不再等待 P2。
2. **P1.5 证据**：批量核心放入 `src/runner`，固定报告字段；标签可达性改为六类（含顶层过重）；kill criteria 改为预注册参数网格 + 稳定聚类，不再用“3 个参数格”。
3. **聚类方法**：新增 07 §8.1，要求预注册特征向量、标准化、距离、算法、k 范围、稳定性（ARI≥0.70、最小聚类规模）；标签只作描述。
4. **运行时权威**：run identity 增加 `runtimeVersion`；ADR-0001 要求每个 hash domain 有字段级 canonical schema 与跨 Node/workerd/Chromium 向量，版本不匹配标 `nonAuthoritativeRuntime`。
5. **预注册完整性**：`preregistrationHash` 覆盖 `labelThresholdsHash`（新 domain `stratify-label-thresholds-v1`，P1-02 注册），不再只记录版本字符串。
6. **消融可表达性**：新增 P1-10 `openness.updateMode`（`dynamic|fixed`），O 固定消融不再用极大 τO 近似；开关进入 configHash/paramsHash。
7. **批量规模**：扫描分 Stage A（40/200 人×730 tick×30 种子）与 Stage B（1000 人×3650 tick 仅确认）；确认 run 需全分辨率 metrics 或 `statsStride=1`。
8. **artifact profile**：新增 `artifactProfile=full|metrics-only` 与 R2 `metrics-v1`；`metrics-only` 可省略 decisions/events，但 `replayable=false`，complete 按 profile 核对。
9. **契约一致性**：统一参数简写/路径（03 §3 符号表），清掉正文中的 6/4/0.02/50% 等硬编码；固定结构判异 `C=5` 与窗口/分位；修正 guide 表格公式；明确 O 的 `lastOpennessUpdateTick`、Jev 成本净额与 stale 行动不占用目标。

## 兼容性

本轮只改计划与契约文档，未改代码或默认配置，`configHash/paramsHash` 与 160 个测试不受影响。P1 实现时必须按新增 schema/开关/artifact profile 落地；旧本地文件缺少 `runtimeVersion`/`artifactProfile` 时不得标为权威或可回放。

## 实验可比性

`labels-v3` 仅在 `C=5`、`metrics.flowWindowDays=365`、`metrics.mobilityWindowDays=365`、`metrics.topWealthShareFraction=0.1` 下有效；改变这些值必须升级标签版本/hash 并重新预注册，不得与旧结果混比。

## 验证

- `pnpm check:docs`、`pnpm format` 通过。
- 未运行代码测试：本轮无 `src/` 变更；P1 实施时补 hash schema、runtime matrix、O 固定开关、metrics-v1 与聚类稳定性测试。
