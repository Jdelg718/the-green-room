#!/usr/bin/env python3
"""Validate prototype-only lifecycle fixtures against normative schemas."""
from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCHEMAS = ROOT / "docs" / "memory" / "schemas"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate(name: str, schema_name: str) -> dict:
    value = load(HERE / "fixtures" / name)
    Draft202012Validator(load(SCHEMAS / schema_name)).validate(value)
    return value


def main() -> None:
    retrieval = validate("retrieve-match-response.json", "retrieve-response.schema.json")
    tombstone = validate("tombstone-record.json", "record.schema.json")
    lifecycle = load(HERE / "fixtures" / "lifecycle-evidence.json")
    assert retrieval["items_returned"] == len(retrieval["items"]) == 1
    assert retrieval["bytes_returned"] == 512
    assert retrieval["items"][0]["match"]["reason"] == "Exact phrase: compare-then-choose"
    assert tombstone["status"] == "tombstoned" and "body" not in tombstone
    assert tombstone["revision"] == 3
    assert set(lifecycle) == {
        "fixture_version", "authority_sequence", "room_generation", "restart_reopen",
        "reconnect_replay", "conflict", "unavailable", "disconnect_preflight",
        "rebuild", "backend_scopes"
    }
    assert lifecycle["restart_reopen"] == {
        "integrity_verified": True, "authority_sequence": 10, "active_revision": 1
    }
    assert lifecycle["reconnect_replay"]["idempotency_replay"] is True
    assert lifecycle["reconnect_replay"]["logical_digest_match"] is True
    assert lifecycle["conflict"]["continuation_allowed"] is False
    assert lifecycle["unavailable"]["continuation_allowed"] is False
    assert lifecycle["unavailable"]["fallback_writer"] is False
    assert lifecycle["disconnect_preflight"]["configuration_only"] is True
    assert lifecycle["rebuild"]["source"] == "sqlite-authority"
    assert lifecycle["rebuild"]["logical_digest_match"] is True
    print("prototype lifecycle fixtures: 3 validated")


if __name__ == "__main__":
    main()
