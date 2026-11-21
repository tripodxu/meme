# 0102 P6-13 首次运行被 OOM 杀死与 2-worker 重启

- 日期：2026-11-21
- 关联：[0101](0101-p6-12-n1000-two-regime.md)、[0099](0099-p6-14-paused-jev-quota.md)
- 影响：实验运行状态；无规则、schema 或预注册变更

## 事件

P6-13（R4 收口，N=1000，420 task）以 4 worker 启动，运行约 7 小时 27 分后，
于 2026-11-21 16:01:01 被内核 OOM killer 杀死（`exit 137`）：

```text
Out of memory: Killed process 847676 (node)
total-vm:8884268kB, anon-rss:5729764kB, ... oom_score_adj:500
```

同时段 VPS 内存 7.5 GB 用尽、2 GB swap 全部用尽，load average 一度超过 200，
SSH 出现 banner 超时。P6-14（live，RSS ~0.1 GB）未被杀。

## 损失与原因

- 脚本只在全部任务完成后写 `out/p6-r4n1k-raw.json`，无任务级检查点，因此
  **7.5 小时的 4-worker 计算全部丢失**；`out/p6-r4n1k-closure-result.json` 未生成，
  `p6-13.log` 只有启动行，`p6-13.exit=137`。
- 直接原因是 4 个 worker 同时跑 N=1000 × 3650 tick，进程 RSS 增至 5.7 GB，
  叠加 P6-14 与宿主服务后触发全局 OOM；`oom_score_adj=500` 不足以在 5.7 GB
  实际占用下避免被选中。

## 处置

- 以 `P6_WORKERS=2` 重启（同脚本、同预注册、全新计算）：RSS 约 1.0 GB 起，
  可用内存约 4.9 GB，预计耗时约为 4-worker 的两倍。
- 进程 `oom_score_adj=200`；P6-14 保持 `oom_score_adj=1000`，内存压力下仍优先
  牺牲 live 任务（其 ledger/checkpoint 可续跑）。
- 重启不改变预注册与随机 seed，结果仍可与其他 P6 产物比较；但因首次运行的
  中间结果未落盘，本轮从零开始。

## 任务级增量落盘（已实施）

首次 OOM 暴露的核心缺陷是 P6-13 只在 420 个 task 全部完成后写一次
`out/p6-r4n1k-raw.json`，进程中途死亡即丢失全部计算。已在
`scripts/p6-13-scale-r4-n1000.mjs` 补上任务级持久化：

- 每个 task 完成后立即把该 task 的 w3 聚合结果写入
  `out/p6-r4n1k-raw-parts/<taskKey>.json`（先写 `.tmp` 再 `rename` 原子替换）；
- 主进程启动时先加载所有分片，按 `kind|regime|ablation|seed` 去重，
  **只把缺失 task 分给 worker 重算**；全部分片齐全后仍写一份
  `out/p6-r4n1k-raw.json` 供既有分析复用；
- 分片只含聚合量、不含逐决策日志，磁盘与内存开销可忽略；崩溃留下的
  `.tmp` 与损坏分片会被忽略并重算。

2-worker 的首次重启（16:02 启动）只跑了约 10 分钟、未产生分片，已停止；
随后用打补丁后的脚本再次以 `P6_WORKERS=2` 启动（16:18，PID 1352483），
日志确认 `Loaded 0/420 ... 420 remaining`。本次之后任何单点失败只会损失
尚未完成的 task，不再丢失已完成部分。

## 后续注意

- 后续大规模实验应在启动前把 `P6_WORKERS`、预期 RSS 与 swap 余量写入运行记录。
- 预注册、seed 与规则均未改变；增量落盘不改变任何仿真结果。
