-- 0002: ADR 0001 运行时权威标记。hash 只在同一 runtimeVersion 内承诺一致；
-- 与服务器 RUNTIME_VERSION 不同的 run 必须在 D1 中显式标记，禁止混入正式对照。
-- 只追加；不回填历史 run 的语义（默认 non-authoritative）。

ALTER TABLE runs ADD COLUMN runtime_authority TEXT NOT NULL DEFAULT 'non-authoritative';
