# 实验产物登记（artifacts）

> 本文件是 `out/` 目录入库策略的唯一事实来源。`.gitignore` 的白名单与本表一一对应；表外产物一律不入库。

## 1. 入库规则

1. **白名单制**：只有本文件 §2 列出的文件可以入库。新增、改名或替换产物，必须在同一 PR 中同步更新本表与 `.gitignore` 的 `!out/...` 例外行。
2. **体积上限**：单个产物不得超过 5 MiB。超出时改存 R2 或外部存储，在本表登记 URL、sha256 与生成命令，仓库只保留摘要。
3. **可重建**：产物必须能用 §3 的命令从对应提交重建。不可重现的产物不得作为验收证据。
4. **替换留痕**：覆盖同名产物时，提交信息必须写出新旧 sha256 与关键指标变化，便于回溯判定依据。
5. **只读**：产物是证据而非源码，禁止手工编辑 `out/*.json`；需要修正数据应改代码后重跑。
6. **迁移阈值**：满足以下任一条件时，`out/` 产物必须迁出仓库（R2），仓库只保留 `sha256` + URL + 生成命令：
   - 单文件 > 5 MiB；
   - `out/` 入库总量 > 50 MiB；
   - 任一产物 `git clone` 后无法在 30 分钟内按 §3 重建。

   当前入库 44 个文件、合计约 10.3 MiB（最大 `out/p15-full.json` 3.88 MiB），**未达阈值，
   故不做 LFS/R2 迁移**：迁移只增加运维面，且 LFS 会让「clone 即可复核证据」退化为
   需要额外凭证。阈值本身是可执行判据，不需要在未达标时提前决策。

## 2. 当前登记

| 路径                                                 | 大小     | sha256（文件级）     | 关键指标                                                                                                                                                                                                         | 状态                                                                                                                        |
| ---------------------------------------------------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `out/p15-full.json`                                  | 3.88 MiB | `dc6e85f9…eac1685`   | runCount=840、prereg=`sha256:4dc141e4…`、k=4、silhouette 0.370、ARI min 0.366 / mean 0.579 / max 0.702（门槛 0.70 → **未过**）、temporalConsistency 0.893、w2b/w3 全 840 可用、107 min                           | **历史存档（rules-v5 口径）**：rules-v6 起 `rulesVersion`/状态字段/参照系语义已变，不可与新 run 直接比较（changes/0008 §5） |
| `out/p15-gates.json`                                 | <10 KiB  | （以入库版本为准）   | W1 机制门禁实测：G-D 通过（own 5/5 逐位 + class 往返）；G-A 未过（P0(w3)=0.0000）；G-C 未过（L1=0.1624）；G-B 见 B 节。schema `p15-gates-v1`，按 gate 分节合并写入，判据来自 `src/runner/gates.ts` GATE_CRITERIA | 有效证据（W1 门禁，changes/0008 §6）                                                                                        |
| `out/p15-full-v4draft.json`                          | 1.08 MiB | `7091777f…8cf12697a` | rules-v4 初稿（E 期锚定，已由 `0282170` 勘误）                                                                                                                                                                   | 历史存档                                                                                                                    |
| `out/p15-screen.json`                                | 95.1 KiB | `9b5723d4…21214fe`   | 28 run × 400 tick；`cellsByDesign={baseline:1,single:25,interaction:2}`；w2b/w3 均 `available=false`；budgets.ok                                                                                                 | 预检通过                                                                                                                    |
| `out/p15-feedback-explore.json`                      | 237 KiB  | `5d5937bf…6a5ba25`   | 探索层：11 反馈轴 cell × 2 初值 × 6 种子 = 132 run；同参数两初值终态 P0 0.56 vs 0.17，k=2 ARI=1.0                                                                                                                | **探索证据**（changes/0012 §4 前置），不得引用为 G1.5 确认证据                                                              |
| `out/p15-displacement-explore.json`                  | 118 KiB  | `c2e0cc82…b6da1c`    | 探索层：displacementShare∈{1,.75,.5,.25,0} × 2 初值 × 6 种子 = 60 run；share<1 底层抽空、种子噪声主导                                                                                                            | **探索证据**，changes/0012 §4.1 的负面结论来源                                                                              |
| `out/p15-balance-explore.json`                       | 100 KiB  | `3e3e4727…ff4a0d`    | 探索层：share×η×congestionMin = 12 cell × 1 初值 × 4 种子 = 48 run；强拥挤负反馈不能托住底层                                                                                                                     | **探索证据**，changes/0012 §4.2                                                                                             |
| `out/p15-scarcity-explore.json`                      | 128 KiB  | `4d90a1ec…386fa7`    | 探索层：share∈{1,.75,.5}×scarcity∈{0,.5,1,2,4} = 15 cell × 4 种子 = 60 run                                                                                                                                       | **探索证据**，changes/0013 §4                                                                                               |
| `out/p15-scarcity-high-explore.json`                 | 69 KiB   | `7c816728…2393b14`   | 探索层：高强度权重 5–50，8 cell × 4 种子 = 32 run；w≥20 恢复底层                                                                                                                                                 | **探索证据**，changes/0013 §4                                                                                               |
| `out/p15-scarcity-transition-explore.json`           | 118 KiB  | `500f097c…ed244048`  | 探索层：share=0.5，w=10–50，7 cell × 2 初值 × 4 种子 = 56 run；过渡带与初值依赖                                                                                                                                  | **探索证据**，changes/0013 §4.1                                                                                             |
| `out/p15-scarcity-max-explore.json`                  | 51 KiB   | `d41f461b…558abf1e`  | 探索层：share=0.5，w=60/80/100，3 cell × 2 初值 × 4 种子 = 24 run；P0≈0.10                                                                                                                                       | **探索证据**，changes/0013 §4.1                                                                                             |
| `out/p15-plateau-explore.json`                       | 96 KiB   | `3531ebef…034e4e37b` | 探索层：6 平台 cell × 8 种子 = 48 run；k=2 ARI median=1.0（A vs B∪C），k=3 轮廓 0.347、B 泄漏到 C                                                                                                                | **探索证据**，changes/0013 §4.3                                                                                             |
| `out/p15-v10-full.json`                              | 851 KiB  | `cb9758b2…a4faa82`   | **W4 确认轮证据**：rules-v10，6 cell × 30 新种子 = 180 run；k=2 ARI median/min 1.000、temporal 1.000、最小簇 30 run（60 点）、方向预测过 → G1.5 通过（两类）                                                     | 有效证据（changes/0014）                                                                                                    |
| `out/p15-v10-screen.json`                            | 25 KiB   | `dac6ed45…9e036034`  | W4 预检：6 run × 400 tick，prereg `ece0a98b…`，budgets.ok                                                                                                                                                        | 预检通过                                                                                                                    |
| `out/p15-bifurcation-explore-middle.json`            | 69.5 KiB | `f3c6b2e6…fab656`    | 探索层：ic-middle，10 seeds × 3 mids × 3 paths = 150 run；up locked 1.0、down/control 0；mUp gap 26.7–30.5                                                                                                       | **探索证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-explore-default.json`           | 44.1 KiB | `d2d9f79a…008269`    | 探索层：ic-default，6 seeds × 3 mids × 3 paths = 90 run；up locked 1.0、down/control 0；mUp gap 33.7–39.0                                                                                                        | **探索证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-explore-bottom.json`            | 43.7 KiB | `543eb5e1…95b124`    | 探索层：ic-bottom，6 seeds × 3 mids × 3 paths = 90 run；up locked 0.833、down/control 0；mUp gap 41.3–50.0                                                                                                       | **探索证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-long-middle.json`               | 25.2 KiB | `196d5fcb…a04329`    | 探索层：ic-middle，3 seeds，后段延长到 3650 tick；up locked 1.0、down/control 0；mUp gap 35.3–37.7                                                                                                               | **探索证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-probe.json`                     | 5.7 KiB  | `5674c2b1…23db39`    | 探索层机制探针：3 seeds ×（share=0.5/1 预热 + 锁定后 w=0 恢复）= 15 run；share=0.5 锁定 3/3、share=1 0/3；恢复后仍 3/3 底层空，mUp 44.7 来自上层流动                                                             | **探索证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-repl-middle.json`               | 69.0 KiB | `1d17b8ab…f884a3`    | 复制轮：ic-middle，10 个全新 p15c 种子 × 3 mids × 3 paths = 150 run；up locked 1.0、down/control 0；mUp gap 34.7–40.7；9/9 门槛通过                                                                              | **复制证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-repl-default.json`              | 69.5 KiB | `121c6099…baee79a`   | 复制轮：ic-default，10 seeds × 3 mids × 3 paths = 150 run；up locked 1.0、down/control 0；mUp gap 29.6–37.0                                                                                                      | **复制证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-repl-bottom.json`               | 68.0 KiB | `36bef6e1…b2eeee`    | 复制轮：ic-bottom，10 seeds × 3 mids × 3 paths = 150 run；up locked 1.0、down 0；mUp gap 48.3–55.0                                                                                                               | **复制证据**（changes/0016）                                                                                                |
| `out/p15-bifurcation-policy-random-middle.json`      | 69.2 KiB | `68c6db69…6e4532`    | 策略敏感性（负）：random-uniform-v1，10 seeds × 3 mids × 3 paths = 150 run；up/down locked 0；mUp gap −1.3…+0.5，pathDependent=false                                                                             | **负结果**（changes/0016）                                                                                                  |
| `out/p15-bifurcation-policy-random-default.json`     | 69.9 KiB | `02702187…485043`    | 策略敏感性（负）：random-uniform-v1，10 seeds × 3 mids × 3 paths = 150 run；up/down locked 0；mUp gap −6.7…+2.3，pathDependent=false                                                                             | **负结果**（changes/0016）                                                                                                  |
| `out/p15-bifurcation-policy-random-bottom.json`      | 69.6 KiB | `6e5c2031…5b7023`    | 策略敏感性（负）：random-uniform-v1，10 seeds × 3 mids × 3 paths = 150 run；up/down locked 0；mUp gap 0…+6.0，pathDependent=false                                                                                | **负结果**（changes/0016）                                                                                                  |
| `out/p15-descend-threshold-explore.json`             | 42.1 KiB | `b999751f…29aa40`    | 探索层：streak≥7 门控，5 seeds × 3 paths × d∈{0,.2,.5,.8,1.2,2,4} = 175 run；up locked 1.0（全部 d）、down/control 0；up mUp 2.6–6.4                                                                             | **探索证据**（changes/0017）                                                                                                |
| `out/p15-descend-unconditional-explore.json`         | 41.2 KiB | `8034deb0…a0b238`    | 探索层：无条件 descend，同格点 175 run；d=0 时 up locked 1.0，d≥0.2 时 up/down/control 全 0；mUp 600–1446                                                                                                        | **探索证据**（changes/0017）                                                                                                |
| `out/p15-v10-policy-random-full.json`                | 864 KiB  | `12fcd1eb…0005c`     | 策略敏感性（探索）：W4 v10 格点，random-uniform-v1，6 cell × 30 seeds = 180 run；k=2 ARI 1.000、temporal 1.000（聚类保留），但 B/C P0 0.617–0.680、mUp 0.864–0.906 → 方向预测失败                                | **探索证据**（changes/0020；`exploratoryPolicySensitivity=true`）                                                           |
| `out/p15-v10-policy-unconditional-descend-full.json` | 859 KiB  | `ab123cf0…fc5b52`    | 门控消融（探索）：W4 v10 格点，仅去掉 mock 的 streak≥7 descend 门控，180 run；k=2 ARI 1.000、temporal 1.000（聚类保留），但 B/C P0 0.691–0.725、mUp 0.975–0.979 → 方向失败                                       | **探索证据**（changes/0020；`exploratoryPolicySensitivity=true`）                                                           |
| `out/p15-feedback-v10-explore.json`                  | 443 KiB  | `bc9f1f28…eeabaa`    | 探索层：rules-v10 A 体制（share=1）11 个反馈轴 × 2 IC × 10 seeds = 220 run；ic-default P0≈0.57 vs ic-middle P1≈0.55，between-IC L1 0.72–0.81，同 IC 噪声 0.10–0.24                                               | **探索证据**（changes/0021）                                                                                                |
| `out/p15-multibasin-probe.json`                      | 68 KiB   | `4836d01c…46b62a`    | 探索层：A/B/C × 4 IC × 5 seeds × 3650/7300 = 120 run；A 的多吸引域持续到 7300；B/C 的 IC 差异落入噪声；k=3 轮廓 0.538、ARI 0.964/0.886，但簇组成混合                                                             | **探索证据**（changes/0021）                                                                                                |
| `out/p15-open-feedback-explore.json`                 | 366 KiB  | `9b8088ec…65b842`    | 探索层：开放体制（share=0.5,w=10）9 个反馈轴 × 4 IC × 5 seeds = 180 run；除 congestion 外 IC 差异 < 噪声；congestion 的 3650 信号未跨视野保持                                                                    | **探索证据**（changes/0021）                                                                                                |
| `out/p15-multibasin-congestion-probe.json`           | 40 KiB   | `7ae91bd8…12b2be`    | 探索层：congestion=1 × 4 IC × 10 seeds × 3650/7300 = 80 run；聚类按视野而非 IC 分裂，否定稳定多吸引域                                                                                                            | **探索证据**（changes/0021）                                                                                                |
| `out/p15-barrier-probe.json`                         | 77 KiB   | `8bf2dd8f…3544ca`    | 探索层：开放体制壁垒扫描（cushion 90/180/365、cross120）× 4 IC × 10 seeds = 160 run；仅 cushion365 在 3650 出现 >2× 噪声的 IC 分离                                                                               | **探索证据**（changes/0022）                                                                                                |
| `out/p15-cushion365-probe.json`                      | 39 KiB   | `427d729c…1baa10`    | 探索层：cushion365 × 4 IC × 10 seeds × 3650/7300 = 80 run；3650 的 IC 分离在 7300 大多收敛，仅 top 保持独立；高壁垒是慢混合而非稳定多吸引域                                                                      | **探索证据**（changes/0022）                                                                                                |
| `out/p15-a-ic30-probe.json`                          | 55 KiB   | `dde1fad0…deb28d`    | 探索层：A-share1 × 4 IC × 30 seeds = 120 run；k=2 ARI 0.942/0.869（底重 vs 中上），k=3 ARI 0.676/0.610 不成立，k=4 0.991/0.962 仅细分两族                                                                        | **探索证据**（changes/0023）                                                                                                |
| `out/p15-w4-feature-subspace.json`                   | 14 KiB   | `3ae38cd3…4cf7c7`    | 只读 W4 180 点特征子空间：class k=3 轮廓 0.517、ARI 0.828/0.660，A/B/C 按 cell 分开；full k=3 ARI 0.757/0.522 混合 B/C；network k=2 ARI 1.000                                                                    | **探索证据**（changes/0024）                                                                                                |
| `out/p15-w5-classshare.json`                         | 86 KiB   | `0e70be3c…73ee31`    | W5 确认候选：6 cell × 30 新种子 = 180 run + 60 收敛；k=3 轮廓 0.527、ARI 0.904/0.787；temporal 0.789 < 0.80 未过；方向 6/6 过；收敛 0.833                                                                        | **确认候选未通过**（changes/0025）                                                                                          |
| `out/p15-w5-convergence-10950.json`                  | <10 KiB  | `ee72e45f…16d7aa6`   | 10950 tick 边界收敛：B-w15 25/30 同簇（全部最终在 B）；C-w60 3/30 同簇（28 个滑回 B）                                                                                                                            | **探索证据**（changes/0025）                                                                                                |
| `out/p15-w5-convergence-10950-c80-c100.json`         | <10 KiB  | `65cb9019…bd3736`    | 10950 tick 边界收敛：C-w80 8/30 同簇、C-w100 19/30；C 类随时间滑回 B                                                                                                                                             | **探索证据**（changes/0025）                                                                                                |
| `out/p15-w5-classshare-pooled.json`                  | <10 KiB  | `28b2b0a7…b49f66`    | W5 方法学复核：W4 协议 pooled w2b+w3（360 点）→ 轮廓 0.438、ARI 0.781/0.610（min 未过）、temporal 0.944；与 w3-only 对照，两种口径均未通过                                                                       | **探索证据**（changes/0026）                                                                                                |
| `out/p15-v11-ratchet-probe.json`                     | 36.6 KiB | `3fd84a2c…c500`      | 探索层：rules-v11 H 扫描，6 cell × 5 seeds × 3650/10950 = 60 run；H=0/90/180/365 在 10950 几乎重合，C 终态 P≈[0,0.24,0.40,0.20,0.15]；H 只延迟不钉住 C                                                           | **探索证据**（changes/0027）                                                                                                |
| `out/p15-longhorizon-probe.json`                     | 35.8 KiB | `9541965f…b1d81`     | 探索层：30 seeds × A/B/C × 10950 = 90 run；k=3 轮廓 0.619、ARI 1.000/1.000，A/B/C 各 30/30/30；k=2 合并 B/C；B/C L1≈0.53                                                                                         | **探索证据**（changes/0027）                                                                                                |
| `out/p15-w6-longhorizon.json`                        | 33.2 KiB | `ea01c62a…d87a7`     | **W6 确认候选通过**：p15r6 新种子，120 run；10950 终态 k=3 轮廓 0.638、ARI 0.997/0.938、A/B/C 各 30/30/30、B/C L1 0.513、方向 3/3、14600 同簇 29/30                                                              | **确认候选（非 P6-05/校准）**（changes/0028）                                                                               |

schema v2（`p15-grid-v2`）起产物分两个区块：`manifest` 为参与 `computePreregistrationHash` 的完整预注册设计（26 字段，含 `baseConfigHash`、`artifactProfile`、`cells[].fullConfigHash`、`exclusionRules`），`execution` 记录本次实际执行参数（`stage`/`totalTicks`/`seeds`/`runCount`/`warmupTicks`），`budgets` 记录预算护栏的实际值与是否越界。三者分离，才能让预检产物携带完整预注册哈希同时如实标注「只跑了 400 tick」。任何人可离线复算校验：

```bash
node -e "const d=require('./out/p15-screen.json');const{computePreregistrationHash}=require('./dist/runner/preregistration.js');console.log(computePreregistrationHash(d.manifest)===d.preregistrationHash)"
```

完整 sha256：

```text
dc6e85f9b7deadf40515d5f37ab3f4c6a1fb7640a133f9a381470c2baeac1685  out/p15-full.json
04512d7dd41a4c7f6b419b481a975542c32a90d6b3e2a8329d4dac8bea2c65b9  out/p15-full.json（prereg=2c4843b4…，已替换）
7091777fb18825b81d2c55f75a334d59205f512a7100b66829a4f468cf12697a  out/p15-full-v4draft.json
78d1cd10c19764de030e12ec65180d0f6883ffe2013f523e7a7fd8ac89811477  out/p15-screen.json（2026-11-03 修复前，已替换）
4a7fbbb26a62b26a1b2979291b8adc4382e954634cd50ef7ba4fa071aeb4d8f1  out/p15-screen.json（schema v1，已替换）
925bb44bb4f2b08d4279b70fe7bb332e05e9c56fc4f00d66ff75c3e6389b316b  out/p15-screen.json（schema v2 首版，已替换）
503f535d31949481a1e0fdeef2740cbdcc105c4ae63a125a23ddd5d8e43827ed  out/p15-screen.json（prereg=ba64e87f…，已替换）
9b5723d46769e50e94ed006fbc017172544434eeba8d347e2c845b71b21214fe  out/p15-screen.json
b999751f2773c2059302b8fff8c793fd4e0171f76a024a775a2c46622529aa40  out/p15-descend-threshold-explore.json
8034deb0988fe13a7d9bf224f31392b496a3b9135ce7296015cd3e7ed2a0b238  out/p15-descend-unconditional-explore.json
12fcd1eb09caf01225587e84120634026780341417597e0b6a71cc8d5ca0005c  out/p15-v10-policy-random-full.json
ab123cf077115e28628a3f0eac51f2b39d7fc5a83f0dbb3cace13ca241fc5b52  out/p15-v10-policy-unconditional-descend-full.json
bc9f1f282ee4e71b9e6f00051e9408f600f5612ddc02734e075f004048eeabaa  out/p15-feedback-v10-explore.json
4836d01c0fc14d9a49ed4cdedb862ab6375d0538802d80b3c9fc69ef1446b62a  out/p15-multibasin-probe.json
9b8088ec8872d023231aa728d5775e62e9970b8cfa274151943df11ed965b842  out/p15-open-feedback-explore.json
7ae91bd8fd07fab85ff6f8f81e87a1b0f8a8ed4ac4b6addf700e59dbd212b2be  out/p15-multibasin-congestion-probe.json
8bf2dd8f6399673a3f73006328a85976d0586ba563ff36e0b73c792d6b3544ca  out/p15-barrier-probe.json
427d729c444f71b62b4859602cc6f87b5f47835af36556b8e37a8e125f1baa10  out/p15-cushion365-probe.json
dde1fad0a4b682fc9349b41eb718b1cf6d0231bbd44059d10e677f2598deb28d  out/p15-a-ic30-probe.json
3ae38cd3ea250885d4a38cd18244e40ed4f12c52fe6b5b8cc8b79002e64cf7c7  out/p15-w4-feature-subspace.json
0e70be3c18ebf00ae442522f436e7a1dfcedd5ff4107c50389c25168e073ee31  out/p15-w5-classshare.json
ee72e45f35526e6c278781409da3080ff51cfedf260da810a06091fed16d7aa6  out/p15-w5-convergence-10950.json
65cb9019689fcf53104341fe5e7f9b34d02fd15f23f57bcbf468792bbebd3736  out/p15-w5-convergence-10950-c80-c100.json
28b2b0a7511fb6a799aa866f1c931c18cbd5a8effa32bd453ea3145e50b49f66  out/p15-w5-classshare-pooled.json
```

校验方式：`sha256sum out/*.json`。

## 3. 重跑程序

```bash
pnpm build
node scripts/p15-grid.mjs --stage screen   # 预检：每 cell 1 种子 × 短 tick，筛查崩溃/爆炸
node scripts/p15-grid.mjs --stage full     # 正式：按预注册 manifest 跑全部 cell × 30 种子
```

产物固定写入 `out/p15-<stage>.json`（见 `scripts/p15-grid.mjs:250-251`），不提供自定义输出路径；换名存档需手工 `git mv` 并更新本表。

## 4. 已知缺口

**已关闭（2026-11-03）**：`out/p15-full.json` 曾长期是修复前代码的产物（w2b 与
`temporalConsistency` 共 840 处为 `null`，`preregistrationHash=sha256:2c4843b4…`）。
现已按 `sha256:4dc141e4…` 重跑：w2b/w3 各 840/840 `available`，
`temporalConsistency=0.893`，`extinct=0`。判读与遗留问题见
[P1.5 报告 §10](../research/2026-11-03-p15-report.md)。

**当前缺口**：聚类稳定性的「3 次重聚类取 max / mean / min」未在预注册中冻结，
实现取 min（最保守，0.366 < 0.70 → 未通过）。这是口径缺口而非产物缺陷；
在下一次预注册显式冻结前，不得选择性引用 0.702。

### 4.1 预检重跑结果（2026-11-03）

`out/p15-screen.json` 已用修复后代码重跑（`pnpm build` + `--stage screen`）：28 个 run 全部完成，0 崩溃/爆炸；`w2b` 由 `null` 变为结构完整对象，并携带 `available` / `missingTicks` 标记。

但 screen 的 `totalTicks=400` 低于所有窗口下界，w1/w2b/w3 一律 `available=false`（missingTicks 695/730/730）。因此**预检只能证明计算路径与缺省语义正确，不能证明 w2b 产出数值**。数值验证必须走 `--stage full`（3650 tick，w2b 覆盖 1825–2554）；在此之前 `out/p15-full.json` 仍是修复前产物。

### 4.2 预检顺带修复的 schema 缺陷

首次重跑暴露出 `scripts/p15-grid.mjs` 写出的 `manifest` 只有 5 个字段，而 `PreregManifest` 定义 21 个——产物与哈希不自洽，第三方拿到 artifact 无法复算，违反 `07-experiment-calibration.md` §2「完整 manifest」要求。同时 screen 的实际执行参数（400 tick / 1 种子）被写进 `manifest`，与哈希所依据的 3650 tick × 30 种子矛盾。

`p15-grid-v2` 的处理：`manifest` 写完整预注册设计，`execution` 独立记录实际执行参数。修复后 hash 保持 `sha256:2c4843b4…` 不变（预注册设计未变），复算断言为真。

### 4.3 预注册口径修正后的重跑（2026-11-03，changes/0006）

`preregistrationHash` 发生一次**口径修正**，不是设计变更：

```text
旧 sha256:2c4843b4…（覆盖不全，无法证明产物与 manifest 一致）
新 sha256:ba64e87f13a84e82e14326f0cd181460d788ffd46e9dd60289e1f917778fccf6
```

变更是把 07 §3 要求、但此前未进哈希的字段补齐：`promptVersion`、`promptStyle`、
`baseConfigHash`、`artifactProfile`、`cells[].fullConfigHash`、`exclusionRules`；
同时 `clustering.featureWindows` 从 `['w3']` 改为 `['w2b','w3']`，
`engineVersion` 随实现修订升到 `engine-v0.3.0`。

`out/p15-screen.json` 已按新口径重跑（28 run × 400 tick，0 崩溃）：

```text
503f535d31949481a1e0fdeef2740cbdcc105c4ae63a125a23ddd5d8e43827ed  out/p15-screen.json
91785 bytes（89.6 KiB）
manifest 26 字段；budgets.ok=true（28/840 run、0/480 min、91547/2000000000 bytes）
```

新增产物字段：`budgets`（含 `observed` 与 `violations`）、`execution.warmupTicks`、
`cellDistinctness`（full 阶段才有值）。`manifests.windows` 仍为 `w2b/w3`。

**`out/p15-full.json` 未重跑**，其中 w2b 仍全为 `null`，且其
`preregistrationHash=sha256:2c4843b4…` 已不属于当前口径。按 07 §3「任何预注册内容变化
必须新建 experimentId」，它只能作为历史存档，不得用于 G1.5 判定。

### 4.4 格点设计声明（2026-11-03，changes/0007）

预注册**设计**发生一次变更（非口径修正）：退化的交互 cell
`v5:geMedian=0.7+cushion30`（`cushion=30` 恰为默认值，实际与 `v4:geMedian=0.7`
`fullConfigHash` 相同）改为 `v5:cushionDays=90+geMedian=0.7`。

```text
旧 sha256:ba64e87f…（screen 503f535d…）
新 sha256:4dc141e4b7bce47e5686f227daa5967236fed2b8e24e3b8899e123efef16722a
baseConfigHash 不变：sha256:ff00821e…
```

产物新增 `cells[].design` / `cells[].changedPaths` 与顶层 `cellsByDesign`：
单轴格点（`single`）的效应可归因到单一参数，交互格点（`interaction`）只能表述
「该联合条件下结构可达/不可达」。`out/p15-screen.json` 已按新口径重跑。

### 4.5 只读诊断脚本（2026-11-03）

`scripts/p15-diagnose.mjs` 对既有产物做离线再分析，不改产物、不跑模拟，
随机性来自 `mulberry32`，重复运行数值一致：

```bash
node scripts/p15-diagnose.mjs            # 默认读 out/p15-full.json，约 3–5 分钟
```

输出五段：特征空间 PCA 谱与 Hopkins 统计量、k∈[2,5] 的轮廓与半样本 ARI 分布、
基线阶级占比轨迹、cell 均值空间的 PC1 排序、初始条件敏感性。
用途是**下一轮预注册的设计输入**，属 07 §6.1 的探索性分析，不得用于 G1.5 判定。

### 4.6 W1 门禁与轨迹诊断（2026-11-04，rules-v6）

- `scripts/p15-gates.mjs`：W1 机制门禁 G-A/G-B/G-C/G-D（判据在 `src/runner/gates.ts` GATE_CRITERIA），
  结果分节合并写入 `out/p15-gates.json`（已入库白名单）。G-D 对照基准为
  `test/fixtures/engine/rules-v5-own-reference.json`（rules-v5 构建冻结，见 changes/0008 §6/§9）。
- `scripts/p15-gates-diagnose.mjs`：只读轨迹诊断（baseline 3 种子的 P/G/mUp/mDown 分窗轨迹），
  属 07 §6.1 探索性分析，不用于判定；G-A 未过的机制解释记录于 changes/0008 §6。

## 5. 测试 fixture 的版本约定

两类 fixture 的保留策略**不同**，此前文档混称导致「保留只读」的虚假声明：

| fixture 族                                    | 约定                                                               | 现状                                  |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `test/fixtures/config/default-rules-v*.json`  | **累加式**：升版新增文件，旧文件留在工作树                         | v3/v4/v5 三份并存，均可直接读取与断言 |
| `test/fixtures/engine/mock-run-rules-v*.json` | **改名前滚**：升版 `git mv` 到新名并就地重算，工作树只保留当前版本 | 仅 v5；v3/v4 需按 commit 取回         |

因此 `changes/0005`「v4 配置 fixture 保留只读」是**正确**的（指 config 族），
而把同一句话套用到 engine golden 上是错的。engine golden 的历史版本按下列坐标取回：

| 版本 | 最后所在提交（该提交**之前**的内容） | blob                                       | 取回命令                                                        |
| ---- | ------------------------------------ | ------------------------------------------ | --------------------------------------------------------------- |
| v3   | `192f551^`                           | `86c644313e24b17e0f40916ab82c2c886de8d895` | `git show 192f551^:test/fixtures/engine/mock-run-rules-v3.json` |
| v4   | `63fcb87^`                           | `a15a6575baf8ad8ff19b9f8957749641a82cf996` | `git show 63fcb87^:test/fixtures/engine/mock-run-rules-v4.json` |

取回的旧 golden **不能**在当前代码上断言：`validateRunConfig` 对旧 `rulesVersion`
返回 `config_unknown_version`。它的用途是配合对应提交的代码做历史复核：

```bash
git worktree add /tmp/stratify-v4 192f551^
# 在 worktree 内 pnpm install && pnpm test:coverage，再用上表哈希核对
```

不在工作树里保留旧 engine golden 是刻意选择：无测试会执行它，留着只会积累不会被读取的
死文件；而按坐标取回是可验证的，且不可能与代码脱节（因为坐标里同时钉住了提交）。
