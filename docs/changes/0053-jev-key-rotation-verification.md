# 0053 Jev Key 轮换验证（live 冒烟）

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：changes/0052、`docs/guides/jev-and-vps-runbook.md` §2.3.1、P6-04b
- 性质：运维验证记录；不改变规则、引擎、配置或实验产物

## 1. 验证内容

用户报告新 Key 已写入仓库根 `.env`。按 runbook §2.3.1 执行：

1. `pnpm check:secrets`：418 个入库文件通过。
2. `node --env-file=.env scripts/smoke-live.mjs --dry-run`：`apiKeyPresent=true`，
   端点 `https://jev.logicc.top/v1/systemone`，未发请求。
3. **最小 live 冒烟（6 人 / 1 tick）**：
   - `decisionsDue=6`、`decisionsOk=6`、`fallbacks=0`、`passed=true`；
   - usage：input 6772 / output 660，`listCost=0`，`missingRecords=0`；
   - 延迟 p50 1071 ms / max 4145 ms；响应模型 `jev-1.13-free`；
   - `finalStateHash=sha256:c3129c4d…`。
4. **8 人 / 30 tick 基线**：
   - `decisionsDue=24`、`decisionsOk=24`、`fallbacks=0`、`passed=true`；
   - usage：input 39784 / output 2981，`listCost=0`，`missingRecords=0`；
   - 延迟 p50 1067 ms / max 2446 ms；响应模型 `jev-1.13-free`；
   - `finalStateHash=sha256:3039f057…`。

两次冒烟均无 401、无回退、无缺失 usage；结果与 P2-07 参考基线（24/24、input 39753、
output 2981、p50 1.30 s）一致，差异在正常网络波动内。

## 2. 安全核对与边界

- 未在命令参数、输出或仓库中记录 Key；`--env-file=.env` 加载，未使用 shell 变量。
- `.env` 的 mtime 仍为 2026-11-04 23:21（未被本次写入更新）；当前 `.env` 的 Key
  **不等于**会话记录中唯一出现的 `jv-…` 候选（按 SHA-256 比对，未回显任何 Key）。
  因此当前 Key 至少不是会话中泄露的那一把；但**provider 侧旧 Key 是否已吊销，
  本会话无法独立核验**，需在密钥页确认。
- 本记录不写 Key、不写指纹原文、不写 provider 凭据。

## 3. 状态

- P6-04b 的 live 链路已可用：可以进入 20 次重测信度（top-1 ≥0.70、ICC(2,1) ≥0.50、
  平均 TV ≤0.15），再决定是否进入正式 Jev/mock 对照。
- **P6-04b 尚未运行**；本记录只是密钥与链路验证，不构成 live 实验证据、模型稳定性
  结论或校准（AGENTS #9、07 §11）。
- 建议在密钥页确认旧 Key 状态为 revoked，并检查泄露期间的费用/调用；该确认仍由用户完成。
