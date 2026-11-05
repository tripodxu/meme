# src/runner

Node 批量运行器。按 [01 实施计划](../../docs/01-implementation-plan.md) 施工中：P1.5 的 `preregistration`/`run-cell`/`window-stats`/`cluster` 已可用；P5a 的 `batch`/`checkpoint`（含 `checkpoint-fs`）、**P5-01 批跑 CLI（`batch-cli` + `bin/stratify-batch.mjs`，changes/0031）**、**P5-03 run 内进度检查点（`run-progress`，changes/0032）** 与 **P5-04 微扰配对执行入口（`perturbation`，changes/0033）** 已落地；**P5-02 共享预算/限流/live 批跑执行器（`budget`/`rate-limit`/`batch-live`，changes/0035）** 已落地——**P5a 全部完成**；上传仍未完成。

已实现模块：`preregistration`、`run-cell`、`window-stats`、`cluster`、`batch`、`checkpoint`、`checkpoint-fs`、`batch-cli`、`run-progress`、`perturbation`、`budget`、`rate-limit`、`batch-live`、`p6-analysis`、`p6-factorial`、`p6-perturbation`、`p6-ablation`、`reliability`、`p6-live-comparison`。

计划模块：`uploader`（P5b）。

## 微扰配对（P5-04）

```ts
import { runPerturbationBatch } from '<dist>/runner/perturbation.js';
const summary = runPerturbationBatch(config, tasks, { policy, checkpointTick });
```

- `param`（相对扰动 value×(1+δ)）与 `wealth_absolute`（存活者 += ΔValue）两种声明；
- baseline/treatment 从同一检查点快照克隆（07 §7.2），叶子路径 diff 强制「只改声明变量」；
- round-trip 后哈希不变 → `invalid=true`（07 §7.4），不报「无敏感性」；
- 产出 `perturbation-summary-v1`（任务回显 + 逐对 `firstDivergenceTick`/两侧报告）。

## P6-03 微扰实验（`p6-perturbation` + `scripts/p6-perturbation.mjs`）

```bash
pnpm build
node scripts/p6-perturbation.mjs --freeze
node scripts/p6-perturbation.mjs --run
node scripts/p6-perturbation.mjs --slim
node scripts/p6-perturbation.mjs --analyze
```

- 预注册两个体制（`stable` 默认 / `critical` P6-02 最大联合条件）、10 个扰动 cell
  （control、财富绝对三档、`need.threshold` 与 `need.needMultiplier[1]` 相对各三档）、
  30 个新种子、200 人 × 730 tick、检查点 365；全部进 `preregistrationHash`；
- 每个 (regime, seed) 只跑一次检查点与 baseline，treatment 从同一快照克隆；
- 事件签名 = 死亡数 + 阶级转移矩阵；分类为 `identical` / `absorbed`（730 天内零事件翻转）/
  `trajectory-only` / `structural`（窗口 TV≥0.10 且超出 baseline 跨种子 D95）；
- 只作 exploratory，不构成确认、校准或 P6-05 三类结构验收。

## Jev 重测信度与 live pilot（P6-04b 前置）

- `src/runner/reliability.ts`：ICC(2,1)（行=选项、列=重复）、重复间平均 TV、
  top-1 一致率与 `reliable/model_unstable/exploratory` verdict（07 §11）。
- `scripts/jev-reliability.mjs`：固定一个 mock state，连续调用 live 20 次，
  输出选项分布、ICC、TV、usage/延迟；不推进模拟。
- `scripts/p6-04b-live-pilot.mjs`：1 seed × 40 人 × 730 tick × `decision.interval=30`，
  同配置跑 mock/random/live 并输出描述性 TV/D；**pilot 不是正式对照**。

## 正式 live 对照（P6-04b）

- `src/runner/p6-live-comparison.ts`：配对 TV(P)/D、bootstrap 中位数区间、
  有符号 ΔG 的方向一致率与符号翻转检验、baseline 两两 D95、BH 校正，以及
  回退率/模型漂移/灭绝/窗口不完整等质量闸门；纯函数，不读文件、不发请求。
- `scripts/p6-04b-formal.mjs`：`--freeze` 冻结 10 seed × 4 组设计并写 designHash；
  `--run` 以并发池执行 mock/random/live，ledger 追加式落盘、可断点续跑；
  `--analyze` 输出五个比较与 BH 族。正式批次结果见 changes/0056。

## 批跑 CLI（P5-01/P5-03）

```bash
pnpm build
node bin/stratify-batch.mjs <manifest.json> --out <dir> [--resume] [--checkpoint-ticks N]   # 或 pnpm batch
```

- manifest 为 `batch-v1`（cells × seeds 笛卡尔；校验在 `batch.ts`）；
- stdout 只输出 `batch-summary-v1` 纯 JSON，进度走 stderr；报告/审计/ledger 三文件落输出目录；
- `--resume` 从 `batch-ledger-v1` ledger 恢复（kill 后续跑，G5a）；技术失败跨 resume 保留（07 §3）；
- `--checkpoint-ticks N` 每 N tick 落 run 内进度检查点（`run-progress-v1`：快照 + 窗口累计器），
  kill 后从 tick 级完整点恢复且窗口聚合与不中断运行逐字一致；长 run 建议开启（如 500）；
- mock/random 批跑不依赖 P2：不读密钥、不发网络请求；
- 同一输出目录不得并发运行两个批跑进程（并发/共享预算属 P5-02）。

## 边界

- 运行在 Node，复用 `src/core`、`src/decision` 与共享契约；Node 专有代码不得被核心反向引用。
- 负责并发上限、速率限制、预算与 checkpoint 续跑；这些能力不得渗入核心结算。
- 与 Worker 使用同一 D1 schema 和 R2 manifest 格式，不新建旁路格式。
- 依赖 Deployment 约束见 [02 架构](../../docs/02-architecture.md) 与 [09 发布与运维](../../docs/09-deployment-operations.md)。
