# 0020：W4 策略敏感性 30-seed 复算

- 日期：2026-11-04
- 作者：核心/规则负责人（用户要求「补 30 seeds」）
- 关联：W4 策略敏感性（`changes/0018`）、descend 门控消融（`changes/0019`）
- 性质：探索层（07 §6.1）；不改变 rules-v10 结算语义、预注册 manifest 或生产策略，
  不回溯改变 W4 的 G1.5 判定

## 1. 变更

1. **规模补齐**：把 `changes/0018`/`0019` 的 10 seeds/cell（各 60 run）扩到 W4 的
   完整 30 seeds/cell（各 180 run），两种替代策略各重跑一次：
   - `random-uniform-v1`；
   - `unconditional-descend`（只去掉 `belowNeedStreak>=7` 门控，保留 mock 随机流）。
2. **结果（random，180 run）**：k=2、轮廓 0.539、ARI median/min 1.000、
   temporal 1.000（180/180）、最小簇 30 run；A P0=0.960、mUp=0.693；
   B/C P0 0.617–0.680、mUp 0.864–0.906；方向预测失败
   （最差 P0 0.680、最差 mUp 0.906）。
3. **结果（unconditional-descend，180 run）**：k=2、轮廓 0.544、ARI 1.000、
   temporal 1.000、最小簇 30 run；A P0=0.966、mUp=0.906；
   B/C P0 0.691–0.725、mUp 0.975–0.979；方向预测失败
   （最差 P0 0.725、最差 mUp 0.979）。
4. **结论不变**：A vs B∪C 的聚类分裂在两种替代策略下都复现；B/C 的
   「底轻/中产」方向含义只在预注册 mock 下成立。方向失败由 descend 触发条件
   驱动，不是 random 的均匀抽样本身。

## 2. 产物替换（按 artifacts §1.4）

两个同名产物被 30-seed 版本替换：

```text
out/p15-v10-policy-random-full.json
  旧：60 run，302,989 B，sha256 a10dff5b1dad26f31d4f5c6d8fbc4b11e8f3faa6b678c22a3d12df9d3121b6de
  新：180 run，884,938 B，sha256 12fcd1eb09caf01225587e84120634026780341417597e0b6a71cc8d5ca0005c
  指标变化：ARI 1.000→1.000、temporal 1.000→1.000、轮廓 0.530→0.539；
            B/C 最差 P0 0.677→0.680、最差 mUp 0.906→0.906；结论不变

out/p15-v10-policy-unconditional-descend-full.json
  旧：60 run，300,763 B，sha256 e386bcaa69173fdf6c1b26700248ff0eef0abb5e718b0dce226641fe9cf9908e
  新：180 run，879,429 B，sha256 ab123cf077115e28628a3f0eac51f2b39d7fc5a83f0dbb3cace13ca241fc5b52
  指标变化：ARI 1.000→1.000、temporal 1.000→1.000、轮廓 0.560→0.544；
            B/C 最差 P0 0.727→0.725、最差 mUp 0.978→0.979；结论不变
```

`budgets.ok=true`（180/120 min/2e9），0 全灭；`exploratoryPolicySensitivity=true`
保持不变，仍不得引用为 G1.5 确认证据。

## 3. 版本轴与兼容性

- `rulesVersion`/`engineVersion`/`configSchemaVersion`/`promptVersion` 不变；
  无 config/state schema 变更，无迁移，无 golden 变化。
- `p15-grid.mjs` 无行为变更；仅以 `--seeds 30` 重跑。产物路径不变，按 §2 替换。
- W4 预注册 manifest 与 `preregistrationHash` 未改。

## 4. 测试与验证

- 全量 `typecheck`、`typecheck:core`、`lint`、`test`、`format`、`check:docs`、
  `build` 通过。
- 两次 180-run 均成功（各 wall 8 分钟、0 全灭、budgets.ok）；聚类与判定字段完整。
- 30-seed 的方向与 10-seed 探索一致，未出现反转。

## 5. 未完成

- 仍未测 Jev；未做 30-seed 的 `always`（descend 权重/阈值）细扫描。
- 不改变 P6-05（≥3 类）状态，不把本复算升格为 G1.5/P6 证据。

## 6. 证据

- `out/p15-v10-policy-random-full.json`（180 run，884,938 B，
  sha256 `12fcd1eb…0005c`）
- `out/p15-v10-policy-unconditional-descend-full.json`（180 run，879,429 B，
  sha256 `ab123cf0…fc5b52`）
- 研究记录：`docs/research/2026-11-04-p15-w4-policy-sensitivity.md`
- 重跑：
  `node scripts/p15-grid.mjs --manifest v10 --stage full --policy random-uniform-v1 --seeds 30`
  与
  `node scripts/p15-grid.mjs --manifest v10 --stage full --policy unconditional-descend --seeds 30`
