# 0052 Jev Key 轮换守卫与仓库泄漏审计

- 日期：2026-11-05
- 作者：徐鼎（施工代理执行）
- 关联：11 §2（秘密管理）、`docs/guides/jev-and-vps-runbook.md` §2.3、P6-04b
- 性质：安全工程变更；不改变规则、引擎、配置或实验结果

## 1. 变更内容

- 新增 `scripts/check-secrets.mjs`：只扫描 `git ls-files` 的入库文件，命中
  `jv-` + ≥20 位字母数字的疑似 Key 时失败；**只打印文件:行号与规则名，不打印匹配内容**。
  因 `.env` 被 `.gitignore` 忽略，脚本不会读取本机真实密钥。
- 新增 `scripts/check-secrets.d.mts` 与 `test/unit/scripts/check-secrets.test.ts`（3 项）：
  识别长串 Key、占位符/URL 不误报、短示例串不命中。
- `package.json` 新增 `check:secrets`；CI 在文档链接检查后执行。
- `docs/guides/jev-and-vps-runbook.md` 新增 §2.3.1 轮换步骤：吊销旧 Key、签发新 Key、
  更新本机 `.env`（600）与 VPS `/etc/stratify/runner.env`（600）、仓库/历史扫描、
  dry-run、最小 live 冒烟、仓库外留痕、禁止事项。

## 2. 泄漏审计结果（2026-11-05）

- `.env` 存在，`JEV_API_KEY` 长度 67、以 `jv-` 开头；文件 mtime **2026-11-04 23:21**，
  早于本次泄露披露，**按已泄露处理**；`.env` 被 `.gitignore` 第 19 行忽略。
- `git ls-files` 的 **418 个入库文件**扫描通过：无 `jv-` 长串 Key。
- `git log --all -G 'jv-[A-Za-z0-9]{20,}'` 无命中；历史中 `JEV_API_KEY=` 仅出现在
  `.env.example`、README、runbook、artifacts、smoke 脚本文档/占位符中。
- 未在仓库、fixture、历史提交或文档中发现真实 Key。

## 3. 未完成（需密钥页权限）

- **provider 侧吊销旧 Key 与签发新 Key 未执行**：需要用户账号在密钥页操作，当前会话无此权限。
- 本机 `.env` **尚未更新**为新 Key；VPS `/etc/stratify/runner.env` 尚未更新。
- 在完成上述两步前，**不得用当前 `.env` 发起 live 调用**（旧 Key 已泄露）；
  P6-04b Jev/mock 对照继续保持阻塞。
- 轮换完成后按 runbook §2.3.1 第 5–7 步验证：`pnpm check:secrets`、dry-run、
  6 人/1 tick 冒烟、8 人/30 tick 基线。

## 4. 验证

- `pnpm check:secrets` → 418 个入库文件通过。
- `pnpm vitest run test/unit/scripts/check-secrets.test.ts` → 3/3 通过。

## 5. 兼容性

- 无规则/配置/哈希/实验产物变化；仅新增安全守卫、测试与运维文档。
