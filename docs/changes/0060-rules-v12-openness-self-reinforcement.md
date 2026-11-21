# 0060 rules-v12：开放度自反馈（θH）

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：ADR 0004、changes/0057/0058、docs/03 §6、rule.md 42/45
- 性质：**规则修订**（rules-v11 → rules-v12）；默认关闭，θH=0 与 v11 逐位一致
- 预注册 P6-05c：`out/p6-05c-prereg.json`（experimentId `p6-05c-f7f3cc91`）

## 1. 变更

- 新参数 `openness.selfReinforcement`（θH），默认 `0`，域 `[0,20]`，
  sigmoid 斜率单位；进入参数注册表、`configHash`/`paramsHash` 与 golden。
- 规则 42：

  `O_target = sigmoid(θ0 + θM×(Mup−Mref) − θG×(G−Gref) − θS×(S−Sref) + θH×(O_prev−0.5))`

  `O_prev` 为本 tick 更新前的 O；不得使用同期更新值或引入个体顺序依赖。

- `openness.updateMode=fixed` 时 θH 不生效；θH 越界/非有限值拒绝启动。
- 版本：`rules-v12`、`engine-v0.10.0`、config schema `stratify-config-v7`
  （v6→v7 迁移补 `selfReinforcement: 0`）；状态 schema 不变（O 已在状态中）。
- `θH=0` 与 rules-v11 逐位一致；`θH>0` 是否产生两个稳定 O 不动点、以及能否
  形成稳定第三簇，必须由 P6-05c 检验。

## 2. 依据

P6-05 与 P6-05b 在 6 个参数区域、θS/H 扫描下都没有产生稳定第三簇：第三簇只是
非 A 体制内沿 S/O 的相位漂移（ARI 0.291–0.491、14600 同簇率 0.55–0.67）。
rule 45 已写下“高流动↔高开放 / 高隔离↔低开放”的候选双稳态机制，但 O 只有一个
慢平衡点，没有迟滞。ADR 0004 选择最小显式实现：给 O 目标加自反馈项，默认 0，
不新增权威状态字段。

## 3. 测试与兼容性

- 新增 6 项单测：θH=0 与 v11 公式逐位一致；θH>0 把低 O 推低、高 O 推高；
  θH=0 时两者被拉向同一目标；fixed 模式忽略 θH；参数域与 paramsHash 接线；
  v6→v7 迁移补 0。
- golden：config 增加 `default-rules-v12.json` + hashes；engine golden 单文件
  前滚到 `mock-run-rules-v12.json`；参数快照加入 `openness.selfReinforcement`。
- 旧 run/artifact 仍可按保存的 config 读取；但 v12 的 `configHash/paramsHash`
  与 v11 不同，**不得跨版本比较哈希或把旧 artifact 当作 v12 证据**。
- Jev 决策协议、行动集合、状态 schema 不变。

## 4. 判读边界

- 本变更只提供机制与默认关闭的参数；**不保证**产生第三类结构，也不构成校准。
- P6-05c 若仍无稳定第三簇，按 ADR 0004 转方案 B（显式制度状态机），
  不得继续调 θH 或换 seed。
