# Stratify 执行约定

开始施工前阅读 `docs/README.md`，按任务类型加载对应契约。P1.5 W4 确认轮已通过 G1.5（2026-11-04），P2 已收口（7/7），P5a 五项全完成，P6-01 Stage B 六单元已全部跑完并按 07 严格口径判读（1 个确认：needThreshold=0.9；5 个未确认/exploratory）；P6-02 多参数 factorial 已完成（960/960、0 失败；top 联合条件 TV 0.2484，仅 exploratory，不构成确认；changes/0046）；P6-03 微扰克隆与正常波动区间已完成（600 对全部有效，无结构证据；changes/0050）；P6-04a 五个必跑消融已完成（180/180、0 失败；五消融 TV 均 <0.10，未达 mechanismExplained；仅 exploratory；changes/0051）；P6-04b 重测信度已通过（20 次，top-1 0.70、ICC(2,1) 0.9886、平均 TV 0.0565）；1-seed live pilot 通过（993/993、0 回退、18.6 min；liveVsMock TV 0.0152/D 0.0186、liveVsRandom TV 0.3226/D 0.1619）；VPS `2zhou` runner 标准部署已完成（只读代码/专用用户/600 env/systemd；runbook §4.6）；P6-04b 正式 live 对照已完成（10 新 seed × 4 组 = 40 run、0 剔除；TV(P) 中位数 0.0175/0.0248 vs mock、0.3781/0.3839 vs random；五个比较均未同时满足 07 §8，verdict=no-structural-evidence；changes/0056）；P6-05 全特征聚类已跑完但未通过（k=3 簇 [30,118,32]、ARI median 0.491、silhouette 0.344、14600 同簇率 0.667；二簇稳健、三簇不成立；G6 仍未通过；changes/0057）；P6-05b 机制筛选也未通过（θS∈{4,8,12} × H∈{0,180}；k=3 簇 [136,17,27]、ARI 0.291、silhouette 0.297、同簇率 0.550；H1/H2 均不成立；按预注册停止调参、转 rules-v12 ADR；changes/0058）；rules-v12 已落地（ADR 0004，`openness.selfReinforcement` θH 默认 0，config schema v7；changes/0060），P6-05c 已跑完但未通过（160/160；k=3 [72,39,9]、ARI 0.182、silhouette 0.215、同簇率 0.675；A 方案失败，转方案 B；changes/0061）；参数搜索已完成但验证未通过（9,600 粗筛 + 240 验证；k=3 [74,97,9]、ARI 0.157、silhouette 0.241、同簇率 0.683，`no-stable-region-found`；changes/0059）；仍不得声称双稳态或三簇；rules-v13 已落地（ADR 0005，显式制度状态机 + θR 偏置，config schema v8、state schema v4；默认 `continuous`/θR=0 与 rules-v12 逐位一致；changes/0063），P6-05d 已完成但未通过（continuous 对照 + θR∈{4,8,12} × 30 新 seed，160/160；k=3 [76,3,41]、ARI 0.094、silhouette 0.152、同簇率 0.650；θR>0 终端 O 塌到 0，属 closed 单态吸收；B 方案失败，停止制度机调参、转规则设计评审）；按评审建议 D3 的 P6-05e 测量充分性检查已完成（规则不变，人口 200/1000 × 30 新 seed，80/80；`p6-05e-1b652168`；k=3 [41,13,6]，全部 30 个 pop1000 run 同簇、另两簇仅来自 pop200，ARI 0.527、silhouette 0.282、同簇率 0.300；第三簇更像有限样本噪声，支持“单吸引域/目标修订”方向，不构成 G6 确认；changes/0064）；规则负责人已选择 D1：G6 结构目标改为“2 体制 + 连续统”（ADR 0006、rule.md v14、docs/07 §8.2；changes/0065）——预注册 k=2 稳定（两簇各 ≥5、ARI ≥0.70、silhouette ≥0.35、同簇率 ≥0.80、至少一个簇 ≥2 cell、序参量差异 ≥0.10）且 k=3 无稳定第三簇；旧 k=3 结果不得追认通过，P6-06 确认轮待预注册/运行。`rules-v13` 尚未通过 `docs/07` 的统计验收，不得声称已校准或结构已涌现。

## 强制约束

1. 先实现无 Jev 的确定性核心，再接模型和 UI；核心不得依赖 DOM、fetch、Node、Worker、localStorage 或 wall clock。
2. Jev 只从代码枚举的合法行动中做 Choice；财富、胜率、阶级、寿命和网络均由核心计算。
3. 禁止 `Math.random()` 和全社会共享单随机流；使用 `R(seed,tick,agentId,eventTag,counter)`。
4. 固定 tick 顺序与快照/回放语义；行为变更必须更新规则版本、文档和 golden 测试。
5. 所有业务常数必须来自参数注册表，禁止在结算函数写裸字面量；新参数必须有接线测试并进入 `configHash`。
6. 初始人口、初始网络和初始年龄必须由 `(config, seed)` 纯函数派生，不得接受独立 roster。
7. Cloudflare Worker 不执行大规模长循环；D1 只存可查询元数据/聚合，完整日志进 R2。
8. 真实 Jev 调用必须有超时、有限重试、取消、预算和失败熔断；密钥不得落库或写日志。
9. 不得声称参数已校准或结构已涌现，除非满足 `docs/07-experiment-calibration.md` 的统计验收；P1.5 未通过不得启动 P2–P6。
10. 完成标准为实现+测试+文档+验证证据；CI 未通过不得标记完成。

## 常用入口

- 任务与依赖：`docs/01-implementation-plan.md`
- 架构与模块边界：`docs/02-architecture.md`
- 规则结算：`docs/03-rules-implementation.md`
- Jev 与回放：`docs/04-jev-decision-contract.md`
- API/存储：`docs/05-api-data-contract.md`
- 前端交互：`docs/06-frontend-contract.md`
- 测试门禁：`docs/08-testing-quality.md`
- 发布运维：`docs/09-deployment-operations.md`
- 编码与评审：`docs/10-engineering-conventions.md`
- 架构决策：`docs/adr/README.md`

规则冲突时暂停并澄清，不得静默选择有利口径。
