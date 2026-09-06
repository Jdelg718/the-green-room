-- Persist the browser-standard director snapshot alongside the existing
-- projection columns. Existing rooms reopen with NULL and initialize on their
-- next explicitly submitted human message; launch never schedules work.
ALTER TABLE director_state ADD COLUMN state_json TEXT
  CHECK (state_json IS NULL OR (json_valid(state_json) AND json_type(state_json) = 'object'));
