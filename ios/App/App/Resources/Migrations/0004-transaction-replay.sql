-- Register each reviewed native bridge transaction in the same SQLite
-- transaction as its writes so retries remain idempotent across relaunches.
CREATE TABLE bridge_transactions (
  transaction_id TEXT PRIMARY KEY CHECK (length(transaction_id) BETWEEN 1 AND 256 AND transaction_id = trim(transaction_id)),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest GLOB '[0-9a-f]*'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TRIGGER bridge_transactions_cannot_be_updated
BEFORE UPDATE ON bridge_transactions BEGIN SELECT RAISE(ABORT, 'bridge transaction records are immutable'); END;
CREATE TRIGGER bridge_transactions_cannot_be_deleted
BEFORE DELETE ON bridge_transactions BEGIN SELECT RAISE(ABORT, 'bridge transaction records are immutable'); END;
