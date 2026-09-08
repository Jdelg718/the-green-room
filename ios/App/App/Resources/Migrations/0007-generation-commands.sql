-- A generation command is the only durable mutation made before a provider
-- request.  Its immutable plan contains the proposed room transaction, but no
-- event, director, or room-sequence authority changes until completion wins.
CREATE TABLE generation_commands (
  command_id TEXT PRIMARY KEY CHECK (
    length(command_id) = 36 AND command_id = lower(command_id) AND
    command_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  request_id TEXT NOT NULL UNIQUE CHECK (
    length(request_id) = 36 AND request_id = lower(request_id) AND
    request_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest = lower(request_digest) AND
    request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_plan_json TEXT NOT NULL CHECK (json_valid(request_plan_json) AND json_type(request_plan_json) = 'object'),
  human_event_json TEXT NOT NULL CHECK (json_valid(human_event_json) AND json_extract(human_event_json, '$.type') = 'human_message'),
  director_event_json TEXT NOT NULL CHECK (json_valid(director_event_json) AND json_extract(director_event_json, '$.type') = 'director_decision'),
  director_state_json TEXT NOT NULL CHECK (json_valid(director_state_json) AND json_type(director_state_json) = 'object'),
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  expected_next_event_sequence INTEGER NOT NULL CHECK (expected_next_event_sequence >= 1),
  persona_slug TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'in_flight', 'failed', 'interrupted', 'completed', 'abandoned')),
  attempt_epoch INTEGER NOT NULL DEFAULT 0 CHECK (attempt_epoch >= 0),
  failure_code TEXT,
  response_text TEXT CHECK (response_text IS NULL OR (length(trim(response_text)) > 0 AND length(CAST(response_text AS BLOB)) <= 16384)),
  prepared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  CHECK (
    (persona_slug IS NULL AND json_extract(request_plan_json, '$.kind') = 'silence') OR
    (persona_slug IS NOT NULL AND json_extract(request_plan_json, '$.kind') = 'provider')
  ),
  CHECK (json_extract(request_plan_json, '$.requestId') = request_id),
  CHECK (json_extract(request_plan_json, '$.roomId') = room_id),
  CHECK (json_extract(request_plan_json, '$.sourceEventSequence') = expected_next_event_sequence),
  CHECK (json_extract(request_plan_json, '$.personaSlug') IS persona_slug),
  CHECK (json_extract(director_event_json, '$.generation') = expected_generation),
  CHECK (json_extract(director_event_json, '$.sourceEventSequence') = expected_next_event_sequence),
  CHECK (json_extract(director_event_json, '$.speaker') IS persona_slug),
  CHECK (
    (state = 'prepared' AND attempt_epoch = 0 AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL AND response_text IS NULL) OR
    (state = 'in_flight' AND attempt_epoch >= 1 AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL AND response_text IS NULL) OR
    (state = 'failed' AND attempt_epoch = 0 AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NOT NULL AND response_text IS NULL) OR
    (state = 'interrupted' AND attempt_epoch >= 1 AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NOT NULL AND response_text IS NULL) OR
    (state = 'completed' AND finished_at IS NOT NULL AND failure_code IS NULL AND ((persona_slug IS NULL AND response_text IS NULL) OR (persona_slug IS NOT NULL AND response_text IS NOT NULL))) OR
    (state = 'abandoned' AND finished_at IS NOT NULL AND response_text IS NULL)
  )
) STRICT;

CREATE TRIGGER generation_command_human_belongs_to_room
BEFORE INSERT ON generation_commands
WHEN NOT EXISTS (
  SELECT 1 FROM participants human
  WHERE human.room_id = NEW.room_id AND human.kind = 'human'
    AND human.id = json_extract(NEW.human_event_json, '$.participantId')
)
BEGIN SELECT RAISE(ABORT, 'generation command human is not in room'); END;

CREATE UNIQUE INDEX one_unresolved_generation_command_per_room
ON generation_commands(room_id)
WHERE state IN ('prepared', 'in_flight', 'failed', 'interrupted');

CREATE TRIGGER generation_commands_are_immutable
BEFORE UPDATE ON generation_commands
WHEN NEW.command_id <> OLD.command_id OR NEW.request_id <> OLD.request_id OR
  NEW.room_id <> OLD.room_id OR NEW.request_digest <> OLD.request_digest OR
  NEW.request_plan_json <> OLD.request_plan_json OR NEW.human_event_json <> OLD.human_event_json OR
  NEW.director_event_json <> OLD.director_event_json OR NEW.director_state_json <> OLD.director_state_json OR
  NEW.expected_generation <> OLD.expected_generation OR
  NEW.expected_next_event_sequence <> OLD.expected_next_event_sequence OR
  NEW.persona_slug IS NOT OLD.persona_slug OR NEW.prepared_at <> OLD.prepared_at
BEGIN SELECT RAISE(ABORT, 'generation command is immutable'); END;

CREATE TRIGGER generation_command_transition_is_valid
BEFORE UPDATE ON generation_commands
WHEN NOT (
  (OLD.state = 'prepared' AND NEW.state IN ('in_flight', 'failed', 'completed', 'abandoned')) OR
  (OLD.state = 'failed' AND NEW.state IN ('failed', 'in_flight', 'completed', 'abandoned')) OR
  (OLD.state = 'interrupted' AND NEW.state IN ('in_flight', 'abandoned')) OR
  (OLD.state = 'in_flight' AND NEW.state IN ('interrupted', 'completed')) OR
  (OLD.state = NEW.state AND OLD.attempt_epoch = NEW.attempt_epoch AND
    OLD.failure_code IS NEW.failure_code AND OLD.response_text IS NEW.response_text AND
    OLD.started_at IS NEW.started_at AND OLD.finished_at IS NEW.finished_at)
)
BEGIN SELECT RAISE(ABORT, 'invalid generation command transition'); END;

CREATE TRIGGER generation_command_completion_is_fenced
BEFORE UPDATE OF state ON generation_commands
WHEN NEW.state = 'completed' AND OLD.state <> 'completed' AND NOT EXISTS (
  SELECT 1 FROM rooms room
  WHERE room.id = OLD.room_id AND room.status = 'active'
    AND room.generation = OLD.expected_generation
    AND room.next_event_sequence = OLD.expected_next_event_sequence
)
BEGIN SELECT RAISE(ABORT, 'stale generation completion'); END;

CREATE TRIGGER generation_command_completion_commits_room
AFTER UPDATE OF state ON generation_commands
WHEN NEW.state = 'completed' AND OLD.state <> 'completed'
BEGIN
  UPDATE director_state
  SET state_json = NEW.director_state_json,
      last_human_event_sequence = NEW.expected_next_event_sequence,
      last_speaker_id = CASE WHEN NEW.persona_slug IS NULL THEN last_speaker_id ELSE NEW.persona_slug END,
      autonomous_turns = json_extract(NEW.director_state_json, '$.autonomousTurns'),
      scheduling_window_generation = NEW.expected_generation,
      updated_at = CURRENT_TIMESTAMP
  WHERE room_id = NEW.room_id;
  INSERT INTO events(room_id, sequence, event_json)
    VALUES (NEW.room_id, NEW.expected_next_event_sequence, NEW.human_event_json);
  INSERT INTO events(room_id, sequence, event_json)
    VALUES (NEW.room_id, NEW.expected_next_event_sequence + 1, NEW.director_event_json);
  INSERT INTO events(room_id, sequence, event_json)
    SELECT NEW.room_id, NEW.expected_next_event_sequence + 2,
      json_object(
        'generation', NEW.expected_generation,
        'personaSlug', NEW.persona_slug,
        'sourceEventSequence', NEW.expected_next_event_sequence,
        'text', NEW.response_text,
        'type', 'persona_message'
      )
    WHERE NEW.persona_slug IS NOT NULL;
  DELETE FROM local_drafts WHERE room_id = NEW.room_id;
END;

CREATE TRIGGER generation_commands_cannot_be_deleted
BEFORE DELETE ON generation_commands
BEGIN SELECT RAISE(ABORT, 'generation commands are durable'); END;
