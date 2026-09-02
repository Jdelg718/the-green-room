DROP INDEX rooms_single_active_session;

ALTER TABLE rooms ADD COLUMN activity_order INTEGER NOT NULL DEFAULT 0 CHECK (activity_order >= 0);
ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));

CREATE TABLE room_library_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_activity_order INTEGER NOT NULL CHECK (next_activity_order >= 1)
) STRICT;

UPDATE rooms
SET activity_order = (
  SELECT ordered.activity_order
  FROM (
    SELECT
      rooms.id,
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(MAX(events.created_at), rooms.created_at), rooms.created_at, rooms.id
      ) AS activity_order
    FROM rooms
    LEFT JOIN events ON events.room_id = rooms.id
    GROUP BY rooms.id
  ) AS ordered
  WHERE ordered.id = rooms.id
);

INSERT INTO room_library_state(singleton, next_activity_order)
SELECT 1, COALESCE(MAX(activity_order), 0) + 1 FROM rooms;

CREATE TRIGGER room_event_updates_activity
AFTER INSERT ON events
BEGIN
  UPDATE rooms
  SET activity_order = (SELECT next_activity_order FROM room_library_state WHERE singleton = 1)
  WHERE id = NEW.room_id;
  UPDATE room_library_state
  SET next_activity_order = next_activity_order + 1
  WHERE singleton = 1;
END;
