# 0095 Worker complete 复算 expectedDueDecisions（2026-11-20）

> 状态：工程契约补强；不改规则、schema 或科学判据。

## 0. 问题

`POST /api/runs/:id/complete` 此前只复算 tick 行数与 agent 行数，并校验
`artifactManifestHash`；`expectedDueDecisions` 由客户端自报后原样写入
`complete_json`。这意味着一个少报到期决策数的上传包可以通过 complete，
后续独立验证才发现行数不符，服务端未能尽早拒绝。

## 1. 变更

complete 在行数校验之后新增复算：

```text
expectedDueDecisions = Σ_{t % decisionInterval = 0, 0 ≤ t ≤ finalTick}
                       |{ agent | death_tick IS NULL OR death_tick >= t }|
```

- 决策发生在 tick 开头、死亡在其后结算，因此 tick `t` 的期初存活集合
  正是 `death_tick >= t`（`NULL` 表示活到最后）。
- 数据源是已上传的 `agent_final`，不依赖 `tick_stats` 的采样步长；
  `full` 与 `metrics-only` 两种 profile 均可复算。
- 不一致返回 `409 state_conflict`，错误信息同时给出声明值与复算值。

## 2. 测试与影响

- `test/unit/worker/api.test.ts`：complete 声明错误的到期数返回 409；
  helper 按「存活数 × 决策 tick 数」计算正确值。
- `test/unit/runner/uploader.test.ts`：bundle fixture 的
  `expectedDueDecisions` 改为与服务端复算一致；上传器全链路测试继续通过。
- 全套 920 项测试通过，核心分支覆盖 95.18%；无 schema 迁移。
- 已 completed 的历史 run 不受影响；新 complete 请求才会走复算。
