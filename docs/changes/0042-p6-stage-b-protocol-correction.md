# 0042：P6-01 Stage B 判读口径纠正——主指标 TV(P) 未达门槛，两个「确认」改判未确认

- 日期：2026-11-05
- 作者：Runner/实验负责人（审查后纠正）
- 关联：P6-01（01 §9）、07 §8/§9、changes/0039–0041
- 性质：**判读口径纠正与重算**；不修改规则、引擎、参数或预注册 run 数据，不新增 run

## 1. 问题

三份 Stage B 预注册的 `manifest.primaryMetric` 均为 **`TV(P)`**，`differenceThresholds.tv = 0.10`。
但 `scripts/p6-stage-b.mjs` 的旧判读实现与 07 §8 不一致：

- `anyThreshold` / `ciOk` 扫描 w2b 与 w3 的全部 6 个指标，任意指标、任意窗口超门槛即可；
  07 §8 第 1 条要求**预注册 primary metric** 达门槛，不能靠事后挑选的次要指标；
- `directionOk` 对空集合返回真（真空真），w3 单独触发时可绕过 w2b 主窗口；
- `ci95` 在 n=30 时取 `[min, max]`，不是 07 §9 要求的 bootstrap 95% 区间；
- `confirmed` 未校验 60/60、30 对、缺窗口等完整性条件。

因此 env0=expanded / env0=compressed 的「确认通过」实际由次要指标 Gini 触发，
而主指标 TV(P) 从未达到 0.10。按 07 口径，这两个判定不成立。

## 2. 重算（w2b，30 配对种子，固定分析 seed，10,000 次 bootstrap）

| 单元            | 主指标 TV(P) 中位数 | bootstrap 95% 区间 | 门槛 | 主指标 | 次要指标 Gini | Gini 门槛 | 旧判   | 07 重算 |
| --------------- | ------------------- | ------------------ | ---- | ------ | ------------- | --------- | ------ | ------- |
| env0=expanded   | 0.0647              | [0.0574, 0.0692]   | 0.10 | ❌     | +0.0339       | 0.03      | 确认   | 未确认  |
| env0=compressed | 0.0560              | [0.0528, 0.0571]   | 0.10 | ❌     | −0.0433       | 0.03      | 确认   | 未确认  |
| crossDays=half  | 0.0043              | [0.0038, 0.0052]   | 0.10 | ❌     | −0.0105       | 0.03      | 未确认 | 未确认  |

完整性均为 60/60、30 对、0 灭绝/回退/缺窗口；env0 两单元 100% 超出 baseline 波动带，
crossDays=half 为 0%。**严格按 07 §8，三个单元均为未确认（0/3）。**

## 3. 预注册口径冲突

三份 manifest 的 `hypothesis` 写有「主指标 TV(P) ≥ 0.10 **或其他预注册指标超门槛**」。
该「或其他」与 07 §8 第 1 条冲突：若按宽松文本读，env0 两单元可由 Gini 判确认；
若按 07 严格读，两者均未确认。按 AGENTS「规则冲突时暂停并澄清，不得静默选择有利口径」：

- 本记录**不**把 env0 两单元记为确认，状态为「未确认（预注册口径待裁决）」；
- 在裁决前，不得在任何文档、发布或对外表述中声称 Stage B 已确认；
- 裁决须以 ADR 或独立变更记录明确 primary metric 的唯一口径，再决定是否按新口径
  重新冻结并重跑，不能用现有产物事后放宽。

## 4. 代码与产物变更

- 新增 `src/runner/p6-analysis.ts`：07 §8/§9 判读纯函数（主指标、w2b、
  bootstrap 10,000、符号翻转置换检验、完整性、波动带）；w3 仅作相邻窗口描述。
- `scripts/p6-stage-b.mjs --analyze` 改用该模块，优先读取已入库 slim 产物；
  预注册哈希改为读取冻结文件并记录一致性，不再当场重算自证。
- 新增 `test/unit/runner/p6-analysis.test.ts`（8 项）覆盖主指标优先、w3 不参与确认、
  完整性失败、口径冲突标记、bootstrap 非 [min,max] 等。
- 重算并替换三个 `out/p6-stageB-analysis-*.json`（`schemaVersion` 变为
  `p6-stageB-analysis-v2`；`confirmed` 全为 false）。
- 不改变 `rules-v11` / `engine-v0.9.0` / `stratify-config-v6` / 任何 `configHash`；
  已有 60-run 产物仍是有效运行证据，只是判定结论更正。

## 5. 影响与后续

- `docs/README.md`、`AGENTS.md` 的 Stage B 状态改为「3 个已判读、0 个按 07 主指标确认」；
- 两份 env0 research 报告加更正横幅，原「确认通过」结论撤回；crossDays=half 维持未确认；
- `docs/reference/artifacts.md` 更新三个 analysis 产物的 sha256 与描述；
- P6-01 仍未完成，G6 仍未通过；剩余 3 个单元不因本次纠正获得任何确认；
- 下一步：先裁决 primary metric 口径，再决定是否以修正后的预注册重跑 Stage B。
