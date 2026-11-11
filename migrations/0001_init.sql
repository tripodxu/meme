-- 0001 init: run metadata, sampled tick stats, final agents, experiments,
-- artifact manifest and fixed-window rate limits. 只追加；后续修正用新迁移。

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('browser', 'runner')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  end_reason TEXT CHECK (end_reason IN ('scheduled', 'extinct') OR end_reason IS NULL),
  config_json TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  decision_schema_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  prompt_version TEXT,
  requested_model TEXT,
  seed TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  initial_population_hash TEXT NOT NULL,
  code_sha TEXT NOT NULL,
  write_token_hash TEXT NOT NULL,
  write_token_prefix TEXT NOT NULL,
  artifact_profile TEXT NOT NULL DEFAULT 'full'
    CHECK (artifact_profile IN ('full', 'metrics-only')),
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'uploaded', 'verified', 'rejected')),
  verification_report_hash TEXT,
  response_models_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT,
  final_tick INTEGER,
  final_alive_count INTEGER,
  final_state_hash TEXT,
  summary_hash TEXT,
  complete_json TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS runs_source_status ON runs (source, status, created_at DESC);

CREATE TABLE IF NOT EXISTS tick_stats (
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  alive_count INTEGER NOT NULL,
  class_counts_json TEXT NOT NULL,
  gini REAL NOT NULL,
  median_value REAL NOT NULL,
  top10_share REAL NOT NULL,
  m_up REAL NOT NULL,
  m_down REAL NOT NULL,
  segregation REAL NOT NULL,
  edge_count INTEGER NOT NULL,
  openness REAL NOT NULL,
  death_count INTEGER NOT NULL,
  competition_loss REAL NOT NULL,
  competition_gain REAL NOT NULL,
  fallback_rate REAL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tick),
  FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tick_stats_run_tick ON tick_stats (run_id, tick);

CREATE TABLE IF NOT EXISTS agent_final (
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  alive INTEGER NOT NULL,
  class_index INTEGER NOT NULL,
  max_class_index INTEGER NOT NULL,
  value REAL NOT NULL,
  ge REAL NOT NULL,
  hard REAL NOT NULL,
  initial_life REAL NOT NULL,
  remaining_life REAL NOT NULL,
  death_tick INTEGER,
  death_reason TEXT,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id),
  FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_final_run ON agent_final (run_id, agent_id);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('runner')),
  status TEXT NOT NULL DEFAULT 'created',
  manifest_json TEXT NOT NULL,
  preregistration_hash TEXT NOT NULL,
  label_thresholds_hash TEXT NOT NULL,
  base_config_hash TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS experiments_created_at ON experiments (created_at DESC, experiment_id DESC);

CREATE TABLE IF NOT EXISTS experiment_runs (
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  cell_key TEXT NOT NULL,
  seed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, run_id),
  UNIQUE (experiment_id, cell_key, seed),
  FOREIGN KEY (experiment_id) REFERENCES experiments (experiment_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS experiment_runs_run ON experiment_runs (run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('decisions', 'events', 'snapshot', 'final_state', 'metrics', 'manifest')),
  chunk_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uncompressed_sha256 TEXT NOT NULL,
  compressed_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  start_tick INTEGER,
  end_tick INTEGER,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_id),
  FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS artifacts_run_kind ON artifacts (run_id, kind, start_tick, end_tick);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits (window_start);
