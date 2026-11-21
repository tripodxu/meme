# 0037：P6-01 Stage A 预注册冻结（五主导参数单参数筛查）

- 日期：2026-11-05
- 作者：Runner/实验负责人（自主授权）
- 关联：P6-01（01 §9）、07 §3/§6.2/§8、D-04 v1（changes/0036）、D-07 种子纪律
- 性质：**实验预注册冻结**；`PreregManifest.warmupTicks/warmupDiagnostic` 类型放宽为
  number/string（既有 P1.5 构造输出不变）；不改变规则、引擎与决策协议

## 1. 冻结内容（src/runner/p6-stage-a.ts 即冻结文件）

- **experimentId**：`p6-stageA-40-b9cd2fd9`（hash `sha256:b9cd2fd9…`）与
  `p6-stageA-200-366198c5`（hash `sha256:366198c5…`）；
- **设计**：baseline + 13 个 `single` 设计格点，覆盖 07 §6.2 验收要求的五主导参数：
  needMultiplier（ψ=1 消融/扁平/陡峭/更陡）、needThreshold（0.3/0.7/0.9）、
  env0（压缩/扩大）、crossDays（减半/加倍）、decay（全 1.0/更陡）；
- **规模**：14 cells × 30 配对种子（`p6-stageA-seed-001…030`，与 p15 各轮不重叠）
  = 420 run/人口；40 人与 200 人两个 manifest（同种子跨人口配对）；
- **视野**：730 tick，warmup 365，筛选指标 = `w1` 窗口观测段 [365,729] 日均值
  （w1 完整窗口 365–1094 超出 730 tick，观测段覆盖是预注册取舍）；
- **判据（预注册）**：任一预注册指标（TV(P)/|ΔG|/|ΔMup|/|ΔS|/|ΔO|）配对中位数
  超过 07 §8 门槛 **且** 方向一致率 ≥ 0.90 → 入选 Stage B 候选；
  baseline 跨种子两两 D 的 95 分位作为波动带参考；
- **预算**：D-04 v1 Stage A（1200 run / 180 min / 256 MB）进哈希；
- **排除规则**：extinct run 不计结构判定；missingTicks>0 窗口不参与结构判异；
  网络空窗口不参与 S 相关判读；技术失败保留原因与次数。

## 2. 设计纪律

- Stage A 只做方向/效应量筛选，**不产出结构结论或校准声明**（AGENTS #9）；
- β/η/κ/H/λO/lossRate/rewireProb/初始阶级分布等 07 §6.2 其余行是后续 Stage A 轮次，
  另建 experimentId；全局筛选（Morris/Sobol）亦然——每轮独立预注册；
- `PreregCell.hypothesis/design` 保留原有 `baseline|single|interaction` 自洽校验
  （changedPaths 由代码派生，13 个 single 格点各恰改 1 个叶子路径）。

## 3. 执行与产物

- `node scripts/p6-stage-a.mjs --freeze`（已执行，hash 见上）→ `--run both`
  （ledger 断点续跑、预算纪律超限即失败）→ `--analyze`（离线、确定性）；
- 产物：`out/p6-stageA-prereg-*.json`、`out/p6-stageA-summary-*.json`、
  `out/p6-stageA-analysis.json`（schemaVersion `p6-stageA-analysis-v1`，
  带 `isExperimentalEvidence: true` 与阶段声明）；
- 单测：`test/unit/runner/p6-stage-a.test.ts` 7 项（口径字段、种子集不重叠、
  cells 设计自洽、双 manifest 一致性、哈希确定性、batch 链路连通）。

## 4. 边界

- 预注册哈希冻结后设计不得改；改任何字段（含预算）= 新 experimentId 重跑；
- 扫描结果与判读见 changes/0038（执行后追加）。
