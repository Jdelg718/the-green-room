-- Ordered events allocate their sequence from the room row inside the same
-- transaction. The trigger advances authority only after a successful insert.
CREATE TRIGGER room_event_advances_sequence
AFTER INSERT ON events
BEGIN
  UPDATE rooms
  SET next_event_sequence = NEW.sequence + 1
  WHERE id = NEW.room_id AND next_event_sequence = NEW.sequence;
END;
