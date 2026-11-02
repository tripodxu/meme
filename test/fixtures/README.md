# test/fixtures

测试固定数据目录。现有分组：`config/`、`hash/`。

## 约定

- 每个 fixture 必须包含 schema 版本与来源（文档章节或生成脚本），便于判断何时失效。
- 禁止写入密钥、个人数据或真实 Jev 响应原文。
- golden 期望值更新必须附差异原因并人工审查；禁止用环境变量或 `--update` 一键覆盖后直接通过。
- 生成脚本读取已构建的 `dist/` 或 `src/`，不联网；更新后同时提交 fixture 与对应 golden 测试。
