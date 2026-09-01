CREATE TABLE human_profile (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  emoji TEXT NOT NULL CHECK (emoji IN ('🙂', '😎', '🤓', '🧐', '😄', '🥳', '🧠', '🫡', '🦊', '🐸', '👻', '🤖')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

INSERT INTO human_profile (singleton, emoji) VALUES (1, '🙂');
