# P6-01 严格口径恢复计划（2026-11-05）

- 性质：**非契约执行计划**；判定口径以 `rule.md`、`docs/07-experiment-calibration.md` 与冻结预注册为准。
- 关联：[逐提交审查](../reviews/2026-11-05-zcodes114-commit-audit.md)、[changes/0042](../changes/0042-p6-stage-b-protocol-correction.md)、严格重算产物 `out/p6-stageA-analysis-strict.json`。
- 当前状态：**P6-01 Stage B 0 个确认；G6 未通过；Stage A 严格重算得到 3 个 TV 合格候选。**

## 1. 背景与当前判定

旧 Stage A 用「任意指标」筛选，12 个入选对中 11 个不满足主指标 `TV(P) ≥ 0.10`。
按 07 主指标重算（w1、30 配对种子、固定种子 bootstrap、完整性校验）后：

| 人口 | cell              | TV(P) 中位数 | 95% 区间         | 状态                    |
| ---- | ----------------- | ------------ | ---------------- | ----------------------- |
| 40   | needThreshold=0.3 | 0.1021       | [0.0944, 0.1090] | 边界通过（仅超 0.0021） |
| 40   | needThreshold=0.9 | 0.1797       | [0.1538, 0.1944] | 通过                    |
| 200  | needThreshold=0.9 | 0.1683       | [0.1574, 0.1715] | 通过                    |

其余 10 个 cell（psi=1、env0=expanded/compressed、crossDays=half/double、needThreshold=0.7、needMult 各档、decay 各档）全部低于 0.10。

**因此旧的「六单元 Stage B」计划作废**：6 个候选里只有 `needThreshold=0.9` 有 Stage A 主指标证据；`crossDays=double` 与 `psi=1` 在跑单元只能标 exploratory。

### 1.1 两个待裁决点

1. **TV(P) 的方向口径**：TV 是非负距离，当前实现把方向一致率标为 N/A。旧筛选正是用有符号指标的方向排除了 `needThreshold=0.9@40`；若严格定义方向（如主导阶级 ΔP 同号率 ≥0.90），该候选可能不成立。必须在重冻结 Stage B 前裁决。
2. **`needThreshold=0.3@40` 的边界性**：中位数仅超门槛 0.0021，CI 下界 0.0944 低于 0.10；不应单独据此启动确认轮。

## 2. 现有资产与缺口

### 有效资产

- Stage A 840 run 全成功；`out/p6-stageA-slim-40.json`、`-200.json` 已入库，可离线重算。
- 三个 Stage B 单元已有 60/60 数据：env0=expanded、env0=compressed、crossDays=half；按 07 均未确认。
- 严格重算代码 `src/runner/p6-analysis.ts#evaluateStageA` 与 `scripts/p6-stage-a.mjs --analyze-strict` 已写出；产物已生成（**尚未提交、尚无单测**）。
- 工程修复已提交：P5-04 数组字段/首次偏离/maxTicks/快照哈希断言（`ee9548b`）；RateLimiter 监听器清理（`46f96f2`）。

### 主要缺口

- Stage A 严格分析的测试、文档索引、artifacts 登记；
- TV 方向口径未裁决；
- `baseConfig` 未进 ledger 哈希；
- live 检查点未接入 `runBatchWithPolicy`；live 预算可选、`requestedModel` 默认 `mock`；
- 检查点 `meta.tickCompleted` 与快照 tick 未交叉校验；
- `warmupTicks` 类型仍被放宽；
- 全量 668 项测试未在最后提交后重跑；integration/e2e 未跑。

## 3. 分阶段计划

### 阶段 0：冻结现状（约 1 天）

1. 给 `evaluateStageA` 补单测（TV 达标/不达标、完整性失败、方向 N/A、w1 窗口）；
2. 提交 `--analyze-strict`、严格分析产物与 `changes/0043`；
3. 更新 `docs/research/README.md`、`docs/README.md`、`AGENTS.md`、artifacts；
4. 运行全量 `typecheck / test / lint / check:docs / format`；
5. 让三个后台 Stage B 批跑自然结束；结果按 1.1 的候选集标记。

**验收**：严格分析可复现；旧 `p6-stageA-analysis.json` 明确标为历史口径；门禁全绿。

### 阶段 1：TV 方向口径裁决（约 2–3 天）

用现有 Stage A 数据同时计算三种定义下的候选集：

1. N/A（当前实现，最宽松）；
2. **主导阶级方向**：取 |ΔP[c]| 最大的阶级，要求 ΔP 在 ≥90% 配对种子上同号（推荐）；
3. 分层模型同向概率（成本最高）。

把裁决写入 ADR 或 `changes/0043`，只对**新冻结**的 Stage B 生效，不改写历史判定。

**验收**：唯一口径；三种定义的候选集对比表；`needThreshold=0.9@200` 在主导阶级定义下是否仍通过有明确结论。

### 阶段 2：P5 runner 正确性修复（约 1 周）

| 修复                                                                                                       | 验收                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 检查点 `meta.tickCompleted === state.society.tick`、stats/flows/decisions 元素与 tick 范围、异步加载去重读 | 篡改检查点被当作损坏；正常恢复逐字一致 |
| `baseConfig` 入 ledger 哈希（旧 ledger 兼容）                                                              | 不同 baseConfig 不能复用同一 ledger    |
| live 检查点接入 `runBatchWithPolicy`；live 预算强制、`requestedModel` 不默认 `mock`                        | 测试覆盖 checkpoint 透传与缺预算拒绝   |
| `warmupTicks` 恢复受限联合类型；TV 方向字段落地                                                            | 类型测试；非法 warmup 编译失败         |

**验收**：每项单测；全量门禁绿；逐项提交。

### 阶段 3：Stage B 重冻结与执行（约 3–5 天 + 计算）

1. 按阶段 1 裁决，为每个候选新建 Stage B manifest（新 experimentId、独立确认种子、D-04 预算）；
2. 推荐顺序：
   - `needThreshold=0.9`（已有数据，最稳）；
   - `needThreshold=0.3`（仅当方向口径允许且接受 40 人边界证据）；
3. 每单元 60 run（baseline+candidate × 30），约 2 小时；断点续跑；
4. 判读用 `p6-analysis` v2 严格 07 条件。

**验收**：60/60、0 失败/灭绝/回退；analysis 产物入库并登记 sha256。

### 阶段 4：P6-01 判定（约 2–3 天）

- 若 `needThreshold=0.9` 在 1000×3650 达到 TV≥0.10 且全部条件满足 → 记 **1 个确认效应**；其余五个标 exploratory；
- 若未达到 → P6-01 **0 确认**，按 07 记录负结果；
- 更新 README/AGENTS/changes/artifacts；P6-01 收口或明确未收口。

**验收**：证据链完整（prereg、slim、analysis、hash 一致）；不得事后改门槛/窗口/种子。

### 阶段 5：P6-02～P6-05（约 4–8 周，条件启动）

只有阶段 4 产生至少一个确认效应才启动：

- P6-02 多参数扫描/临界区；
- P6-03 微扰配对（使用已修的 P5-04）；
- P6-04 live Jev 对照（需 P2 冒烟与预算）；
- P6-05 ≥3 类结构指纹聚类（G6 的唯一验收，独立预注册 + 30 种子）。

### 阶段 6：P3/P4/P5b/P7（发布线，独立排期）

前端、Worker/D1/R2、上传、发布；不在 P6-01 未定案时并行投入。

## 4. 资源与运行约束

- 单 run 1000 人 × 3650 tick 实测约 125–166 秒；单 cell 60 run 约 2 小时。
- 本机 20 核 / 16.9 GB，三进程并行可行；长批次优先 VPS systemd。
- ledger + checkpoint 续跑；单写者；磁盘守卫 `deploy/check-disk-space.sh`。
- 正在跑的三单元：crossDays=double、psi=1、needThreshold=0.9；前两者在候选重定后标 exploratory。

## 5. 风险与止损

| 风险                                                 | 止损                                            |
| ---------------------------------------------------- | ----------------------------------------------- |
| TV 方向 N/A 导致候选虚高                             | 阶段 1 用主导阶级方向复核；不通过则不冻结该候选 |
| 40 人 Stage A 信号在 1000 人消失（crossDays 已先例） | 优先 200 人证据；40 人只作 exploratory          |
| `needThreshold=0.3@40` 边界 0.0021                   | 不单独启动确认；需 200 人复现                   |
| 长批跑中断/磁盘不足                                  | ledger 续跑 + 磁盘守卫 + 单写者                 |
| 在跑单元使用旧代码                                   | 只作 exploratory；主判读只用新代码产物          |
| 文档/产物哈希漂移                                    | 每次分析更新 artifacts sha256 与 changes        |

## 6. 立即行动

1. 补 `evaluateStageA` 测试，提交严格分析（代码 + 产物 + changes/0043）；
2. 等待 `needThreshold=0.9` 跑完；`crossDays=double`、`psi=1` 完成后标 exploratory；
3. 计算三种 TV 方向定义下的候选集，完成裁决；
4. 按裁决重冻结 Stage B（至少 `needThreshold=0.9`）；
5. 全量门禁 + 文档/产物登记。
