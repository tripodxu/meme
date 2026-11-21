# 0036：D-04 预算冻结（v1）与 P6-01 前置（人口实验级化）

- 日期：2026-11-05
- 作者：Runner/实验负责人（自主授权）
- 关联：D-04（01 §12）、07 §3/§8、P6-01、changes/0031–0035
- 性质：**实验预算决策 + Runner 实现变更**；不改变规则、引擎与决策协议

## 1. 结论先行

1. **D-04 关闭（v1）**：P6 各 manifest 类型的 `maxRuns/maxWallMinutes/maxStorageBytes`
   按 VPS `2zhou`（正式环境）实测冻结，取代 07 的示例占位值——
   Stage A 1200 run / 180 min / 256 MB；Stage B 60 / 240 / 512 MB；
   微扰 240 / 120 / 256 MB；消融 120 / 240 / 512 MB。
   冻结依据与使用纪律见 `docs/research/2026-11-05-d04-p6-budget-freeze.md`
   （换预算 = 新 experimentId；重冻结条件写明）。
2. **P6-01 工程前置补齐**：批跑人口规模实验级化——`--population N` 改变
   `manifest.populationSize` 的校验基准（缺省仍为 DEFAULT_RUN_CONFIG 的 40 人契约），
   cells 仍不得各自改写人口（07 §3）。200 人 × 730 tick × 3 种子经 CLI 实机验证。
3. **基准记录**：`docs/benchmarks/2026-11-05-p5a-engine.md`——rules-v11 引擎在
   开发机与 VPS 双环境的 40/200/1000 人实测（VPS：2.18 s / 13.06 s / 119.9 s per 3650 tick）。

## 2. 冻结纪律（摘要）

- 预算数字进 `budgets` 字段并计入 `preregistrationHash`；
- 超预算的批跑在执行层失败并如实记录，不得静默截断种子；
- Stage A 只做筛选，Stage B 不复用 Stage A 择优种子（07 §8 种子集分离）；
- 重冻结条件：版本/环境变化或基准漂移 > 50%。

## 3. 验证证据

- 双环境基准（同一脚本同一方法学）；VPS 冒烟管线（tar + ssh stdin 密钥）复用 runbook §4。
- 实机：`--population 200` 200 人 × 730 tick × 3 seeds 全成功，~2.3 s/run 与基准一致；
  防覆盖与 resume 语义回归不变。
- 全套门禁：typecheck/lint/format/test（649）/test:integration（4）/build 全绿。

## 4. 边界

- D-04 冻结不构成校准完成或结构已涌现（AGENTS #9）；P6 判定以 07 §8 统计验收为准。
- P6-01 Stage A 的**正式预注册**（全局筛选网格、Morris/Sobol 设计、种子集声明）是
  下一入口，须按 07 §8 的预注册协议新建 experimentId 后才可启动正式扫描。
