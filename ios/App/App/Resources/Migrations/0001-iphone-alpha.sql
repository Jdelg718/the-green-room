-- Intentionally seeds no room. The signed JavaScript runtime creates the
-- first bounded room through reviewed statement IDs after this migration.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id = trim(id)),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 128 AND title = trim(title)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE participants (
  id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'persona')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128 AND display_name = trim(display_name)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 3),
  persona_slug TEXT,
  PRIMARY KEY (room_id, id),
  UNIQUE (room_id, sort_order),
  UNIQUE (room_id, persona_slug),
  CHECK (
    (kind = 'human' AND persona_slug IS NULL AND sort_order = 0) OR
    (kind = 'persona' AND persona_slug IS NOT NULL AND sort_order BETWEEN 1 AND 3)
  )
) STRICT;

CREATE TRIGGER participant_identity_is_immutable
BEFORE UPDATE OF id, room_id, kind, display_name, sort_order, persona_slug ON participants
BEGIN SELECT RAISE(ABORT, 'participant identity is immutable'); END;

CREATE TRIGGER participants_cannot_be_deleted
BEFORE DELETE ON participants
BEGIN SELECT RAISE(ABORT, 'participants cannot be deleted'); END;

CREATE TABLE events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_json TEXT NOT NULL CHECK (json_valid(event_json) AND json_type(event_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, sequence)
) STRICT;

CREATE TRIGGER events_cannot_be_updated
BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER events_cannot_be_deleted
BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;

CREATE TABLE director_state (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  last_speaker_id TEXT,
  last_human_event_sequence INTEGER CHECK (last_human_event_sequence IS NULL OR last_human_event_sequence >= 1),
  autonomous_turns INTEGER NOT NULL DEFAULT 0 CHECK (autonomous_turns >= 0),
  scheduling_window_generation INTEGER NOT NULL DEFAULT 0 CHECK (scheduling_window_generation >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id, last_speaker_id) REFERENCES participants(room_id, id)
) STRICT;

CREATE TABLE current_room (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id)
) STRICT;

CREATE TRIGGER current_room_cannot_be_deleted
BEFORE DELETE ON current_room BEGIN SELECT RAISE(ABORT, 'current room pointer cannot be deleted'); END;

CREATE TABLE local_drafts (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  text TEXT NOT NULL CHECK (length(text) <= 16384),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
