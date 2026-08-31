#!/usr/bin/env python3
"""Architecture conformance checks for the Memory Adapter Contract 1.0."""

from __future__ import annotations

import hashlib
import base64
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
import rfc8785

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "docs" / "memory"
SCHEMAS = MEMORY / "schemas"
FIXTURES = MEMORY / "fixtures"
ADAPTER_FIXTURES = FIXTURES / "memory-adapter"
HISTORY_FIXTURES = ADAPTER_FIXTURES / "history"
VAULT = FIXTURES / "obsidian-vault" / "Green Room"
EXPECTED_BYTES = FIXTURES / "obsidian-vault" / "expected-bytes.json"
EXPECTED_ANNOTATIONS = FIXTURES / "obsidian-vault" / "expected-user-annotations.json"
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_KEYS = {
    "operation_id", "event_id", "room_id", "actor_id", "record_id",
    "revision_id", "commit_id", "export_id", "persona_id",
    "source_persona_id", "target_persona_id", "proposal_id",
    "first_event_id", "last_event_id", "source_event_ids",
    "source_revision_ids", "room_ids",
}
LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
FRONTMATTER_ORDER = [
    "greenroom_schema", "greenroom_kind", "room_id", "record_id",
    "revision_id", "revision", "status", "created_at",
    "source_event_ids", "body_sha256", "generated_sha256",
]


def load_json(path: Path):
    def no_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=no_duplicates)


def canonical_json_bytes(value) -> bytes:
    """RFC 8785 JSON Canonicalization Scheme bytes."""
    return rfc8785.dumps(value)


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def schema_for_fixture(path: Path) -> Path:
    if path.name == "event.json":
        return SCHEMAS / "event.schema.json"
    if path.name == "retrieve-request.json":
        return SCHEMAS / "retrieve-request.schema.json"
    return SCHEMAS / "record.schema.json"


def parse_frontmatter(text: str, path: Path):
    assert text.startswith("---\n"), f"{path}: missing opening frontmatter marker"
    end = text.find("\n---\n", 4)
    assert end >= 0, f"{path}: missing closing frontmatter marker"
    lines = text[4:end].splitlines()
    keys = []
    values = {}
    current_list = None
    for line in lines:
        if line.startswith("  - "):
            assert current_list is not None, f"{path}: unexpected list item"
            value = line[4:]
            assert value.startswith('"') and value.endswith('"'), f"{path}: list strings must be quoted"
            values[current_list].append(value[1:-1])
            continue
        assert ":" in line and not line.startswith((" ", "\t")), f"{path}: unsupported YAML"
        key, raw = line.split(":", 1)
        keys.append(key)
        raw = raw.strip()
        current_list = None
        if raw == "":
            values[key] = []
            current_list = key
        elif key == "revision":
            assert raw.isdecimal(), f"{path}: revision must be a decimal integer"
            values[key] = int(raw)
        else:
            assert raw.startswith('"') and raw.endswith('"'), f"{path}: strings must be quoted"
            values[key] = raw[1:-1]
    return keys, values, text[end + 5 :]


def validate_record_semantics(record: dict, events: dict[str, dict]) -> None:
    sources = record["provenance"]["source_event_ids"]
    if sources != sorted(set(sources)):
        raise ValueError("source_event_ids must be sorted and unique")
    if not sources:
        raise ValueError("active records need provenance")
    for event_id in sources:
        event = events.get(event_id)
        if event is None:
            raise ValueError(f"missing provenance event: {event_id}")
        if event["room_id"] != record["room_id"]:
            raise ValueError("cross-room provenance")
    scope = record["scope"]
    if record["kind"] == "relationship" and scope["source_persona_id"] == scope["target_persona_id"]:
        raise ValueError("relationship direction endpoints must differ")
    if record["kind"] == "episode":
        event_range = scope["event_range"]
        first = events.get(event_range["first_event_id"])
        last = events.get(event_range["last_event_id"])
        if first is None or last is None:
            raise ValueError("episode range event is missing")
        if first["room_id"] != record["room_id"] or last["room_id"] != record["room_id"]:
            raise ValueError("episode range crosses rooms")
        if first["event_sequence"] > last["event_sequence"]:
            raise ValueError("episode range is reversed")
    if "body" in record and len(record["body"].encode("utf-8")) > 16384:
        raise ValueError("body exceeds UTF-8 byte bound")


def validate_retrieve_semantics(request: dict) -> None:
    if len(request["query"].encode("utf-8")) > 4096:
        raise ValueError("query exceeds UTF-8 byte bound")


def test_schemas_and_fixtures() -> None:
    schemas = {}
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        schema = load_json(path)
        Draft202012Validator.check_schema(schema)
        schemas[path.name] = schema
    operations = [
        "health", "append-events", "commit-records", "get-events",
        "get-records", "retrieve", "export", "import", "migrate",
        "reset", "erase",
    ]
    expected = {"event.schema.json", "export-manifest.schema.json", "record.schema.json", "error.schema.json"}
    expected.update(f"{operation}-{direction}.schema.json" for operation in operations for direction in ("request", "response"))
    assert set(schemas) == expected

    envelopes = load_json(ADAPTER_FIXTURES / "valid" / "operation-envelopes.json")
    assert [item["operation"].replace("_", "-") for item in envelopes] == operations
    for item in envelopes:
        stem = item["operation"].replace("_", "-")
        Draft202012Validator(schemas[f"{stem}-request.schema.json"]).validate(item["request"])
        Draft202012Validator(schemas[f"{stem}-response.schema.json"]).validate(item["response"])
        error_response = {
            "contract_version": "1.0",
            "operation_id": item["request"]["operation_id"],
            "operation": item["operation"],
            "status": "error",
            "error": {
                "code": "invalid_request",
                "message": "fixture rejection",
                "retryable": False,
                "operation_id": item["request"]["operation_id"],
            },
        }
        Draft202012Validator(schemas[f"{stem}-response.schema.json"]).validate(error_response)
        wrong = dict(item["request"], operation="unknown")
        assert not Draft202012Validator(schemas[f"{stem}-request.schema.json"]).is_valid(wrong)

    health_bad_error = {
        "contract_version": "1.0",
        "operation_id": envelopes[0]["request"]["operation_id"],
        "operation": "health",
        "status": "error",
        "error": {
            "code": "id_collision",
            "message": "impossible for health",
            "retryable": False,
            "operation_id": envelopes[0]["request"]["operation_id"],
        },
    }
    assert not Draft202012Validator(schemas["health-response.schema.json"]).is_valid(health_bad_error)

    mutators = {"append_events", "commit_records", "import", "migrate", "reset", "erase"}
    for item in envelopes:
        if item["operation"] in mutators:
            assert {"idempotency_key", "request_digest"} <= item["request"].keys()

    event = load_json(ADAPTER_FIXTURES / "valid" / "event.json")
    events = {event["event_id"]: event}
    unsigned_event = {key: value for key, value in event.items() if key != "content_digest"}
    assert event["content_digest"] == sha256(canonical_json_bytes(unsigned_event))

    valid = sorted(path for path in (ADAPTER_FIXTURES / "valid").glob("*.json") if path.name != "operation-envelopes.json")
    assert len(valid) == 6
    for path in valid:
        data = load_json(path)
        Draft202012Validator(load_json(schema_for_fixture(path))).validate(data)
        if path.name.endswith("-record.json"):
            validate_record_semantics(data, events)

    invalid = sorted((ADAPTER_FIXTURES / "invalid").glob("*.json"))
    assert len(invalid) == 3
    failures = {}
    for path in invalid:
        data = load_json(path)
        try:
            Draft202012Validator(load_json(schema_for_fixture(path))).validate(data)
            if path.name.endswith(".json"):
                validate_record_semantics(data, events)
        except (ValidationError, ValueError, KeyError) as exc:
            failures[path.name] = str(exc)
    assert set(failures) == {path.name for path in invalid}, f"invalid fixtures unexpectedly passed: {failures}"

    record_schema = Draft202012Validator(schemas["record.schema.json"])
    missing_lineage = load_json(ADAPTER_FIXTURES / "valid" / "room-record.json")
    missing_lineage["provenance"]["derivation"] = {"kind": "compaction", "producer": "fixture"}
    assert not record_schema.is_valid(missing_lineage), "compaction without lineage unexpectedly passed"

    retrieve_schema = Draft202012Validator(schemas["retrieve-request.schema.json"])
    half_direction = load_json(ADAPTER_FIXTURES / "valid" / "retrieve-request.json")
    half_direction.pop("persona_id")
    half_direction["source_persona_id"] = "018f0f6e-bbc1-78c1-a23a-46588c34f46e"
    assert not retrieve_schema.is_valid(half_direction), "half-directional retrieval scope unexpectedly passed"

    export_manifest = Draft202012Validator(schemas["export-manifest.schema.json"])
    manifest = {
        "contract_version": "1.0",
        "storage_version": 1,
        "export_id": "018f0f71-0000-7000-8000-000000000029",
        "created_at": "2026-08-30T16:04:00.000Z",
        "snapshot_digest": "sha256:" + "c" * 64,
        "scope": "events_and_derived",
        "rooms": [event["room_id"]],
        "counts": {"rooms": 1, "events": 1, "record_revisions": 4, "active_records": 4, "tombstones": 0},
        "entries": [{"path": f"rooms/{event['room_id']}/events.ndjson", "bytes": 432, "sha256": "sha256:" + "d" * 64, "items": 1}],
    }
    export_manifest.validate(manifest)
    for required in ("storage_version", "counts", "snapshot_digest"):
        incomplete = dict(manifest)
        incomplete.pop(required)
        assert not export_manifest.is_valid(incomplete), f"manifest without {required} unexpectedly passed"


def test_canonical_identifiers_and_times() -> None:
    for path in sorted(ADAPTER_FIXTURES.rglob("*.json")):
        data = load_json(path)
        stack = [data]
        while stack:
            value = stack.pop()
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in ID_KEYS:
                        values = child if isinstance(child, list) else [child]
                        for identifier in values:
                            if identifier is None:
                                assert key == "commit_id", f"{path}: only dry-run commit_id may be null"
                                continue
                            assert isinstance(identifier, str), f"{path}: identifier is not a string"
                            assert ID_RE.fullmatch(identifier), f"{path}: noncanonical ID {identifier}"
                    if key.endswith("_at"):
                        assert isinstance(child, str), f"{path}: timestamp is not a string"
                        assert TIME_RE.fullmatch(child), f"{path}: noncanonical timestamp {child}"
                        datetime.strptime(child, "%Y-%m-%dT%H:%M:%S.%fZ")
                    stack.append(child)
            elif isinstance(value, list):
                stack.extend(value)


def test_rfc8785_numeric_and_utf16_key_ordering() -> None:
    assert canonical_json_bytes({"n": 1.0}) == b'{"n":1}'
    assert canonical_json_bytes({"n": -0.0}) == b'{"n":0}'
    assert canonical_json_bytes({"n": 1e30}) == b'{"n":1e+30}'
    assert canonical_json_bytes({"\ue000": 1, "\U00010000": 2}) == '{"\U00010000":2,"\ue000":1}'.encode()


def test_utf8_byte_limits_are_semantic() -> None:
    event = load_json(ADAPTER_FIXTURES / "valid" / "event.json")
    events = {event["event_id"]: event}
    record = load_json(ADAPTER_FIXTURES / "valid" / "room-record.json")
    record["body"] = "😀" * 4097
    try:
        validate_record_semantics(record, events)
    except ValueError as exc:
        assert "UTF-8" in str(exc)
    else:
        raise AssertionError("16 KiB+ UTF-8 record body unexpectedly accepted")

    request = load_json(ADAPTER_FIXTURES / "valid" / "retrieve-request.json")
    request["query"] = "😀" * 1025
    try:
        validate_retrieve_semantics(request)
    except ValueError as exc:
        assert "UTF-8" in str(exc)
    else:
        raise AssertionError("4 KiB+ UTF-8 query unexpectedly accepted")


def test_obsidian_vault_exact_bytes_and_notes() -> None:
    expected = load_json(EXPECTED_BYTES)
    assert expected["contract_version"] == "1.0"
    entries = expected["files"]
    expected_paths = [item["path"] for item in entries]
    assert expected_paths == sorted(expected_paths)
    all_paths = list(VAULT.rglob("*"))
    assert not any(path.is_symlink() for path in all_paths), "fixture tree cannot contain symbolic links"
    actual_paths = sorted(path.relative_to(VAULT).as_posix() for path in all_paths if path.is_file())
    assert actual_paths == expected_paths
    assert len({unicodedata.normalize("NFC", path).casefold() for path in actual_paths}) == len(actual_paths)

    for item in entries:
        rel = item["path"]
        pure = PurePosixPath(rel)
        assert not pure.is_absolute() and ".." not in pure.parts and "\\" not in rel
        path = VAULT / rel
        assert not path.is_symlink(), f"managed fixture cannot contain links: {rel}"
        data = path.read_bytes()
        assert len(data) == item["bytes"], f"byte count mismatch: {rel}"
        assert sha256(data) == item["sha256"], f"digest mismatch: {rel}"
        assert not data.startswith(b"\xef\xbb\xbf"), f"BOM forbidden: {rel}"
        assert data.endswith(b"\n") and not data.endswith(b"\n\n"), f"exactly one terminal LF required: {rel}"
        assert b"\r" not in data and b"\t" not in data, f"CR/tab forbidden: {rel}"
        for line in data.splitlines():
            assert not line.endswith(b" "), f"trailing space forbidden: {rel}"

    managed = load_json(VAULT / "state" / "managed-files.json")
    manifest_paths = [item["path"] for item in managed["files"]]
    assert manifest_paths == [path for path in expected_paths if path != "state/managed-files.json"]
    by_path = {item["path"]: item for item in entries}
    for item in managed["files"]:
        expected_item = by_path[item["path"]]
        assert item["bytes"] == expected_item["bytes"]
        assert item["sha256"] == expected_item["sha256"]
        assert item["revision"] >= 1
        if item["path"].endswith(".md"):
            assert DIGEST_RE.fullmatch(item["generated_sha256"])
    assert canonical_json_bytes(managed) + b"\n" == (VAULT / "state" / "managed-files.json").read_bytes()
    assert canonical_json_bytes(load_json(VAULT / "state" / "adapter.json")) + b"\n" == (VAULT / "state" / "adapter.json").read_bytes()
    for line in (VAULT / "state" / "operations.ndjson").read_bytes().splitlines():
        assert canonical_json_bytes(json.loads(line)) == line
    for line in (VAULT / "rooms" / "018f0f6e-7b6a-7c10-8af1-7f4c620b93c1" / "events" / "2026-08.ndjson").read_bytes().splitlines():
        assert canonical_json_bytes(json.loads(line)) == line

    note_paths = sorted(path for path in VAULT.rglob("*.md") if path.name not in {"README.md", "room.md"})
    assert len(note_paths) == 4
    expected_revisions = [load_json(path) for path in sorted((ADAPTER_FIXTURES / "valid").glob("*-record.json"))]
    expected_revisions.extend(load_json(path) for path in sorted(HISTORY_FIXTURES.glob("*.json")))
    expected_revisions.sort(key=lambda record: (record["record_id"], record["revision"]))
    fixture_records = {}
    for record in expected_revisions:
        fixture_records[record["record_id"]] = record
    sidecars = sorted(VAULT.rglob("records/*.ndjson"))
    assert len(sidecars) == 1
    authoritative = [json.loads(line) for line in sidecars[0].read_bytes().splitlines()]
    assert authoritative == sorted(authoritative, key=lambda record: (record["record_id"], record["revision"]))
    assert authoritative == expected_revisions
    room_history = [record for record in authoritative if record["record_id"] == "018f0f70-9a8c-75dc-b6bf-dfe68dbe71bd"]
    assert [record["revision"] for record in room_history] == [1, 2]
    assert room_history[1]["supersedes_revision_id"] == room_history[0]["revision_id"]
    for record in authoritative:
        Draft202012Validator(load_json(SCHEMAS / "record.schema.json")).validate(record)
    for path in note_paths:
        text = path.read_text(encoding="utf-8")
        keys, metadata, body = parse_frontmatter(text, path)
        assert keys == FRONTMATTER_ORDER, f"{path}: wrong frontmatter order: {keys}"
        assert metadata["greenroom_schema"] == "1.0"
        assert metadata["source_event_ids"] == sorted(set(metadata["source_event_ids"]))
        assert ID_RE.fullmatch(metadata["room_id"])
        assert ID_RE.fullmatch(metadata["record_id"])
        assert ID_RE.fullmatch(metadata["revision_id"])
        assert TIME_RE.fullmatch(metadata["created_at"])
        assert DIGEST_RE.fullmatch(metadata["body_sha256"])
        assert DIGEST_RE.fullmatch(metadata["generated_sha256"])
        assert body.count("<!-- greenroom:generated:start -->") == 1
        assert body.count("<!-- greenroom:generated:end -->") == 1
        assert body.count("<!-- greenroom:user-notes:start -->") == 1
        assert body.count("<!-- greenroom:user-notes:end -->") == 1
        start = body.index("<!-- greenroom:generated:start -->\n") + len("<!-- greenroom:generated:start -->\n")
        end = body.index("<!-- greenroom:generated:end -->")
        generated = body[start:end].encode("utf-8")
        assert sha256(generated) == metadata["generated_sha256"]
        record = fixture_records[metadata["record_id"]]
        assert record["body"].encode("utf-8") in generated
        assert record["kind"] == metadata["greenroom_kind"]
        assert record["revision_id"] == metadata["revision_id"]
        assert record["revision"] == metadata["revision"]
        assert record["status"] == metadata["status"]
        assert record["provenance"]["source_event_ids"] == metadata["source_event_ids"]
        assert sha256(record["body"].encode("utf-8")) == metadata["body_sha256"]
        if record["kind"] == "persona":
            assert f"people/{record['scope']['persona_id']}/" in path.relative_to(VAULT).as_posix()
        elif record["kind"] == "relationship":
            direction = f"{record['scope']['source_persona_id']}--{record['scope']['target_persona_id']}"
            assert f"relationships/{direction}/" in path.relative_to(VAULT).as_posix()


def test_erase_annotation_preservation_fixture() -> None:
    expected = load_json(EXPECTED_ANNOTATIONS)
    actual = []
    start_marker = b"<!-- greenroom:user-notes:start -->\n"
    end_marker = b"<!-- greenroom:user-notes:end -->"
    for path in sorted(VAULT.rglob("*.md")):
        data = path.read_bytes()
        assert data.count(start_marker) == data.count(end_marker) == 1
        notes = data.split(start_marker, 1)[1].split(end_marker, 1)[0]
        if notes.strip() and not notes.lstrip().startswith(b"<!--"):
            metadata = None
            if path.name not in {"README.md", "room.md"}:
                _, metadata, _ = parse_frontmatter(data.decode(), path)
            archive_name = metadata["record_id"] if metadata else path.stem
            room_id = metadata["room_id"] if metadata else "vault"
            actual.append({
                "source_path": path.relative_to(VAULT).as_posix(),
                "archive_path": f"user-annotations/{room_id}/{archive_name}.md",
                "bytes": len(notes),
                "sha256": sha256(notes),
                "base64": base64.b64encode(notes).decode("ascii"),
            })
    assert actual == expected["annotations"]


def test_required_security_and_contract_topics() -> None:
    contract = (MEMORY / "MEMORY-ADAPTER-CONTRACT.md").read_text(encoding="utf-8").lower()
    obsidian = (MEMORY / "OBSIDIAN-BACKEND.md").read_text(encoding="utf-8").lower()
    threat = (MEMORY / "THREAT-MODEL.md").read_text(encoding="utf-8").lower()
    conformance = (MEMORY / "CONFORMANCE.md").read_text(encoding="utf-8").lower()
    topic_groups = {
        "contract": (contract, ["idempotency", "provenance", "tombstone", "compaction", "byte", "timeout", "jcs", "no operation accepts"]),
        "obsidian": (obsidian, ["openat", "o_nofollow", "reparse", "hard links", "atomic", "recovery", "user-notes", "managed-files.json"]),
        "threat": (threat, ["ssrf", "redirect", "dns rebinding", "pinned", "proxy", "tls 1.2", "decoded", "loopback"]),
        "conformance": (conformance, ["cross-room", "symlink/junction", "deterministic", "export secrets", "duplicate-key"]),
    }
    for document, (text, terms) in topic_groups.items():
        missing = [term for term in terms if term not in text]
        assert not missing, f"{document} missing required topics: {missing}"


def test_local_markdown_links() -> None:
    markdown_paths = [ROOT / "docs" / "adr" / "0002-self-hosted-memory-adapters.md", *sorted(MEMORY.rglob("*.md"))]
    checked = 0
    for source in markdown_paths:
        text = source.read_text(encoding="utf-8")
        for raw_target in LINK_RE.findall(text):
            target = raw_target.split(maxsplit=1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith(("mailto:", "#")):
                continue
            path_part = unquote(parsed.path)
            destination = (source.parent / path_part).resolve()
            assert destination.exists(), f"{source.relative_to(ROOT)}: broken link {raw_target}"
            checked += 1
    assert checked >= 5, f"expected at least five checked local links, got {checked}"


def main() -> int:
    tests = [
        test_schemas_and_fixtures,
        test_canonical_identifiers_and_times,
        test_rfc8785_numeric_and_utf16_key_ordering,
        test_utf8_byte_limits_are_semantic,
        test_obsidian_vault_exact_bytes_and_notes,
        test_erase_annotation_preservation_fixture,
        test_required_security_and_contract_topics,
        test_local_markdown_links,
    ]
    failures = []
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as exc:
            failures.append((test.__name__, exc))
            print(f"FAIL {test.__name__}: {exc}", file=sys.stderr)
    print(f"{len(tests) - len(failures)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
