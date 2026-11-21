# 0039：Stage B 开跑实测触发 D-04 v2 重冻结；6 个确认 manifest 以 v2 预算重新冻结

- 日期：2026-11-05
- 作者：Runner/实验负责人（自主授权）
- 关联：D-04 §4/§5（01 §12）、changes/0036（v1）/0037/0038、07 §8（statsStride=1）
- 性质：**实验预算重冻结**；预注册纪律的预期内执行（v1 冻结时就写明了重冻结条件）

## 1. 事实

- Stage B 首个确认（env0=expanded，experimentId `p6-stageB-env0-expanded-66918ef0`）
  实测 **~4.5 min/run**（1000 人 × 3650 tick，statsStride=1 全分辨率统计 + 四窗口聚合
  - 标签计算），60 run ≈ 275 min——超出 v1 的 240 min；
- 偏差来源：基准（docs/benchmarks/2026-11-05-p5a-engine.md）按 statsStride=10 测得
  120 s/run；07 §8 要求确认 run `statsStride=1`，全分辨率逐 tick 统计（基尼/网络/
  分层指标 × 1000 人 × 3650 tick）是基准未覆盖的成本。偏差 +130% > 50% 阈值；
- **处置**：停止在跑批次（11 run 归属旧 experimentId 作废留档）；按 §4 重冻结为
  D-04 v2（Stage B maxWallMinutes 240 → 480，maxRuns/存储不变）；全部 6 个确认
  manifest 以 v2 预算重新冻结（新 experimentId，见 §2）。

## 2. v2 冻结清单（experimentId → preregistrationHash）

| cellKey           | experimentId                           | prereg hash        |
| ----------------- | -------------------------------------- | ------------------ |
| env0=expanded     | `p6-stageB-env0-expanded-b8aef285`     | `sha256:b8aef285…` |
| env0=compressed   | `p6-stageB-env0-compressed-fa37f21d`   | `sha256:fa37f21d…` |
| crossDays=half    | `p6-stageB-crossDays-half-c1206246`    | `sha256:c1206246…` |
| crossDays=double  | `p6-stageB-crossDays-double-011657cf`  | `sha256:011657cf…` |
| psi=1             | `p6-stageB-psi-1-bcde3589`             | `sha256:bcde3589…` |
| needThreshold=0.9 | `p6-stageB-needThreshold-0-9-dbb0b30a` | `sha256:dbb0b30a…` |

## 3. 纪律要点

- 预注册哈希含 budgets 字段——预算变更必然新 experimentId（07 §3）；
  作废 run 不删除、不冒充新实验的产物（旧 ledger 留档后清理）；
- 确认种子集 p6-stageB-seed-001…030 不变（与 Stage A 的分离纪律不受重冻结影响）；
- v2 的 480 min ≈ 实测 275 min × 1.7 余量；后续单元（~275 min/个）逐个执行。

## 4. 验证

- `--freeze` 六连跑哈希与 experimentId 落盘（out/p6-stageB-prereg-*.json 已重写）；
- env0=expanded 确认轮已在 v2 预算下重启（ledger 断点续跑可用）。
