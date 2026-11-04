# scripts

仓库级脚本。Node-only，不进入构建产物，也不得被 `src/core` 引用。

计划脚本：`smoke-live`、`verify-backup`、`benchmark`、`export-d1`。

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
| `p15-descend-threshold.mjs`           | descend 权重/触发条件阈值探针（streak vs always；非确认证据）                                                                          |
| `benchmark.mjs`                       | 性能基准                                                                                                                               |
