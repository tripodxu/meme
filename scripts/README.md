# scripts

仓库级脚本。Node-only，不进入构建产物，也不得被 `src/core` 引用。

计划脚本：`smoke-live`、`verify-backup`、`benchmark`、`export-d1`。

## 约定

- 密钥只从环境变量读取，不得打印、写入 fixture 或提交到仓库。
- 真实 Jev 冒烟必须使用独立低预算密钥，默认不随 CI 运行。
- `check-doc-links.mjs` 由 `pnpm check:docs` 调用，检查仓库内 Markdown 的相对链接。

## 现有脚本

| 脚本                  | 作用                           |
| --------------------- | ------------------------------ |
| `check-doc-links.mjs` | 校验 Markdown 相对链接目标存在 |
