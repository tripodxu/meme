# 0078 浏览器 live（同源 BYOK 代理）

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/04、docs/05 §4.1、docs/06、docs/11、changes/0071/0073
- 性质：前端能力接入；不改规则、参数或实验结论
- 影响范围：`src/app`、`src/ui/workspaces/setup.ts`、`src/decision/jev-client.ts`、`vite.config.ts`、测试与文档

## 1. 交付

- `src/app/live-policy.ts`：浏览器 live 策略工厂。
  - 端点固定为当前 origin 的 `/api/jev`（测试可注入），用户不能填写任意 URL；
  - Key 只在内存与 `Authorization` 头，不写 localStorage/IndexedDB/bundle/日志；
  - 预算 `maxCalls`/`maxInputTokens`、run 截止 `maxRunMinutes`、熔断与回退率窗口全部启用；
  - `jitterMs=0`，不引入 `Math.random()`；超时 30s、最多 2 attempts、网络重试 1 次。
- `resolveEndpoint` 允许 **loopback http**（localhost/127.0.0.1/::1），便于本地
  Vite 代理；远程 `http:` 仍拒绝，避免 Bearer Key 明文出网。
- `RunController` 支持 `policy='jev_live'`：
  - `prepare(..., live?)` 注入内存 Key/模型/预算；缺失 Key 返回配置错误；
  - snapshot/导出 bundle 不含 Key；导出 live bundle 的 `policy='jev_live'`；
  - 导入/回放 live bundle 使用保存的 `selectedAction`，不要求重新提供 Key，
    回放模式 `jev_replay`。
- 设置页启用 `jev_live`：密码输入 Key（不回显）、模型、最大调用数、最大 input
  token、最长运行分钟；切换到 live 时显示真实费用与停止语义警告。
- `vite.config.ts` 增加 `/api` → `http://127.0.0.1:8787` 本地代理；生产由
  Static Assets + Worker 同源提供 `/api/jev`。

## 2. 验证

- `test/unit/app/live-policy.test.ts` 3 项：
  1. 空 Key / 非法预算拒绝；
  2. `runSingleWithPolicy` 仅向注入端点 POST，`Authorization: Bearer <key>`，
     URL/body 不含 Key，决策非 fallback，预算计数增加；
  3. 控制器 snapshot/exportBundle 序列化不含 Key。
- `test/e2e/p3-web.e2e.test.ts` 新增 1 项：选择 `jev_live` 显示 password 字段，
  Key 只留在 `app.liveApiKey`，不进入 snapshot/localStorage/sessionStorage；
  切回 mock 后字段消失。
- 未调用真实 Jev：没有可用的 live 冒烟 Key；代理本身已有 mock 上游单元测试。

## 3. 未完成 / 边界

- **真实浏览器 live 冒烟未执行**；不得声称 `/api/jev` 已对真实上游验证。
- 浏览器 runtimeVersion 与 Worker 不同，创建云端 run 时会标记 non-authoritative
  （ADR 0001）；浏览器 live 结果不能直接混入 Node runner 正式对照。
- 未实现 Worker 全局保险丝/跨用户配额；当前只有 IP 限流与 run 内预算。
- 未限制 live 规模到 06 建议的 40 人/730 tick/interval 30 的硬门禁；设置页仅静态
  估算与警告，超限仍可启动。
- 不改 `rulesVersion`/`schemaVersion`/`promptVersion`；不构成校准或结构证据。
