#!/usr/bin/env python3
"""Shared constants and strict primitives for the Alpha 1 evidence format."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import stat
import zipfile
from typing import Any, NoReturn
from urllib.parse import quote

ARTIFACT_NAME = "The-Green-Room-0.1.0-alpha.1-macos-arm64.zip"
ARTIFACT_BYTES = 51_598_158
ARTIFACT_SHA256 = "333f5cdd2e9c88e901cacd5cdad58109b67affc1f63cc5f98321644592bde469"
APP_ROOT = "The Green Room.app"
SOURCE_COMMIT = "cd0096c53e356a4c2a7830ecbed5db690485c070"
SOURCE_TREE = "4ea71d620c5ea0fe2564cfa134d3445d8917185b"
SIGNING_HEAD = "ed92f1f9efb9635dde3579ef09fe62c5311cb6a9"
SIGNING_MERGE = "6171a2736886f899e5221cc734444934e5cfa0fb"
UNSIGNED_DIGEST = "673726aa78d8ecd647f7296ef6c08bd94ac6a0f13a001c2eee1140176e351d8c"
PRE_STAPLE_DIGEST = "60b0845fe300ede1695f68515e721094d09e3bed08fb102e6c5be304807e8629"
FINAL_TREE_DIGEST = "c05036f9828ba344188e085cfbc0090b249e05046039c64fa8e409a55abbd674"
NOTARY_ID = "1b9c51ee-280b-4349-9459-583e967651e8"
STATUS_HASH = "984c7cf7f1b4168fbd353c139d24743a59fd6266e819ba0bf829167d350cc98f"
PRIVATE_LOG_HASH = "4bcca3156992de7d7ab3f2f491e6903acf81088be6944e48213377dd902baa52"
NOTARY_EVIDENCE_HASH = "6897299741275341e158553672cbf269bab5333b22b2a41185a982cb41aaff81"
TEAM_ID = "JZ233HBW3Z"
SIGNING_IDENTITY = "Developer ID Application: James DelGuercio (JZ233HBW3Z)"
PACKAGE_LOCK_HASH = "cd2b5a738e96841da5fa144ec8098c9aa4a8654038257e7a071ab811e339709a"
UV_LOCK_HASH = "394a408332bc50dafc0d7c6b046d2157dda77a8a8524c39dd44b8fd9973743f4"
PYPROJECT_HASH = "2257c13a556445f12556381ac2b68fd9bc905b9d64f6c69c2d6b956bb235df02"
SOURCE_PACKAGE_HASH = "a4cb173c7ae46f2ba98d867a20d0e4bddf190e5d47644cf4b1c81753610a43e4"
FINAL_PACKAGE_HASH = "bec58c3d68c4feac47c00a62583c6f2e376aab83637ed92f294b4f05b2c9eeee"
VALIDATOR_BUILD_SCRIPT_HASH = "1be962f2eae46e6a4efa511cee6b6b1b240fee280d3d55bd2a55f204b5cb935f"
VALIDATOR_SPEC_HASH = "c5eb11349b64ea61bd1e2571855d6b5bf40e4a4f2475f05125a1532b3c6a7fff"
CPYTHON_LICENSE_HASH = "78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb"
PYINSTALLER_LICENSE_HASH = "571f650c741ae1f6d8b689ef639b02c93297b84cef32db7c5211674d7b6fc094"
PYYAML_LICENSE_HASH = "8d3928f9dc4490fd635707cb88eb26bd764102a7282954307d3e5167a577e8a4"
EXPECTED_ENTRIES = 1_651
EXPECTED_FILES = 1_341
EXPECTED_DIRECTORIES = 310
EXPECTED_PAYLOAD = 1_337
EXPECTED_NPM_PACKAGES = 52
EXPECTED_PERSONAS = 19
EXPECTED_VALIDATOR_FILES = 4
MAX_TOTAL_BYTES = 200_000_000
MAX_ENTRY_BYTES = 130_000_000
MAX_RATIO = 100
APP_PREFIX = APP_ROOT + "/"
MANIFEST_PATH = APP_PREFIX + "Contents/Resources/release-manifest.json"
NODE_MODULES = APP_PREFIX + "Contents/Resources/app/node_modules/"
PERSONAS = APP_PREFIX + "Contents/Resources/app/dist/personas/"
VALIDATOR = APP_PREFIX + "Contents/Resources/validator/"
SIGNATURE_OWNED = [
    "Contents/CodeResources",
    "Contents/MacOS/GreenRoomLauncher",
    "Contents/_CodeSignature/CodeResources",
]
CHECKSUM_NAMES = [
    ARTIFACT_NAME,
    "The-Green-Room-0.1.0-alpha.1.spdx.json",
    "THIRD-PARTY-NOTICES.txt",
    "notarization-evidence.json",
    "release-evidence.json",
    "provenance.intoto.jsonl",
]
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9._ +@-]+(?:/[A-Za-z0-9._ +@-]+)*/?$")
NPM_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9._~-]*$")
JUNK = {".DS_Store", "Thumbs.db", "__MACOSX"}


class EvidenceError(ValueError):
    """Stable fail-closed evidence error."""


def fail(code: str, detail: str = "") -> NoReturn:
    raise EvidenceError(f"{code}: {detail}" if detail else code)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def exact_keys(value: Any, keys: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(code)
    return value


def safe_parts(name: str) -> tuple[str, ...]:
    if (
        not name
        or len(name.encode()) > 4096
        or not SAFE_PATH.fullmatch(name)
        or name.startswith("/")
        or "\\" in name
        or "//" in name
    ):
        fail("archive_path_invalid", name)
    parts = tuple(name.rstrip("/").split("/"))
    if not parts or parts[0] != APP_ROOT or any(part in {"", ".", ".."} for part in parts):
        fail("archive_path_invalid", name)
    if any(part in JUNK for part in parts):
        fail("archive_junk_forbidden", name)
    return parts


def inspect_archive(
    path: pathlib.Path, *, require_identity: bool = True
) -> tuple[list[dict[str, Any]], bytes]:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        fail("artifact_type_invalid")
    if require_identity and (
        path.name != ARTIFACT_NAME
        or details.st_size != ARTIFACT_BYTES
        or sha256_file(path) != ARTIFACT_SHA256
    ):
        fail("artifact_identity_invalid")
    records: list[dict[str, Any]] = []
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile):
        fail("archive_invalid")
    with archive:
        if archive.comment:
            fail("archive_metadata_invalid")
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if (
            len(infos) != EXPECTED_ENTRIES
            or names != sorted(names)
            or len(names) != len(set(names))
        ):
            fail("archive_inventory_invalid")
        total = 0
        files: set[tuple[str, ...]] = set()
        directories: set[tuple[str, ...]] = set()
        for info in infos:
            parts = safe_parts(info.filename)
            directory = info.filename.endswith("/")
            mode = info.external_attr >> 16
            if (
                info.create_system != 3
                or info.extra
                or info.comment
                or info.flag_bits != 0
                or info.compress_type != zipfile.ZIP_DEFLATED
            ):
                fail("archive_metadata_invalid", info.filename)
            if stat.S_IFMT(mode) != (stat.S_IFDIR if directory else stat.S_IFREG):
                fail("archive_type_invalid", info.filename)
            permissions = stat.S_IMODE(mode)
            if permissions not in ({0o555} if directory else {0o444, 0o555}):
                fail("archive_mode_invalid", info.filename)
            if info.file_size > MAX_ENTRY_BYTES or (
                info.file_size and info.file_size > max(1, info.compress_size) * MAX_RATIO
            ):
                fail("archive_bomb_forbidden", info.filename)
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                fail("archive_bomb_forbidden")
            if directory:
                if info.file_size != 0 or parts in files:
                    fail("archive_directory_invalid", info.filename)
                directories.add(parts)
                continue
            if parts in directories or any(
                parts[:index] in files for index in range(1, len(parts))
            ):
                fail("archive_collision", info.filename)
            files.add(parts)
            try:
                data = archive.read(info)
            except (OSError, RuntimeError, zipfile.BadZipFile):
                fail("archive_member_invalid", info.filename)
            records.append(
                {
                    "path": info.filename[len(APP_PREFIX) :],
                    "mode": permissions,
                    "bytes": len(data),
                    "sha256": sha256_bytes(data),
                    "sha1": hashlib.sha1(data).hexdigest(),  # noqa: S324 - SPDX 2.3 requires SHA-1
                }
            )
        if len(files) != EXPECTED_FILES or len(directories) != EXPECTED_DIRECTORIES:
            fail("archive_file_count_invalid")
        for parts in files | directories:
            for index in range(1, len(parts)):
                if parts[:index] not in directories:
                    fail("archive_directory_missing", "/".join(parts[:index]))
        manifest_bytes = archive.read(MANIFEST_PATH)
    return records, manifest_bytes


def package_root(relative: str) -> bool:
    parts = relative.split("/")
    index = 0
    while index < len(parts):
        if parts[index] == "node_modules":
            index += 1
        if index >= len(parts):
            return False
        index += 2 if parts[index].startswith("@") else 1
        if index < len(parts) and parts[index] != "node_modules":
            return False
    return True


def npm_name_for_path(relative: str) -> str:
    """Return the npm identity represented by an exact node_modules package root."""
    if not package_root(relative):
        fail("npm_package_path_invalid", relative)
    leaf = relative.rsplit("/node_modules/", 1)[-1]
    parts = leaf.split("/")
    if len(parts) == 1 and NPM_SEGMENT.fullmatch(parts[0]):
        return parts[0]
    if (
        len(parts) == 2
        and parts[0].startswith("@")
        and NPM_SEGMENT.fullmatch(parts[0][1:])
        and NPM_SEGMENT.fullmatch(parts[1])
    ):
        return leaf
    fail("npm_package_path_invalid", relative)


def canonical_npm_purl(name: str, version: str) -> str:
    """Build a package-url npm PURL by encoding namespace/name as separate segments."""
    if not isinstance(name, str) or not isinstance(version, str) or not version:
        fail("npm_identity_invalid")
    if name.startswith("@"):
        parts = name.split("/")
        if (
            len(parts) != 2
            or not NPM_SEGMENT.fullmatch(parts[0][1:])
            or not NPM_SEGMENT.fullmatch(parts[1])
        ):
            fail("npm_name_invalid", name)
        encoded_name = f"{quote(parts[0], safe='')}/{quote(parts[1], safe='')}"
    else:
        if not NPM_SEGMENT.fullmatch(name):
            fail("npm_name_invalid", name)
        encoded_name = quote(name, safe="")
    return f"pkg:npm/{encoded_name}@{quote(version, safe='')}"


def spdx_id(prefix: str, value: str) -> str:
    return f"SPDXRef-{prefix}-{hashlib.sha256(value.encode()).hexdigest()[:20]}"


def validate_manifest(data: bytes, records: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        manifest = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("manifest_invalid")
    exact_keys(
        manifest,
        {
            "schemaVersion",
            "bundleIdentifier",
            "appVersion",
            "sourceCommit",
            "buildEpoch",
            "targetTriple",
            "runtimes",
            "databaseSchema",
            "unsignedPayloadDigest",
            "payloadFiles",
            "signatureOwnedFiles",
            "signingPolicy",
        },
        "manifest_schema_invalid",
    )
    if (
        manifest["schemaVersion"] != 2
        or manifest["bundleIdentifier"] != "net.greenroomai.GreenRoom"
        or manifest["appVersion"] != "0.1.0"
        or manifest["sourceCommit"] != SOURCE_COMMIT
        or manifest["targetTriple"] != "arm64-apple-darwin"
        or manifest["unsignedPayloadDigest"] != UNSIGNED_DIGEST
        or manifest["runtimes"]
        != {"nodeVersion": "24.20.0", "pythonVersion": "3.13.13", "validatorVersion": "0.1.0"}
        or manifest["signatureOwnedFiles"] != SIGNATURE_OWNED
    ):
        fail("manifest_identity_invalid")
    policy = manifest["signingPolicy"]
    if (
        not isinstance(policy, dict)
        or policy.get("teamId") != TEAM_ID
        or policy.get("identity") != SIGNING_IDENTITY
        or policy.get("hardenedRuntime") is not True
        or policy.get("secureTimestamp") is not True
    ):
        fail("manifest_signing_invalid")
    payload = manifest["payloadFiles"]
    if not isinstance(payload, list) or len(payload) != EXPECTED_PAYLOAD:
        fail("manifest_payload_count_invalid")
    actual = {item["path"]: item for item in records}
    manifest_relative = MANIFEST_PATH[len(APP_PREFIX) :]
    expected_paths = set(actual) - {manifest_relative, *SIGNATURE_OWNED}
    if {item.get("path") for item in payload if isinstance(item, dict)} != expected_paths:
        fail("manifest_payload_set_invalid")
    for item in payload:
        expected = actual[item["path"]]
        if set(item) != {"path", "mode", "bytes", "sha256"} or item != {
            key: expected[key] for key in ("path", "mode", "bytes", "sha256")
        }:
            fail("manifest_payload_record_invalid", str(item.get("path")))
    return manifest
