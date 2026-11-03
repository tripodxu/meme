# src/experimental/p2-decision

P2 决策层（P2-03~05）脚手架：Jev 请求构造、prompt 序列化、策略接口与 live 适配。

## 状态：未接线，不得用于正式实验

`docs/01-implementation-plan.md` §1 规定「P1.5（G1.5）未通过前不得启动 P2–P6」，
当前 G1.5 尚未通过（见 `docs/reviews/2026-11-03-zcodes-nightly-audit.md`）。
本目录因此被隔离在 `src/experimental/`，**生产路径零引用**：

- `src/runner/run-cell.ts` 只使用 `src/decision/mock.ts` 与 `src/decision/random.ts`；
- `scripts/*.mjs` 只使用 dist 下的 runner 与 core；
- 这些文件不进入 `pnpm typecheck:core`。

## 迁出条件

1. G1.5 判定通过并记录在 `docs/reviews/`；或决策层负责人书面确认 P2 可先行；
2. 接入 runner 时必须有真实调用预算、超时、重试、取消与熔断，失败走确定性 fallback；
3. 补齐接线测试（改变 policyVersion 必须改变决策记录与产物），并在 `docs/changes/` 登记；
4. 迁移回 `src/decision/` 时同步更新 `src/decision/README.md` 与 02 §架构的模块图。

## 与 `src/decision/` 的关系

`src/decision/` 保留 P1.5 实际使用的 `mock`/`random` 策略与共享类型 `types.ts`。
本目录从那里导入 `DecisionRecord`/`FallbackReason`/`PromptStyle` 与 `POLICY_VERSION_MOCK`，
不反向依赖。
