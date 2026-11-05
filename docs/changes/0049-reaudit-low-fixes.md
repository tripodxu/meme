# 0049：第二轮复审 Low 项修复（诊断类型、协议检测、旧分析告警、哈希差异关闭）

- 日期：2026-11-05
- 作者：Runner/实验负责人
- 关联：[第二轮复审](../reviews/2026-11-05-zcodes114-reaudit.md)、changes/0041/0047/0048
- 性质：**类型/文档/运行时告警收尾**；不修改规则、参数或实验判定

## 1. `warmupDiagnostic` 类型收紧

`PreregManifest.warmupDiagnostic` 从 `string` 收紧为 `WarmupDiagnostic`：
`WARMUP_DIAGNOSTICS` 登记三个已冻结文本（attractor stability、Stage A、P6-02）。
字面值不变，**预注册哈希不变**；新增实验档位必须登记新文本并写 changes，不能直接塞任意字符串。

## 2. `protocolConflict` 检测去子串化

`p6-analysis` 新增 `detectProtocolConflict` 与 `PROTOCOL_CONFLICT_MARKERS`（中英文两个已登记标记），
替代内联的单一中文子串判断；新增单测覆盖 `undefined`、正常文本、冲突文本。
冻结 manifest 的文本不改（会改哈希）；新实验应避免“或其他指标”措辞。

## 3. 旧 `--analyze` 路径运行时告警

`scripts/p6-stage-a.mjs --analyze` 启动时向 stderr 打出警告：该路径是历史“任意指标”口径，
不得用于候选/判定，严格判读用 `--analyze-strict`；输出对象新增 `deprecated: true` 与
`protocol: 'legacy-any-metric'`。`--analyze-strict` 行为不变。

## 4. `crossDays=half` 哈希差异关闭

当前 `out/p6-stageB-prereg-crossDays-half.json` 的 `preregistrationHash` 可复算为
`sha256:83a1d58a…`；`changes/0039` 冻结表写的 `c1206246` 无法由当前代码复算，登记为
过期/笔误。按“产物可复算”原则，证据以 `83a1d58a` 为准；不修改历史条目，artifacts 行状态
改为“已关闭（changes/0049）”。

## 5. 其他

- `batch-live.ts` 中 runId 熵源的过时注释（写 `Math.random`，实际 `randomBytes`）已修正；
- Stage B 六单元共用同一组确认种子，未做跨单元 BH 校正；在 needThreshold 研究文档补“多重比较说明”：
  该单元置换 p≈3e-5，BH(q=0.05) 不会改变确认；其余五单元未达主指标门槛，不因未校正改判。
  本说明不构成“已完成 BH”或校准声明。

## 6. 兼容性与验证

- 规则/配置/预注册哈希无变化；旧 `--analyze` 输出仅新增字段；所有实验判定不变。
- `pnpm test` / `typecheck` / `lint` / `check:docs` / `format` 全绿（数值见提交说明）。
