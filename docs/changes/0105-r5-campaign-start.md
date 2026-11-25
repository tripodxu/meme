# 0105 R5 大规模实验战役启动

- 日期：2026-11-22
- 关联：[R5 计划](../plans/r5-campaign.md)、[0101](0101-p6-12-n1000-two-regime.md)、[0103](0103-p6-13-r4-n1000-result.md)
- 影响：实验执行；无规则、schema 或产品代码变更

## 部署

- 运行目录：上海 VPS `~/stratify-r5`（独立于 `~/stratify-scale` 与 `~/stratify-r2c`）。
- 规则基线：`rules-v18`（复制 `~/stratify-scale/dist`，`RULES_VERSION='rules-v18'`），
  与 P6-12/P6-13 的基线一致；`node_modules` 软链到 `~/stratify-scale/node_modules`。
- runner：`scripts/r5-campaign.mjs`（commit `be159e6`，TDZ 修复 `ddb08a5`）。

## 预注册（已冻结，VPS `out/r5/<exp>/prereg.json`）

| 实验             | designHash（sha256）                                               |
| ---------------- | ------------------------------------------------------------------ |
| r5-phase-n200    | `45cabe1ff5e0fd675c1fe50889ce532a376253d2637529e936ffe5b235ae7f4d` |
| r5-robust-c      | `1a29df501c3f91c0eec9d91e0ad0f31282fa7b87a59c801ae4ef88ade0df8bd1` |
| r5-robust-policy | `6bbfa6293ecf0ecb8303ff0f306832eede9061971207e5b8d6006f90527f55ac` |
| r5-horizon       | `2664bcf6eaf49a15b646786fff8206e78f62f7da36a9b5fff5a164819257ec0c` |
| r5-scale-n200    | `f4418c8dc5782968d4578e7af54778ac94fa41e50a33f685703597cef2d43361` |
| r5-scale-n1000   | `dd9ddd83538068cab6f4c8bbea6669e5dab48b1f0fd5434390f374dd6cecb22e` |
| r5-scale-n3000   | `4a6ba88597599706f2625947ed4c5ba406584af5b5c94c999a118f2b8fdd0544` |
| r5-gen-n1000     | `181b8e29f945403d9446defb1c04cce793ecb08e9116a99b0d29ad7ce3c8ffe0` |
| r5-pert-n200     | `2797ad428e2978eeec8e43e1bd6d29a65ec6b85e46b25e55f99b263e208ccec1` |
| r5-pert-n1000    | `1495470b734813762d64421f603e108f1d470fb7d4029fdfb0f9128e18567571` |

## 队列与并发

```text
phase-n200 → robust-c → robust-policy → horizon → scale-n200 → pert-n200
→ gen-n1000 → scale-n1000 → pert-n1000 → scale-n3000
```

- 约 3,600 task；`N≤200` 最多 4 worker，`N≤1000` 2，`N=3000` 1。
- 启动前检查 `/proc/meminfo` 的 `MemAvailable`，不足时等待 60 s；单进程
  `oom_score_adj=300`，worker 内存在分片落盘后释放。
- **检查点**：每个 task 完成后立即写
  `out/r5/<exp>/parts/<taskKey>.json`（tmp+rename 原子替换）；重启同一条
  `--run` 命令时按 `taskKey` 去重，只补缺失 task。
- E7（相图候选的 N=1000 复核）为条件实验，本队列不包含；E8（Jev 剂量）不包含。

## 启动状态

- 2026-11-22 23:0x CST 启动；`r5-phase-n200` 4 worker 运行，首分钟已产出 8 个
  task 分片，VPS 可用内存约 5.1 GB、无 OOM 迹象。
- 预计 Wave A（N=200 段）数小时，整队列 4–6 天；任何中断后在同一目录重跑
  `--run` 即可续跑。

## 复现命令

```bash
cd ~/stratify-r5
node scripts/r5-campaign.mjs --status
node scripts/r5-campaign.mjs --run
node scripts/r5-campaign.mjs --analyze r5-phase-n200
```

## 边界

- 全部为 exploratory/characterization；**不构成 G6 确认、不关闭 G6**。
- 不调用 Jev、不消耗配额；E8 需另行预注册与批准。
- 负结果按纪律归档，不调参凑数；若出现候选第三簇，另立 ADR 再用全新 seed 确认。
