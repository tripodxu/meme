# P6-02 多参数 factorial 探索（2026-11-05）

- 状态：**执行完成（2026-11-05）**。960/960 run、0 失败、0 灭绝；结果仅 exploratory（changes/0046）。
- 关联：P6-02（01 §9）、07 §6.3、changes/0037/0038/0043/0045/0046。
- 性质：探索扫描，不构成确认、校准或结构涌现证据（AGENTS #9）。

## 1. 目的与设计

P6-01 严格重算后只有 `needThreshold=0.9` 通过 Stage B 确认；其余单轴效应在 1000 人 × 3650 tick 未确认。P6-02 的目标不是重复确认单轴，而是定位**联合条件**下结构变化较大的区域，并保留全默认稳定区验证扰动吸收（07 §6.3）。

设计为 2^5 全因子（32 cell），五轴取 Stage A 已扫描的高低水平：

| 轴             | 默认（低）                 | 高水平                          |
| -------------- | -------------------------- | ------------------------------- |
| needThreshold  | 0.5                        | 0.9                             |
| needMultiplier | `[1,1.3,1.8,2.5,3.5]`      | flat `[1,1.5,1.5,1.5,1.5]`      |
| env0           | `[1,1.5,2.2,3.2,4.5]`      | expanded `[1,2,3.5,5,7]`        |
| crossDays      | `[30,40,50,60]`            | half `[15,20,25,30]`            |
| decay          | `[1.3,1.15,1.0,0.88,0.75]` | steeper `[2.0,1.6,1.2,0.9,0.7]` |

视野：200 人 × 730 tick，warmup 365，w1 观测段 `[365,729]`；30 个新种子
`p6-factorial-seed-001…030`；主指标 `TV(P)`；预算 1000 run / 180 min / 256 MiB。

冻结：`experimentId = p6-factorial-eaf53b7b`，
`preregistrationHash = sha256:eaf53b7b319e10831933de47d586038ca1fd37628f2df318c72a6f599a34d453`。

## 2. 搜索范围、排除与资源

- 搜索范围：五轴高低水平全组合（32 点），每点 30 配对种子；不含连续细网格（留待本轮结果后的细化轮）。
- 排除：`extinct` run 不计入结构判定（07 §3 冻结排除规则）；缺窗口/非有限值同样排除并报完整性。
- 资源：960 run 全部完成，0 失败、0 灭绝、0 resumed；实测 wall **52.9 min**（预算 180 min），在 1000 run / 256 MiB 预算内；ledger 单写者。
- 不纳入本轮：β/η/κ/H/λO/竞争损失率/rewireProb/初始阶级分布（rule 56 要求的其余轴，另建 experimentId，避免本轮预算与解释混杂）。

## 3. 判读口径

- 每 cell 报 `TV(P)` 配对中位数、bootstrap 95% 区间、超 baseline 波动带比例、完整性。
- `single` cell 可与 Stage A 单轴方向对账，但仍只作探索描述。
- `interaction` cell 只回答「该联合条件下结构是否可达/不可达」；不得单轴归因。
- TV 变化最大的格点只用于下一轮细化取样；不得据此宣称确认或校准。
- 全默认 baseline 的跨种子波动带用于稳定区参照；只找临界区不验证稳定区不算完成（07 §6.3）。

## 4. 结果

**完整性**：32 cell（baseline + 31）、960/960 run 完成，0 失败/0 灭绝/0 回退；31 个非 baseline cell 均 30 配对、完整性通过；w1 观测段 365/730 tick（730 tick 视野的预注册取舍，`missingTicks=365`）。baseline 两两 D 的 95 分位 = **0.0928**。

### 4.1 单轴参照（design=single）

| cell                | TV(P) 中位数 | 95% bootstrap 区间 | 超 baseline 波动带比例 |
| ------------------- | ------------ | ------------------ | ---------------------- |
| needThreshold=0.9   | 0.1635       | [0.1485, 0.1738]   | 0.23                   |
| env0=expanded       | 0.0638       | [0.0611, 0.0702]   | 1.00                   |
| needMultiplier=flat | 0.0606       | [0.0481, 0.0715]   | 0.00                   |
| decay=steeper       | 0.0064       | [0.0043, 0.0072]   | 0.00                   |
| crossDays=half      | 0.0058       | [0.0045, 0.0072]   | 0.00                   |

只有 `needThreshold=0.9` 的单轴 TV 超过 0.10，与 P6-01 Stage A/B 的确认方向一致；env0 与 ψ=flat 的单轴 TV 约 0.06，低于主指标门槛；crossDays/decay 在本视野接近零。

### 4.2 联合条件（design=interaction，按 TV 中位数降序，前 12）

| cell                                                              | TV(P) 中位数 | 95% 区间         | 波动带比例 |
| ----------------------------------------------------------------- | ------------ | ---------------- | ---------- |
| threshold=0.9+psi=flat+env0=expanded+crossDays=half               | **0.2484**   | [0.2376, 0.2555] | 1.00       |
| threshold=0.9+psi=flat+env0=expanded+crossDays=half+decay=steeper | 0.2465       | [0.2377, 0.2537] | 1.00       |
| threshold=0.9+psi=flat+env0=expanded+decay=steeper                | 0.2446       | [0.2371, 0.2536] | 1.00       |
| threshold=0.9+psi=flat+env0=expanded                              | 0.2441       | [0.2375, 0.2566] | 1.00       |
| threshold=0.9+env0=expanded+crossDays=half                        | 0.2181       | [0.2107, 0.2234] | 1.00       |
| threshold=0.9+env0=expanded                                       | 0.2160       | [0.2094, 0.2238] | 1.00       |
| threshold=0.9+env0=expanded+decay=steeper                         | 0.2140       | [0.2083, 0.2237] | 1.00       |
| threshold=0.9+env0=expanded+crossDays=half+decay=steeper          | 0.2140       | [0.2080, 0.2251] | 1.00       |
| threshold=0.9+psi=flat+crossDays=half                             | 0.1966       | [0.1879, 0.2050] | 0.10       |
| threshold=0.9+psi=flat                                            | 0.1962       | [0.1854, 0.2047] | 0.77       |
| threshold=0.9+psi=flat+crossDays=half+decay=steeper               | 0.1957       | [0.1857, 0.2061] | 0.10       |
| threshold=0.9+psi=flat+decay=steeper                              | 0.1945       | [0.1833, 0.2038] | 0.70       |

不含 `threshold=0.9` 的联合格点最高为 `psi=flat+env0=expanded+crossDays=half` 的 0.0988（CI [0.0898, 0.1073]），仍低于 0.10。

### 4.3 解读（探索层）

- **主导轴是 needThreshold=0.9**：所有 TV ≥ 0.16 的格点都含该轴；不含它的格点最高 0.0988。
- **env0=expanded 与 ψ=flat 在联合条件下放大 TV**：`threshold+env0` 0.2160、`threshold+psi` 0.1962、`threshold+psi+env0` 0.2441；三者都高于 threshold 单轴 0.1635。按 07 §6.3，这是**联合条件**的描述，不能写成“env0 或 ψ 单独导致结构变化”。
- **crossDays/decay 在本视野被吸收**：单轴 0.0058/0.0064；加入 top 联合条件后 TV 变化 <0.005（0.2484 → 0.2465）。它们是下一轮稳定区的候选，不是临界轴。
- **临界区候选**：`threshold=0.9 × env0=expanded × psi=flat` 附近；下一轮细化应围绕该区域变 threshold（如 0.7/0.8/0.9/1.0）与 env0/ψ 的相邻档，而不是继续扫 crossDays/decay。
- **稳定区参照**：baseline D95=0.0928；crossDays/decay 单轴与多数不含 threshold 的联合格点未超主指标门槛，可作为稳定区候选。只找临界区不验证稳定区不算完成（07 §6.3），故下一轮必须同时保留稳定区点。
- **边界**：本实验是 200 人 × 730 tick 的探索视野；不能外推到 1000 人 × 3650 tick，也不能据此声称确认、校准或结构涌现。

### 4.4 产物

- `out/p6-factorial-prereg.json`（sha256 `f25c835e…`）
- `out/p6-factorial-slim.json`（4.45 MiB，sha256 `b315ff61…`）
- `out/p6-factorial-analysis.json`（16.5 KiB，sha256 `48bb3621…`）
- summary（>5 MiB，不入库，可由 ledger 重建）
