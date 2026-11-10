CREATE TABLE IF NOT EXISTS cv_gateway_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS cv_gateway_credentials_user ON cv_gateway_credentials(user_id, project_id);
