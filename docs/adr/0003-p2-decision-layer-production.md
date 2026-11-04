# 0003 P2 决策层迁回生产路径

- 状态：accepted
- 日期：2026-11-04
- 决策者：规则/架构负责人（用户确认「确认并启动 P2」）
- 相关任务：P2-01~P2-06、G1.5
- 取代：[ADR-0002](0002-p2-decision-layer-stays-experimental.md)（其「G1.5 通过即删除 experimental 目录」条件已触发）

## 背景

ADR-0002 规定：G1.5 通过并正式启动 P2 时，删除 `src/experimental/p2-decision/`，
并按 `01 §6` 重新实现/接线，旧代码只能作参考。

2026-11-04 W4 确认轮按预注册协议通过 G1.5（`changes/0014`：k=2 ARI median/min 1.000、
temporalConsistency 1.000、两区域 A vs B∪C），P2 已获准启动。因此需要处置
`src/experimental/p2-decision/` 的 1284 行实现与 434 行测试。

## 决策

**把 `policy`/`serialize`/`jev-client`/`live` 迁回 `src/decision/`，保留其测试，
并在 `src/runner/run-cell.ts` 增加 Policy 驱动的接线路径；不重写实现。**

具体：

1. `git mv` 四个模块到 `src/decision/`，测试迁到 `test/unit/decision/p2-decision.test.ts`；
   import 只做路径调整，不改变实现语义。
2. `src/decision/policy.ts` 的 `DecisionPolicy` 成为生产策略接口；
   `mock`/`random`/`live` 都实现该接口，runner 通过接口调用，核心不感知 HTTP。
3. 保留 `test/unit/architecture.test.ts` 的 `src/experimental` 隔离守卫——
   它现在保护未来的实验代码，而不是本模块。
4. 真实 Jev 调用仍必须满足 04 §6/§7（超时、有限重试、取消、预算、熔断、确定性 fallback）；
   密钥只从运行时注入，不落日志/URL/产物。
5. P2-07 真实冒烟（VPS 直连）不在 CI 运行，需独立低预算密钥；本轮只交付可注入的客户端与冒烟脚本。

## 为什么不是「删除后重写」

- ADR-0002 的删除条件针对的是「未获准启用的死代码」；G1.5 通过后，同一实现已具备
  生产资格，重写不会带来证据或契约上的改进。
- 该实现已有 434 行测试（故障注入、预算、熔断、序列化、状态哈希、非法响应），
  删除会丢失这些回归资产；`git mv` + 接线测试能把「可测试」升级为「已接线」。
- 版本轴与证据链不受影响：`policyVersion` 仍为 `jev-choice-v1`/`mock-weighted-v1`/`random-uniform-v1`，
  预注册 hash 与 P1.5 产物不因目录移动而改变。

## 后果

- `src/decision/` 成为唯一策略层；`src/experimental/` 留空目录与 README，供未来实验使用。
- `src/decision/README.md`、`02 §模块边界`、`01 §5 P2` 同批更新；`changes/0015` 记录迁移。
- 接线测试必须证明：更换 Policy 会改变决策记录与执行结果；live 失败走确定性 fallback；
  mock/random 的现有 P1.5 行为不变。
