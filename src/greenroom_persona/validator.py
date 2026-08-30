from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .archive import ArchiveError, ArchiveMember, read_archive
from .limits import MAX_RUNTIME_FILE_BYTES, MAX_RUNTIME_TOTAL_BYTES
from .manifest import declared_asset_paths, parse_manifest
from .models import DiagnosticCollector, InspectionResult

REQUIRED_FILES = {
    "persona.yaml",
    "AGENTS.md",
    "BACKGROUND.md",
    "VOICE.md",
    "PROVENANCE.md",
    "LICENSE",
}
RUNTIME_ORDER = (
    "AGENTS.md",
    "BACKGROUND.md",
    "VOICE.md",
    "RELATIONSHIPS.md",
    "SCENARIOS.md",
)
METADATA_FILES = {"PROVENANCE.md", "SOURCES.md", "LICENSE"}
TOP_LEVEL_FILES = {"persona.yaml", *RUNTIME_ORDER, *METADATA_FILES}
EXECUTABLE_SUFFIXES = {
    ".bat",
    ".cmd",
    ".com",
    ".dll",
    ".exe",
    ".jar",
    ".js",
    ".msi",
    ".ps1",
    ".py",
    ".sh",
    ".so",
    ".vbs",
    ".wasm",
}
EXECUTABLE_MAGIC = (b"#!", b"\x7fELF", b"MZ", b"\x00asm", b"\xca\xfe\xba\xbe")
CREDENTIAL_CONTENT = re.compile(
    rb"-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP)? ?PRIVATE KEY-----|"
    rb"\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b"
)
STRUCTURAL_RUNTIME_PATTERNS = (
    re.compile(rb"BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY", re.IGNORECASE),
    re.compile(rb"<tool_call>|\b(?:tool|function)[ _-]?call\s*[:=(]", re.IGNORECASE),
    re.compile(
        rb'"(?:name|tool|function)"\s*:\s*"(?:browser|filesystem|network|shell|'
        rb"send[_-]?email|send[_-]?message|terminal)\b",
        re.IGNORECASE,
    ),
    re.compile(
        rb"\b(?:available\s+tools?|capabilities|permissions|tools?)\s*[:=]"
        rb"[^\r\n]{0,200}\b(?:browser|filesystem|internet|messaging|network|shell|terminal|"
        rb"tools?|web)\b",
        re.IGNORECASE,
    ),
    re.compile(
        rb"\b(?:curl|wget)\b[^\r\n]{0,200}\|\s*(?:bash|sh)\b",
        re.IGNORECASE,
    ),
)
CAPABILITY_OBJECT = (
    rb"(?:api[ _-]?keys?|browser|credentials?|directories|directory|email|filesystem|"
    rb"https?\s+requests?|https?://|internet|mail|messages?|messaging|network|online|"
    rb"passwords?|private\s+keys?|secrets?|send[_-]?email|send[_-]?message|shell|sms|"
    rb"terminal|tokens?|tool(?:[ _-]?calls?)?s?|urls?|web|webhook)"
)
ACTION_OBJECT_REQUEST = re.compile(
    rb"^\s*(?:[-*]\s*)?(?:(?:always|first|please|then)\s+)*"
    rb"(?:access|ask|browse|call|collect|connect(?:\s+to)?|delete|download|enable|execute|"
    rb"fetch|grant|invoke|list|make|modify|obtain|open|perform|post|provide|read|request|"
    rb"retrieve|run|send|store|upload|use|write)\b[^\r\n]{0,120}\b" + CAPABILITY_OBJECT + rb"\b",
    re.IGNORECASE,
)
DIRECT_MESSAGE_REQUEST = re.compile(
    rb"^\s*(?:[-*]\s*)?(?:(?:always|please)\s+)*(?:email|mail|message)\s+"
    rb"(?:a|an|my|our|the|their|this|your)\s+[A-Za-z0-9_-]+\b",
    re.IGNORECASE,
)
ACTOR_CAPABILITY_REQUEST = re.compile(
    rb"^\s*(?:[-*]\s*)?(?:the\s+)?(?:agent|character|i|persona|they|this\s+persona|you)\s+"
    rb"(?:are\s+allowed\s+to|can|has?|have|may|must|needs?|requires?|should|will)\b"
    rb"[^\r\n]{0,120}\b" + CAPABILITY_OBJECT + rb"\b",
    re.IGNORECASE,
)
SAFE_REFERENCE_REQUEST = re.compile(
    rb"^\s*(?:[-*]\s*)?use\s+(?:a\s+|an\s+|the\s+)?"
    rb"(?:analogy|concept|metaphor|phrase|term|word)\b",
    re.IGNORECASE,
)
CLAUSE_SPLIT = re.compile(rb"[.!?;,]+")
RUNTIME_NEGATION = re.compile(
    rb"\b(?:avoid|can(?:not|'t)|do(?:es)?\s+not|don't|forbid(?:den|s)?|may\s+not|"
    rb"must\s+not|never|no|not\s+available|without)\b",
    re.IGNORECASE,
)


def _forbidden_runtime_request(data: bytes) -> bool:
    for line in data.splitlines():
        if any(pattern.search(line) for pattern in STRUCTURAL_RUNTIME_PATTERNS):
            return True
        for clause in CLAUSE_SPLIT.split(line):
            if not clause.strip() or SAFE_REFERENCE_REQUEST.search(clause):
                continue
            for pattern in (
                ACTION_OBJECT_REQUEST,
                DIRECT_MESSAGE_REQUEST,
                ACTOR_CAPABILITY_REQUEST,
            ):
                match = pattern.search(clause)
                if match is not None and RUNTIME_NEGATION.search(clause[: match.end()]) is None:
                    return True
    return False


def _runtime_content(path: str, data: bytes, diagnostics: DiagnosticCollector) -> bool:
    if len(data) > MAX_RUNTIME_FILE_BYTES:
        diagnostics.error("runtime_file_too_large", "runtime file exceeds 16,384 bytes", path)
        return False
    if (
        len(data) < 2
        or b"\xef\xbb\xbf" in data
        or b"\x00" in data
        or b"\r" in data
        or not data.endswith(b"\n")
        or data.endswith(b"\n\n")
    ):
        diagnostics.error(
            "invalid_runtime_encoding", "runtime file violates strict UTF-8/LF rules", path
        )
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        diagnostics.error("invalid_runtime_encoding", "runtime file is not UTF-8", path)
        return False
    if _forbidden_runtime_request(data):
        diagnostics.error(
            "forbidden_runtime_request",
            "runtime file contains a tool, credential, or network request",
            path,
        )
        return False
    return True


def _executable_content(member: ArchiveMember, diagnostics: DiagnosticCollector) -> None:
    if member.is_dir:
        return
    suffix = Path(member.path).suffix.lower()
    if suffix in EXECUTABLE_SUFFIXES or member.data.startswith(EXECUTABLE_MAGIC):
        diagnostics.error(
            "executable_content", "executable archive content is forbidden", member.path
        )
    if CREDENTIAL_CONTENT.search(member.data):
        diagnostics.error(
            "credential_content", "credential-like secret material is forbidden", member.path
        )


def _prompt(files: dict[str, ArchiveMember], runtime_files: tuple[str, ...]) -> bytes:
    sections: list[bytes] = []
    for name in runtime_files:
        sections.extend(
            (
                f"--- BEGIN GREEN ROOM PERSONA FILE: {name} ---\n".encode(),
                files[name].data,
                f"--- END GREEN ROOM PERSONA FILE: {name} ---\n".encode(),
            )
        )
    return b"".join(sections)


def inspect_pack(path: str | Path) -> InspectionResult:
    diagnostics = DiagnosticCollector()
    try:
        members = read_archive(Path(path))
    except ArchiveError as exc:
        diagnostics.error(exc.code, exc.message, exc.path)
        if exc.truncated:
            diagnostics.mark_truncated()
        return InspectionResult(
            False,
            False,
            diagnostics.errors,
            diagnostics.warnings,
            (),
            b"",
            {},
            diagnostics.truncated,
            diagnostics.omitted,
        )

    files = {member.path: member for member in members if not member.is_dir}
    for required in sorted(REQUIRED_FILES - set(files)):
        diagnostics.error("missing_required_file", "required canonical file is missing", required)

    manifest: dict[str, Any] = {}
    if "persona.yaml" in files:
        manifest = parse_manifest(files["persona.yaml"].data, diagnostics)
    declared_assets = declared_asset_paths(manifest)

    for member in members:
        _executable_content(member, diagnostics)
        if member.is_dir:
            allowed_directories = {"", "assets"}
            for asset_path in declared_assets:
                parts = asset_path.split("/")[:-1]
                allowed_directories.update(
                    "/".join(parts[:index]) for index in range(1, len(parts) + 1)
                )
            if member.path not in allowed_directories:
                diagnostics.error("unknown_file", "forbidden archive directory", member.path)
        elif member.path not in TOP_LEVEL_FILES and not member.path.startswith("assets/"):
            diagnostics.error("unknown_file", "file has no draft 0.1 role", member.path)

    present_assets = {name for name in files if name.startswith("assets/")}
    for undeclared in sorted(present_assets - declared_assets):
        diagnostics.error("undeclared_asset", "asset is not declared in persona.yaml", undeclared)
    for missing in sorted(declared_assets - present_assets):
        diagnostics.error("missing_declared_asset", "declared asset is missing", missing)

    runtime_files = tuple(name for name in RUNTIME_ORDER if name in files)
    runtime_total = 0
    for name in runtime_files:
        runtime_total += len(files[name].data)
        _runtime_content(name, files[name].data, diagnostics)
    if runtime_total > MAX_RUNTIME_TOTAL_BYTES:
        diagnostics.error("runtime_total_too_large", "runtime content exceeds 65,536 bytes")

    errors = diagnostics.errors
    prompt = _prompt(files, runtime_files) if not errors else b""
    return InspectionResult(
        not errors,
        not errors,
        errors,
        diagnostics.warnings,
        runtime_files,
        prompt,
        manifest,
        diagnostics.truncated,
        diagnostics.omitted,
    )


def validated_prompt(result: InspectionResult) -> bytes:
    if not result.valid:
        raise ValueError("cannot obtain a prompt from an invalid pack")
    return result.prompt
