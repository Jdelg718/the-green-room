-- Connection profile revisions are immutable native authority. A credential
-- reservation may only bind the current non-tombstoned exact provider revision.
CREATE TABLE connection_profile_revisions (
  profile_id TEXT NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 128 AND profile_id GLOB '[a-z]*' AND
    profile_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  profile_revision INTEGER NOT NULL CHECK (profile_revision BETWEEN 1 AND 2147483647),
  provider_id TEXT NOT NULL CHECK (
    length(provider_id) BETWEEN 1 AND 128 AND provider_id GLOB '[a-z]*' AND
    provider_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  expected_prior_revision INTEGER CHECK (
    expected_prior_revision IS NULL OR expected_prior_revision BETWEEN 1 AND 2147483647
  ),
  tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, profile_revision),
  UNIQUE (profile_id, profile_revision, provider_id),
  CHECK (
    (profile_revision = 1 AND expected_prior_revision IS NULL) OR
    (profile_revision > 1 AND expected_prior_revision = profile_revision - 1)
  )
) STRICT;

CREATE TRIGGER connection_profile_revisions_are_contiguous
BEFORE INSERT ON connection_profile_revisions
WHEN NEW.profile_revision <> COALESCE(
  (SELECT max(profile_revision) + 1 FROM connection_profile_revisions WHERE profile_id = NEW.profile_id), 1
)
BEGIN SELECT RAISE(ABORT, 'connection profile revision gap or conflict'); END;

CREATE TRIGGER connection_profile_provider_is_stable
BEFORE INSERT ON connection_profile_revisions
WHEN EXISTS (
  SELECT 1 FROM connection_profile_revisions
  WHERE profile_id = NEW.profile_id AND provider_id <> NEW.provider_id
)
BEGIN SELECT RAISE(ABORT, 'connection profile provider mismatch'); END;

CREATE TRIGGER connection_profile_revisions_are_immutable
BEFORE UPDATE ON connection_profile_revisions
WHEN NEW.profile_id <> OLD.profile_id OR NEW.profile_revision <> OLD.profile_revision OR
  NEW.provider_id <> OLD.provider_id OR NEW.expected_prior_revision IS NOT OLD.expected_prior_revision OR
  NEW.created_at <> OLD.created_at OR NOT (OLD.tombstoned = NEW.tombstoned OR (OLD.tombstoned = 0 AND NEW.tombstoned = 1))
BEGIN SELECT RAISE(ABORT, 'connection profile revision is immutable'); END;

CREATE TRIGGER connection_profile_revisions_cannot_be_deleted
BEFORE DELETE ON connection_profile_revisions
BEGIN SELECT RAISE(ABORT, 'connection profile revisions are durable'); END;

-- Provider credential bytes never enter this schema. This table is the
-- authoritative, non-secret lifecycle record for one immutable profile
-- revision and its canonical Keychain reference.
CREATE TABLE credential_revisions (
  profile_id TEXT NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 128 AND
    profile_id GLOB '[a-z]*' AND
    profile_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  profile_revision INTEGER NOT NULL CHECK (profile_revision BETWEEN 1 AND 2147483647),
  provider_id TEXT NOT NULL CHECK (
    length(provider_id) BETWEEN 1 AND 128 AND
    provider_id GLOB '[a-z]*' AND
    provider_id NOT GLOB '*[^a-z0-9._-]*'
  ),
  credential_ref TEXT NOT NULL CHECK (
    credential_ref = 'credential:' || profile_id || ':' || profile_revision
  ),
  expected_prior_revision INTEGER CHECK (
    expected_prior_revision IS NULL OR
    expected_prior_revision BETWEEN 1 AND 2147483647
  ),
  mutation_id TEXT NOT NULL UNIQUE CHECK (
    length(mutation_id) = 36 AND
    mutation_id = lower(mutation_id) AND
    mutation_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('credential_pending', 'ready', 'delete_pending', 'missing')
  ),
  tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  PRIMARY KEY (profile_id, profile_revision),
  UNIQUE (credential_ref),
  FOREIGN KEY (profile_id, profile_revision, provider_id)
    REFERENCES connection_profile_revisions(profile_id, profile_revision, provider_id),
  CHECK (
    (profile_revision = 1 AND expected_prior_revision IS NULL) OR
    (profile_revision > 1 AND expected_prior_revision = profile_revision - 1)
  ),
  CHECK (tombstoned = 0 OR lifecycle_state IN ('delete_pending', 'missing'))
) STRICT;

CREATE TRIGGER credential_reservation_requires_current_profile
BEFORE INSERT ON credential_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM connection_profile_revisions profile
  WHERE profile.profile_id = NEW.profile_id
    AND profile.profile_revision = NEW.profile_revision
    AND profile.provider_id = NEW.provider_id
    AND profile.tombstoned = 0
    AND profile.profile_revision = (
      SELECT max(current.profile_revision) FROM connection_profile_revisions current
      WHERE current.profile_id = profile.profile_id
    )
)
BEGIN SELECT RAISE(ABORT, 'credential reservation lacks current profile authority'); END;

CREATE TRIGGER credential_revisions_are_contiguous
BEFORE INSERT ON credential_revisions
WHEN NEW.profile_revision <> COALESCE(
  (SELECT max(profile_revision) + 1 FROM credential_revisions WHERE profile_id = NEW.profile_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'credential revision gap or conflict');
END;

CREATE TRIGGER credential_revisions_lineage_is_stable
BEFORE INSERT ON credential_revisions
WHEN EXISTS (
  SELECT 1 FROM credential_revisions
  WHERE profile_id = NEW.profile_id AND provider_id <> NEW.provider_id
)
BEGIN
  SELECT RAISE(ABORT, 'credential provider lineage mismatch');
END;

CREATE TRIGGER credential_revisions_lifecycle_only
BEFORE UPDATE ON credential_revisions
WHEN
  NEW.profile_id <> OLD.profile_id OR
  NEW.profile_revision <> OLD.profile_revision OR
  NEW.provider_id <> OLD.provider_id OR
  NEW.credential_ref <> OLD.credential_ref OR
  NEW.expected_prior_revision IS NOT OLD.expected_prior_revision OR
  NEW.mutation_id <> OLD.mutation_id OR
  NEW.created_at <> OLD.created_at OR
  NOT (
    (OLD.lifecycle_state = 'credential_pending' AND NEW.lifecycle_state = 'ready' AND NEW.tombstoned = 0) OR
    (OLD.lifecycle_state = 'ready' AND NEW.lifecycle_state = 'missing' AND NEW.tombstoned = 0) OR
    (OLD.lifecycle_state IN ('credential_pending', 'ready', 'delete_pending') AND NEW.lifecycle_state = 'delete_pending' AND NEW.tombstoned = 1) OR
    (OLD.lifecycle_state = 'delete_pending' AND NEW.lifecycle_state = 'missing' AND NEW.tombstoned = 1) OR
    (OLD.lifecycle_state = NEW.lifecycle_state AND OLD.tombstoned = NEW.tombstoned)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid credential lifecycle transition');
END;

CREATE TRIGGER credential_revisions_cannot_be_deleted
BEFORE DELETE ON credential_revisions
BEGIN SELECT RAISE(ABORT, 'credential lifecycle records are durable'); END;

CREATE TABLE credential_tombstones (
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE CHECK (
    length(mutation_id) = 36 AND
    mutation_id = lower(mutation_id) AND
    mutation_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, profile_revision),
  FOREIGN KEY (profile_id, profile_revision)
    REFERENCES credential_revisions(profile_id, profile_revision),
  CHECK (credential_ref = 'credential:' || profile_id || ':' || profile_revision)
) STRICT;

CREATE TRIGGER credential_tombstones_match_revision
BEFORE INSERT ON credential_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM credential_revisions
  WHERE profile_id = NEW.profile_id
    AND profile_revision = NEW.profile_revision
    AND provider_id = NEW.provider_id
    AND credential_ref = NEW.credential_ref
)
BEGIN
  SELECT RAISE(ABORT, 'credential tombstone mismatch');
END;

CREATE TRIGGER credential_tombstone_blocks_use
AFTER INSERT ON credential_tombstones
BEGIN
  UPDATE connection_profile_revisions
  SET tombstoned = 1
  WHERE profile_id = NEW.profile_id AND profile_revision = NEW.profile_revision;
  UPDATE credential_revisions
  SET lifecycle_state = 'delete_pending', tombstoned = 1
  WHERE profile_id = NEW.profile_id AND profile_revision = NEW.profile_revision;
END;

CREATE TRIGGER credential_tombstones_cannot_be_updated
BEFORE UPDATE ON credential_tombstones
BEGIN SELECT RAISE(ABORT, 'credential tombstones are immutable'); END;

CREATE TRIGGER credential_tombstones_cannot_be_deleted
BEFORE DELETE ON credential_tombstones
BEGIN SELECT RAISE(ABORT, 'credential tombstones are durable'); END;

CREATE INDEX credential_revisions_by_state
ON credential_revisions(lifecycle_state, tombstoned, profile_id, profile_revision);
