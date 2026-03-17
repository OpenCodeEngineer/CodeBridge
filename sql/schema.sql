CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  source_key TEXT UNIQUE,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  backend TEXT,
  agent TEXT,
  model TEXT,
  branch_prefix TEXT,
  slack_channel TEXT,
  slack_thread_ts TEXT,
  slack_message_ts TEXT,
  slack_user_id TEXT,
  github_owner TEXT,
  github_repo TEXT,
  github_issue_number INTEGER,
  github_comment_id BIGINT,
  github_trigger_comment_id BIGINT,
  github_installation_id BIGINT,
  github_issue_title TEXT,
  github_issue_body TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS github_trigger_comment_id BIGINT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS backend TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS runs_source_key_idx ON runs(source_key);

CREATE TABLE IF NOT EXISTS github_poll_state (
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  last_comment_id BIGINT,
  last_comment_created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, repo_full_name)
);
