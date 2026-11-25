# 0063 rules-v13 显式制度状态机（ADR 0005）

- 日期：2026-11-11
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0005、changes/0061（P6-05c 失败 → B 方案）、docs/03 §6 阶段 H、rule.md 42/43/45
- 性质：**规则版本升级**（rules-v13 / engine-v0.11.0 / config schema v8 / state schema v4）
- 影响范围：`src/core/{config,feedback,engine,model,hash,init,control}`、golden、P6-05d

## 1. 动机

P6-05c（rules-v12，θH∈{0,6,10,14}）160/160 跑完后仍无稳定第三簇：k=3
簇 [72,39,9]、ARI median 0.182、silhouette 0.215、14600 同簇率 0.675，
全部未过 07 §8.1 线；k=2 [111,9]、silhouette 0.505 显示二簇稳健
（changes/0061）。A 方案的诊断是：只给连续 O 的目标函数加自反馈，
仍不足以让轨迹锁定在第二个制度状态。按 ADR 0004 的预注册决策规则
转 B 方案：把制度变成显式权威状态。

## 2. 规则变更

新增权威状态 `society.institutionalRegime ∈ {closed, open}`（rules-v13）：

- 初值：`O_initial >= 0.5 ? open : closed`。
- 仅在决策周期、`openness.updateMode='dynamic'`、`openness.regimeMode='hysteresis'`
  时更新：
  - `closed→open`：`Mup >= enterM` 且 `S <= enterS`；
  - `open→closed`：`Mup <= exitM` 或 `S >= exitS`；
  - 其余保持原制度。
- `O_target` 在 v12 公式上增加 `θR·sign(regime)`（open 为 `+θR`，
  closed 为 `−θR`）。
- `regimeMode='continuous'` 或 `updateMode='fixed'` 时不更新制度；
  默认 `continuous`、`θR=0`，与 rules-v12 逐位一致。

新参数（全部进入参数注册表与 `paramsHash`）：

| 参数                                  | 默认值       | 域     |
| ------------------------------------- | ------------ | ------ |
| `openness.regimeMode`                 | `continuous` | enum   |
| `openness.regimeBias`（θR）           | 0            | [0,20] |
| `openness.regimeEnterOpenMobility`    | 0.25         | [0,1]  |
| `openness.regimeExitOpenMobility`     | 0.15         | [0,1]  |
| `openness.regimeEnterOpenSegregation` | 0.20         | [-1,1] |
| `openness.regimeExitOpenSegregation`  | 0.30         | [-1,1] |

校验强制 `exitM <= enterM`、`enterS <= exitS`（滞回带方向）。

## 3. 版本与迁移

- `RULES_VERSION='rules-v13'`、`ENGINE_VERSION='engine-v0.11.0'`。
- config schema v8：v7→v8 迁移补默认制度字段（`continuous`/0/0.25/0.15/0.20/0.30），
  保持 v12 语义；v1→…→v8 迁移链逐级推进，不会跳级。
- state schema v4：新增 `society.institutionalRegime`，进入
  `encodeSimState`/`decodeSimState`、状态哈希 schema 与快照。导入 v3 状态时
  按 `O >= 0.5` 推断制度并升级为 v4；迁移后状态哈希与旧 v3 哈希不同，
  旧快照不得当作 v13 证据。

## 4. 测试与 golden

- 新增 `test/unit/engine/openness-regime.test.ts`（11 项）：
  continuous 不更新制度；closed→open 需同时满足两个条件；open→closed
  任一条件即可；滞回带保持；θR 抬高/压低 O；fixed 模式保持 O 与制度；
  参数注册表/`paramsHash`；v7→v8 迁移；阈值顺序校验；引擎在决策周期
  写入制度；θR=0 与 continuous 逐位一致、θR>0 轨迹分叉。
- `serialize.test.ts` 新增 v3→v4 推断与 v4 缺字段拒绝。
- `own-parity.test.ts` 在对照 v5 参照 fixture 时排除 `institutionalRegime`。
- golden 前滚：`test/fixtures/config/default-rules-v13.json` +
  `.hashes.json`（`configHash sha256:ef5d84ac…`、
  `paramsHash sha256:fa6f447b…`）；engine golden
  `mock-run-rules-v13.json` 重算（rules-v13、engine-v0.11.0）；
  `param-definitions.json` 94 项；v12 config fixture 保留为只读历史。
- 全量：typecheck、lint、format、build 通过；799 单测全绿（69 文件）。

## 5. P6-05d 预注册

- 脚本：`scripts/p6-05-cluster.mjs --design p6-05d`。
- 设计：`continuous` 对照 + θR∈{4,8,12}（hysteresis，默认阈值），
  固定 `displacementShare=0.5`、`scarcityWeight=15`；
  30 个全新 seed × 10950 tick（40 人）+ 每 cell 前 10 seed × 14600；
  全特征 k=3，沿用 P6-05 的 ARI/silhouette/同簇率/反预设验收。
- 预注册冻结：`out/p6-05d-prereg.json`，`p6-05d-5cb910dd`
  （designHash `sha256:5cb910dd…`），160 run。
- 首跑事故：θR 的注册域原为 `[0,10]`，而 P6-05d 设计含 θR=12，VPS 在
  cell `thetaR12` 构造配置时被校验拒绝（120/160 后失败）。修复为与 θH
  同域 `[0,20]`，并在 `--freeze` 时新增逐 cell 配置校验，避免非法设计
  冻结后才在运行期暴露；pre-registered design 未改动（designHash 不变），
  修复后用全新输出目录重跑全部 160 run，不混用旧 ledger。
- 决策规则：若 θR>0 仍无稳定第三簇，方案 B 失败，**停止继续给制度机
  加可调旋钮**，转规则设计评审；通过也只是 mock 候选，不是校准或
  结构涌现声明。

### P6-05d 结果（2026-11-11，未通过）

- `p6-05d-5cb910dd`：160/160 完成（120 base + 40 followup）、0 排除、
  0 灭绝；VPS `2zhou` unit `p6-05d-5cb910dd-r2`，wall 约 8.5 min。
- k=3 簇 **[76, 3, 41]**，三个簇都混合全部 4 个 cell；最小簇只有 3 个
  run（<5），**ARI median 0.094**（min -0.027）、**silhouette 0.152**、
  14600 同簇率 **0.650**，四项判据全部未过；`antiPreset=true` 但无意义
  （簇内混合所有 cell）。k=2 诊断 [79,41]、silhouette 0.129；k=4/5 也
  只有 0.176/0.205，均弱于 P6-05c。
- **机制诊断**：θR>0 的三个 cell 终端 O 几乎全部塌到 0（θR=4 均值
  0.004、θR=8/12 均值 0.000），continuous 对照 O 均值 0.252、sd 0.156。
  显式制度在默认阈值下先进入 open、随后因 `Mup <= exitM` 迅速退回
  closed，`−θR` 偏置把 O 进一步压低并锁死；结果不是两个稳定制度，
  而是**closed 单态吸收**，全特征差异主要来自噪声。
- **判定**：方案 B 失败。按预注册决策规则，**停止继续给制度状态机加
  可调旋钮**（不再调 θR/enter/exit/seed/k），转规则设计评审，需要新的
  机制假设与新的 ADR；不得声称双稳态、三簇、已校准或结构已涌现。

## 6. 明确不做

- 不调 k、不换特征、不事后挑 seed/cell。
- 不声称双稳态、三簇、已校准或结构已涌现。
- 不把旧 v3 状态哈希与 v4 状态哈希混比。
