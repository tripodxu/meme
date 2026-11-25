# 0009 rules-v16：代际更替与遗产折算机制（重启 P6 结构目标）

- 状态：accepted（2026-11-18，规则负责人选择路线 B）
- 决策者：徐鼎
- 关联：ADR 0008（重新立项门槛）、changes/0088、`rule.md`、docs/03、docs/07 §8.1
- 影响：`src/core` 版本轴（`rules-v16` / `engine-v0.13.0` / `stratify-config-v10`）、阶段 E 结算、事件 schema、配置注册表、P6-08 预注册确认轮
- 不改变：默认 `generationalMode='none'` 时与 `rules-v15` 运行轨迹逐位一致；状态 schema 保持 `stratify-state-v5`

## 背景

ADR 0008 要求未来若重启 P6 结构目标，必须满足三项前置条件：

1. **新立 ADR**，提出与已失败机制（`θH/θR/θS/H/share/w/behavior.*` 单代封闭模型调参）不同的假设；
2. 使用**全新预注册与全新独立 seed 集**；
3. 不追认或复用任何旧 P6-05/06/07 结果作为确认证据。

此前的全部实验在 `rules-v11`～`v15` 中均为**固定封闭人口、无出生/代际更替**：只要 `displacementShare < 1`，早期攀升者离开底层后没有新人口补入，导致底层 `P[0]` 在长视野下不可逆地归零，整个模型被迫坍缩为「`share=1` 高频换位金字塔」vs「`share<1` 底层抽空静止态」两极。

## 机制假设（路线 B）

在阶段 E（寿命与死亡）之后引入可控的**代际更替与遗产折算**（`population.generationalMode = 'none' | 'replace'`）：

1. **默认关闭保持等价**：`generationalMode='none'`（默认）、`bequestRate=0`、`classInheritanceRate=0`。关闭时不消费新随机地址、不生成新生个体，轨迹与 `rules-v15` 逐位一致。
2. **开启代际更替（`generationalMode='replace'`）**：
   - 每个在 tick `t` 因寿命耗尽死亡的个体 `d`，按 `id` 升序在阶段 E 末生成一名继承者 `child`，赋予单调递增的新 `agentId`（死亡者 ID 永不复用、`alive=false` 不可逆）；
   - 新个体消费以 `(seed, t, childId)` 寻址的独立随机流重新抽样先天 `ge`、`hard`、`initialLife`（`remainingLife = initialLife`）与行为特质，并从 `parent.value * bequestRate` 继承初始财富；
   - 新个体初始阶级按 `classInheritanceRate` 概率继承 `parent.classIndex`，否则从底层 `0` 起步（消费 `birth_class` 地址）；
   - 新个体以 `network_birth` 独立地址按当前开放度下的同层/财富权重连接至最多 `min(initialDegree, maxDegree)` 个存活且度未满的邻居，维持跨代网络拓扑不断裂，并 emit `agent_born` 事件。
3. **三类宏观结构假说**：
   - **体制 1（高频位移金字塔）**：`displacementShare=1, scarcityWeight=0`，1:1 位移维持底重分布与高流动（`Mup~0.9+`、`O~0.7+`）；
   - **体制 2（顶层寡头/开放塌缩）**：`displacementShare=0, scarcityWeight=0`（无位置壁垒），代际补入仍被快速上升抽干至顶层聚集（`P4~0.8+`、`Mup<0.15`）；
   - **体制 3（稀缺锁定橄榄中产）**：`displacementShare=0.5, scarcityWeight=30/60`，中产占据主导（`P1+P2+P3~0.85+`）、高隔离低开放。

## 预注册确认协议（P6-08）

- **实验**：`p6-08`（全新 seed 集 `p6-08-seed-001..030`，`N=40`，`10950` tick，每 cell 前 10 续跑 `14600` tick，共 `240` run）；
- **6 个参数单元**（覆盖全部 3 类体制，且体制 2 与体制 3 各含 ≥2 个参数单元以满足反预设要求）：
  - `A1_pyramid_bequest0` / `A2_pyramid_bequest50`（`share=1, w=0`，`beq∈{0, 0.5}`）
  - `B1_top_open_fresh` / `B2_top_open_dynasty`（`share=0, w=0`，`(beq, inh)∈{(0,0), (0.5,0.5)}`）
  - `C1_olive_w30_fresh` / `C2_olive_w60_dynasty`（`share=0.5, w∈{30,60}`，`(beq, inh)∈{(0,0), (0.8,1.0)}`）
- **严格验收口径（07 §8.1 `k=3`）**：`k=3` 全部簇 `>= 5` run、`ARI median >= 0.70`（同报 min）、`silhouette >= 0.35`、`14600` 同簇率 `>= 0.80`、`antiPreset=true`（非一对一预设）、`extinctRate <= 10%`。
- **科学边界**：即使 `P6-08` 通过 `k=3` 聚类候选（`three-cluster-candidate`），仍须按 `07 §8–§12` 补齐微扰吸收、五消融与 Jev 对照，方可声称完成 G6 校准。
