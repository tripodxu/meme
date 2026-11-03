# src/decision

决策策略层。**P1.5 实际使用**：`mock`（`mock-weighted-v1`）与 `random`（`random-uniform-v1`）；
两者由 `src/runner/run-cell.ts` 直接调用，产出 `decision-v1` 记录。

`types.ts` 是策略层共享契约（`DecisionRecord`/`DecisionInput`/`FallbackReason`/`PromptStyle`），
生产与实验模块共用。

## 已迁出

`policy`/`serialize`/`jev-client`/`live`（P2-03~05 脚手架）已移入
[`src/experimental/p2-decision`](../experimental/p2-decision/README.md)：
它们实现超前于 G1.5 闸门，此前曾以「清理未用变量」的提交夹带进 `src/decision/`，
在仓库内零引用。隔离后仍可测试，但生产路径无法导入。

## 边界

- 只读取 `src/core` 暴露的只读视图与合法行动枚举，不修改核心状态，也不重新计算财富、胜率、阶级、寿命或网络。
- 只在代码枚举的行动中选择：`accumulate`、`ascend`、`descend`、`compete:<agentId>`；禁止从模型文本中解析或拼接行动。
- 真实调用必须带超时、有限重试、取消、预算和失败熔断；失败时走确定性 fallback，不得静默改变规则。
- 密钥只从运行时环境注入，不写入数据库、fixture 或日志。
- 契约见 [04 Jev 决策协议](../../docs/04-jev-decision-contract.md)，模块边界见 [02 架构](../../docs/02-architecture.md)。
