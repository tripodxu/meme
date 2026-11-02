# 0005 rules-v5：上升资格绑定目标阶级持有裕度（D-05 方向 B）

- 日期：2026-11-03
- 类型：规则行为变更（`rulesVersion: rules-v4 → rules-v5`，`engineVersion: engine-v0.1.0 → engine-v0.2.0`）
- 依据：P1.5 v4 复核（`docs/research/2026-11-03-p15-report.md` §8）——三轮预注册实验（1920 run）
  证明旋转门引擎（积累无上界 + 被动跌落携带财富并重置需求时钟 + mock 无条件上升）使 Mup→1
  与参数无关，低流动性盆地不可达。D-05 登记于 01 §12；本变更由用户授权的自主规则负责人
  选择方向 B 执行。

## 变更内容

**上升资格门槛（rule.md 9 / 03 §5）**：

```text
ascend 合法 ⇔ classIndex < C-1 且 value >= cross + ρ × B × E[t,target] × ψ_eff[target]
cross = crossDays[c]×B×E[t,c+1]×(1−discount)×openMultiplier   （实际支付，不变）
ψ_eff[target] = ψ[target] × (env0[target]/env0[0])^φ           （v4 乘子，复用）
ρ = ascent.holdingCushionDays                                  （新参数，默认 30，域 [0,365] 整数）
```

- 裕度是**余额门槛**而非支付：支付额仍为 cross；执行前复核同样要求
  `value >= cross + cushion`，失效记 `stale_invalid(reason=insufficient_cushion)`。
- `ρ=0` 精确退回 v4 语义（消融值）。
- 动机：切断"积累无上界 → 费用终可负担 → 无条件上升"的旋转门引擎——
  上升资格与个人生产力/财富挂钩，形成 rule.md 45 的双盆地
  （高生产力个体维持流动，低生产力个体停留在可持续阶级）。

## 未采纳方向

- A（被动跌落财富清偿）：只削弱旋转门而不切断（无界积累仍在）。
- C（积累承载上限）：引入财富上限语义，偏离 rule.md 1–4 的自由积累框架，留作 v6 候选。

## 兼容性

- `rules-v4` 及更早配置不再被接受（`config_unknown_version`）；v4 golden fixture 保留只读。
- 默认配置 hash 变化（新增 `ascent.holdingCushionDays`）。
- 合法行动集语义变化影响 `actionSetHash` 与 Jev state 的 `costs.ascend` 可用性
  （最高层或裕度不足时为 null）——P2 未实现，无兼容负担。

## golden 与测试

- `default-rules-v5.json/.hashes.json` 新建；v4 fixture 保留只读。
- `mock-run-rules-v5.json` 重新生成。
- 参数快照重新生成（新增 `ascent.holdingCushionDays`）。
- 接线测试：`ρ=0` 与 v4 逐位一致；`ρ>0` 时裕度不足的个体无 ascend 行动，
  引擎执行前复核抛 `insufficient_cushion`。
