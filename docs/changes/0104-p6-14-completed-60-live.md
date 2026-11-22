# 0104 P6-14 扩大规模 live 对照完成（60/60 live）

- 日期：2026-11-22
- 关联：[0093](0093-p6-11-jev-prompt-causal-result.md)、[0099](0099-p6-14-paused-jev-quota.md)、[ADR 0013](../adr/0013-p6-11-jev-prompt-causal.md)
- 影响：实验结论；无代码、规则或 schema 变更

## 执行

- 实验 `p6-14-c6e7eff3`，预注册与 P6-11 相同设计：30 对同种子、每对
  `mock-weighted-v1` + `jev_live`（neutral / survival_hint），目标 60 个 live run。
- 2026-11-22 08:05 CST 由 VPS cron 按预约自动续跑（见 0099），从 ledger 与检查点
  继续，16/16 剩余 live run 全部完成；`--run` 只执行，不写 analysis，随后用
  `--analyze` 基于已有 ledger/raw 离线生成 `out/p6-14-jev-causal-analysis.json`。
- 结果：90 个有效 run（30 mock + 30 neutral + 30 survival_hint）、0 排除；
  30 个配对 seed；单一服务端模型 `jev-1.13-free`；最大回退率 4.51%（上限 20%）；
  21 条历史 failed ledger 行是配额期的重试记录，最终 30 个 seed 全部有效。

## 因果结果

| 指标  | 中位数  | 95% CI             | 置换检验 p | BH q    | 门槛 |
| ----- | ------- | ------------------ | ---------- | ------- | ---- |
| ΔO    | −0.3943 | [−0.4394, −0.3523] | 0.00005    | 0.00006 | 过   |
| ΔS    | +0.2579 | [+0.2253, +0.2837] | 0.00006    | 0.00006 | 过   |
| ΔMup  | −0.4124 | [−0.4623, −0.3692] | 0.00005    | 0.00006 | 过   |
| ΔG    | −0.0163 | [−0.0198, −0.0078] | 0.00033    | —       | 未过 |
| TV(P) | 0.0262  | [0.0189, 0.0368]   | —          | —       | —    |

`passesCausalClaim=true`：survival_hint 相对 neutral 显著压低开放度、抬高隔离度、
压低向上流动性；ΔG 未达预注册阈值，仅作描述。

## 复算校验

在 VPS 上用同一 ledger/raw 再次执行 `--analyze`，输出文件与正式 analysis
**逐字节相同**（`sha256=f13fcbe2a8b5db281d94f1349aa3ee4977f10ca470f12af5c45964230d6a7a9d`），
bootstrap/置换检验的 analysis seed 均取自预注册，结果可离线复现。

## 边界

- 请求模型 `jev-1.13-free`，实际返回也是 `jev-1.13-free`，本实验没有 P6-11 的
  模型名偏离；`TV(P)` 仍是阶级份额距离，不是行动概率距离。
- 该实验验证的是 Jev 提示词（生存提示）的宏观因果效应，**不关闭 G6**；
  P6-13 的消融仍未过结构退化门槛（changes/0103），G6 保持未通过。
- 原始产物：`out/p6-14-jev-causal/ledger.ndjson`（111 行，含历史 failed 重试）、
  `raw/`、`checkpoints/`、`out/p6-14-jev-causal-analysis.json`。
