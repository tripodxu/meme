# scripts

仓库级脚本。Node-only，不进入构建产物，也不得被 `src/core` 引用。

计划脚本：`smoke-live`、`verify-backup`、`export-d1`（对应阶段尚未开工，当前不存在）。

## 约定

- 密钥只从环境变量读取，不得打印、写入 fixture 或提交到仓库。
- 真实 Jev 冒烟必须使用独立低预算密钥，默认不随 CI 运行。
- `check-doc-links.mjs` 由 `pnpm check:docs` 调用，检查仓库内 Markdown 的相对链接。

## 现有脚本

| 脚本                                  | 作用                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `check-doc-links.mjs`                 | 校验 Markdown 相对链接目标存在                                                                                                         |
| `generate-param-snapshot.mjs`         | 生成参数注册表契约快照（`pnpm params:snapshot`）                                                                                       |
| `generate-default-config-fixture.mjs` | 生成当前 rulesVersion 的 config golden fixture（累加式）                                                                               |
| `p15-grid.mjs`                        | P1.5 批量网格与聚类：W2（默认）与 `--manifest v10` W4 确认轮；`--policy`/`--seeds` 做策略敏感性（random / unconditional-descend 消融） |
| `p15-gates.mjs`                       | W1 机制门禁 G-A..G-D 批量实测                                                                                                          |
| `p15-diagnose.mjs`                    | P1.5 产物离线诊断（只读、确定性）                                                                                                      |
| `p15-gates-diagnose.mjs`              | 机制门禁产物离线复核                                                                                                                   |
| `p15-mean-field.mjs`                  | 均值场方向分析                                                                                                                         |
| `p15-feedback-explore.mjs`            | 反馈轴 / 位移份额 / 占用锚定的探索层网格（含 open-feedback 与 4 IC；非确认证据）                                                       |
| `p15-bifurcation-explore.mjs`         | 参数路径迟滞/底层锁定探索（up/down/control；非确认证据）                                                                               |
| `p15-bifurcation-probe.mjs`           | 分叉机制探针：share 消融与锁定后恢复（非确认证据）                                                                                     |
| `p15-multibasin-probe.mjs`            | 多吸引域/壁垒探针：A/B/C、cushion/cross × 4 IC × 3650/7300（非确认证据）                                                               |
| `p15-feature-subspace.mjs`            | W4 特征子空间只读重聚类（class/network/full/traj）                                                                                     |
| `p15-w5-classshare.mjs`               | W5 class-share 三类候选确认（新种子；非 P6-05 证据）                                                                                   |
| `p15-w5-convergence.mjs`              | W5 边界 10950 tick 收敛探针（探索层）                                                                                                  |
| `p15-w5-pooled.mjs`                   | W5 方法学复核：W4 协议 pooled w2b+w3 重聚类（只读）                                                                                    |
| `p15-v11-ratchet-probe.mjs`           | rules-v11 占用记忆 H 扫描：H=0/90/180/365 × A/B/C × 3650/10950（探索层）                                                               |
| `p15-longhorizon-probe.mjs`           | 10950 终态 class-share 聚类复核（30 seeds；探索层）                                                                                    |
| `p15-w6-longhorizon.mjs`              | W6 长视野三类候选确认（p15r6 新种子 + 14600 收敛；已通过）                                                                             |
| `p15-descend-threshold.mjs`           | descend 权重/触发条件阈值探针（streak vs always；非确认证据）                                                                          |
| `benchmark.mjs`                       | 性能基准                                                                                                                               |
