CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'persona')),
  display_name TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  UNIQUE (room_id, id),
  UNIQUE (room_id, sort_order)
) STRICT;

CREATE TRIGGER participant_identity_is_immutable
BEFORE UPDATE OF id, room_id, kind, display_name, sort_order ON participants
BEGIN
  SELECT RAISE(ABORT, 'participant identity is immutable');
END;

CREATE TRIGGER participants_cannot_be_deleted
BEFORE DELETE ON participants
BEGIN
  SELECT RAISE(ABORT, 'fixed participants cannot be deleted');
END;

CREATE TABLE events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_json TEXT NOT NULL CHECK (json_valid(event_json) AND json_type(event_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, sequence)
) STRICT;

CREATE TRIGGER events_cannot_be_updated
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_cannot_be_deleted
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TABLE commands (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, request_id)
) STRICT;

CREATE TABLE director_state (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  last_speaker_id TEXT,
  last_human_event_sequence INTEGER CHECK (
    last_human_event_sequence IS NULL OR last_human_event_sequence >= 1
  ),
  autonomous_turns INTEGER NOT NULL DEFAULT 0 CHECK (autonomous_turns >= 0),
  scheduling_window_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    scheduling_window_generation >= 0
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id, last_speaker_id) REFERENCES participants(room_id, id)
) STRICT;

INSERT INTO rooms (id, title, status)
VALUES ('first-playable', 'The Green Room', 'active');

INSERT INTO participants (id, room_id, kind, display_name, sort_order)
VALUES
  ('human', 'first-playable', 'human', 'You', 0),
  ('detective', 'first-playable', 'persona', 'The Detective', 1),
  ('fixer', 'first-playable', 'persona', 'The Fixer', 2),
  ('optimist', 'first-playable', 'persona', 'The Optimist', 3);

INSERT INTO director_state (room_id)
VALUES ('first-playable');
