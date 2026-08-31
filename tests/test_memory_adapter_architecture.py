#!/usr/bin/env python3
"""Architecture conformance checks for the Memory Adapter Contract 1.0."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "docs" / "memory"
SCHEMAS = MEMORY / "schemas"
FIXTURES = MEMORY / "fixtures"
ADAPTER_FIXTURES = FIXTURES / "memory-adapter"
VAULT = FIXTURES / "obsidian-vault" / "Green Room"
EXPECTED_BYTES = FIXTURES / "obsidian-vault" / "expected-bytes.json"
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
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
    """JCS bytes for the fixture subset (objects, arrays, strings, integers)."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def schema_for_fixture(path: Path) -> Path:
    if path.name == "event.json":
        return SCHEMAS / "event.schema.json"
    if path.name == "retrieve-request.json":
        return SCHEMAS / "retrieve.schema.json"
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


def test_schemas_and_fixtures() -> None:
    schemas = {}
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        schema = load_json(path)
        Draft202012Validator.check_schema(schema)
        schemas[path.name] = schema
    assert set(schemas) == {
        "event.schema.json", "export-manifest.schema.json",
        "record.schema.json", "retrieve.schema.json",
    }

    event = load_json(ADAPTER_FIXTURES / "valid" / "event.json")
    events = {event["event_id"]: event}
    unsigned_event = {key: value for key, value in event.items() if key != "content_digest"}
    assert event["content_digest"] == sha256(canonical_json_bytes(unsigned_event))

    valid = sorted((ADAPTER_FIXTURES / "valid").glob("*.json"))
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

    retrieve_schema = Draft202012Validator(schemas["retrieve.schema.json"])
    half_direction = load_json(ADAPTER_FIXTURES / "valid" / "retrieve-request.json")
    half_direction.pop("persona_id")
    half_direction["source_persona_id"] = "018f0f6e-bbc1-78c1-a23a-46588c34f46e"
    assert not retrieve_schema.is_valid(half_direction), "half-directional retrieval scope unexpectedly passed"


def test_canonical_identifiers_and_times() -> None:
    for path in sorted(ADAPTER_FIXTURES.rglob("*.json")):
        data = load_json(path)
        stack = [data]
        while stack:
            value = stack.pop()
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("_id") or key.endswith("_ids"):
                        values = child if isinstance(child, list) else [child]
                        for identifier in values:
                            assert isinstance(identifier, str), f"{path}: identifier is not a string"
                            assert ID_RE.fullmatch(identifier), f"{path}: noncanonical ID {identifier}"
                    if key.endswith("_at"):
                        assert isinstance(child, str), f"{path}: timestamp is not a string"
                        assert TIME_RE.fullmatch(child), f"{path}: noncanonical timestamp {child}"
                        datetime.strptime(child, "%Y-%m-%dT%H:%M:%S.%fZ")
                    stack.append(child)
            elif isinstance(value, list):
                stack.extend(value)


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
    assert [item["path"] for item in managed["files"]] == expected_paths
    assert canonical_json_bytes(managed) + b"\n" == (VAULT / "state" / "managed-files.json").read_bytes()
    assert canonical_json_bytes(load_json(VAULT / "state" / "adapter.json")) + b"\n" == (VAULT / "state" / "adapter.json").read_bytes()
    for line in (VAULT / "state" / "operations.ndjson").read_bytes().splitlines():
        assert canonical_json_bytes(json.loads(line)) == line
    for line in (VAULT / "rooms" / "018f0f6e-7b6a-7c10-8af1-7f4c620b93c1" / "events" / "2026-08.ndjson").read_bytes().splitlines():
        assert canonical_json_bytes(json.loads(line)) == line

    note_paths = sorted(path for path in VAULT.rglob("*.md") if path.name not in {"README.md", "room.md"})
    assert len(note_paths) == 4
    fixture_records = {
        load_json(path)["record_id"]: load_json(path)
        for path in sorted((ADAPTER_FIXTURES / "valid").glob("*-record.json"))
    }
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
        test_obsidian_vault_exact_bytes_and_notes,
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
