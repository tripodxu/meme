# src/decision

Jev 决策适配层。按 [01 实施计划](../../docs/01-implementation-plan.md) 预留，当前尚未实现。

计划模块：`legal-actions`、`serialize`、`policy`、`jev-client`、`mock`、`replay`、`fallback`。

## 边界

- 只读取 `src/core` 暴露的只读视图与合法行动枚举，不修改核心状态，也不重新计算财富、胜率、阶级、寿命或网络。
- 只在代码枚举的行动中选择：`accumulate`、`ascend`、`descend`、`compete:<agentId>`；禁止从模型文本中解析或拼接行动。
- 真实调用必须带超时、有限重试、取消、预算和失败熔断；失败时走确定性 fallback，不得静默改变规则。
- 密钥只从运行时环境注入，不写入数据库、fixture 或日志。
- 契约见 [04 Jev 决策协议](../../docs/04-jev-decision-contract.md)，模块边界见 [02 架构](../../docs/02-architecture.md)。
