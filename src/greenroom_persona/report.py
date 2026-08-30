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
    rendered = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    while len(rendered.encode("utf-8")) > MAX_REPORT_BYTES and payload["errors"]:
        payload["errors"].pop()
        payload["diagnostics_truncated"] = True
        rendered = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
        )
    if len(rendered.encode("utf-8")) > MAX_REPORT_BYTES and "prompt" in payload:
        del payload["prompt"]
        payload["prompt_omitted"] = "report_size_limit"
        rendered = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
        )
    return rendered


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
    for diagnostic in result.errors:
        location = f" [{diagnostic.path}]" if diagnostic.path else ""
        lines.append(f"ERROR {diagnostic.code}{location}: {diagnostic.message}")
    for diagnostic in result.warnings:
        location = f" [{diagnostic.path}]" if diagnostic.path else ""
        lines.append(f"WARNING {diagnostic.code}{location}: {diagnostic.message}")
    if result.diagnostics_truncated:
        lines.append("NOTICE diagnostics_truncated: true")
    return "\n".join(lines) + "\n"
