# 0016：P1.5 路径依赖探索与 runSingle initialState

- 日期：2026-11-04
- 作者：核心/规则负责人（用户要求「继续研究涌现分叉的可能性」）
- 关联：W4 确认轮（`changes/0014`）、路径依赖研究（`research/2026-11-04-p15-emergent-bifurcation-explore.md`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义，不构成 G1.5/P6 判定

## 1. 变更

1. **续跑能力**：`RunOptions.initialState` 允许 `runSingle` 从已有状态继续，用于
   检查点恢复与多阶段参数路径实验；续跑前校验 `configHash` 与 `seed`，不一致立即
   拒绝。默认不传时行为不变。
2. **探索脚本**：新增 `scripts/p15-bifurcation-explore.mjs`，实现
   `up`（w=0 预热 → w_mid）、`down`（w=100 预热 → w_mid）、`control`（全程 w_mid）
   三条路径，按 `(tick, agentId)` 确定性结算；支持 `--stage screen|full|long`、
   `--seeds`、`--ic default|middle|bottom`。
3. **探索结果**：`share=0.5`、`w_mid=20/25/30` 下，`up` 路径在 1825 tick 预热中
   抽空 class0/1，切换到 w_mid 后无法恢复（middle 10/10 seeds 锁定、default 6/6、
   bottom 5/6）；`down`/`control` 均 0 锁定。`up` 的 mUp 为 2.5–6.0，`down` 为
   31.2–53.0，`control` 为 50.8–109.8；后段延长到 3650 tick 后差异仍持续。
   机制是**底层抽空形成的吸收边界 + 高壁垒后的流动性疤痕**，判为路径依赖锁定/
   单向棘轮候选，**不是已确认的对称双稳态分岔**。
4. **机制探针**（`scripts/p15-bifurcation-probe.mjs`，3 seeds，w_mid=25）：
   `share=0.5` 预热锁定 3/3，`share=1` 预热 0/3（开放准入是锁定必要条件）；
   锁定后 `w=0` 仍 3/3 底层为空，mUp 44.7 来自上层重组——说明是**组成吸收边界**，
   不是全局冻结。
5. **全新种子复制（mock）**：按预冻结设计（`p15c-*`，3 ICs × 10 seeds × 3 mids），
   9/9 cell 通过 per-cell 门槛、0 反向 cell；up locked 1.0 / down 0，
   mUp gap 29.6–55.0。但 **`random-uniform-v1` 敏感性为负**：3 ICs × 3 mids
   全部 locked=0、up/down mUp 差 −6.7…+6.0、`pathDependent=false`。因此锁定是
   **策略-规则交互**，不是 rules-v10 的结构性涌现分岔；复制只在 mock 内成立。

## 2. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion` 不变（`rules-v10`/
  `engine-v0.8.0`/`stratify-config-v5`）。
- `initialState` 是 runner 的增量选项；调用方不传时 `runSingle` 行为与配置哈希、
  golden 均不变。
- 探索脚本只读 `dist`，不进入构建产物；产物为 `out/p15-bifurcation-*.json`，
  按 artifacts 规则登记，不进入确认轮证据。

## 3. 测试与验证

- `test/unit/runner/policy-wiring.test.ts` 新增 2 项：`initialState` 续跑终态与
  整段运行一致；`config`/`seed` 不一致时拒绝。
- 探索脚本 `screen/full/long` 三档均成功运行（150/90/90/45 run），确定性种子
  `p15b-*` 与确认轮种子不重叠。
- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。

## 4. 未完成

- 未做预注册确认轮：当前只有探索层证据，无 ARI/锁定比例的正式门槛判定。
- 未测试 Jev/random 策略；`mock-weighted-v1` 下的锁定不能直接外推到 live。
- 未做恢复/扰动实验与 `displacementShare` 消融；机制归因仍是候选。
- 不改变 P6-05（≥3 类）状态：路径依赖锁定不等于三类结构；且 random 策略不复现，
  不能称为规则层涌现分岔。

## 5. 证据

- `out/p15-bifurcation-explore-middle.json`（150 run）
- `out/p15-bifurcation-explore-default.json`（90 run）
- `out/p15-bifurcation-explore-bottom.json`（90 run）
- `out/p15-bifurcation-long-middle.json`（45 run，后段 3650 tick）
- `out/p15-bifurcation-probe.json`（15 run；share 消融 + 锁定后恢复）
- `out/p15-bifurcation-repl-{middle,default,bottom}.json`（各 150 run，p15c 全新种子）
- `out/p15-bifurcation-policy-random-{middle,default,bottom}.json`（各 150 run，
  random 策略敏感性；全部 locked=0）
- 研究记录：`docs/research/2026-11-04-p15-emergent-bifurcation-explore.md`
