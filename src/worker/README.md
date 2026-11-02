# src/worker

Cloudflare Worker API。按 [01 实施计划](../../docs/01-implementation-plan.md) 预留，当前尚未实现。

计划模块：`routes`、`db`、`middleware`、`maintenance`、`index`。

## 边界

- 只做协议、鉴权、配额与存储编排，不在请求内执行大规模长循环或完整模拟；批量模拟由 `src/runner` 完成。
- D1 只存可查询的元数据与聚合；完整日志和产物写 R2，并以 manifest 与 hash 校验。
- 与浏览器共享的请求/响应 schema 必须来自同一契约，禁止在 Worker 内复制规则逻辑。
- 契约见 [05 API 与数据契约](../../docs/05-api-data-contract.md)，运维见 [09 发布与运维](../../docs/09-deployment-operations.md)。
