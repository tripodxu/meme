# src/ui

浏览器界面层（原生 DOM/SVG，不引入框架）。按 [01 实施计划](../../docs/01-implementation-plan.md) 预留，当前尚未实现。

计划模块：`setup`、`dashboard`、`agent-inspector`、`charts`、`replay`。

## 边界

- 只通过 `src/app` 的控制器与视图模型读写，不直接修改 agent 状态或调用决策层。
- 回放只消费快照、事件流与 manifest，不重跑规则，也不自行推断权威状态。
- 交互、错误恢复与可访问性要求见 [06 前端契约](../../docs/06-frontend-contract.md)。
