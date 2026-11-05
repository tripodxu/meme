# P6-01 Stage B 结果：needThreshold=0.9 确认（2026-11-05）

- experimentId：`p6-stageB-needThreshold-0-9-dbb0b30a`（prereg `sha256:dbb0b30a…`，D-04 v2 预算）
- 规模：baseline + needThreshold=0.9 × 30 独立确认种子 × 1000 人 × 3650 tick = **60 run 全成功**
  （0 技术失败、0 灭绝、0 回退）；wall **161.4 min**（预算 480 min）
- 窗口：w2b（1825–2554）主判定；w3 仅作相邻窗口描述（07 §8 第 4 条）
- 判读口径：changes/0043 的 07 严格口径 + TV 方向规则（每对主导阶级 + 同号 ≥90%）
- **声明：本报告是效应确认层；不构成三类结构结论、校准或 P6-05 验收（AGENTS #9）。**

## 1. 判定：**确认**

| 条件                         | 结果                        |
| ---------------------------- | --------------------------- |
| 主指标 TV(P) ≥ 0.10          | ✅ 中位数 **0.1553**        |
| bootstrap 95% 区间不跨 0     | ✅ [0.1494, 0.1587]         |
| 方向（主导阶级 + 同号 ≥90%） | ✅ 30/30 为类别 0、全部同号 |
| 超出 baseline 波动带         | ✅ 100%                     |
| 非伪影                       | ✅ 0 灭绝、0 回退、0 缺窗口 |

## 2. 与 Stage A 的对照

- Stage A 200 人：TV(P)=0.1683，CI [0.1574, 0.1715]，主导类别 0、30/30 同号；
- Stage B 1000 人 × 3650 tick：TV(P)=0.1553，CI [0.1494, 0.1587]，主导类别 0、30/30 同号；
- 方向与量级在更大人口/更长视野下保持，未出现 crossDays 式的效应消失。

## 3. 队列状态

| cell                       | 状态                                |
| -------------------------- | ----------------------------------- |
| **needThreshold=0.9**      | ✅ **确认**（本报告）               |
| env0=expanded / compressed | 未确认（TV 0.0647 / 0.0560 < 0.10） |
| crossDays=half             | 未确认（TV 0.0043）                 |
| crossDays=double           | 未确认（TV 0.0057）                 |
| psi=1                      | 未确认（TV 0.0881；方向分裂）       |

P6-01 当前：**1 个确认效应（needThreshold=0.9）**；G6 仍未通过（P6-05 未开始）。

## 4. 复现与产物

- 复现：`node scripts/p6-stage-b.mjs --freeze "needThreshold=0.9" && node
scripts/p6-stage-b.mjs --run "needThreshold=0.9" && node scripts/p6-stage-b.mjs
--slim "needThreshold=0.9" && node scripts/p6-stage-b.mjs --analyze "needThreshold=0.9"`
- 产物：`out/p6-stageB-slim-needThreshold-0-9.json`（1.64 MiB，sha256 `c50e4c60…`）、
  `out/p6-stageB-analysis-needThreshold-0-9.json`（6.0 KiB）、prereg（4.4 KiB）。

## 5. 多重比较说明

六个 Stage B 单元共用同一组 `p6-stageB` 确认种子，未对六个单元做跨单元 BH 校正；
每个单元是独立 experimentId 的确认轮。`needThreshold=0.9` 的符号翻转置换 p≈3e-5，
即使按 q=0.05 对六单元做 BH 也不会改变其确认；其余五单元未达主指标门槛，
不因未校正而改判。本说明不构成“已完成 BH”或校准声明（07 §9）。
