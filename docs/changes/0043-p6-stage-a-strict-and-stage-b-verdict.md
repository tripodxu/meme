# 0043：P6-01 Stage A 严格口径重算、TV 方向裁决与 Stage B 判定

- 日期：2026-11-05
- 作者：Runner/实验负责人（严格口径恢复）
- 关联：P6-01（01 §9）、07 §8/§9、changes/0039–0042、`docs/reviews/2026-11-05-zcodes114-commit-audit.md`
- 性质：**判读口径纠正与结果更新**；不修改规则、引擎、参数或预注册 run 数据

## 1. Stage A 严格重算

旧 Stage A 用「任意指标」筛选：12 个入选对中 11 个不满足主指标 `TV(P) ≥ 0.10`。
按 07 主指标重算（w1、30 配对种子、固定种子 10,000 次 bootstrap、完整性校验）：

| 人口 | cell              | TV(P) 中位数 | 95% 区间         | 判定              |
| ---- | ----------------- | ------------ | ---------------- | ----------------- |
| 40   | needThreshold=0.3 | 0.1021       | [0.0944, 0.1090] | TV 过门槛（边界） |
| 40   | needThreshold=0.9 | 0.1797       | [0.1538, 0.1944] | TV 过门槛         |
| 200  | needThreshold=0.9 | 0.1683       | [0.1574, 0.1715] | TV 过门槛         |

其余 10 个 cell（psi=1、env0=expanded/compressed、crossDays=half/double、needThreshold=0.7、needMult/decay 各档）全部低于 0.10。旧 12 个入选对中仅 `needThreshold=0.9@200` 保留。

## 2. TV 方向裁决

TV(P) 是非负距离，方向不能直接取符号。用三种定义复核：

| 定义                                 | 0.9@40            | 0.9@200           | 0.3@40                    | 0.3@200          |
| ------------------------------------ | ----------------- | ----------------- | ------------------------- | ---------------- |
| N/A（TV 方向不适用）                 | 通过              | 通过              | 通过                      | 通过             |
| **每对主导阶级 + 同号 ≥90%（采用）** | 30/30 类别0、同号 | 30/30 类别0、同号 | 主导阶级 0:18 / 2:11，60% | 0:16 / 2:14，53% |
| 固定中位主导阶级同号                 | 100%              | 100%              | 100%                      | 100%             |

**裁决：采用「每对主导阶级 + 同号 ≥90%」。**

- `needThreshold=0.9` 在 40/200 两个人口都是 30/30 主导类别 0、全部同号，方向稳健；
- `needThreshold=0.3` 的效应在类别 0 与类别 2 之间分裂，不构成单一方向，**淘汰出确认候选，降为 exploratory**；
- 「固定中位主导阶级」会掩盖双峰，不作为主口径。

**Stage B 候选集：`needThreshold=0.9`。** 其余候选（env0、crossDays、psi=1）在 Stage A 主指标或方向裁决中已被排除。

## 3. Stage B 判定（严格 07 + 方向规则）

| 单元                  | TV(P) 中位数 | 95% 区间             | 主导方向                  | 超波动带 | 判定     |
| --------------------- | ------------ | -------------------- | ------------------------- | -------- | -------- |
| env0=expanded         | 0.0647       | [0.0574, 0.0692]     | —                         | 100%     | 未确认   |
| env0=compressed       | 0.0560       | [0.0528, 0.0571]     | —                         | 100%     | 未确认   |
| crossDays=half        | 0.0043       | [0.0038, 0.0052]     | —                         | 0%       | 未确认   |
| crossDays=double      | 0.0057       | [0.0040, 0.0069]     | —                         | 16.7%    | 未确认   |
| psi=1                 | 0.0881       | [0.0837, 0.0891]     | 类别0:8 / 类别2:22（73%） | 100%     | 未确认   |
| **needThreshold=0.9** | **0.1553**   | **[0.1494, 0.1587]** | **类别0 30/30、同号**     | **100%** | **确认** |

- `needThreshold=0.9`：60/60 run、0 失败/灭绝/回退；TV(P)=0.1553 ≥ 0.10，区间不跨 0，主导阶级方向 30/30 同号，100% 超 baseline 波动带 → **07 严格口径确认**。
- `psi=1`：TV(P)=0.0881 < 0.10；方向也分裂（类别 0 与类别 2），即使放宽 TV 也不满足方向规则。
- `crossDays=double`：TV(P)=0.0057；与 crossDays=half 一起构成 crossDays 轴双向负结果。
- env0 两单元此前已按 TV 撤回；crossDays=half 维持未确认。

**P6-01 当前：1 个确认效应（needThreshold=0.9），5 个未确认/exploratory。G6 仍未通过（P6-05 未开始）。**

## 4. 代码与产物

- 新增 `src/runner/p6-analysis.ts#evaluateStageA` 与 `scripts/p6-stage-a.mjs --analyze-strict`；
- 新增 `scripts/p6-stage-b.mjs --slim`，把 3.9 MiB summary 瘦身为 1.6–1.7 MiB slim；
- 新增严格分析产物：
  - `out/p6-stageA-analysis-strict.json`（109,894 bytes，sha256 `0f0048e0…a5b9`）；
  - `out/p6-stageB-slim-needThreshold-0-9.json`（1,717,012 bytes，sha256 `828e5df1…2a2c`）；
  - `out/p6-stageB-slim-psi-1.json`（1,721,992 bytes，sha256 `a2008f54…1ccd`）；
  - `out/p6-stageB-slim-crossDays-double.json`（1,713,460 bytes，sha256 `e7012318…2e19`）；
  - 对应 analysis JSON 三个（约 6 KiB each）。
- 旧 `out/p6-stageA-analysis.json` 保留为历史口径，不再用于候选。

## 5. 预注册与重冻结说明

- `needThreshold=0.9` 的 Stage B manifest 内容（cell、阈值、种子）不变，`preregistrationHash` 仍为 `sha256:dbb0b30a…`；**不新建 experimentId、不作废当前 60-run 数据**。
- TV 方向规则是 07 的分析层操作化（Stage A 后、Stage B 判读前裁决），写入本记录；未写入 manifest 哈希，避免无谓重跑。
- `needThreshold=0.3` 不冻结 Stage B；除非以新预注册重新提出。

## 6. 影响

- 旧「六单元确认」计划彻底作废；Stage B 的确认候选只有 `needThreshold=0.9`。
- P6-01 首次得到 1 个符合 07 主指标与方向规则的确认效应；不代表三类结构或校准，G6 仍未通过。
- crossDays 轴双向失败、psi=1 方向分裂、env0 两单元主指标不足，均记录为负结果/exploratory。
- 不改变 `rules-v11` / `engine-v0.9.0` / `stratify-config-v6` / 任何 `configHash`。
