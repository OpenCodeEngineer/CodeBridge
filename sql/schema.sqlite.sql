CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  source_key TEXT UNIQUE,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  branch_prefix TEXT,
  slack_channel TEXT,
  slack_thread_ts TEXT,
  slack_message_ts TEXT,
  slack_user_id TEXT,
  github_owner TEXT,
  github_repo TEXT,
  github_issue_number INTEGER,
  github_comment_id INTEGER,
  github_trigger_comment_id INTEGER,
  github_installation_id INTEGER,
  github_issue_title TEXT,
  github_issue_body TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id);

CREATE TABLE IF NOT EXISTS github_poll_state (
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  last_comment_id INTEGER,
  last_comment_created_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, repo_full_name)
);
