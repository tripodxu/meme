# 0009：rules-v7 裕度参照系统一计价（D-06 A′ 单变量收尾）

- 日期：2026-11-04
- 作者：核心/规则负责人（自主授权执行；上游依据 changes/0008 §6/§7 的决策项）
- 关联：D-06（A′ 收尾）、D-08（判定树，见 0010）
- 受影响版本轴：`rulesVersion: rules-v6 → rules-v7`；`engineVersion: engine-v0.4.0 → engine-v0.5.0`。
  `CONFIG_SCHEMA_VERSION`（v3）与 `STATE_SCHEMA_VERSION`（v2）**不变**（无新字段、无新参数）。

## 1. 变更内容

`computeAscendCushion` 参照量随 `need.referenceMode` 分派：

```text
# v6（裕度仍按旧单位计价——0008 实测的尺度错位根源）
cushion = ρ × B × E[t,target] × ψ_eff[target]          # ≈ 1.5× need（refIncome ≈ 0.65×B×E）

# v7（裕度与需求线同参照系）
'class' 模式：cushion = ρ × refIncome[target] × ψ_eff[target]
'own'   模式：cushion = ρ × B × E[t,target] × ψ_eff[target]   # 逐位 = v5（G-D）
```

`ρ=bufferDays=30` 时到岸余额恰为 `1.0×need = 2×跌落阈值`，名义上恢复跌落通道。

## 2. 门禁实测（`out/p15-gates.json`，30 种子）

| 门禁             | v6 实测（0008） | v7 实测                            | 结果     |
| ---------------- | --------------- | ---------------------------------- | -------- |
| G-A P0(w3)≥0.15  | 0.0000          | **0.0000**                         | **未过** |
| G-A mUp(w3)≤0.60 | 0.0416          | 0.0880                             | 达标     |
| G-B P4 极差≥0.40 | 0.3070          | **0.6327**（7 个相邻档位对 ≥0.10） | **通过** |
| G-C ‖ΔP‖₁<0.10   | 0.1624          | 0.4158                             | **未过** |
| G-D own 逐位     | 通过            | **通过**（5/5 种子逐位一致）       | 通过     |

## 3. 结论（单变量证据）

- **G-B 由 0.307 → 0.6327 转为通过**：参照系统一计价打开了参数响应面（bufferDays=60 →
  P4 0.649 等），D-06 A′ 的核心机制有效。
- **G-A 的 P0 仍为 0、G-C 恶化（0.16→0.42）**：裕度=need 后到岸余额为 2× 跌落阈值，
  但竞争频次（mock 策略约 0.5–0.8 次/44 天）远低于击穿所需的约 9 次净损失——
  **纯比例（乘性）机制在 income>0 时不会产生下行流**，梯子仍只上不下。
- 判定树前提（「相对单位已就位」）至此成立，按 diagnosis §8 判定树启动
  **位移准入（D-09，changes/0010）** 作为第二级，而非继续调参（红线 4）。

## 4. 兼容性与实验可比性

- rules-v6 产物（含 `out/p15-gates.json` 旧分节）不可与 v7 直接比较（版本轴已变）。
- golden：`default-rules-v7.json` 累加式新增；engine golden 改名前滚 v7；
  v6 入历史只读——v7 未增删参数，**v6 fixture 的 paramsHash 仍可计算且与冻结记录一致**
  （paramsHash 覆盖 name/unit/value，不含 formulaRef 文本）。
- 测试：cushion 参照系分派守卫（class/own 双路径）、迁移测试 rulesVersion 跟随。

## 5. 文档位置

03 §5（裕度参照量分派）、rule.md 9、params 注册表 `ascent.holdingCushionDays` formulaRef、
01 §4.5 本轮记录。
