# 0106 审计发现与修复：`runSingle` 缺省策略静默回落 `RandomPolicy` 与 R5 脚本缺陷

- 日期：2026-11-24
- 关联：[0088](0088-rules-v16-p6-08-result.md)、[0089](0089-p6-09-two-regime-confirmation.md)、[0090](0090-p6-r4-calibration-g6-closure.md)、[0091](0091-rules-v17-p6-10-result.md)、[0092](0092-rules-v18-r2b-probe-result.md)、[0093](0093-p6-11-jev-prompt-causal-result.md)、[0100](0100-explore-r2c-hcg-result.md)、[0101](0101-p6-12-n1000-two-regime.md)、[0103](0103-p6-13-r4-n1000-result.md)、[0104](0104-p6-14-completed-60-live.md)、[0105](0105-r5-campaign-start.md)
- 影响：`src/runner/run-cell.ts`、`test/unit/runner/policy-wiring.test.ts`、10 个 `.mjs` 实验脚本；**不改变任何核心规则、schema 或 golden 哈希**

## 1. 根因

`src/runner/run-cell.ts` 原实现按如下三元链解析同步策略：

```ts
const policy: DecisionPolicy =
  options.policyImpl ??
  (options.policy === 'mock-weighted-v1'
    ? new MockPolicy()
    : options.policy === 'mock-weighted-v2'
      ? new MockPolicyV2()
      : new RandomPolicy());
```

在 TypeScript 源码与测试中，`RunOptions.policy` 为必填项，编译期会阻止缺省；但在未经过 `tsc` 检查的 `.mjs` 实验脚本中，自 2026-11-18 起多个脚本调用 `runSingle(cfg, seed, {})` 或 `runSingle(cfg, seed, { artifactSink })` 时漏传了 `policy: 'mock-weighted-v1'`。于是 `options.policy` 为 `undefined`，三元表达式静默落入 `else` 分支 **`new RandomPolicy()`**（`random-uniform-v1`）。

此外，`scripts/r5-campaign.mjs` 还存在第二处分发缺陷：微扰实验（`r5-pert-n200`/`r5-pert-n1000`）声明 `kind: 'pert'`，但 worker 线程仅判断 `task.kind === 'pair'`，导致 300 个微扰任务全部误走 `runSingleTask` 且 `analyzePert` 输出空 `groups: {}`。

## 2. 数值取证

对比真实执行 `mock-weighted-v1` 的 `P6-06`（`scripts/p6-05-cluster.mjs:707`，显式传入 `policy: design.policy`）与漏传 `policy` 的 `P6-09`/`P6-12`/`R5`：

| 实验 / 策略实际值                                        | A (`share=1, w=0`)                      | B–F (`share<1`)                         | 体制差异方向                                           |
| :------------------------------------------------------- | :-------------------------------------- | :-------------------------------------- | :----------------------------------------------------- |
| `P6-06`（真实 `mock-weighted-v1`，0066）                 | `P0=0.548, Mup=0.960, S=0.019, O=0.796` | `P0=0.000, Mup=0.011, S=0.319, O=0.240` | A 高流动开放，B–F 低流动闭合（`TV(P)=0.723`）          |
| `changes/0020`（显式 `random-uniform-v1`）               | —                                       | `P0=0.617–0.680, Mup=0.864–0.906`       | `random` 无条件 `descend` 压低阶级并拉高流动           |
| `P6-09` / `P6-12` / `R5`（漏传 `policy`，实跑 `random`） | `P0=0.985, Mup=0.631, S=0.257, O=0.672` | `P0=0.638, Mup=0.885, S=0.016, O=0.901` | 与 `0020` 的 `random` 特征完全吻合，方向与 `mock` 相反 |

进一步证实：`R5` 的 `r5-robust-policy` 中 `mock-weighted-v1`、`mock-weighted-v2` 与 `random-uniform-v1` 三组结果逐位一致（均静默落入 `RandomPolicy`）；`R4`（`p6-r4-closure.mjs`）与 `P6-13`（`p6-13-scale-r4-n1000.mjs`）中 Part A（微扰）显式传 `policy: 'mock-weighted-v1'`，但 Part B（全部 360 个消融 run）漏传 `policy` 实跑了 `RandomPolicy`。

## 3. 受影响历史实验清单（诚实披露，不改写原始归档）

- **全量实跑了 `random-uniform-v1`（非预注册 `mock-weighted-v1`）**：
  `P6-08`（0088）、`P6-09`（0089）、`P6-10`（0091）、`R2-B`（0092）、`R2-C`（0100）、`P6-12`（0101）以及 2026-11-22 启动的 `R5` VPS 批次（0105，且 `r5-pert-n200` 未执行微扰配对）。
- **部分受影响**：
  - `R4`（0090）与 `P6-13`（0103）：Part A 微扰吸收确实在 `mock-weighted-v1` 下成立；**Part B 五项消融实跑了 `random-uniform-v1`**，此前从未在真实 `mock-weighted-v1` 体制 II（`P0=0, Mup=0.011, S=0.319, O=0.240`）上验证五消融。
  - `P6-11`（0093）与 `P6-14`（0104）：主因果对照 `live(survival_hint) - live(neutral)` 经由 `runSingleWithPolicy`（`JevLivePolicy`）执行，**不受影响**（`passesCausalClaim=true` 结论有效）；仅 `mock` 对照臂实跑了 `RandomPolicy`。
- **不受影响**：`P1.5`（含 W4/W6）、`P6-01`、`P6-02`、`P6-03`、`P6-04a`、`P6-04b`、`P6-05`、`P6-05b`、`P6-05c`、`P6-05d`、`P6-05e`、`P6-06`、`P6-07` 均显式传递了策略。

## 4. 修复与防回归

1. **`src/runner/run-cell.ts` fail-closed**：新增 `resolveSyncPolicy()`，未传 `policyImpl` 时严格要求 `options.policy` 为 `'mock-weighted-v1' | 'mock-weighted-v2' | 'random-uniform-v1'` 之一，否则立即抛出 `StratifyError(CONFIG_INVALID)`，彻底杜绝静默回落。
2. **回归单测**：`test/unit/runner/policy-wiring.test.ts` 新增缺省与未知 `policy` 抛错断言。
3. **脚本修复**：为上述 10 个 `.mjs` 脚本补齐显式 `policy` 参数，并修复 `scripts/r5-campaign.mjs` 的 `task.kind === 'pert'` 分发分支。
4. **科学纪律**：不追认任何旧产物；真实 `mock-weighted-v1` 下的 G6 收口验证（两体制确认 + 微扰 + 五消融）必须以全新预注册与全新种子在上海 VPS 执行。
