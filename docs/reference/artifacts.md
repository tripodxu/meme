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
| `out/p15-screen.json`       | 89.6 KiB | `503f535d…e43827ed`  | 28 run × 400 tick；w1/w2b/w3 均 `available=false`（missingTicks 695/730/730）；budgets.ok   | 预检通过 |

schema v2（`p15-grid-v2`）起产物分两个区块：`manifest` 为参与 `computePreregistrationHash` 的完整预注册设计（26 字段，含 `baseConfigHash`、`artifactProfile`、`cells[].fullConfigHash`、`exclusionRules`），`execution` 记录本次实际执行参数（`stage`/`totalTicks`/`seeds`/`runCount`/`warmupTicks`），`budgets` 记录预算护栏的实际值与是否越界。三者分离，才能让预检产物携带完整预注册哈希同时如实标注「只跑了 400 tick」。任何人可离线复算校验：

```bash
node -e "const d=require('./out/p15-screen.json');const{computePreregistrationHash}=require('./dist/runner/preregistration.js');console.log(computePreregistrationHash(d.manifest)===d.preregistrationHash)"
```

完整 sha256：

```text
04512d7dd41a4c7f6b419b481a975542c32a90d6b3e2a8329d4dac8bea2c65b9  out/p15-full.json
7091777fb18825b81d2c55f75a334d59205f512a7100b66829a4f468cf12697a  out/p15-full-v4draft.json
78d1cd10c19764de030e12ec65180d0f6883ffe2013f523e7a7fd8ac89811477  out/p15-screen.json（2026-11-03 修复前，已替换）
4a7fbbb26a62b26a1b2979291b8adc4382e954634cd50ef7ba4fa071aeb4d8f1  out/p15-screen.json（schema v1，已替换）
925bb44bb4f2b08d4279b70fe7bb332e05e9c56fc4f00d66ff75c3e6389b316b  out/p15-screen.json（schema v2 首版，已替换）
503f535d31949481a1e0fdeef2740cbdcc105c4ae63a125a23ddd5d8e43827ed  out/p15-screen.json
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

### 4.1 预检重跑结果（2026-11-03）

`out/p15-screen.json` 已用修复后代码重跑（`pnpm build` + `--stage screen`）：28 个 run 全部完成，0 崩溃/爆炸；`w2b` 由 `null` 变为结构完整对象，并携带 `available` / `missingTicks` 标记。

但 screen 的 `totalTicks=400` 低于所有窗口下界，w1/w2b/w3 一律 `available=false`（missingTicks 695/730/730）。因此**预检只能证明计算路径与缺省语义正确，不能证明 w2b 产出数值**。数值验证必须走 `--stage full`（3650 tick，w2b 覆盖 1825–2554）；在此之前 `out/p15-full.json` 仍是修复前产物。

### 4.2 预检顺带修复的 schema 缺陷

首次重跑暴露出 `scripts/p15-grid.mjs` 写出的 `manifest` 只有 5 个字段，而 `PreregManifest` 定义 21 个——产物与哈希不自洽，第三方拿到 artifact 无法复算，违反 `07-experiment-calibration.md` §2「完整 manifest」要求。同时 screen 的实际执行参数（400 tick / 1 种子）被写进 `manifest`，与哈希所依据的 3650 tick × 30 种子矛盾。

`p15-grid-v2` 的处理：`manifest` 写完整预注册设计，`execution` 独立记录实际执行参数。修复后 hash 保持 `sha256:2c4843b4…` 不变（预注册设计未变），复算断言为真。

### 4.3 预注册口径修正后的重跑（2026-11-03，changes/0006）

`preregistrationHash` 发生一次**口径修正**，不是设计变更：

```text
旧 sha256:2c4843b4…（覆盖不全，无法证明产物与 manifest 一致）
新 sha256:ba64e87f13a84e82e14326f0cd181460d788ffd46e9dd60289e1f917778fccf6
```

变更是把 07 §3 要求、但此前未进哈希的字段补齐：`promptVersion`、`promptStyle`、
`baseConfigHash`、`artifactProfile`、`cells[].fullConfigHash`、`exclusionRules`；
同时 `clustering.featureWindows` 从 `['w3']` 改为 `['w2b','w3']`，
`engineVersion` 随实现修订升到 `engine-v0.3.0`。

`out/p15-screen.json` 已按新口径重跑（28 run × 400 tick，0 崩溃）：

```text
503f535d31949481a1e0fdeef2740cbdcc105c4ae63a125a23ddd5d8e43827ed  out/p15-screen.json
91785 bytes（89.6 KiB）
manifest 26 字段；budgets.ok=true（28/840 run、0/480 min、91547/2000000000 bytes）
```

新增产物字段：`budgets`（含 `observed` 与 `violations`）、`execution.warmupTicks`、
`cellDistinctness`（full 阶段才有值）。`manifests.windows` 仍为 `w2b/w3`。

**`out/p15-full.json` 未重跑**，其中 w2b 仍全为 `null`，且其
`preregistrationHash=sha256:2c4843b4…` 已不属于当前口径。按 07 §3「任何预注册内容变化
必须新建 experimentId」，它只能作为历史存档，不得用于 G1.5 判定。
