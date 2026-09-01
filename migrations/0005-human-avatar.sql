ALTER TABLE human_profile ADD COLUMN avatar_webp BLOB
  CHECK (avatar_webp IS NULL OR (typeof(avatar_webp) = 'blob' AND length(avatar_webp) BETWEEN 16 AND 262144));
ALTER TABLE human_profile ADD COLUMN avatar_sha256 TEXT
  CHECK (avatar_sha256 IS NULL OR (typeof(avatar_sha256) = 'text' AND length(avatar_sha256) = 64));

CREATE TRIGGER human_avatar_columns_are_consistent_on_update
BEFORE UPDATE OF avatar_webp, avatar_sha256 ON human_profile
WHEN (NEW.avatar_webp IS NULL) <> (NEW.avatar_sha256 IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'human avatar columns must be set or cleared together');
END;
