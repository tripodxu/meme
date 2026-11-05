# P6-01 Stage B 结果：crossDays=double 未确认（2026-11-05）

- experimentId：`p6-stageB-crossDays-double-011657cf`（prereg `sha256:011657cf…`，D-04 v2 预算）
- 规模：baseline + crossDays=double × 30 独立确认种子 × 1000 人 × 3650 tick
  = **60 run 全成功**（30 baseline 复用 + 30 candidate；0 技术失败）；wall **74.7 min**
- 判定口径：changes/0043 的 07 严格口径 + TV 方向规则

## 判定：**未确认**

| 条件                     | 结果                                        |
| ------------------------ | ------------------------------------------- |
| 主指标 TV(P) ≥ 0.10      | ❌ 中位数 **0.0057**                        |
| bootstrap 95% 区间不跨 0 | ✅ [0.0040, 0.0069]（不跨 0，但远低于门槛） |
| 超出 baseline 波动带     | ❌ **16.7%**                                |
| 非伪影                   | ✅ 0 灭绝/回退/缺窗口                       |

## crossDays 轴的双向负结果

| 单元             | Stage A TV（40/200） | Stage B TV（1000） | 判定   |
| ---------------- | -------------------- | ------------------ | ------ |
| crossDays=half   | 0.0124 / 0.0066      | 0.0043             | 未确认 |
| crossDays=double | 0.0123 / 0.0046      | 0.0057             | 未确认 |

Stage A 的 crossDays 信号（Mup 通道）在 1000 人 × 3650 tick 下双向消失；
crossDays 轴不再作为确认候选，若继续研究需新的机制假设。

## 产物

- `out/p6-stageB-slim-crossDays-double.json`（1.63 MiB，sha256 `e7012318…`）
- `out/p6-stageB-analysis-crossDays-double.json`（6.0 KiB）
- prereg `out/p6-stageB-prereg-crossDays-double.json`（4.5 KiB）
