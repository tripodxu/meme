# 06 前端与交互契约

## 1. 页面目标

前端是实验检查器，不是只展示“社会演化动画”。用户必须能回答：当前配置是什么、为何发生行动、财富变化来自哪里、结构指标在哪个窗口计算、实验是否可复现。

## 2. 信息架构

单页分为五个可切换工作区，运行中切换不中断仿真：

1. **实验设置**：预设、人口、规则、决策策略、预算、配置校验和预计调用量。
2. **实时总览**：控制条、当前 tick/存活数、结构指纹、核心曲线和事件流。
3. **个体检查器**：搜索/筛选 agent，查看属性、关系、需求、寿命、行动和 Value 事件。
4. **回放与对比**：导入实验、逐 tick/倍速回放、两个窗口指标并排、微扰来源说明。
5. **实验管理**：本地运行、云端上传状态、导出、错误和版本信息。

移动端使用底部/分段导航，不删除预算、单步、回放或导出等关键能力。

## 3. 设置与启动

### 3.1 分组

- 基础：人口、总 tick、决策间隔、seed、初始阶级分布、`initialAgeMode`（uniform/newborn）。
- 个体：ge/hard/寿命分布与截断、`hardLifeFactor`。
- 阶级：env0、decay、crossDays、`needMultiplier`、需求阈值/缓冲/连续跌落日数/主动降阶天数。
- 竞争：损失率、传递效率、方向系数、候选数、局部/全局比例。
- 网络与反馈：β/η/κ/H/λO/rewireProb、Congestion/Polarization 上下限、O 固定开关、`flowWindowDays`、`MupWindowDays`。
- 决策：mock/random/Jev/replay、promptStyle（neutral/survival_hint）、模型、topK、并发、超时。
- 预算：maxCalls/maxInputTokens/maxRunMinutes；live 必填。

预设分“演示未校准”和“已校准”两类；只有满足 07 证据要求的预设可进入后者。修改已校准预设任何字段后显示“自定义，未校准”。结构实验默认提示人口 1000、3650 tick；浏览器 live 默认限制 40 人、730 tick、`decisionInterval=30`，超出需明确确认并显示请求/费用估算。

### 3.2 启动检查

- 字段级错误定位，禁止 NaN/Infinity/越界/数组长度错误进入核心。
- live 启动前显示静态调用上界、并发和预算；超建议规模需再次确认。按 40 人×365 决策×30 种子估算，live 请求量可达数十万，必须显示工时/费用，不得只显示 token 上界。
- 真实 Key 只保存在当前内存，不预填、不进 localStorage；刷新后需重新输入。
- 非 V8 浏览器（Safari/Firefox）启动时显示 `nonAuthoritativeRuntime`：可运行，但哈希/回放不承诺与 Chromium/Node/workerd 一致。
- 启动时冻结配置快照；运行中的设置变化只能用于“下一场”，不得偷偷改变当前规则。

## 4. 控制条与状态反馈

控制：开始、暂停、继续、单步、重置、停止、速度、跳转快照。状态必须明确区分：

```text
未配置/校验失败/就绪/等待决策/结算中/已暂停/回放中/
上传落后/预算耗尽/已取消/失败/已完成
```

- 等待 Jev 时显示在途/完成/失败数，不把网络等待当作 tick 已结算。
- 暂停和重置使旧 generation 响应失效；不得出现重置后旧响应改写新世界。
- 失败显示 runId、阶段、稳定错误码和可下载诊断；核心不变量失败不能继续。
- 上传落后不阻塞本地权威状态，但达到本地磁盘/内存上限时暂停并提示。

## 5. 图表与指标词典

| 视图 | 必需内容 |
|---|---|
| 阶级结构 | 各阶级存活人口堆叠面积/比例，另显示存活总数，避免死亡被误读为流动 |
| 财富 | Gini、中位数、前10%占比；可用对数坐标并明确标注 |
| 流动 | Mup/Mdown 是 365 日参与率（不是年化事件率），二者分开；转移矩阵使用 `flowWindowDays` 同一窗口 |
| 网络 | 调整后 S（`[-1,1]`）、edgeCount、平均度、跨层边、连通分量；无网络时显示 `edgeCount=0` 而不是 S=1；小人口网络图仅作辅助，不替代指标 |
| 制度 | O、动态 E、跨越成本乘子，显示慢变量更新时间 |
| 竞争 | 发起/胜率、损失、获得、净损耗，按原发起方向分组 |
| 寿命 | 剩余寿命分布、死亡数、按阶级死亡统计 |
| 决策 | 行动分布、Jev 回退率、延迟、token/调用预算，mock 不显示伪模型成本 |
| 结构指纹 | P/G/top10/Mup/Mdown/S/O 和窗口，D 只能作为辅助 |

所有图表提供标题、单位、窗口、数据点定义和空态。默认窗口与实验窗口一致；终局值不得冒名窗口均值。用户可查看原始聚合表/下载数据。

## 6. 个体检查器

- 支持按 ID、阶级、存活状态筛选；人口大时虚拟列表/分页，不一次渲染全部卡片。
- 属性卡：value/ge/hard/remainingLife/derived age/classIndex/maxClassIndex/classAge/baselineSum/need/needMultiplier/belowNeedStreak/lastAscentTick/lastDescentTick。
- 决策卡：legal actions、模型概率、topK、requested/selected action、核心实际执行结果、policyVersion、promptVersion/promptStyle、source、fallback/stale 原因。
- 账本：每次 Value before/delta/after/cause/referenceId；可跳到关联竞争/阶级事件。
- 关系：当前 ties 和本 tick 重构事件；不允许多手编辑权威状态。微扰通过专门 fork 操作完成并记录字段。
- rawResponse 默认折叠，下载时遵循 artifact 保留说明；绝不显示请求 Key。

## 7. 回放、导入与对比

- 导入先读取 schema/version/hash，再校验配置和日志；未知主版本拒绝，不覆盖当前 run。
- 回放控制与 live 共用视图，但显著标识 `jev_replay`，显示 `replay_invalid` 数。
- 对比页至少并排显示：配置差异、seed 是否配对、窗口、P/G/top10/Mup/Mdown/S/O、波动区间来源。
- 微扰对比显示克隆检查点 hash 和唯一变更字段；若变更多于一项，不能标为单微扰。
- 没有同策略配对波动区间时只显示“描述性差异”，不提供“结构显著改变”按钮/结论。

## 8. 本地存储与文件

localStorage 只存：

```text
stratify.settings.v1       非敏感UI偏好
stratify.lastConfig.v1     最近配置，不含Key
stratify.recentRuns.v1     runId、时间、状态和小摘要
```

writeToken 只存当前标签页的 `sessionStorage`（`stratify.runToken.<runId>`），不进 localStorage；刷新可续传同一 run，关闭标签页后上传停止，服务器 run 由静默超时清理。离线 mock run 使用 `local-<ulid>` 作为 runId，只支持导出/回放，MVP 不支持直接采纳为服务器 run；UI 必须明确显示“仅本地，未上传”。

运行中的权威状态、决策日志和周期快照必须分块写入 IndexedDB（P3-05 必须实现），不能只放内存；刷新后从最近完整块恢复。若 IndexedDB 不可用，启动前必须警告“刷新将丢失当前 run”，并提供导出。存储配额不足要显式提示并停止无界增长。提供“清除本地实验”二次确认，不影响服务器数据。

导出至少包含 manifest、config、identity、stats、初始/最终 state、完整决策/事件 artifact 及清单；声称“完整可回放”时必须实际包含全部到期决策和必要初始状态，而不是只有图表 CSV。云端 completed 仅显示“上传完整”，独立验证器通过后才显示“已验证/可正式采用”。

## 9. 性能与响应式

- 核心按时间片运行；每片后让出主线程。可将纯核心移入 Web Worker，但不是 MVP 必需；若引入，消息协议版本化。
- 图表按可视像素降采样，缩放查看原始窗口；不在每 tick 重建整个 DOM/SVG。
- 网络图仅默认用于小规模；大人口显示聚合指标。
- 近期事件使用有界缓冲区，完整事件写 artifact；前端内存有上限并可测。
- 360px 宽度无横向关键操作遮挡；桌面图表可并排，移动端顺序阅读。

## 10. 可访问性与视觉约定

- 所有按钮可键盘访问，焦点清晰；输入有 label 和错误关联；动态状态用适度 aria-live，不逐 tick 骚扰。
- 图表除颜色外提供线型/图例/文本表；文本和控件满足 WCAG AA 对比度目标。
- 涨跌不套用股票红绿语义；社会指标使用中性、可区分配色，死亡/错误不仅靠红色表达。
- 动画可减少，遵循 prefers-reduced-motion；数值更新不闪烁。
- 中文界面为主，Jev state/prompt 保持英文；公式与代码字段不翻译。

## 11. 前端验收场景

1. 无网络、无 Key：mock 从配置运行到完成，暂停/单步/重置和导出正常。
2. live：Key 错误、429、超时、预算耗尽均有明确状态，不静默变成 mock。
3. 等待响应时重置：旧响应被丢弃，状态 hash 不被污染。
4. 导入完整 live：无网络可回放，非法行动有 replay_invalid 记录。
5. 导入损坏/未知版本：当前实验不受影响，显示字段/版本错误。
6. 长实验：图表降采样，内存有界，浏览器可继续交互。
7. 全零财富、空网络、空阶级、全死亡：图表无 NaN，空态解释正确；无网络显示 `edgeCount=0` 而非 S=1。
8. 键盘和移动端：完成配置、运行、检查个体、回放和导出全流程。
9. 运行中刷新：同标签页从 IndexedDB 最近完整块恢复；没有完整块时明确警告并保留导出，不得假装恢复成功。
10. 离线 run：显示 `local-<ulid>` 和“仅本地，未上传”；尝试上传时给出明确限制，不创建虚假服务器记录。
11. 非 V8 浏览器：显示 `nonAuthoritativeRuntime` 警告，哈希/回放结果不标记为权威。
12. live 规模超限：40 人/730 tick/interval 30 以上时显示请求、token、工时和费用估算，并要求二次确认。
