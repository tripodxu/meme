# 0079 浏览器 live 规模门禁与 Jev 全局保险丝

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：docs/06 §live、docs/09、docs/11、changes/0078
- 性质：工程加固；不改规则、参数或实验结论
- 影响范围：`src/worker`、`src/app/live-policy.ts`、`src/ui`、测试与文档

## 1. 交付

- Worker `/api/jev` 在 IP 限流之外增加**全局小时保险丝**：
  `rate_limits` bucket `jev:global`，默认 1000 次/小时，可用
  `JEV_GLOBAL_HOURLY_LIMIT` 覆盖；耗尽返回 429 `rate_limited`
  （“Jev 代理全局小时配额已耗尽”）。IP 与全局计数都在发起上游请求前完成。
- 浏览器 live 规模门禁（docs/06）：超过建议上限（40 人 / 730 tick /
  决策间隔 30）时，设置页显示确认复选框；未勾选时 `start()`/`step()` 被阻止，
  显示提示且不创建 run。修改配置或策略会重置确认状态。
- `src/app/live-policy.ts` 导出 `LIVE_SUGGESTED_LIMITS` 与
  `exceedsLiveSuggestion(config)`，供 UI 与测试共用同一口径。

## 2. 验证

- `test/unit/worker/api.test.ts` 新增：全局 bucket 计数耗尽 → 429，且不调用上游。
- `test/unit/app/live-policy.test.ts` 新增：建议内/外三种超限组合。
- `test/e2e/p3-web.e2e.test.ts` 新增：50 人 live run 未勾选确认时 `start()` 保持
  `idle` 并显示提示；勾选后 `liveScaleConfirmed=true`；Key 不进入 snapshot。

## 3. 未完成 / 边界

- 全局保险丝是固定小时窗口，不是分布式令牌桶；多实例下 D1 计数是唯一协调点。
- 规模门禁是**显式确认**而非硬拒绝；用户仍可在确认后运行超建议规模。
- 真实 Jev live 冒烟未执行；不得声称上游已联调或费用已实测。
- 不改 `rulesVersion`/`schemaVersion`/`promptVersion`；不构成校准或结构证据。
