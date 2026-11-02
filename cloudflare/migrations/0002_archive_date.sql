ALTER TABLE migajas_events ADD COLUMN archived_at TEXT;
UPDATE migajas_events SET archived_at=updated_at WHERE archived=1;
