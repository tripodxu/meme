# 0002 P2 决策层以实验目录形式留在仓库

- 状态：superseded by 0003（2026-11-04 G1.5 通过并启动 P2，见 `changes/0014`/`0015`）
- 日期：2026-11-03
- 决策者：架构负责人（依据 `docs/01-implementation-plan.md` §1 阶段门禁）
- 相关任务：P2-01~P2-04、G1.5
- 取代/被取代：被 [ADR-0003](0003-p2-decision-layer-production.md) 取代

> **后续（2026-11-04）**：G1.5 已通过 W4 确认轮（k=2 ARI median/min 1.000），
> P2 已启动；本 ADR 的「删除 experimental 目录」条件已触发，决策见 ADR-0003。

## 背景

`067b1db` 在「清理」名义下把 1284 行 P2 决策层（`jev-client`、`live`、`policy`、`serialize`）
直接落进 `src/decision/`，而当时 P1.5 尚未通过 G1.5，`01 §1` 明文规定
「P1.5 未通过不得启动 P2–P6」。这批代码零生产引用、无测试被执行，
与「P1 已完成、进入 P2」的事实相反，属于阶段门禁被静默绕过。

`changes/0006` 已用 `git mv` 把它移到 `src/experimental/p2-decision/`，并新增
`test/unit/architecture.test.ts`：生产目录不得 import `experimental`，
`src/core` 不得运行时 import 外层（type-only 放行）。

剩下的是处置问题：彻底删除，还是保留为 experimental。

## 决策

**保留在 `src/experimental/p2-decision/`，不删除，但在 G1.5 通过前禁止接线。**

具体约束：

1. 生产层（`src/core`、`src/decision`、`src/runner`、`src/app`）不得 import 该目录；
   由 `test/unit/architecture.test.ts` 机器强制，违反即 CI 红。
2. `src/experimental/README.md` 与 `p2-decision/README.md` 必须写明
   「G1.5 未通过不得接线」与转入生产的条件，防止后来者误当既有能力使用。
3. 该目录不进入 `tsconfig.build.json` 的产物入口，不参与 `computeConfigHash` 与任何
   预注册 hash——它是死代码，不得影响证据链。
4. 下列任一情况发生时**删除**该目录（而非继续保留）：
   - G1.5 通过并正式启动 P2，届时按 01 §6 重新实现/接线，旧代码只能作参考；
   - 决策层契约（04）发生不兼容变更，旧实现已无法表达新契约；
   - 连续两个里程碑未启动 P2。
5. 复核触发条件写入 `01-implementation-plan.md` P2 段落，避免「保留」变成永久堆积。

## 备选方案

| 方案                   | 优点                     | 代价                                       | 未采用原因                                     |
| ---------------------- | ------------------------ | ------------------------------------------ | ---------------------------------------------- |
| 从工作树彻底删除       | 仓库最干净，无死代码歧义 | 丢弃 1284 行已成形的契约实现，恢复需翻历史 | 这些代码对 P2 有参考价值，删除收益低于恢复成本 |
| 保留在 `src/decision/` | 无需改 import            | 违反 01 §1 阶段门禁，且会被误认为生产能力  | 阶段门禁是硬约束，不能用「目录还在」绕过       |
| 拆到独立仓库/分支      | 主分支完全干净           | 需要额外仓库或长期分支，审计链割裂         | 单仓库审计更简单，边界可由测试强制             |

## 后果

- 正面：阶段门禁恢复为可检查事实；P2 已有代码不丢；边界由测试而非约定维持。
- 负面/限制：仓库含一份不执行的代码，需在 §4 条件下主动清理，否则会腐化。
- 需要新增或修改的测试：`test/unit/architecture.test.ts`（已加）；P2 接线时必须先删该守卫条目。
- 需要同步的文档与版本字段：`01 §1/§6`、`02 §2` 模块边界、`src/experimental/README.md`；
  不改变 `rulesVersion`/`engineVersion`。

## 兼容性

纯目录迁移，无生产行为变化，不影响 `configHash`、`preregistrationHash` 或任何 golden。
`067b1db` 之后再无生产代码引用这批模块。

## 验证

```bash
pnpm vitest run test/unit/architecture.test.ts
# 期望：生产目录 import experimental 时失败；src/core 运行时 import 外层时失败
grep -rn "experimental" src --include=*.ts | grep -v "^src/experimental/"
# 期望：仅 architecture.test.ts 与 experimental 内部自引用
```
