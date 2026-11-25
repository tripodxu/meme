# 0067 rules-v15：个体行为异质性（D2）

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0007、ADR 0006、changes/0066
- 性质：**新机制 + 版本升级**；默认配置与 rules-v13/v14 逐位一致
- 影响范围：`src/core`、`src/decision`、`src/runner`、`test/`、`docs/`、`out/p6-07-*`

## 1. 变更内容

### 1.1 个体特质

新增不可变 `riskTolerance` / `crossClassOpenness ∈ [0,1]`，由
`(config, seed)` 经 `init_risk_trait` / `init_cross_class_trait` 地址派生；
`sigma=0` 时恒为 `0.5`。特质进入初始人口哈希与权威状态，不进入结算公式。

### 1.2 `mock-weighted-v2`

在 v1 权重上只改写 `compete` 权重：

```text
w = w_v1 × exp(θrisk×(riskTolerance−0.5) + θcross×(crossClassOpenness−0.5)×跨层)
```

敏感性为 0 时与 v1 逐位一致；默认策略仍是 `mock-weighted-v1`。

### 1.3 版本

- `rules-v15`（v14 仅为 G6 目标修订，无结算语义变化）
- `engine-v0.12.0`
- `stratify-config-v9`（v8→v9 补 `behavior` 四个 0）
- `stratify-state-v5`（v3/v4→v5 缺特质按 0.5 迁移）
- `mock-weighted-v2`

## 2. 参数

| 参数                                    | 默认 | 域     |
| --------------------------------------- | ---- | ------ |
| `behavior.riskTraitSigma`               | 0    | [0,1]  |
| `behavior.crossClassTraitSigma`         | 0    | [0,1]  |
| `behavior.riskCompeteSensitivity`       | 0    | [0,10] |
| `behavior.crossClassCompeteSensitivity` | 0    | [0,10] |

四个参数均有注册表定义、接线测试，并进入 `configHash` / `paramsHash`。

## 3. 兼容性

- 旧配置 v1–v7 继续沿迁移链升级到 v9；v8 直接补 `behavior` 默认值。
- 旧状态 v3/v4 可解码，特质按 0.5 迁移；v5 状态必须显式携带特质。
- 旧 `configHash`/`stateHash` 不再与新版本相同（schema 与 `behavior` 字段变化）；
  旧 ledger 不得与新版本逐字节比较。
- 默认 `behavior=0` 且策略为 v1 时，结算轨迹与 rules-v13/v14 相同；
  仅版本信封与状态字段不同。

## 4. 测试与 golden

- 新增：特质初始化确定性 / `sigma=0 → 0.5`、v2 零敏感性等价 v1、
  风险与跨层敏感性改变竞争概率、v8→v9 配置迁移、v4→v5 状态迁移、
  v2 接线轨迹等价。
- 更新：config fixture `default-rules-v15.json`、engine golden
  `mock-run-rules-v15.json`、参数定义快照（98 项）、own-parity 排除
  新增特质字段。
- 全量门禁：`pnpm typecheck`、`pnpm test`（812+）、`pnpm lint`。

## 5. 实验

P6-07（探索，非 G6 确认）：6 个行为异质性 cell × 30 个全新 seed ×
40 人 × 10950 tick，`mock-weighted-v2`；每 cell 前 10 续跑 14600。
A 为全零对照，B 为“有特质方差但不读取”的安慰剂，C–F 逐步打开风险/
跨层敏感性。结果单独记录于 changes/0068（或后续编号）。

**不得**据本轮声称 G6 通过、参数已校准或结构已涌现；D1 目标与
`docs/07` §8.2 不变，旧 P6-06 结果不追认。
