-- One non-secret current consent record. Schema-seven upgrades intentionally
-- create the table empty: prior provider use is not evidence of consent.
CREATE TABLE iphone_provider_data_use_consent (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider_id TEXT NOT NULL CHECK (
    provider_id IN ('openrouter', 'openai', 'xai', 'groq', 'together')
  ),
  provider_definition_version INTEGER NOT NULL CHECK (provider_definition_version = 1),
  model TEXT NOT NULL CHECK (
    length(CAST(model AS BLOB)) BETWEEN 1 AND 256 AND
    model = trim(model) AND
    instr(model, char(0)) = 0 AND instr(model, char(9)) = 0 AND
    instr(model, char(10)) = 0 AND instr(model, char(11)) = 0 AND
    instr(model, char(12)) = 0 AND instr(model, char(13)) = 0 AND
    instr(model, char(32)) = 0
  ),
  disclosure_version INTEGER NOT NULL CHECK (disclosure_version = 1),
  accepted_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%d %H:%M:%S', accepted_at) IS NOT NULL AND
    accepted_at = strftime('%Y-%m-%d %H:%M:%S', accepted_at)
  )
) STRICT;

-- Any separately persisted selection change invalidates consent. Reverting the
-- selection later cannot revive the deleted acceptance.
CREATE TRIGGER provider_selection_change_clears_consent
AFTER UPDATE ON iphone_provider_selection
WHEN NEW.provider_id <> OLD.provider_id OR NEW.model <> OLD.model OR
  NEW.profile_id <> OLD.profile_id OR NEW.profile_revision <> OLD.profile_revision
BEGIN
  DELETE FROM iphone_provider_data_use_consent;
END;

CREATE TRIGGER provider_selection_delete_clears_consent
AFTER DELETE ON iphone_provider_selection
BEGIN
  DELETE FROM iphone_provider_data_use_consent;
END;
