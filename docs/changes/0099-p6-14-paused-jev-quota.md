# 0099 P6-14 扩大规模 live 对照因 Jev 配额暂停

- 日期：2026-11-20
- 关联：[0093](0093-p6-11-jev-prompt-causal-result.md)、[ADR 0013](../adr/0013-p6-11-jev-prompt-causal.md)
- 影响：仅实验执行状态；无代码、规则、schema 或预注册变更

## 事件

P6-14（`p6-11-jev-causal.mjs --prereg out/p6-14-prereg.json`，30 对同种子、每对
`mock-weighted-v1` + `jev_live` 各一，目标 60 个 live run）持续收到上游 Jev 配额
限流（429/`FreeUsageLimitError`），live run 反复因“最近 100 个到期决策回退率超阈值”
暂停并无限重试。2026-11-20 用户指示暂停该实验，已向进程 `157690` 发送 `SIGTERM`，
进程退出。

## 停止时落盘状态

`out/p6-14-jev-causal/` 保留完整可续跑状态（已核验）：

- `ledger.ndjson`：63 行 —— 30 个 `mock-weighted-v1` 成功、12 个 `jev_live` 成功、
  21 个 `jev_live` 失败（配额/回退暂停，不计入有效样本）；
- `checkpoints/`：6 个未完成 live run 的 `.progress.json`（seed 007–009 的
  `neutral` 与 `survival_hint`；最后已结算 tick 分别为 659/539/479 与 659/599/479）；
- `raw/`：已完成的 live/mock 逐决策原始 NDJSON（gzip）保留；
- `out/p6-14-prereg.json` 未被改写。

## 判定与边界

- 12/60 个 live run 完成、21 个失败，**未达到预注册规模**，不生成 analysis，
  不构成任何因果或结构结论；不得把这 12 个运行当作 P6-14 结果引用。
- 该暂停不影响 P6-11 已通过的因果结论（90/90、30 对同种子、`passesCausalClaim=true`）；
  P6-14 只是更大规模复验，尚未完成。
- 恢复条件：Jev 配额恢复后，用同一预注册与目录重新执行（脚本从 ledger/checkpoint
  续跑，不重跑已完成 run）。建议先把 `--max-resume-attempts` 与配额预算写入运行记录。

## 恢复命令（上海 VPS）

```bash
cd ~/stratify-scale
node scripts/p6-11-jev-causal.mjs --run \
  --prereg out/p6-14-prereg.json \
  --dir out/p6-14-jev-causal \
  --out out/p6-14-jev-causal-analysis.json \
  --quota-wait-minutes 5 --max-resume-attempts 48
```

## 其余实验

`explore-r2c-hcg`（rules-v19，独立目录 `~/stratify-r2c`）、P6-12、P6-13 不受影响；
本记录不改变 G6 未通过的状态，也不构成校准证据。
