from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .limits import MAX_DIAGNOSTICS


@dataclass(frozen=True, order=True)
class Diagnostic:
    code: str
    message: str
    path: str = ""


@dataclass(frozen=True)
class InspectionResult:
    valid: bool
    loadable: bool
    errors: tuple[Diagnostic, ...]
    warnings: tuple[Diagnostic, ...]
    runtime_files: tuple[str, ...]
    prompt: bytes = field(repr=False)
    manifest: dict[str, Any] = field(repr=False)
    diagnostics_truncated: bool = False
    diagnostics_omitted: int = 0

    @property
    def prompt_utf8_bytes(self) -> int:
        return len(self.prompt)

    @property
    def prompt_sha256(self) -> str:
        return hashlib.sha256(self.prompt).hexdigest() if self.valid else ""


class DiagnosticCollector:
    def __init__(self) -> None:
        self._errors: list[Diagnostic] = []
        self._warnings: list[Diagnostic] = []
        self.truncated = False
        self._omitted = 0

    def error(self, code: str, message: str, path: str = "") -> None:
        if len(self._errors) >= MAX_DIAGNOSTICS:
            self.truncated = True
            self._omitted += 1
            return
        self._errors.append(Diagnostic(code, message[:240], path[:255]))

    def warning(self, code: str, message: str, path: str = "") -> None:
        if len(self._warnings) >= MAX_DIAGNOSTICS:
            self.truncated = True
            self._omitted += 1
            return
        self._warnings.append(Diagnostic(code, message[:240], path[:255]))

    def mark_truncated(self, omitted: int = 1) -> None:
        self.truncated = True
        self._omitted += max(1, omitted)

    @property
    def omitted(self) -> int:
        return self._omitted

    @property
    def errors(self) -> tuple[Diagnostic, ...]:
        return tuple(sorted(self._errors))

    @property
    def warnings(self) -> tuple[Diagnostic, ...]:
        return tuple(sorted(self._warnings))
