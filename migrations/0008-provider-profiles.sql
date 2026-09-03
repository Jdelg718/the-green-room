CREATE TABLE connection_profile_revisions (
  profile_id TEXT NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 128 AND
    profile_id GLOB '[a-z]*' AND
    profile_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled', 'deleted')),
  profile_json TEXT NOT NULL CHECK (
    json_valid(profile_json) AND json_type(profile_json) = 'object' AND
    length(profile_json) <= 8192 AND
    json_extract(profile_json, '$.id') = profile_id AND
    json_extract(profile_json, '$.revision') = revision AND
    (state = 'enabled' OR json_type(profile_json, '$.credentialRef') IS NULL) AND
    (
      json_type(profile_json, '$.credentialRef') IS NULL OR
      json_extract(profile_json, '$.credentialRef') =
        'credential:' || profile_id || ':' || revision
    )
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, revision)
) STRICT;

CREATE TRIGGER connection_profile_revisions_are_contiguous
BEFORE INSERT ON connection_profile_revisions
WHEN NEW.revision <> COALESCE(
  (SELECT max(revision) + 1 FROM connection_profile_revisions WHERE profile_id = NEW.profile_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'connection profile revision gap or conflict');
END;

CREATE TRIGGER connection_profile_revisions_have_no_secret_fields
BEFORE INSERT ON connection_profile_revisions
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.profile_json)
  WHERE lower(COALESCE(key, '')) IN (
    'credential', 'apikey', 'api_key', 'authorization', 'secret', 'token'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'connection profile contains a secret field');
END;

CREATE TRIGGER connection_profile_revisions_cannot_be_updated
BEFORE UPDATE ON connection_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'connection profile revisions are immutable');
END;

CREATE TRIGGER connection_profile_revisions_cannot_be_deleted
BEFORE DELETE ON connection_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'connection profile revisions are immutable');
END;

CREATE TABLE model_profile_revisions (
  profile_id TEXT NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 128 AND
    profile_id GLOB '[a-z]*' AND
    profile_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled', 'deleted')),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  profile_json TEXT NOT NULL CHECK (
    json_valid(profile_json) AND json_type(profile_json) = 'object' AND
    length(profile_json) <= 16384 AND
    json_extract(profile_json, '$.id') = profile_id AND
    json_extract(profile_json, '$.revision') = revision AND
    json_extract(profile_json, '$.connection.profileId') = connection_id AND
    json_extract(profile_json, '$.connection.revision') = connection_revision
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, revision),
  FOREIGN KEY (connection_id, connection_revision)
    REFERENCES connection_profile_revisions(profile_id, revision)
) STRICT;

CREATE TRIGGER model_profile_revisions_are_contiguous
BEFORE INSERT ON model_profile_revisions
WHEN NEW.revision <> COALESCE(
  (SELECT max(revision) + 1 FROM model_profile_revisions WHERE profile_id = NEW.profile_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'model profile revision gap or conflict');
END;

CREATE TRIGGER model_profile_revisions_have_no_secret_fields
BEFORE INSERT ON model_profile_revisions
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.profile_json)
  WHERE lower(COALESCE(key, '')) IN (
    'credentialref', 'credential', 'apikey', 'api_key', 'authorization', 'secret', 'token'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'model profile contains a secret field');
END;

CREATE TRIGGER model_profile_revisions_cannot_be_updated
BEFORE UPDATE ON model_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TRIGGER model_profile_revisions_cannot_be_deleted
BEFORE DELETE ON model_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TABLE provider_observations (
  observation_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (
    length(id) BETWEEN 1 AND 128 AND id = trim(id)
  ),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('ready', 'degraded', 'failed')),
  capability_fingerprint TEXT NOT NULL CHECK (
    length(capability_fingerprint) = 71 AND
    capability_fingerprint GLOB 'sha256:*' AND
    substr(capability_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_json TEXT NOT NULL CHECK (
    json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND
    length(evidence_json) <= 16384
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (connection_id, connection_revision)
    REFERENCES connection_profile_revisions(profile_id, revision)
) STRICT;

CREATE INDEX provider_observations_by_connection
ON provider_observations(connection_id, connection_revision, observation_sequence);

CREATE TRIGGER provider_observations_have_no_secret_fields
BEFORE INSERT ON provider_observations
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.evidence_json)
  WHERE lower(COALESCE(key, '')) IN (
    'credentialref', 'credential', 'apikey', 'api_key', 'authorization', 'secret', 'token'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'provider observation contains a secret field');
END;

CREATE TRIGGER provider_observations_cannot_be_updated
BEFORE UPDATE ON provider_observations
BEGIN
  SELECT RAISE(ABORT, 'provider observations are immutable');
END;

CREATE TRIGGER provider_observations_cannot_be_deleted
BEFORE DELETE ON provider_observations
BEGIN
  SELECT RAISE(ABORT, 'provider observations are immutable');
END;

CREATE TABLE room_binding_revisions (
  binding_id TEXT NOT NULL CHECK (
    length(binding_id) BETWEEN 1 AND 128 AND
    binding_id GLOB '[a-z]*' AND
    binding_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  purpose TEXT NOT NULL CHECK (purpose = 'persona-default'),
  model_id TEXT NOT NULL,
  model_revision INTEGER NOT NULL,
  binding_json TEXT NOT NULL CHECK (
    json_valid(binding_json) AND json_type(binding_json) = 'object' AND
    length(binding_json) <= 8192 AND
    json_extract(binding_json, '$.id') = binding_id AND
    json_extract(binding_json, '$.revision') = revision AND
    json_extract(binding_json, '$.roomId') = room_id AND
    json_extract(binding_json, '$.purpose') = purpose AND
    json_extract(binding_json, '$.model.profileId') = model_id AND
    json_extract(binding_json, '$.model.revision') = model_revision
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (binding_id, revision),
  UNIQUE (room_id, purpose, revision),
  FOREIGN KEY (model_id, model_revision)
    REFERENCES model_profile_revisions(profile_id, revision)
) STRICT;

CREATE TRIGGER room_binding_identity_is_stable
BEFORE INSERT ON room_binding_revisions
WHEN EXISTS (
  SELECT 1 FROM room_binding_revisions
  WHERE room_id = NEW.room_id AND purpose = NEW.purpose AND binding_id <> NEW.binding_id
)
BEGIN
  SELECT RAISE(ABORT, 'room binding identity mismatch');
END;

CREATE TRIGGER room_binding_lineage_is_stable
BEFORE INSERT ON room_binding_revisions
WHEN EXISTS (
  SELECT 1 FROM room_binding_revisions
  WHERE binding_id = NEW.binding_id AND (room_id <> NEW.room_id OR purpose <> NEW.purpose)
)
BEGIN
  SELECT RAISE(ABORT, 'room binding lineage mismatch');
END;

CREATE TRIGGER room_binding_revisions_are_contiguous
BEFORE INSERT ON room_binding_revisions
WHEN NEW.revision <> COALESCE(
  (SELECT max(revision) + 1 FROM room_binding_revisions WHERE binding_id = NEW.binding_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'room binding revision gap or conflict');
END;

CREATE TRIGGER room_binding_revisions_cannot_be_updated
BEFORE UPDATE ON room_binding_revisions
BEGIN
  SELECT RAISE(ABORT, 'room binding revisions are immutable');
END;

CREATE TRIGGER room_binding_revisions_cannot_be_deleted
BEFORE DELETE ON room_binding_revisions
BEGIN
  SELECT RAISE(ABORT, 'room binding revisions are immutable');
END;

CREATE TABLE provider_decision_snapshots (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND
    id GLOB '[a-z]*' AND
    id NOT GLOB '*[^a-z0-9._-]*'
  ),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256 AND request_id = trim(request_id)),
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  model_revision INTEGER NOT NULL,
  capability_fingerprint TEXT NOT NULL CHECK (
    length(capability_fingerprint) = 71 AND
    capability_fingerprint GLOB 'sha256:*' AND
    substr(capability_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_definition_id TEXT,
  provider_definition_version INTEGER CHECK (
    provider_definition_version IS NULL OR provider_definition_version = 1
  ),
  routing_policy TEXT NOT NULL CHECK (routing_policy = 'single-attempt-no-fallback-v1'),
  snapshot_json TEXT NOT NULL CHECK (
    json_valid(snapshot_json) AND json_type(snapshot_json) = 'object' AND
    length(snapshot_json) <= 32768 AND
    json_extract(snapshot_json, '$.id') = id AND
    json_extract(snapshot_json, '$.binding.id') = binding_id AND
    json_extract(snapshot_json, '$.binding.revision') = binding_revision AND
    json_extract(snapshot_json, '$.binding.roomId') = room_id AND
    json_extract(snapshot_json, '$.connection.id') = connection_id AND
    json_extract(snapshot_json, '$.connection.revision') = connection_revision AND
    json_extract(snapshot_json, '$.model.id') = model_id AND
    json_extract(snapshot_json, '$.model.revision') = model_revision AND
    json_extract(snapshot_json, '$.capabilityFingerprint') = capability_fingerprint
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, request_id),
  FOREIGN KEY (binding_id, binding_revision)
    REFERENCES room_binding_revisions(binding_id, revision),
  FOREIGN KEY (connection_id, connection_revision)
    REFERENCES connection_profile_revisions(profile_id, revision),
  FOREIGN KEY (model_id, model_revision)
    REFERENCES model_profile_revisions(profile_id, revision),
  CHECK (
    (provider_definition_id IS NULL) = (provider_definition_version IS NULL)
  )
) STRICT;

CREATE TRIGGER provider_decision_snapshots_have_no_credential_reference
BEFORE INSERT ON provider_decision_snapshots
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.snapshot_json)
  WHERE lower(COALESCE(key, '')) IN (
    'credentialref', 'credential', 'apikey', 'api_key', 'authorization', 'secret', 'token'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'decision snapshot contains a credential reference or secret field');
END;

CREATE TRIGGER provider_decision_snapshots_cannot_be_updated
BEFORE UPDATE ON provider_decision_snapshots
BEGIN
  SELECT RAISE(ABORT, 'provider decision snapshots are immutable');
END;

CREATE TRIGGER provider_decision_snapshots_cannot_be_deleted
BEFORE DELETE ON provider_decision_snapshots
BEGIN
  SELECT RAISE(ABORT, 'provider decision snapshots are immutable');
END;
