-- A3 stores only the selected approved provider/profile/model tuple. Credential
-- bytes remain Keychain-only. Room activity is a projection of immutable events.
ALTER TABLE rooms ADD COLUMN last_activity_order INTEGER NOT NULL DEFAULT 0
  CHECK (last_activity_order >= 0);

UPDATE rooms SET last_activity_order = rowid;

CREATE TRIGGER room_event_updates_activity
AFTER INSERT ON events
BEGIN
  UPDATE rooms
  SET last_activity_order = COALESCE(
    (SELECT max(last_activity_order) FROM rooms WHERE id <> NEW.room_id),
    0
  ) + 1
  WHERE id = NEW.room_id;
END;

CREATE TABLE iphone_provider_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider_id TEXT NOT NULL CHECK (
    provider_id IN ('openrouter', 'openai', 'xai', 'groq', 'together')
  ),
  profile_id TEXT NOT NULL CHECK (profile_id = 'iphone.' || provider_id),
  profile_revision INTEGER NOT NULL CHECK (profile_revision BETWEEN 1 AND 2147483647),
  model TEXT NOT NULL CHECK (
    length(model) BETWEEN 1 AND 256 AND model = trim(model) AND instr(model, char(0)) = 0
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id, profile_revision, provider_id)
    REFERENCES connection_profile_revisions(profile_id, profile_revision, provider_id)
) STRICT;
