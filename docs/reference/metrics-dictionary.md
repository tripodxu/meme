# 指标词典

本词典解释界面、`tick_stats`、`metrics-v1` 与实验报告中的字段。公式的权威来源是
[03 规则实现](../03-rules-implementation.md) 与 [07 实验校准](../07-experiment-calibration.md)；
本页不改变任何验收口径。

## 1. 人口与阶级

| 字段             | 含义                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `aliveCount`     | 当前存活人数；0 表示灭绝，后续 tick 不再结算                            |
| `classCounts[c]` | 存活者中 `classIndex=c` 的人数                                          |
| `P[c]`           | 阶级占比，只对存活者取分母；无存活者时全 0                              |
| `medianValue`    | 存活者 Value 中位数；空人口为 0                                         |
| `top10Share`     | 最高 `ceil(fraction×n)` 个存活者 Value 之和 / 总 Value；总值为 0 时为 0 |
| `deathCount`     | 本 tick 新增死亡数（累计死亡看事件账本/最终个体）                       |
| `remainingLife`  | 个体剩余寿命（天）；`hard` 是硬寿命上限                                 |
| `maxClassIndex`  | 个体历史达到过的最高阶级                                                |

## 2. 财富与流动

| 字段                  | 含义                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gini`（G）           | 存活者 Value 的 Gini；升序 `G=Σ(2i-n-1)x[i]/(nΣx)`，总和为 0 时 0                                                           |
| `mUp`（Mup）          | 过去 `metrics.mobilityWindowDays`（默认 365）天内至少上升一次的存活者占比；含被动跌落后的重新上升，不是年化事件率、不是 EMA |
| `mDown`（Mdown）      | 同窗口内至少下降一次的存活者占比；包含被动跌落与主动降阶                                                                    |
| 转移矩阵              | 窗口内 `class_ascended/class_descended` 从 `from` 到 `to` 的计数；界面显示为矩阵                                            |
| `competitionLoss`     | 竞争损失率 `(loserLoss-winnerGain)/loserLoss`；无损失时 0                                                                   |
| `competitionGain`     | 竞争获得量（同一结算窗口）                                                                                                  |
| `fallbackRate`        | 决策回退率；mock/random 通常为 0，live 上游失败/非法输出时升高                                                              |
| `decisionsByTick.due` | 该决策 tick 到期决策数；是实际值，不是理论上界                                                                              |

## 3. 网络与开放度

| 字段                         | 含义                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `edgeCount`                  | 存活网络的**无向**边数；无网络时必须与 `S=0` 同时出现                                                               |
| `sameShare`                  | 同阶级边 / `edgeCount`                                                                                              |
| `segregation`（S）           | 双侧归一化同层边占比，`S∈[-1,1]`：随机混合 0、全同层 +1、无同层边 -1；`edgeCount=0` 时固定 0，不得用 1 冒充完全隔离 |
| `openness`（O）              | 社会开放度，初值 `openness.initial`；仅在决策周期按 `Otarget` 指数趋近，`updateMode=fixed` 时保持不变               |
| `E[c]`                       | 阶级环境机会乘子；由拥挤度、极化与 `env0[c]` 构成，逐 tick 平滑                                                     |
| `institutionalRegime`        | rules-v13 的 `closed/open` 制度状态；`continuous` 模式下不更新；θR>0 时偏置 O 目标（P6-05d 未通过）                 |
| `openness.selfReinforcement` | θH，O 自反馈权重；默认 0，与 rules-v11 逐位一致                                                                     |

## 4. 窗口与标签

- `ANALYSIS_WINDOWS` 是实验窗口（见 07），窗口统计只使用窗口内 tick。
- `labelsByWindow` 是标签集合；`labelsEvidenceByWindow` 记录每个标签的判定证据字符串。
- `statsStride` 只影响 D1 `tick_stats` 采样；窗口统计必须由 Runner 从全分辨率
  `metrics-v1` 计算，不能从采样表反推（除非 `statsStride=1`）。
- `expectedDueDecisions = Σ_{t%decisionInterval=0} aliveAtTickStart(t)`；死亡或提前
  extinct 时必须用实际值。

## 5. 运行状态与证据字段

| 字段                    | 含义                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `runtimeVersion`        | 产生权威 hash 的运行时；不同版本之间 1 ulp 差异可能改变 hash（ADR 0001）                |
| `runtimeAuthority`      | `authoritative` = 与服务器 `RUNTIME_VERSION` 相同并已复算；`non-authoritative` = 未复算 |
| `configHash`            | 完整配置的语义哈希；参数/开关变化必须改变它                                             |
| `paramsHash`            | 参数注册表视图哈希                                                                      |
| `initialPopulationHash` | `(config,seed)` 派生的初始人口与网络哈希；不接受外部 roster                             |
| `finalStateHash`        | 最终权威状态哈希                                                                        |
| `verificationStatus`    | `pending/uploaded/verified/rejected`；`uploaded` 只表示技术上传完成                     |
| `artifactProfile`       | `full` 含 decisions/events/snapshot；`metrics-only` 不可声明可回放                      |
| `payloadHash`           | tick/agent 行幂等键；同主键不同 hash 返回 409                                           |

## 6. 读图注意

- 图表只做描述性展示；TV、ARI、silhouette、同簇率等统计判据见 07，不在前端计算。
- 空态不是 0 值：无网络、无存活者、无决策时界面显示明确空态。
- `O`、`S`、`Mup`、`Mdown` 都依赖窗口/配置；跨 run 比较前先确认
  `configHash`、`runtimeVersion` 与 `rulesVersion` 一致。
