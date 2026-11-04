# 0017：descend 触发条件探针——策略敏感性来源

- 日期：2026-11-04
- 作者：核心/规则负责人（用户要求「继续做下一步」）
- 关联：分叉探索（`changes/0016`）、复制轮（`research/2026-11-04-p15-bifurcation-replication.md`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、生产策略或 G1.5/P6 判定

## 1. 变更

1. **探索层 RNG tag**：`RNG_EVENT_TAGS.exploreDescend = "explore_descend"`，仅用于
   `scripts/p15-descend-threshold.mjs` 的加权抽样；不进入生产策略，不复用
   `mock_action`/`random_action` 的地址语义。
2. **探针脚本**：新增 `scripts/p15-descend-threshold.mjs`，固定 mock 的
   accumulate/ascend/compete 权重，只扫描 descend 权重 `d`；路径与分叉实验一致
   （up/down/control，`share=0.5`、`w_mid=25`、ic-middle、1825+1825 tick、
   5 个 `p15d-*` 种子）。支持两档触发条件：
   - `--descend-condition streak`（默认）：仅在 `belowNeedStreak >= 7` 时可选；
   - `--descend-condition always`：只要 descend 合法即可选。
3. **结果（条件为 streak，d=0…4）**：`up` 在全部 d 下锁定（lockedFraction 1.0），
   `down`/`control` 均 0；`up` 的 mUp 仅 2.6–6.4。**提高 descend 权重不解除锁定**。
4. **结果（条件为 always，d=0…4）**：d=0 与 streak 对照一致（up 锁定）；
   d≥0.2 时 `up`/`down`/`control` 全部 locked=0，mUp 升至 600–1446。阈值在
   d=0 与 0.2 之间，权重幅度不再重要。
5. **结论**：锁定是否出现由 **descend 的触发条件**决定，不是 descend 权重。
   `random-uniform-v1` 的均匀选择天然包含无条件下降，因此落在 `always` 一侧，
   解释了复制轮 0/9 锁定的负结果。锁定是**策略-规则交互**，不能称为 rules-v10
   的结构性涌现分岔；跨策略的 mUp 不可直接比较。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 均不变；
  无 config/state schema 变更，无迁移。
- 新增 tag 是纯增量枚举，不改变任何既有地址或消费顺序；golden、configHash、
  paramsHash、快照与回放均不受影响。
- 探针脚本只读 `dist`，不进入构建产物；产物为 `out/p15-descend-*.json`，
  按 artifacts 规则登记，不进入确认轮证据。

## 3. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过；tag 为增量枚举，无快照/地址断言变化。
- 两档条件各 175 run（5 seeds × 3 paths × 7 d 值）成功运行；种子 `p15d-*`
  与 `p15b-*`/`p15c-*`/`p15r3-*`/`p15r4-*` 均不重叠。
- 加权抽样只消费 `explore_descend` 地址，不使用共享随机流；既有 tag 的地址与
  消费顺序不变。

## 4. 未完成

- 仅 5 个种子、单个 IC（middle）、单个 `w_mid=25`、mock-like 其它权重；未测 Jev。
- `d=0.2` 与 `random-uniform-v1` 的实际下降概率只是机制一致，未做精确等价校准。
- 未回答“无条件下降下是否还有其它路径效应”；本轮只判定锁定是否出现。
- 未检验 W4 的 A/B/C 体制在 `always`/`random`/Jev 策略下是否保持；W4/G1.5 的
  结论范围仍是预注册的 `mock-weighted-v1`，不得外推为策略无关结构。
- 不改变 P6-05（≥3 类）状态，也不把任何结果升格为 G1.5/P6 证据。

## 5. 证据

- `out/p15-descend-threshold-explore.json`（175 run，streak 条件，
  sha256 `b999751f…29aa40`）
- `out/p15-descend-unconditional-explore.json`（175 run，always 条件，
  sha256 `8034deb0…a0b238`）
- 研究记录：`docs/research/2026-11-04-p15-descend-condition.md`
