# 0046：P6-02 多参数 factorial 探索结果

- 日期：2026-11-05
- 作者：Runner/实验负责人（严格口径恢复）
- 关联：P6-02（01 §9）、07 §6.3/§9、changes/0045、`docs/research/2026-11-05-p6-02-factorial-explore.md`
- 性质：**探索性结果记录**；不修改规则、参数默认值或既有实验判定，不构成确认/校准

## 1. 执行与完整性

- 预注册：`p6-factorial-eaf53b7b`，prereg `sha256:eaf53b7b…`（changes/0045）。
- 32 cell（baseline + 5 single + 26 interaction）× 30 个新种子 × 200 人 × 730 tick = 960 run。
- **960/960 完成，0 失败、0 灭绝、0 回退、0 resumed**；wall **52.9 min**（预算 180 min），在 1000 run / 256 MiB 预算内。
- 31 个非 baseline cell 均 30 配对、完整性通过；w1 观测段 365/730 tick（预注册取舍）。

## 2. 主要结果

baseline 两两 D 的 95 分位 = 0.0928。

| 类型        | cell                                                    | TV(P) 中位数 | 95% 区间         | 波动带比例 |
| ----------- | ------------------------------------------------------- | ------------ | ---------------- | ---------- |
| single      | needThreshold=0.9                                       | 0.1635       | [0.1485, 0.1738] | 0.23       |
| single      | env0=expanded                                           | 0.0638       | [0.0611, 0.0702] | 1.00       |
| single      | needMultiplier=flat                                     | 0.0606       | [0.0481, 0.0715] | 0.00       |
| single      | decay=steeper                                           | 0.0064       | [0.0043, 0.0072] | 0.00       |
| single      | crossDays=half                                          | 0.0058       | [0.0045, 0.0072] | 0.00       |
| interaction | threshold=0.9+psi=flat+env0=expanded+crossDays=half     | **0.2484**   | [0.2376, 0.2555] | 1.00       |
| interaction | threshold=0.9+psi=flat+env0=expanded                    | 0.2441       | [0.2375, 0.2566] | 1.00       |
| interaction | threshold=0.9+env0=expanded                             | 0.2160       | [0.2094, 0.2238] | 1.00       |
| interaction | threshold=0.9+psi=flat                                  | 0.1962       | [0.1854, 0.2047] | 0.77       |
| interaction | psi=flat+env0=expanded+crossDays=half（不含 threshold） | 0.0988       | [0.0898, 0.1073] | 1.00       |

- 所有 TV ≥0.16 的格点都含 `needThreshold=0.9`；不含它的格点最高 0.0988（<0.10）。
- `env0=expanded` 与 `ψ=flat` 在联合条件下放大 TV：`threshold+env0` 0.2160、`threshold+psi` 0.1962、`threshold+psi+env0` 0.2441，均高于 threshold 单轴 0.1635。
- `crossDays=half`/`decay=steeper` 在本视野被吸收：单轴 0.0058/0.0064；加入 top 联合条件后 TV 变化 <0.005。
- 临界区候选：`threshold=0.9 × env0=expanded × psi=flat` 附近；下一轮细化应围绕该区域变 threshold 与 env0/ψ 相邻档，并保留稳定区点。

## 3. 口径与限制

- 本实验是**探索扫描**：interaction 格点只回答联合条件是否可达/不可达，不得单轴归因；所有结果只标 exploratory（07 §6.3/§9）。
- 200 人 × 730 tick 视野；不能外推到 1000 人 × 3650 tick，也不能据此声称确认、校准或结构涌现（AGENTS #9）。
- 预注册主指标 `TV(P)`；bootstrap 区间为固定分析 seed 的 10,000 次配对 bootstrap。波动带比例使用 baseline 两两 D 的 95 分位，仅作描述。
- 与 P6-01 的关系：`needThreshold=0.9` 的单轴确认（Stage B TV 0.1553）不受本实验影响；本实验新增的是**联合条件**的探索信号，不是第二个确认效应。

## 4. 产物

| 产物                             | 大小     | sha256（前 8 位） |
| -------------------------------- | -------- | ----------------- |
| `out/p6-factorial-prereg.json`   | 30.0 KiB | `f25c835e…`       |
| `out/p6-factorial-slim.json`     | 4.45 MiB | `b315ff61…`       |
| `out/p6-factorial-analysis.json` | 16.5 KiB | `48bb3621…`       |

全量 summary >5 MiB，不入库；可由 ledger 重建。产物登记见 artifacts。

## 5. 下一步

P6-03 的微扰设计应以本轮的临界区候选与稳定区候选为取样范围；P6-02 的细化轮（threshold × env0/ψ 相邻档）在启动前须新建 experimentId 与预注册种子，不得复用本轮 30 个种子择优。
