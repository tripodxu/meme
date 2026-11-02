# src/app

应用控制层。按 [01 实施计划](../../docs/01-implementation-plan.md) 预留，当前尚未实现。

计划模块：`run-controller`、`api-client`、`experiment`、`local-store`。

## 边界

- 负责编排：创建与取消运行、断点续跑、分块上传、本地草稿与实验任务调度。
- 不实现第二套规则；所有数值来自 `src/core`，决策来自 `src/decision`。
- 浏览器端存储只保存可恢复的控制器状态和元数据，完整日志走 API 与对象存储。
- 通过控制器视图模型向 UI 暴露数据；交互与视图模型契约见 [06 前端契约](../../docs/06-frontend-contract.md)。
