# 实验产物登记（artifacts）

> 本文件是 `out/` 目录入库策略的唯一事实来源。`.gitignore` 的白名单与本表一一对应；表外产物一律不入库。

## 1. 入库规则

1. **白名单制**：只有本文件 §2 列出的文件可以入库。新增、改名或替换产物，必须在同一 PR 中同步更新本表与 `.gitignore` 的 `!out/...` 例外行。
2. **体积上限**：单个产物不得超过 5 MiB。超出时改存 R2 或外部存储，在本表登记 URL、sha256 与生成命令，仓库只保留摘要。
3. **可重建**：产物必须能用 §3 的命令从对应提交重建。不可重现的产物不得作为验收证据。
4. **替换留痕**：覆盖同名产物时，提交信息必须写出新旧 sha256 与关键指标变化，便于回溯判定依据。
5. **只读**：产物是证据而非源码，禁止手工编辑 `out/*.json`；需要修正数据应改代码后重跑。

## 2. 当前登记

| 路径                        | 大小     | sha256（文件级）     | 关键指标                                                                                    | 状态     |
| --------------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `out/p15-full.json`         | 2.70 MiB | `04512d7d…bea2c65b9` | runCount=840、prereg=`sha256:2c4843b4…`、k=2、silhouette 0.403、ARI 0.868、3650 tick、40 人 | 待重跑   |
| `out/p15-full-v4draft.json` | 1.08 MiB | `7091777f…8cf12697a` | rules-v4 初稿（E 期锚定，已由 `0282170` 勘误）                                              | 历史存档 |
| `out/p15-screen.json`       | 28.1 KiB | `78d1cd10…c89811477` | 预检阶段输出（每 cell 1 种子）                                                              | 历史存档 |

完整 sha256：

```text
04512d7dd41a4c7f6b419b481a975542c32a90d6b3e2a8329d4dac8bea2c65b9  out/p15-full.json
7091777fb18825b81d2c55f75a334d59205f512a7100b66829a4f468cf12697a  out/p15-full-v4draft.json
78d1cd10c19764de030e12ec65180d0f6883ffe2013f523e7a7fd8ac89811477  out/p15-screen.json
```

校验方式：`sha256sum out/*.json`。

## 3. 重跑程序

```bash
pnpm build
node scripts/p15-grid.mjs --stage screen   # 预检：每 cell 1 种子 × 短 tick，筛查崩溃/爆炸
node scripts/p15-grid.mjs --stage full     # 正式：按预注册 manifest 跑全部 cell × 30 种子
```

产物固定写入 `out/p15-<stage>.json`（见 `scripts/p15-grid.mjs:250-251`），不提供自定义输出路径；换名存档需手工 `git mv` 并更新本表。

## 4. 已知缺口

`out/p15-full.json` 中 `w2b` 与 `temporalConsistency` 共 840 处取值均为 `null`：该产物由修复前代码（`ANALYSIS_WINDOWS` 尚不含 w2b）生成，对应 `preregistrationHash=sha256:2c4843b4…`。

w2b 窗口的代码修复已随 `9a714f8` 落地，但**产物尚未重跑**。在按 §3 重跑并更新本表 sha256 之前，该文件不得用于 G1.5 判定（依据：`07-experiment-calibration.md` §8.1、`reviews/2026-11-03-zcodes-nightly-audit.md` §5）。
