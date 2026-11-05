# 0047：第二轮复审 High 项修复（完整性门禁、部署脚本、检查点快照）

- 日期：2026-11-05
- 作者：Runner/实验负责人
- 关联：[第二轮复审](../reviews/2026-11-05-zcodes114-reaudit.md)、changes/0043/0046、07 §7/§8/§9
- 性质：**正确性与证据链加固**；不修改规则、参数默认值或实验判定

## 1. p6-analysis 窗口完整性门禁

**问题**：`evaluateStageB`/`evaluateStageA` 只把“窗口对象不存在”计为缺失，未检查 `observedTicks/missingTicks`。用 `w2b.missingTicks=100, observedTicks=630` 的 30 对合成数据复现了 `confirmed=true`——被 `maxTicks` 截断但未标 extinct 的 run 可以部分窗口通过确认门禁。

**修复**（`src/runner/p6-analysis.ts`）：

- 新增 `P6Completeness.incompleteWindow`；
- Stage B 的 w2b 必须 `observedTicks >= tickCount` **且** `missingTicks === 0`；
- Stage A 的 w1 是有意部分观测（`tickCount=365`、`missingTicks=365`），要求 `observedTicks >= tickCount`（观测段跑满），不要求 `missingTicks=0`；
- `completeness.ok` 与 `criteria.artifactFree` 都要求 `incompleteWindow === 0`；
- 缺少 `tickCount/observedTicks` 字段的分析输入按不完整处理（宁可拒绝判定）。

**回归测试**：

- `p6-analysis.test.ts`：w2b 未观测满 → `confirmed=false`、`incompleteWindow=30`；
- `p6-analysis.test.ts`：w1 观测段为 0 → `screenedIn=false`、`incompleteWindow=30`。

**重算结果**：用新门禁重算 Stage A 严格分析、Stage B 六单元与 P6-02 分析，**判定不变**——Stage B 仍仅 `needThreshold=0.9` 确认，六单元 `incompleteWindow=0`；Stage A 仍 3 个候选；P6-02 31 cell 全部完整。重算后的产物哈希已更新到 artifacts。

## 2. 部署脚本可执行性与 systemd 调用

**问题**：`deploy/check-disk-space.sh` 在 git 中为 `100644`，unit 直接执行它；安装后 systemd 会因无执行权限拒绝启动。

**修复**：

- 文件模式改为 `100755`；
- unit 改为 `ExecStartPre=/bin/bash /opt/stratify/current/deploy/check-disk-space.sh …`，即使发布目录丢失执行位也能运行；
- `deploy/README.md` 安装步骤增加 `chmod +x deploy/check-disk-space.sh`；
- `systemd-unit.test.ts` 断言 `ExecStartPre` 含 `/bin/bash`。

## 3. 检查点快照 config/params/seed 校验

**问题**：`runSingle`/`runSingleWithPolicy` 只校验 `meta` 三元组，随后直接使用 `loaded.state`；没有验证快照内 `config`/`paramsHash`/`seed` 与本次 run 一致。损坏或伪造的检查点可以保留匹配的 meta、却以不同规则续跑。

**修复**：新增 `assertCheckpointSnapshot`（`src/runner/run-cell.ts`），两条恢复路径都要求：

- `computeConfigHash(state.config) === computeConfigHash(config)`；
- `computeParamsHash(state.config) === computeParamsHash(config)`；
- `state.seed === validatedSeed`。

**回归测试**：同步与异步路径各一项——meta 伪造成目标 config、快照来自另一 config，恢复必须抛 `/快照 config/`。

## 4. 兼容性

- **分析产物**：新增 `incompleteWindow` 字段（向后兼容的附加字段）；旧 analysis 产物仍可读，但建议用新脚本重算。已重算的产物哈希见 artifacts。
- **规则/配置**：无变更；`configHash`/`paramsHash`/`preregistrationHash` 不受影响。
- **实验判定**：Stage A/B 与 P6-02 的判定均未改变；本记录不重跑任何 run，只重算离线分析。
- **部署**：unit 的 `ExecStartPre` 从直接执行改为 `/bin/bash` 调用；行为等价，兼容性更好。

## 5. 未修的 Medium/Low 项

第二轮复审中的 Medium/Low 项（live ledger provenance、`requireBudget` 默认强制、ledger report 深校验、CLI stdout 退出、分析脚本哈希不一致硬失败、微扰字段白名单等）不在本次范围；保留在复审文档中待后续处理。
