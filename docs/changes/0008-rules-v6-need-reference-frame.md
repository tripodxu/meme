# 0008：rules-v6 需求参照系（D-06 选项 A′）

- 日期：2026-11-04
- 作者：核心/规则负责人（自主授权执行，施工说明 `research/2026-11-03-p15-w0-w1-handoff.md`）
- 关联：D-06（已定 A′）、D-07/D-08（交接单锁定）、W0（commit `6df579b`）
- 受影响版本轴：`rulesVersion: rules-v5 → rules-v6`；`engineVersion: engine-v0.3.0 → engine-v0.4.0`；
  `CONFIG_SCHEMA_VERSION: stratify-config-v2 → stratify-config-v3`；`STATE_SCHEMA_VERSION: stratify-state-v1 → stratify-state-v2`。
  `promptVersion` 不变（P2 未启动）；`HASH_DOMAINS` 全部不变（冻结哈希契约）。

## 1. 公式对照（前 → 后）

```text
# v3–v5（'own'，保留为消融模式，逐位不变）
need_i(t)       = buffer(classAge_i) × baselineSum_i × ψ_eff[class_i]
ascendCost_i    = crossDays[c] × B × E[t,c+1] × (1-discount) × openMultiplier

# v6（'class'，新默认）
refGain[c](t)     = mean{ gain_i(t) : i 存活且 class_i(t)=c }      # 空阶级保持上期值
refIncome[c](t+1) = (1-α)·refIncome[c](t) + α·refGain[c](t)        # α = need.referenceSmoothing（默认 0.2）
need_i(t)         = refIncome[class_i](t-1) × bufferDays × ψ_eff[class_i]   # 上期值，先算后用
ascendCost_i      = crossDays[c] × refIncome[c+1](t-1) × (1-discount) × openMultiplier
belowNeedStreak_i = 0 if classAge_i ≤ graceDays（仅 'class' 模式）  # 判定计时与标尺解耦
```

`ψ_eff[c] = needMultiplier[c] × (env0[c]/env0[0])^φ` 与 v4/v5 相同；持有裕度（`ascent.holdingCushionDays`，
changes/0005）公式**未改动**。`refIncome` 初值 `B×env0[c]` 由 `(config, seed)` 纯函数派生（AGENTS 6）。

修断动机（D-06 诊断）：`'own'` 语义下升阶清零标尺（免租期）且标尺随停留天数线性无界（久居者被计时器赶下去），
持有能力退化为绝对生产率测试；详见 `research/2026-11-03-p15-diagnosis-and-next-round.md`。

## 2. 新参数（注册表 3 项，`stratify-params-v1` 快照已重生成）

| 注册名                    | 单位          | 合法域                 | 默认      | 说明                                                 |
| ------------------------- | ------------- | ---------------------- | --------- | ---------------------------------------------------- |
| `need.referenceMode`      | dimensionless | enum `['own','class']` | `'class'` | `'own'` 与 v5 golden **逐位一致**（G-D 硬门禁）      |
| `need.referenceSmoothing` | dimensionless | (0,1]                  | 0.2       | refIncome EMA 系数；`'own'` 不读取                   |
| `need.graceDays`          | days          | [0,120] 整数           | 30        | 判定计时宽限期；仅 `'class'` 生效，`'own'` 按 0 处理 |

`need.bufferDays` 语义随模式分派（`'class'`：持有标尺天数；`'own'`：缓冲爬坡长度），不新增 `need.needDays`。

## 3. 状态与迁移

- `SocietyState` 增补 `readonly refIncome: number[]`（长度 C，恒 >0）；序列化/导入边界校验
  （长度 = classCount、有限、>0），`STATE_SCHEMA_VERSION='stratify-state-v2'`。
- 更新时机：阶段 C 全部 gain 算完之后（同 tick 末尾），为下一 tick 服务；**禁止同期值**（agent 顺序依赖）。
- 配置迁移：v1→v2 补 `updateMode:'dynamic'`（原样保留）；v2→v3 补
  `referenceMode:'own'`、`referenceSmoothing:0.2`、`graceDays:0`——**迁移不默认开新机制**，
  'own' + 宽限 0 与 v5 语义逐位一致。

## 4. 兼容性

- 旧配置（v1/v2 schema）：`validateRunConfig` 迁移链可读；`rulesVersion` 仍只接受当前版本，
  旧 `rules-v5` 配置整体被 `config_unknown_version` 拒绝（与 v3/v4 fixture 处理一致）。
- 旧快照（state-v1）：`decodeSimState` 拒绝（schemaVersion 不符），与既有约定一致；
  历史快照按 commit 取回。
- 旧 golden：config fixture v3/v4/v5 转历史只读（configHash 冻结值不变、paramsHash 因注册表增长
  不再可算——注册表驱动的既有行为）；engine golden 按改名前滚约定 v5→v6 重算（v6 class 语义）。

## 5. 实验可比性

- **全部 rules-v6 之前产物不可与新 run 直接比较**（状态字段、参照系语义、版本轴均变）。
- `out/p15-full.json`（v5 轮 2，840 run）标记为历史存档。
- 预注册 manifest 的 `baseConfigHash`/`fullConfigHash`/`preregistrationHash` 随默认值与版本轴全部变化；
  W2 确认轮必须重新预注册（D-07 新种子 `p15r3-seed-001…030`）。

## 6. W1 门禁实测（2026-11-04，`out/p15-gates.json`）

| 门禁 | 判据                                       | 实测                                                   | 结果             |
| ---- | ------------------------------------------ | ------------------------------------------------------ | ---------------- |
| G-D  | own 模式与 v5 逐位一致；class 可序列化往返 | 5/5 种子语义状态逐位一致、refIncome 保持初值；往返一致 | **通过**         |
| G-A  | P0(w3)≥0.15 且 mUp(w3)≤0.60（30 种子均值） | P0(w3)=**0.0000**，mUp(w3)=0.0416（30/30 可用）        | **未通过**（P0） |
| G-C  | ‖P(w2b)−P(w3)‖₁ 均值 < 0.10                | 0.1624（max 1.2141）                                   | **未通过**       |
| G-B  | P4 极差 ≥0.40 且 ≥2 个相邻档位 ‖ΔP‖₁≥0.10  | （本轮实测见 `out/p15-gates.json` B 节）               | 见产物           |

G-A 失败轨迹诊断（`scripts/p15-gates-diagnose.mjs`，3 种子）：w1 期 mUp 0.86–0.93 的人口大幅上迁，
w2b 起 P4≈0.93–0.98、P0=0 且 mDown≈0.01–0.05。机制解释：v6 class 需求线是「30 天人均生活标准」的**固定存量**，
而 changes/0005 的持有裕度门槛 `ρ×B×E[target]×ψ_eff[target]` 在 class 模式下**高于**需求线
（refIncome ≈ 0.65×B×E，裕度 ≈ 1.5×need），新升阶者必然带着高于需求线的余额进入——跌落几乎只剩竞争驱动，
上升是吸收态，底层无人补入（0→1 跨越成本+裕度 ≈ 174 ≫ 底层个体储蓄能力）且按寿命流失。
**裕度与参照系的尺度错位**是 G-A 未通过的机制根因，不是实现缺陷（own 路径由 G-D 逐位对照与公式级单测证明忠实）。

## 7. 后续处置（handoff §8，不自行决定）

- G-A/G-C 未过 → 按 handoff §8 停止：**不回填参数**（红线 4）、不跳过门禁直接跑确认轮（红线 5）。
- D-08（位移准入）是否启动、以及「裕度在 class 模式下改按 refIncome 计价」的后续规则修订，
  属规则负责人决策项，须以独立预注册（新 `experimentId`）执行；本文仅登记实测事实。
- W2 确认轮（D-07 种子）**未启动**：G-A 是 W2 资格前提。

## 8. golden 与文档更新位置

- golden：`test/fixtures/config/default-rules-v6.json`（+hashes，累加式新增）；
  `test/fixtures/engine/mock-run-rules-v6.json`（改名前滚重算，uniform3650=0.15/newborn=0 达标）；
  `test/fixtures/config/param-definitions.json`（84 项快照重生成）。
- 文档：03 §2.1/§2.2/§5/§6（公式、refIncome、graceDays）、rule.md 头注与规则 5/6/7/9/37、
  02 §3/§10（状态 v2 与迁移）、07 §8.1（W0 已冻结文本）、01 §4.5（本轮记录）。
- 测试：`test/unit/engine/reference-mode.test.ts`（13 项接线）、`test/unit/engine/own-parity.test.ts`
  （G-D 语义对照）、`test/unit/runner/gates.test.ts`（14 项门禁判定）、defense 补测参照系护栏。
- G-D 对照基准：`test/fixtures/engine/rules-v5-own-reference.json`（commit 冻结于 rules-v5 构建）。

## 9. 与交接单的偏离（显式登记，handoff §7.6）

- **G-D 对照口径**：交接单写「own 与 v5 产物 finalStateHash 逐位一致」。因 state-v2 增补 refIncome、
  config-v3 增补 3 字段、paramsHash 随注册表增长，序列化信封的哈希**不可跨版本逐位比较**；
  改为**语义状态逐字段比较**（agents 全字段 + society 除 refIncome 外全部字段，浮点 Object.is 级），
  参照 fixture 由 rules-v5 构建在升级前冻结。语义等价性主张不变，比较载体变化；
  v5 参照各 seed 的原版 `finalStateHash` 保留在 fixture 中供审计。
