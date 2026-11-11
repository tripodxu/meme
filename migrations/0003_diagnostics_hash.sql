-- 0003: cancel/fail 的 diagnosticsHash（05 §3）。只追加；旧 run 保持 NULL。
-- 该摘要只是诊断元数据，不参与回放或内容认证。

ALTER TABLE runs ADD COLUMN diagnostics_hash TEXT;
