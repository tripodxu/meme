# 提交级审查：71d0d51..1386f04

- 日期：2026-11-03
- 范围：`71d0d510b29e8fefe128b45afb3d4b42d60025a7..1386f04`，共 27 个提交
- 方法：逐提交阅读 `git show -- src test scripts ':(exclude)out'`，剔除产物快照与锁文件后
  按实现正确性、与提交信息是否相符、契约一致性（02/03/05/07）、测试覆盖四条判据核查；
  结论逐条用可执行命令或最小复现验证，不做静态推断
- 修复状态：本轮修复见 [`changes/0006`](../changes/0006-analysis-and-engine-integrity-fixes.md)；
  本文件保留审查发现与验证证据，标「已修」的条目均附回归测试位置

## 1. 总览

27 个提交中 12 个存在缺陷或流程问题，其中 6 处高危（5 处会使实验数据失真，
1 处是流程夹带）。已修复 9 类，3 项待决策。

| 提交      | 主题                   | 结论                                                              | 状态             |
| --------- | ---------------------- | ----------------------------------------------------------------- | ---------------- |
| `d0ecbcc` | P1-02 状态/哈希        | 中：字段级 schema 零引用，测试只查 domain 名；`wireTest` 是字符串 | 未修             |
| `f7ac25f` | P1-03 合法行动 / P1-10 | 中：新增必填 `updateMode` 但 schema 未升版；低：键校验恒真式      | 已修             |
| `80059b6` | P1-04~09 引擎管线      | 中 3：自竞争可执行、重构零权重崩溃、跨层乘子 NaN                  | 已修             |
| `02db89c` | P1.5 预研              | **高 2**：全死亡日污染窗口均值；末 tick 全死不算 extinct          | 已修             |
| `bc6d5a2` | rules-v4 登记          | 低：改 03 摘要未同步 §6 公式                                      | 已修             |
| `ff4c8d0` | changes 索引           | 低：夹带 03 的 70 行重排                                          | 记录             |
| `192f551` | v4 代码同步            | 中：v3 engine golden 被 rename 覆盖；03 §6 未更新                 | 已修（约定入档） |
| `d54fdfb` | v4 勘误                | **高 1**：mean-field 未跟着改锚，调用点不传 E                     | 已修             |
| `523a43a` | engineVersion          | 中：golden 不含 engineVersion，无法区分实现                       | 已修             |
| `a85014c` | v4 二轮预注册          | **高 1**：`featureWindows` 类型写死 `'w1'\|'w3'`                  | 已修             |
| `f00dffd` | v4 复核判定            | 中：docs 提交夹带 58k 行产物                                      | 记录             |
| `6b4e91c` | 登记 D-05              | 无问题                                                            | —                |
| `63fcb87` | rules-v5 裕度          | 中 3：NaN 反向 fail-open、原因码合并、v4 cell 注入 ρ=30           | 部分修           |
| `5c518ef` | v5 预注册              | 中：两个 cell 同改两参数，违反「唯一改变量」                      | 待决策           |
| `47a79de` | v5 轮 2                | **高 2**：当时代码产不出 w2b；产物 hash 与 manifest 不符          | 已修             |
| `177b605` | 清理占位块             | 中：标题说清理，实际新增 50 行时序一致性计算                      | 记录             |
| `3ec7bab` | 清理未用变量           | **高：夹带 P2 决策层 1284 行**                                    | 已修             |
| `01ee20b` | lint 修复              | 无问题                                                            | —                |
| `8a84f48` | P5a 批量/检查点        | **高 3**：原子性无载体、`.prev` 未校验、batch 校验空壳            | 部分修           |
| `993b4a7` | 暂存快照               | 无问题                                                            | —                |
| `1ad5e90` | 审查记录               | 无问题                                                            | —                |
| `b14b299` | 修 w2b/标尺/校验       | **高 2**：w2b 仍进不了聚类；产物未重跑                            | 已修             |
| 其余 5 个 | 产物策略 / CI / 预检   | 无问题（含本会话自己提交的）                                      | —                |

## 2. 高危发现与验证证据

### 2.1 全死亡日污染窗口统计（`02db89c`，已修）

`window-stats.ts` 旧实现：

```ts
rows.reduce((sum, row) => sum + (row.classCounts[c] ?? 0) / Math.max(row.aliveCount, 1), 0) / n;
```

`aliveCount=0` 的行按要求贡献 0，但分母 `n` 仍把它算进去。复现（窗口尾部 10 日全死亡）：

```text
missingTicks=0  tickCount=730  classShares 和=0.139（应为 1）  窗口判 available=true
```

影响：TV(P) 系统性偏大，窗口仍进聚类与标签；直接违反 07 §5。
修复后同一输入给出 `missingTicks=10 / deadTicks=10 / classShares 和=1`。
回归测试：`test/unit/runner/runner.test.ts`「全死亡 tick 不补入结构均值」。

### 2.2 末 tick 全死亡不算 extinct（`02db89c`，已修）

引擎对最后一 tick 返回 `scheduled`（03 §1），`extinct = endReason === 'extinct'` 漏判，
这类 run 以存活身份进入聚类。修复后 `deriveExtinct('scheduled', 0) === true`，
07 §8 质量检查第 5 条恢复有效。

### 2.3 mean-field 未跟着 v4 勘误改锚（`d54fdfb`，已修）

`topClassMargin` 已支持 `eByClass`，但 `scripts/p15-mean-field.mjs` 调用点不传参，
`envMultiplier` 恒为 1。实测同配置：无乘子 `0.2857`，按 w3 观测 E 计算 `0.0635`。
报告中的「顶层可持续性裕度」是 v3 数字的 4.5 倍，而 G1.5 有一半靠
「均值场预测与仿真方向一致」判定。修复后脚本同时输出 v3 对照与真实口径。

### 2.4 w2b 无法进入聚类（`a85014c` / `b14b299`，已修）

类型 `readonly ('w1'|'w3')[]` + 值 `['w3']`，每个 run 只有一个特征点。
`b14b299` 让 w2b 能**算**，但簇空间里没有它；v5 轮 2 的「吸引子稳定性」
是 `p15-grid.mjs` 把 w2b 投影到 w3 质心的近似，`sameClusterRate` 也无判据阈值。
修复：`featureWindows = ['w2b','w3']`，两窗口特征点同空间聚类后直接比较簇号，
新增 `temporalConsistencyMinRate = 0.8` 与 `met` 布尔结论。

### 2.5 预注册哈希缺 6 项（`a85014c` / `47a79de`，已修）

对照 07 §3 覆盖清单缺 `promptVersion`、`promptStyle`、`baseConfigHash`、
`artifactProfile`、`cells[].fullConfigHash`、排除规则。
`src/core/hash/schemas.ts` 的域声明自己列了这些字段，实现却没喂给 `hashValue`
（`hashValue` 不校验字段，故不报错）。实测补上后哈希不变，证明此前这些字段确实未参与。

最严重的是 `baseConfigHash`：`buildCellConfig` 固定合并 `DEFAULT_RUN_CONFIG`，
默认配置变化会让产物变而预注册哈希不变。

### 2.6 P2 决策层夹带（`3ec7bab`，已修）

提交信息「chore(decision): 清理未用变量」，`--name-status` 实际是：

```text
A  src/decision/jev-client.ts   (+421)
A  src/decision/live.ts         (+132)
A  src/decision/policy.ts       (+37)
A  src/decision/serialize.ts    (+260)
A  test/unit/decision/jev-client.test.ts (+434)
```

`jev-client.ts` 头部自述「P2-03~05」，而 01 §1 规定「P1.5 未通过不得启动 P2–P6」，
01:78 仍写着「P2–P6 依闸门搁置」。同提交还改了 `p15-grid.mjs` 格式并重写
`out/p15-full.json`（−13421/+3328）——四件不相关的事塞进一个「清理」提交。

处理：迁入 `src/experimental/p2-decision/`，加 README 说明闸门与迁出条件；
新增 `test/unit/architecture.test.ts` 盯住边界。**未做**：是否彻底移出仓库待负责人决定。

## 3. 中低危发现

### 3.1 引擎（`80059b6`，已修）

- **自竞争可执行**：`compete:<self>` 无守卫。复现 Value 1000 → 982.88（同一对象先扣后加）。
  现记 `stale_invalid(self_target)`，不进入结算。
- **重构零权重崩溃**：`exp(...)` 可整体下溢为 0 → `weightedSampleIndex` 返回 -1 →
  `candidates[-1].id` 抛 `TypeError`，且旧边已从双方移除。现按「无候选」恢复旧边。
- **跨层乘子 NaN**：`[0,1.25]` 允许 0，两者皆 0 时 `-Inf−(−Inf)=NaN`，`r < NaN` 恒 false
  ⇒ 发起方恒败。注册域改 `[1e-6,1.25]`，运行期再加正数断言。

### 3.2 校验（`f7ac25f`，已修）

`parseActionKey` 的 `key !== \`compete:${target}\`` 是恒真式（`target`由 key 切片而来），`compete: a-0001`、`compete:../x`被放行。改用`AGENT_ID_PATTERN`。

`updateMode` 变为必填但 `CONFIG_SCHEMA_VERSION` 未升：新旧语义共用一个版本号。
现升 `stratify-config-v2` 并提供 v1→v2 迁移（补 `dynamic`，保持 v1 语义）。
注意 `HASH_DOMAINS.config` 的 `'stratify-config-v1'` 是**哈希域前缀**，不随 schema 版本改。

### 3.3 标签（`80059b6` 同源，已修）

「封闭分层」的 80% 块条件用整窗均值套每个块，块级判定实际失效（任一块 O 低即通过）。
现 `blocks30d` 携带 `mUp/segregation/edgeCountAverage` 逐块判定。
`networkEmpty` 由「只看末行」改为整窗判定，并让依赖 S 的两个标签在空网络时强制不成立。

### 3.4 版本轴（`523a43a`，已修）

golden fixture 不含 `engineVersion`，「规则相同、实现不同」的产物无法区分。
现 fixture 增加该字段并断言。本轮 `engineVersion` 升至 `engine-v0.3.0`。

### 3.5 P5a 检查点（`8a84f48`，部分修）

- 原子性载体：`8a84f48` 交付时只有内存宿主，`nodeCheckpointHost`（fsync + rename +
  目录 fsync best-effort）由 `b14b299` 补上，**当前已具备**。
- `.prev` 提升前未校验：`saveCheckpointWithHistory` 现在用 `tryLoadCheckpoint`
  先解析校验，损坏主点不会覆盖既有 `.prev`，**已具备**。
- batch 校验空壳：`assertManifestVersions`/`assertPopulationSize` 已实装，
  但 `parseCell` 是否拒绝「未登记的点路径键」需逐项比对 `PARAM_DEFINITIONS`——**未修**。

### 3.6 提交信息与内容不符（记录，不改历史）

`177b605`「清理占位块与未用变量」实际新增 50 行时序一致性计算；
`f00dffd` docs 提交夹带 58k 行产物；`ff4c8d0` 夹带 03 的 70 行重排。
历史不改写，以本记录留痕。

## 4. 决策结论（2026-11-03 复盘）

**1. `067b1db` 的 P2 决策层归属 → 保留在 `src/experimental/p2-decision/`**
理由：删除会丢弃 1284 行已成形的契约实现；隔离 + `test/unit/architecture.test.ts`
边界守卫已保证生产层无法引用；`src/experimental/README.md` 明确「G1.5 未通过不得接线」。
复核触发条件与删除时机见 ADR-0002。

**2. v3/v4 历史 mock fixture → 不恢复死文件，改为坐标化取回**
复核推翻了本条的前提：**config** fixture 是累加式（v3/v4/v5 三份都在），
`changes/0005`「v4 配置 fixture 保留只读」本来就正确；只有 **engine golden** 是改名前滚。
故不恢复 `mock-run-rules-v4.json`——无测试会执行它，留下只会积累不会被读取的死文件。
改为在 `docs/reference/artifacts.md` §5 记录两类 fixture 的不同约定、v3/v4 的
commit + blob 坐标与取回命令，并修正 `test/golden/engine-mock.test.ts` 的虚假注释。

**3. `5c518ef` 的双变量 cell → 本条判断本身有误**
`v5:geMedian=0.7+cushion30` 的 `holdingCushionDays: 30` **恰是默认值**，合并后只改
`attributes.ge.median` 一项，因此它不是双变量 cell，而是与 `v4:geMedian=0.7`
`fullConfigHash` 完全相同的**重复格点**——白耗 30 个种子预算且不产生任何新信息。
这不是「标注为交互项」能解决的，须改参数使其真正成立：改为
`v5:cushionDays=90+geMedian=0.7`（`design: 'interaction'`，2 项差异）。
同时新增 `design`/`changedPaths` 字段与构造期校验（changes/0007），使同类问题
不再依赖人工命名自觉。

**4. `out/` 产物存储策略 → 现有白名单 + 5 MiB 上限不变，迁移阈值写入 §1**
未达阈值前迁移只增加运维面，不解决任何已知问题。

## 5. 复现命令

```bash
# 全死亡污染（修复前应看到 classShares 和 ≈0.139）
node -e "const {summarizeWindow}=require('./dist/runner/window-stats.js'); /* 见 runner.test.ts */"

# 自竞争（修复前 Value 1000 → 982.88）
pnpm vitest run test/unit/engine/engine.test.ts -t self_target

# 零权重下溢（修复前抛 TypeError）
pnpm vitest run test/unit/network/rewire.test.ts -t 下溢

# 跨层乘子 NaN（修复前 pInitiator=NaN）
pnpm vitest run test/unit/engine/settlement.test.ts -t 乘子为 0

# 预注册哈希可复算
pnpm build && node -e "
const d=require('./out/p15-screen.json');
const {computePreregistrationHash}=require('./dist/runner/preregistration.js');
console.log(computePreregistrationHash(d.manifest)===d.preregistrationHash);"
```

## 6. 遗留风险

- **证据链仍未闭合**：`out/p15-full.json` 的 w2b 全为 `null`，是修复前产物。
  代码、文档、门禁已对齐，但 G1.5 仍缺一份用当前代码跑出的 full 产物。
  重跑约 46 分钟起，且 `preregistrationHash` 已变为 `sha256:ba64e87f…`，
  按 07 §3 属新预注册，须新建 `experimentId` 后重跑。
- **`out/` 体积**：三份 JSON 仍是纯文本入库，`p15-full.json` 2.7MB；
  迁 LFS 或外置存储属策略变更，见 `reference/artifacts.md`。
- **`src/core` 对 `src/decision/types` 的 type-only 依赖**：编译期擦除，无运行时耦合，
  但方向是外层向内层反向。若要消除，应把 `ExecutionRecord` 定义下沉到 `src/core`。
