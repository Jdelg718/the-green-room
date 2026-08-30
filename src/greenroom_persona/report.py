from __future__ import annotations

import json
from typing import Any

from .limits import MAX_REPORT_BYTES
from .models import Diagnostic, InspectionResult


def _diagnostic(diagnostic: Diagnostic) -> dict[str, str]:
    result = {"code": diagnostic.code, "message": diagnostic.message}
    if diagnostic.path:
        result["path"] = diagnostic.path
    return result


def _payload(result: InspectionResult, include_prompt: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "diagnostics_truncated": result.diagnostics_truncated,
        "diagnostics_omitted": result.diagnostics_omitted,
        "errors": [_diagnostic(item) for item in result.errors],
        "loadable": result.loadable,
        "prompt_sha256": result.prompt_sha256 or None,
        "prompt_utf8_bytes": result.prompt_utf8_bytes if result.valid else None,
        "report_version": "1",
        "runtime_files": list(result.runtime_files),
        "valid": result.valid,
        "warnings": [_diagnostic(item) for item in result.warnings],
    }
    if include_prompt and result.valid:
        payload["prompt"] = result.prompt.decode("utf-8")
    return payload


def render_json(result: InspectionResult, *, include_prompt: bool = False) -> str:
    payload = _payload(result, include_prompt)
    rendered = _render_json_payload(payload)
    if len(rendered.encode("utf-8")) > MAX_REPORT_BYTES and "prompt" in payload:
        del payload["prompt"]
        payload["prompt_omitted"] = "report_size_limit"
        rendered = _render_json_payload(payload)
    while len(rendered.encode("utf-8")) > MAX_REPORT_BYTES and (
        payload["warnings"] or payload["errors"]
    ):
        diagnostics = payload["warnings"] or payload["errors"]
        diagnostics.pop()
        payload["diagnostics_omitted"] += 1
        payload["diagnostics_truncated"] = True
        rendered = _render_json_payload(payload)
    return rendered


def _render_json_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"


def render_human(result: InspectionResult) -> str:
    if result.valid:
        lines = [
            "VALID persona pack",
            "report_version: 1",
            f"runtime_files: {', '.join(result.runtime_files)}",
            f"prompt_utf8_bytes: {result.prompt_utf8_bytes}",
            f"prompt_sha256: {result.prompt_sha256}",
        ]
    else:
        lines = ["INVALID persona pack", "report_version: 1"]
    diagnostic_lines: list[str] = []
    for diagnostic in result.errors:
        location = f" [{diagnostic.path}]" if diagnostic.path else ""
        diagnostic_lines.append(f"ERROR {diagnostic.code}{location}: {diagnostic.message}")
    for diagnostic in result.warnings:
        location = f" [{diagnostic.path}]" if diagnostic.path else ""
        diagnostic_lines.append(f"WARNING {diagnostic.code}{location}: {diagnostic.message}")

    for rendered_count in range(len(diagnostic_lines), -1, -1):
        omitted = result.diagnostics_omitted + len(diagnostic_lines) - rendered_count
        candidate = [*lines, *diagnostic_lines[:rendered_count]]
        if result.diagnostics_truncated or omitted:
            candidate.append(f"NOTICE diagnostics_truncated: true; omitted_diagnostics: {omitted}")
        rendered = "\n".join(candidate) + "\n"
        if len(rendered.encode("utf-8")) <= MAX_REPORT_BYTES:
            return rendered
    raise AssertionError("fixed report header exceeds MAX_REPORT_BYTES")
