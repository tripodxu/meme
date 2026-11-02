# 0004 rules-v4：阶级环境持有人乘子与开放度制动再平衡

- 日期：2026-11-03
- 类型：规则行为变更（升级 `rulesVersion: rules-v3 → rules-v4`）
- 依据：P1.5 预研判定 G1.5 未通过（单一"顶层过重+旋转门"结构，`docs/research/2026-11-03-p15-report.md`）；
  本变更由用户授权的自主规则负责人按该报告 §6 流程执行。
- 关联文档：`rule.md`（规则 5/37/42）、`docs/03-rules-implementation.md`、`docs/research/p15-mean-field.md`

## 变更内容

1. **需求线解耦（采纳报告 §6.1 的意图）**：
   `need = buffer(classAge) × baselineSum × ψ[c] × (E[t,c]/E[t,0])^φ`，
   新参数 `need.envExponent`（`φ`），默认 **1.0**，合法域 `[0,4]`；`φ=0` 精确退回 v3 语义（保留为消融值）。
   动机：v3 中需求与收益同源（都正比于 `B×E[c]`），可持续性比 `ge·F·Opp/ψ[c]` 与阶级机会无关，
   ψ 参数扫描无法改变阶级排序——这是单一结构 basin 的机制根因。
   v4 使高阶级的有效持有成本随其相对机会增长，抵消 env0 的单调收益梯度。
2. **开放度制动再平衡（采纳报告 §6.3）**：`openness.mobilityWeight` 默认 **8 → 3**。
   动机：v3 中 Mup≫Mref 的正反馈把 O 驱至 ~1（探索数据 O≈0.99），封闭分层（O≤0.25）等
   中间开放度结构不可达；θM=3 使 O 可进入中间区间。
3. **暂缓报告 §6.2/§6.4**：Opportunity 饱和与 env0 非单调。理由：§6.1 落地后顶层自我强化的
   可持续性通道已被切断，Opportunity 饱和参数在该机制下冗余（保留为 v5 候选）；
   env0 非单调违背 rule.md 规则 2 的"阶级越高系数越大"语义。

## 兼容性

- `rulesVersion` 升级为 `rules-v4`：`rules-v3` 配置不再被 `validateRunConfig` 接受
  （`config_unknown_version`）；v3 golden fixture 保留为只读历史证据（哈希稳定性测试），
  不得用于 v4 仿真。
- 默认配置 `configHash/paramsHash` 变化（新增 `need.envExponent` + `θM` 默认值）。
- 旧 v3 快照/决策日志按版本分派读取，不参与 v4 对照组。

## 实验可比性

- v3 与 v4 结果不可并入同一对照组；P1.5 将以 v4 重新预注册并重跑（新 preregistrationHash）。
- 网格新增 `φ∈{0,0.5,1,1.5}` 扫描与 `θM=8`（v3 值）对照单元，保证变更效果可分离归因。

## golden 与测试

- `test/fixtures/config/default-rules-v4.json`（新）与 `default-rules-v3.json`（保留只读）。
- `test/fixtures/engine/mock-run-rules-v4.json`（新，v4 默认 mock 运行）；
  v3 engine fixture 保留只读。
- 参数定义快照 `param-definitions.json` 重新生成（新增 `need.envExponent`）。
- 新增接线测试：`φ=0` 与 v3 公式逐位一致；`φ>0` 改变高阶级 need 与跌落边界。
