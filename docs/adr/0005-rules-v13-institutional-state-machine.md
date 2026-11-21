# 0005 rules-v13 显式制度状态机

- 状态：accepted（2026-11-11；ADR 0004 的 A 方案失败后转入 B 方案）；**P6-05d 验证失败（2026-11-11）**
- 决策者：徐鼎（提案人；按 2026-11-05 执行目标确认的 A→B 决策路径）
- 相关任务：P6-05d（P6-05/P6-05b/P6-05c 均失败后的显式制度检验）
- 取代/被取代：不取代 ADR 0004；A 方案保留为 `regimeMode='continuous'` 的历史实现

## 背景

P6-05、P6-05b、P6-05c 与参数搜索验证都没有产生稳定三簇。ADR 0004 的 A 方案
（`openness.selfReinforcement` θH 自反馈）在 P6-05c 中失败：k=3 簇
[72,39,9]、ARI 0.182、silhouette 0.215、14600 同簇率 0.675；k=2 [111,9]
二簇稳健，第三簇只是 9 个 run 的不稳定子群（changes/0061）。按 ADR 0004
的预注册决策规则，停止调 θH，转 B 方案：**显式制度状态机**。

A 方案失败说明“只改 O 目标函数的连续迟滞”不足以锁定第二个制度状态。
B 方案把制度本身变成权威状态，用带迟滞的离散转移锁定 `closed`/`open`
两个制度，再由制度偏置改变 O_target。

## 决策

1. 新增权威状态 `society.institutionalRegime: 'closed' | 'open'`
   （`STATE_SCHEMA_VERSION` v3→v4）。初始值由 `openness.initial >= 0.5`
   决定：`open`/`closed`。状态进入序列化、快照、回放与状态哈希。
2. 新增配置（全部进入参数注册表、`configHash`/`paramsHash` 与 golden）：
   - `openness.regimeMode: 'continuous' | 'hysteresis'`，默认 `continuous`
     （`continuous` 与 rules-v12 逐位一致）；
   - `openness.regimeBias` θR，默认 `0`，域 `[0,20]`（与 θH 同域，覆盖 P6-05d 的 12）；
   - `openness.regimeEnterOpenMobility`，默认 `0.25`，域 `[0,1]`；
   - `openness.regimeExitOpenMobility`，默认 `0.15`，域 `[0,1]`；
   - `openness.regimeEnterOpenSegregation`，默认 `0.20`，域 `[-1,1]`；
   - `openness.regimeExitOpenSegregation`，默认 `0.30`，域 `[-1,1]`。
     校验要求 `exitM <= enterM`、`enterS <= exitS`（迟滞带不得倒置）。
3. 仅在决策周期、且 `openness.updateMode='dynamic'` 时更新制度：

   ```text
   if regime == 'closed' and Mup >= enterM and S <= enterS:
       regime = 'open'
   else if regime == 'open' and (Mup <= exitM or S >= exitS):
       regime = 'closed'
   ```

   其余情况保持不变。`regimeMode='continuous'` 或 `updateMode='fixed'` 时
   不更新制度，`regime` 保持初值。

4. O_target 在 rules-v12 公式上增加制度偏置：

   ```text
   bias = (regimeMode == 'hysteresis') ? (regime == 'open' ? +θR : -θR) : 0
   O_target = sigmoid(θ0 + θM(Mup−Mref) − θG(G−Gref) − θS(S−Sref)
                      + θH(O_prev−0.5) + bias)
   ```

   制度转移先于 O 更新使用，但 O 本身仍按 rule 43 慢更新；不得用新 O
   回头重算同 tick 的 gain/cost/network。

5. 版本：`rules-v13`、`engine-v0.11.0`、config schema v8、state schema v4。
   config v7→v8 迁移补默认字段；state v3→v4 迁移按 O 初始化 regime。
6. 旧 run/artifact 可按保存的 config 读取；v3 状态快照导入时迁移为 v4，
   但迁移后的状态哈希不同，**不得把旧快照哈希当作 v13 证据**。

## 备选方案

| 方案                   | 优点               | 代价                                    | 未采用原因           |
| ---------------------- | ------------------ | --------------------------------------- | -------------------- |
| A θH 连续自反馈（v12） | 改动最小           | P6-05c 已失败；不能锁定离散制度         | 已由 P6-05c 判定失败 |
| B 显式状态机（本 ADR） | 双稳态最强、可解释 | 新状态字段、state schema、迁移与 golden | —（采用）            |
| C 网络重构锁定         | 不改状态           | P6-05b 证据弱；可能只延迟不锁定         | 证据不足             |
| D 制度捕获/精英闭锁    | 可能产生真实第三态 | 新增行为/Jev 语义，范围过大             | 超出本轮最小修订     |

## 后果

- 正面：制度是可直接检查的权威状态；`continuous` + θR=0 保持 v12 行为；
  P6-05d 可直接检验 `closed`/`open` 是否形成稳定第三簇。
- 负面/限制：state schema 升版，所有 v13 状态哈希与旧版不同；阈值/θR
  需要校准，存在过拟合风险；仍可能只得到两个制度而非三类阶级结构。
- 测试：制度转移（进入/退出/迟滞带/不翻转）、continuous 与 v12 等价、
  fixed 模式忽略、序列化/快照/hash、config 迁移、golden 重算。
- 文档：`rule.md` 42/45（v13）、`docs/03` 阶段 H、`docs/01`、`docs/07`、
  `AGENTS.md`、参数注册表、版本轴。
- 验证：P6-05d，4 cell（continuous 对照 + θR∈{4,8,12}）× 30 个全新 seed
  × 10950 tick（前 10 续跑 14600），全特征 k=3，沿用 P6-05 验收；
  若失败，B 方案判失败，项目目标需另立 ADR 重新评估，不得继续调阈值。

## 验证结果（P6-05d，2026-11-11）

P6-05d `p6-05d-5cb910dd` 160/160 完成、0 排除、0 灭绝：k=3 簇 **[76,3,41]**，
三个簇都混合全部 4 个 cell；ARI median **0.094**、silhouette **0.152**、
14600 同簇率 **0.650**，最小簇 3 run，四项判据全部未过。

机制上，θR>0 的三个 cell 终端 O 几乎全部塌到 0（θR=4 均值 0.004，
θR=8/12 均值 0.000），continuous 对照 O 均值 0.252、sd 0.156。默认
`enterM=0.25/exitM=0.15` 使制度短暂进入 open 后因 `Mup <= exitM`
迅速退回 closed，`−θR` 偏置把 O 压低并锁死，得到的是 **closed 单态
吸收**，不是两个稳定制度。

**结论**：B 方案失败。按预注册决策规则，停止继续给制度状态机加可调
旋钮（不再调 θR/enter/exit/seed/k），转规则设计评审；新的机制假设须
另立 ADR。不得声称双稳态、三簇、已校准或结构已涌现（changes/0063）。
