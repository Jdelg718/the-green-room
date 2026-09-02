ALTER TABLE current_room ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT 0
  CHECK (selection_revision >= 0);

CREATE TABLE room_selection_commands (
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

CREATE TRIGGER room_selection_commands_cannot_be_updated
BEFORE UPDATE ON room_selection_commands
BEGIN
  SELECT RAISE(ABORT, 'room selection command results are immutable');
END;

CREATE TRIGGER room_selection_command_result_has_no_private_catalog_fields
BEFORE INSERT ON room_selection_commands
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.result_json)
  WHERE key IN (
    'prompt', 'promptSha256', 'promptUtf8Bytes', 'sourcePath', 'manifestId',
    'manifest', 'provenance', 'sources', 'license', 'digest', 'byteCount'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'room selection command result contains private catalog metadata');
END;

CREATE TRIGGER room_selection_commands_cannot_be_deleted
BEFORE DELETE ON room_selection_commands
BEGIN
  SELECT RAISE(ABORT, 'room selection command results are immutable');
END;
