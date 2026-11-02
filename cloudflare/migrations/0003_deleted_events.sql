CREATE TABLE IF NOT EXISTS migajas_deleted_events (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  deleted_by TEXT NOT NULL
);
