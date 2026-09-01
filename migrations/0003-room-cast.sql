ALTER TABLE participants ADD COLUMN persona_slug TEXT;

UPDATE participants
SET persona_slug = id
WHERE kind = 'persona';

CREATE UNIQUE INDEX participants_room_persona_slug_unique
ON participants(room_id, persona_slug)
WHERE persona_slug IS NOT NULL;

CREATE UNIQUE INDEX rooms_single_active_session
ON rooms(status)
WHERE status = 'active';

CREATE TRIGGER participant_cast_insert_is_valid
BEFORE INSERT ON participants
WHEN
  length(NEW.id) NOT BETWEEN 1 AND 128 OR
  NEW.id <> trim(NEW.id) OR
  length(NEW.display_name) NOT BETWEEN 1 AND 128 OR
  NEW.display_name <> trim(NEW.display_name) OR
  (NEW.kind = 'human' AND (NEW.persona_slug IS NOT NULL OR NEW.sort_order <> 0)) OR
  (NEW.kind = 'persona' AND (
    NEW.persona_slug IS NULL OR
    length(NEW.persona_slug) NOT BETWEEN 1 AND 128 OR
    NEW.persona_slug <> trim(NEW.persona_slug) OR
    NEW.persona_slug <> lower(NEW.persona_slug) OR
    NEW.persona_slug GLOB '*[^a-z0-9-]*' OR
    NEW.persona_slug LIKE '-%' OR
    NEW.persona_slug LIKE '%-' OR
    NEW.persona_slug LIKE '%--%' OR
    NEW.sort_order NOT BETWEEN 1 AND 3
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid bounded participant cast identity');
END;

CREATE TRIGGER participant_cast_identity_is_immutable
BEFORE UPDATE OF persona_slug ON participants
BEGIN
  SELECT RAISE(ABORT, 'participant cast identity is immutable');
END;

CREATE TABLE current_room (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id)
) STRICT;

CREATE TRIGGER current_room_cannot_be_deleted
BEFORE DELETE ON current_room
BEGIN
  SELECT RAISE(ABORT, 'current room pointer cannot be deleted');
END;

INSERT INTO current_room(singleton, room_id)
VALUES (1, 'first-playable');

CREATE TABLE cast_commands (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) BETWEEN 1 AND 256 AND request_id = trim(request_id)
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND
    json_type(result_json) = 'object' AND
    length(result_json) <= 32768 AND
    json_type(result_json, '$.prompt') IS NULL AND
    json_type(result_json, '$.promptSha256') IS NULL AND
    json_type(result_json, '$.sourcePath') IS NULL
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TRIGGER cast_commands_cannot_be_updated
BEFORE UPDATE ON cast_commands
BEGIN
  SELECT RAISE(ABORT, 'cast command results are immutable');
END;

CREATE TRIGGER cast_command_result_has_no_private_catalog_fields
BEFORE INSERT ON cast_commands
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.result_json)
  WHERE key IN (
    'prompt', 'promptSha256', 'promptUtf8Bytes', 'sourcePath', 'manifestId',
    'manifest', 'provenance', 'sources', 'license', 'digest', 'byteCount'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cast command result contains private catalog metadata');
END;

CREATE TRIGGER cast_commands_cannot_be_deleted
BEFORE DELETE ON cast_commands
BEGIN
  SELECT RAISE(ABORT, 'cast command results are immutable');
END;
