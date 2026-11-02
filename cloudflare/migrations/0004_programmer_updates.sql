ALTER TABLE migajas_roles RENAME TO migajas_roles_previous;
CREATE TABLE migajas_roles(uuid TEXT NOT NULL REFERENCES migajas_profiles(uuid),role TEXT NOT NULL CHECK(role IN('owner','admin','organizer','moderator','programmer')),event_id TEXT NOT NULL DEFAULT '*',auth_user_id TEXT NOT NULL,granted_by TEXT,created_at TEXT NOT NULL,PRIMARY KEY(uuid,role,event_id));
INSERT INTO migajas_roles SELECT * FROM migajas_roles_previous;
DROP TABLE migajas_roles_previous;
CREATE TABLE migajas_launcher_updates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  version_rank INTEGER NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('staging','active','retired')),
  uploader_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE UNIQUE INDEX launcher_single_active ON migajas_launcher_updates(status) WHERE status='active';
