ALTER TABLE commands ADD COLUMN claim_owner TEXT CHECK (
  claim_owner IS NULL OR (length(claim_owner) BETWEEN 1 AND 128)
);

ALTER TABLE commands ADD COLUMN claim_expires_at INTEGER CHECK (
  claim_expires_at IS NULL OR
  (claim_expires_at >= 0 AND claim_expires_at <= 8640000000000000)
);

CREATE TRIGGER command_claim_insert_is_valid
BEFORE INSERT ON commands
WHEN
  (NEW.claim_owner IS NULL) <> (NEW.claim_expires_at IS NULL) OR
  (NEW.claim_owner IS NOT NULL AND json_extract(NEW.result_json, '$.state') IS NOT 'pending') OR
  (json_extract(NEW.result_json, '$.state') = 'pending' AND
    (json_type(NEW.result_json, '$.prompt') IS NOT 'text' OR
     length(json_extract(NEW.result_json, '$.prompt')) > 16384)) OR
  length(NEW.result_json) > 131072
BEGIN
  SELECT RAISE(ABORT, 'invalid command claim or oversized command metadata');
END;

CREATE TRIGGER command_claim_update_is_valid
BEFORE UPDATE ON commands
WHEN
  (NEW.claim_owner IS NULL) <> (NEW.claim_expires_at IS NULL) OR
  (NEW.claim_owner IS NOT NULL AND json_extract(NEW.result_json, '$.state') IS NOT 'pending') OR
  (json_extract(NEW.result_json, '$.state') = 'pending' AND
    (json_type(NEW.result_json, '$.prompt') IS NOT 'text' OR
     length(json_extract(NEW.result_json, '$.prompt')) > 16384)) OR
  length(NEW.result_json) > 131072
BEGIN
  SELECT RAISE(ABORT, 'invalid command claim or oversized command metadata');
END;
