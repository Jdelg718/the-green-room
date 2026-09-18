-- Room inference mode is immutable so a normal BYOK room can never silently
-- become a local demonstration room (or vice versa). Existing rooms remain BYOK.
ALTER TABLE rooms ADD COLUMN inference_mode TEXT NOT NULL DEFAULT 'provider'
  CHECK (inference_mode IN ('provider', 'review_demo'));

CREATE TRIGGER room_inference_mode_is_immutable
BEFORE UPDATE OF inference_mode ON rooms
BEGIN SELECT RAISE(ABORT, 'room inference mode is immutable'); END;
