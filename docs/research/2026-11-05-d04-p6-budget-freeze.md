# D-04：P6 预算冻结提案与基线（2026-11-05）

- 关联：01 §12 D-04、07 §3（budgets 进 preregistrationHash）、07 §8（两阶段规模）、
  `docs/benchmarks/2026-11-05-p5a-engine.md`、changes/0031–0035
- 性质：**实验预算决策记录**；本文件把 D-04 的「P1.5 基准后确定
  `maxRuns/maxWallMinutes/maxStorageBytes`」落为冻结数字。
- 状态：**已冻结（v1）**，冻结基准 = VPS `2zhou` 实测（正式环境）；引擎或执行环境
  变更时须按 §4 重冻结。

## 1. 冻结依据（实测，非占位）

| 口径                                               | 实测（VPS `2zhou`，rules-v11） |
| -------------------------------------------------- | ------------------------------ |
| Stage A 单点：30 配对种子 × (40+200 人) × 730 tick | ≈ 95 s/点                      |
| Stage B 单元：30 配对种子 × 1000 人 × 3650 tick    | ≈ 60 min/单元                  |
| 聚类 ward-lw-v1（1680 点 k∈[2,5]）                 | < 60 s                         |

详见 `docs/benchmarks/2026-11-05-p5a-engine.md`（开发机与 VPS 双环境对照；
管线经 `bin/stratify-batch.mjs --population 200` 200 人 × 730 tick × 3 种子实机验证）。

## 2. 冻结数字（v1）

| manifest 类型                               | maxRuns | maxWallMinutes | maxStorageBytes |
| ------------------------------------------- | ------- | -------------- | --------------- |
| P6-01 Stage A 筛查（单参数/全局筛选）       | 1200    | 180            | 256 MB          |
| P6-01 Stage B 确认（每入选单元一 manifest） | 60      | 240            | 512 MB          |
| P6-03 微扰对（配对批）                      | 240     | 120            | 256 MB          |
| P6-04 消融（每消融一 manifest）             | 120     | 240            | 512 MB          |

推导与余量：

- Stage A：19 个单参数点（07 §6.2 主参数 5+4+3+3+3−1 基线合并）× 30 种子 ≈ 570 run；
  预算 1200 run 留出全局筛选（Morris/Sobol 网格）与补跑余量。实测 ≈ 95 s/点 →
  19 点 ≈ 30 min，180 min 预算含窗口聚合、标签、聚类与一次技术重跑。
- Stage B：每单元 30 run 实测 ≈ 60 min；预算 240 min ≈ 4× 余量（含一次技术重跑与
  `metrics-v1` 全分辨率 artifact 写盘）。`maxRuns=60` 覆盖 30 种子 + baseline 复用。
- 存储：`metrics-v1` 全分辨率 1000 人 ≈ 1.1 MB/run + 快照对 ≈ 0.2 MB → Stage B
  30 run ≈ 40 MB；512 MB 上限允许保存分布产物与失败诊断。Stage A 摘要 ≈ 5 KB/run
  （600 run ≈ 3 MB），256 MB 上限同样留出 `artifactProfile=full` 的入选 run 存档。

## 3. 使用纪律

1. 预算数字进 07 §3 的 `budgets` 字段并计入 `preregistrationHash`——**换预算即新 experimentId**。
2. 超预算的批跑在执行层必须失败（ledger/summary 如实记录），不得静默截断种子；
   需要更多 run 时按 §4 重冻结后再新建实验。
3. Stage A 结果只用于筛选方向与效应量；Stage B 不复用 Stage A 择优种子（07 §8 种子集分离）。
4. 本文件不构成校准完成或结构已涌现的声明（AGENTS #9）；P6 判定仍以 07 §8 统计验收为准。

## 4. 重冻结条件

- `engineVersion` 或 `rulesVersion` 变化；或
- 执行环境变化（开发机 ↔ VPS ↔ CI）；或
- 单 run 实测与冻结基准偏差 > 50%（基准漂移，先复测后重冻结）。

重冻结 = 更新本文件 v2+ 并在 changes/ 追加记录；旧 manifest 不改预算数字。
