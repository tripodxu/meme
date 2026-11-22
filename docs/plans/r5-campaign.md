# R5 大规模实验战役计划（2026-11-22 提案，待批准）

> 状态：**提案，尚未运行**。G6 仍未通过；P6-13 十项消融 `median TV(P)` 全部 <0.10，
> P6-12/P6-13 的两体制仍是 `share=1` vs `share<1` 的单轴分裂。本战役全部为
> exploratory/characterization，任何确认轮都必须另立 ADR、全新预注册与全新 seed。
> 全部实验在上海 VPS（`lhsh`）执行；本地只编译、单测、离线复算。

## 0. 目标

回答四个尚未被大规模数据回答的问题：

1. **第三类结构到底存不存在**：在 `(share, w)` 二维相图上，是否存在一个既非
   `share=1`、也非 `share<1` 连续统的稳定盆地？
2. **两体制是不是有限规模/有限时程假象**：N=200→1000→3000、3650→10950→21900
   时，k=2 组成与 TV(P) 是否收敛，k=3 第三簇是否消失？
3. **代际通道（ADR 0009）从未在 N≥200 上检验**：`replace` + 遗产/出身继承/
   天赋传递能否产生稳定第三簇或至少 `TV(P)≥0.10` 的消融效应？
4. **微扰吸收的边界在哪**：1e-4 全吸收，扩大到 1e-6…1 时何时出现结构放大？

不承诺任何一项能关闭 G6；负结果按纪律归档，不调参凑数。

## 1. 通用协议

- 规则：`rules-v18`（P6-12/P6-13 基线），`mock-weighted-v1`，除非实验显式改策略。
- 初始人口/网络/年龄仍由 `(config, seed)` 派生；所有 seed 为全新命名空间。
- 特征：11 维（P0..P4、G、top10、Mup、Mdown、S、O），末 365 天均值；
  聚类 Ward-LW + pooled z-score + 20 次二分洗牌。
- 每个 task 完成后立即写 `out/r5/<exp>/parts/<taskKey>.json`（tmp+rename 原子替换）；
  启动时加载分片、按 task 去重、只补缺失 task；每个实验再汇总 `raw.json`/`result.json`。
- 预注册：每个实验启动前冻结 `out/r5/<exp>/prereg.json`（含设计、cell、seed 列表、
  configHash、gate），hash 不一致拒绝运行；设计变更必须新实验 id + 新 seed。
- 并发按 N 自适应：N≤200 用 4 worker，N=1000 用 2，N≥3000 用 1；启动批次前检查
  `MemAvailable`，低于 800 MB 则等待/降并发；单进程 RSS 超过 4.3 GB 触发内存守卫。
- 预算：总 run 约 3,000–3,700；wall ≤ 7 天；存储 ≤ 20 GB；任何实验可中断续跑。

## 2. 实验清单与设计

### E1 `r5-phase-n200` —— (share × w) 二维相图（优先级最高）

- Cell：`share ∈ {0.3, 0.5, 0.7, 0.85, 0.95, 1.0}` ×
  `w = scarcityWeight ∈ {0, 15, 30, 45, 60}` = 30 cell。
- N=200，3650 tick，30 个新 seed（`r5-phase-s001..030`），900 run。
- 主指标：cell 均值 P、相邻 w 的 TV(P)、沿 w 的序参量曲线；k=2/k=3 聚类。
- 候选第三盆地判据：k=3 簇 ≥5、ARI≥0.70、silhouette≥0.35、同簇率≥0.80，
  且簇组成不是单一 cell；否则记负结果。
- 预计：4 worker，约 3–5 h。

### E2 `r5-robust-n200` —— 结构对 C / 策略的稳健性

- A 组：`classCount ∈ {4,6,8}` × 6 个规范 cell（A–F）× 30 seed × N=200 × 3650 = 540 run。
- B 组：策略 `{mock-v1, mock-v2, random}` × 6 cell × 30 seed × N=200 × 3650 = 540 run。
- seed：`r5-robust-s001..030`；共 1,080 run，4 worker，约 4–6 h。
- 判读：k=2 组成与 TV(P) 是否仍是 A vs B–F；若换 C/策略后分裂消失，说明两体制
  依赖 C=5 或 mock 权重，不能当作一般结构。

### E3 `r5-scale` —— 有限规模标定

- N ∈ {200, 1000, 3000} × 6 cell（A–F）× 30 seed × 3650 tick = 540 run；
  seed：`r5-scale-s001..030`。
- 并发：N=200 4 worker、N=1000 2 worker、N=3000 1 worker（预计 N=3000 段最慢）。
- 判读：k=2 簇组成、TV(P) 随 N 的收敛；k=3 第三簇是否随 N 消失（检验
  “第三簇是有限样本噪声”假说）。

### E4 `r5-horizon` —— 有限时程标定

- N=200 × 6 cell × 30 seed × {10950, 21900} tick = 360 run；
  seed：`r5-horizon-s001..030`。
- 判读：TV(P)/体制分离是否随 horizon 收敛，k=3 是否出现。

### E5 `r5-gen-n1000` —— 代际通道规模化（ADR 0009 核心假设）

- 8 cell：`none` 对照；`replace`；`replace+beq0.5`；`replace+beq0.8`；
  `replace+inh0.5`；`replace+inh1.0`；`replace+beq0.5+inh0.5+talent1.0`；
  `replace+beq0.8+inh1.0+talent1.5`。
- N=1000，30 seed（`r5-gen-s001..030`），base 10950 tick；每 cell 前 10 seed 续跑
  14600 tick；共 240 base + 80 followup = 320 run；2 worker，约 1 天。
- 判读：k=3 门槛；以及关闭 bequest/inheritance/talent 后的 `median TV(P)` 是否 ≥0.10
  （机制解释力）。若没有，按负结果归档。

### E6 `r5-pert` —— 微扰幅度→盆地边界

- N=200 段：2 体制 × 幅度 `{1e-6, 1e-4, 1e-2, 1e-1, 1}` × 30 对 × 3650 tick
  = 300 对（600 run），约 2–3 h。
- N=1000 段：只对 N=200 显示出边界/放大的幅度（至少包含 1e-2、1e-1）做复核，
  2 体制 × 3 幅度 × 30 对 = 180 对（360 run），2 worker，约 12–15 h。
- 判读：吸收率、median D/TV 随幅度的变化；定义临界幅度（吸收率 <0.95 的最小幅度）。

### E7 `r5-phase-n1000` —— 相图候选的 N=1000 复核（条件执行）

- 仅当 E1 出现候选第三盆地或沿 w 的明显非单调/双峰时执行：
  候选 cell（6–12 个）× 30 新 seed（`r5-phase2-s001..030`）× N=1000 × 10950 tick
  = 180–360 run；2 worker，约 1 天。
- 若 E1 全为连续变化，跳过 E7 并把“无第三盆地”作为负结论归档。

### E8 `r5-jev-dose` —— Jev 剂量/时程（条件执行，默认不跑）

- N=200，3650 tick，prompt ∈ {neutral, survival_hint, survival_strong}，30 配对 seed，
  90 live run + 30 mock；token 成本约为 P6-14 的 5 倍。
- 仅当 Jev 配额稳定、且用户明确批准时立项；需要新预注册（可复用 ADR 0013 框架）。
- 本战役的自动队列**不包含** E8。

## 3. 执行顺序（连续队列）

```text
Wave A（N=200，约 10–12 h）
  E1 phase-n200 (900)
  E2 robust-n200 (1080)
  E4 horizon (360)
  E3 scale 的 N=200 段 (180)

Wave B（N=1000，约 2–3 天）
  E5 gen-n1000 (320)
  E3 scale 的 N=1000 段 (180)
  E6 pert 的 N=1000 段 (360)
  E7 phase-n1000（条件，0–360）

Wave C（N=3000，约 1.5–2 天）
  E3 scale 的 N=3000 段 (180)

总计约 2,900–3,700 run；4–6 天。
```

队列由 `scripts/r5-campaign.mjs` 顺序消费；每个实验完成即写 `result.json`，
失败/门禁未过也继续下一个实验，不阻塞队列。E7 由 E1 结果自动决定是否入队。
全程可随时 Ctrl-C / OOM 后重跑同一条命令续跑。

## 4. 工程实现

- 新增 `scripts/r5-campaign.mjs`：
  - `--freeze` 冻结全部实验的 prereg（或单实验）；
  - `--run` 顺序执行队列；
  - `--analyze <exp>` 离线复算；
  - 任务级分片、manifest、内存守卫、N 自适应并发、失败重试上限。
- 复用 P6-13 的 `parts` 持久化模式；每实验目录 `out/r5/<exp>/`。
- 监控：`r5-campaign.log` 每个 task 一行；`out/r5/state.json` 记录实验完成/失败/
  跳过；内存与 RSS 每 5 分钟写入 `r5-health.log`。
- 看门狗（可选）：cron 每 15 分钟检查队列进程是否存在，若不在且未标记完成，
  用同一命令重启（最多 5 次，防止 OOM 循环）。

## 5. 判读与交付

- 每个实验产出 `result.json` + `runs.ndjson` + 简短判读；所有负结果照实记录。
- 若 E1/E5 出现候选第三簇：另立 ADR、冻结确认轮（240 run 起）、全新 seed；
  不把 exploratory 结果升格为 G6 确认。
- 若全部为负：把“现有规则族在 N≤3000、时程≤21900 内不存在稳定第三类结构”
  作为负结论归档，G6 保持未通过。
- 交付：本计划、campaign runner、每实验 prereg/结果、changes 文档、AGENTS 更新。

## 6. 风险

- **OOM**：N=1000 4 worker 曾在 5.7 GB 被杀；本计划 N=1000 上限 2 worker、
  N=3000 上限 1 worker，且任务级分片可续跑。
- **时长**：完整队列 4–6 天；VPS 还承载其他服务，load 高时自动降并发/等待。
- **科学风险**：大概率仍是无第三簇的负结果；这正是要回答的问题，不能靠调参避免。
- **Jev 配额**：E8 默认不跑，不影响 Wave A–C。

## 7. 批准后第一步

1. 实现 `scripts/r5-campaign.mjs` 与 prereg 冻结；
2. 本地 `node --check`、format/lint、单测；不跑仿真；
3. 同步到 VPS `~/stratify-r5`（独立目录，避免影响现有产物）；
4. 先启动 Wave A，观察 30 分钟内存/进度后保持连续运行；
5. 每日汇总一次，不逐 task 打扰。
