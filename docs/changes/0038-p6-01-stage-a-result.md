# 0038：P6-01 Stage A 执行结果（840 run，12 对入选）

- 日期：2026-11-05
- 作者：Runner/实验负责人（自主授权）
- 关联：P6-01（01 §9）、07 §6.2/§8、changes/0036（D-04 v1）/0037（预注册冻结）
- 性质：**实验执行与判读**；预注册口径以 changes/0037 冻结哈希为准，运行后未改任何设计字段

## 1. 执行事实

- 840 run（14 cells × 30 种子 × 2 人口）**全部成功**：0 技术失败、0 灭绝、0 取消；
- wall：40 人 2.8 min、200 人 20.5 min（预算 180 min）——预算纪律达标；
- 预注册哈希校验在启动前完成（`--run` 拒绝跑未冻结或哈希不一致的设计）；
- 产物入库（artifacts §2 同步登记）：prereg ×2（10.4 KiB）、slim ×2（1.9/2.0 MiB，
  全量 summary 7.4 MiB 超过 5 MiB 上限不入库，可按命令重建）、analysis（25.5 KiB）。

## 2. 判读（详见 research/2026-11-05-p6-01-stage-a-result.md）

- baseline 跨种子波动带（两两 D 95 分位）：40 人 0.138、200 人 0.104；
- **12 个 (cell, 人口) 对按预注册判据入选**（门槛命中 + 方向一致率 ≥0.90）；
- **env0 最强**：expanded/compressed 两方向 × 两人口全入选，`expanded` 的
  d>band 0.57/0.97（ΔMup −0.36/−0.38、ΔO −0.33/−0.38）；
- crossDays 双向、ψ=1 消融跨人口一致入选；needThreshold=0.9 仅 200 人口入选
  （跨人口方向不稳，Stage B 裁决）；decay 轴在 730 tick 视野未达筛选门槛
  （只判「本视野未达门槛」，不判无敏感性）。

## 3. Stage B 候选（cell 归并）

`env0=expanded`、`env0=compressed`、`crossDays=double`、`crossDays=half`、
`psi=1`、`needThreshold=0.9`（附方向稳定性保留意见）。

## 4. 边界与下一步

- Stage A 是筛选层：不构成结构结论、校准或 P6-05 验收（AGENTS #9）；
- Stage B 确认前须按 07 §8 预注册：**新确认种子集**（p6-stageB-seed-001…030，
  不与 Stage A 重叠——D-07 纪律外推）、1000 人 × 3650 tick、statsStride=1、
  w2b/w3 完整窗口、07 §8「结构显著改变」全条件；预算按 D-04 v1 Stage B
  （60 run/240 min/512 MB 每单元）；
- 07 §6.2 其余参数轴（β/η/κ/H/λO/lossRate/rewireProb/初始阶级分布/initialAgeMode）
  与全局筛选（Morris/Sobol）为后续 Stage A 轮次，另建 experimentId。
