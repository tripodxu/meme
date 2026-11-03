# 0010：rules-v8 位移准入（D-09，diagnosis §8 判定树 prescribed）

- 日期：2026-11-04
- 作者：核心/规则负责人（自主授权执行；D-08/D-09 判定顺序由
  `research/2026-11-03-p15-diagnosis-and-next-round.md` §8 写死）
- 关联：D-08（G-A/G-B 未过 → 启动位移准入，独立记账）、D-09（本次启动登记）
- 受影响版本轴：`rulesVersion: rules-v7 → rules-v8`；`engineVersion: engine-v0.5.0 → engine-v0.6.0`。
  `CONFIG_SCHEMA_VERSION`（v3）与 `STATE_SCHEMA_VERSION`（v2）**不变**（无新参数、无新状态字段）。

## 1. 机制定义（唯一权威口径）

**'class' 参照系下，上升准入从「财富可负担」升级为「财富可负担 + 击败目标阶级在位者」**：

1. 攻击方通过费用 + 裕度复核后，按地址化 RNG `R(seed,tick,agentId,"displacement_target",0)`
   从目标阶级当前存活者（工作副本，池序 = agentId 升序）均匀抽样一名**在位者**；
   目标阶级为空 → 无对手，直接准入（边界扩张，不消费 competitionResolve 地址以外的新地址）。
2. 对决复用 rule.md 12–19 竞争结算（`resolveCompetition`：logPower、跨层乘子、方向乘子、
   败者损失 `lossRate×value`、胜者收益 `loss×baseTransferEfficiency×directionMultiplier`），
   消费攻击方的 `competition_resolve` 地址（该 tick 攻击方未发起竞争，地址空闲）。
3. **攻击方获胜** → 在位者降级到攻击方原阶级：`classIndex-=1`、`classAge/baselineSum/belowNeedStreak`
   清零、`lastDescentTick=tick`（计入 Mdown 与流动窗口）、`maxClassIndex` 不变；
   事件 `class_descended` reason `'passive'`（被动降级，事件 schema 不扩展）。
   攻击方随后支付 cross 并升阶（原路径不变）。
4. **攻击方失败** → 准入失败：不支付 cross、不升阶；对决财富转移已结算；
   事件 `action_invalid` reason `'displacement_lost'`、执行记录 `stale_invalid/displacement_lost`
   （status 联合不扩展，reason 为自由字符串）。
5. **'own' 模式不进入该分支、不消费 `displacement_target` 与 `competition_resolve`
   新消费**——RNG 流与 v5 逐位一致（G-D 硬门禁，实测 5/5 种子逐位一致保持）。

## 2. 设计理由

- changes/0009 实测证明：参照系统一后 G-B 通过（响应面打开），但纯比例机制在 income>0 时
  无下行流（P0=0，mDown=0）。**位移是结构性零和机制**——每次成功上升必然把一名在位者
  挤下一层，下行流 = 上行流，不依赖任何参数调校。
- 复用既有竞争结算而非新增战斗公式：'击败'的语义由 rule.md 12–19 唯一定义，
  不引入第二套力量模型（AGENTS/02 模块边界）。
- 无新参数：对决强度完全继承竞争参数（lossRate/transferEfficiency/乘子），
  G-B 的响应面不引入新轴；消融对照 = 'own' 模式（历史语义整体）。

## 3. 门禁实测（30 种子，`out/p15-gates.json`）

| 门禁 | v7 实测 | v8 实测 | 结果 |
| --- | --- | --- | --- |
| G-A P0(w3)≥0.15 | 0.0000 | **0.5+**（3 种子诊断 0.51–0.61；30 种子均值见产物） | **P0 达标** |
| G-A mUp(w3)≤0.60 | 0.0880 | **0.94–0.98** | **未过**（见 §4） |
| G-B P4 极差≥0.40 | 0.6327（通过） | 见产物 | — |
| G-C ‖ΔP‖₁<0.10 | 0.4158 | 3 种子诊断 w2b≈w3（漂移微小）；30 种子均值见产物 | 见产物 |
| G-D own 逐位 | 通过 | **通过**（5/5 种子逐位一致） | 通过 |

## 4. 残余失效模式与判定树耗尽（诚实记录）

位移准入把 G-A 的失效模式从「底层抽空（P0=0）」翻转为「**环流稳态**」：
1:1 零和位移 + 财富近保守 + mock 策略升阶意愿（policyVersion 冻结，不可改——改则
G-D 逐位断裂）使几乎全部个体每年完成至少一次升-降循环，mUp/mDown 双双饱和于 ~0.95；
阶级分布本身稳态且**底重**（P≈[0.5,0.4,0.03,0.03,0.03]，金字塔形态）。

- P0≥0.15 ✓、G-C 平稳 ✓、G-B ✓（见产物）、G-D ✓；**唯 mUp≤0.60 ✗**。
- 判定树（diagnosis §8）对「位移准入已落地但 mUp 仍不过」无后续分支——树已穷尽。
- 不可为通过而做的事（红线/契约）：改 mUp 门槛（改判据＝预注册级变更）、调 mock 策略
  （冻结）、调竞争参数回填（红线 4）。
- **规则负责人决策项**（后续轮候选，本文不实施）：
  1. 重推 G-A 的 mUp 判据在位移体制下的标定依据（位移使高流动与稳态结构共存，
     0.60 的「扶梯降速」proxy 是否仍度量原意图——须先修订 diagnosis/07 再判）；
  2. 失败升阶的承诺成本（stake）：攻击方无论胜负支付 cross 或其一部分——新的单变量
     修订（rules-v9），须独立预注册；
  3. D-06 备选 B（阶级承载力配额）/C（网络闭锁准入）的重新评估（各自已知缺陷见
     diagnosis §5 被否备选表）。

## 5. 兼容性与实验可比性

- rules-v7 及更早产物不可与 v8 直接比较。
- golden：`default-rules-v8.json` 累加式新增；engine golden 改名前滚 v8；v7 入历史只读
 （无参数增删，paramsHash 沿用性同 0009 §4）。
- RNG 契约：新增 tag `displacement_target`；**仅 'class' 模式消费**——own 模式 RNG 流
  与 v5 逐位一致（`test/unit/engine/displacement.test.ts` 与 G-D 双重覆盖）。

## 6. 文档位置

03 §5（上升准入语义）、rule.md 9、01 §4.5 本轮记录、01 §12 D-09 登记、
`test/unit/engine/displacement.test.ts`（5 项：胜/败/空池/own 跳过/抽样确定性）。
