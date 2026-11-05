# Stratify 执行约定

开始施工前阅读 `docs/README.md`，按任务类型加载对应契约。P1.5 W4 确认轮已通过 G1.5（2026-11-04），P2 已收口（7/7），P5a 五项全完成，P6-01 Stage B 六单元已全部跑完并按 07 严格口径判读（1 个确认：needThreshold=0.9；5 个未确认/exploratory）；P6-02 多参数 factorial 已完成（960/960、0 失败；top 联合条件 TV 0.2484，仅 exploratory，不构成确认；changes/0046）；P6-03 微扰克隆与正常波动区间已完成（600 对全部有效，无结构证据；changes/0050）；P6-04a 五个必跑消融已完成（180/180、0 失败；五消融 TV 均 <0.10，未达 mechanismExplained；仅 exploratory；changes/0051）；P6-04b 重测信度已通过（20 次，top-1 0.70、ICC(2,1) 0.9886、平均 TV 0.0565）；1-seed live pilot 通过（993/993、0 回退、18.6 min；liveVsMock TV 0.0152/D 0.0186、liveVsRandom TV 0.3226/D 0.1619）；正式 live/mock 对照未运行；`rules-v11` 尚未通过 `docs/07` 的统计验收，不得声称已校准或结构已涌现。

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
