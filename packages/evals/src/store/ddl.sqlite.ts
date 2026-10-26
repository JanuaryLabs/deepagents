export const statements = [
  `CREATE TABLE suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)`,
  `CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  config TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  summary TEXT,
  FOREIGN KEY (suite_id) REFERENCES suites(id) ON DELETE CASCADE
)`,
  `CREATE INDEX idx_runs_suite_id ON runs(suite_id)`,
  `CREATE INDEX idx_runs_started_at ON runs(started_at)`,
  `CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  expected TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
)`,
  `CREATE INDEX idx_cases_run_id ON cases(run_id)`,
  `CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  scorer_name TEXT NOT NULL,
  score REAL NOT NULL,
  reason TEXT,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
)`,
  `CREATE INDEX idx_scores_case_id ON scores(case_id)`,
  `CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(name, version)
)`,
  `CREATE INDEX idx_prompts_created_at ON prompts(created_at)`,
  `CREATE INDEX idx_prompts_name_version ON prompts(name, version DESC)`,
];
