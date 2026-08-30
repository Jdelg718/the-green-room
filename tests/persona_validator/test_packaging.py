from __future__ import annotations

import tomllib
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_sdist_scope_is_explicit_and_excludes_workspace_only_content() -> None:
    configuration = tomllib.loads((REPOSITORY_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    sdist = configuration["tool"]["hatch"]["build"]["targets"]["sdist"]

    assert set(sdist["include"]) == {
        "/LICENSE",
        "/README.md",
        "/pyproject.toml",
        "/schemas/persona-0.1.schema.json",
        "/src/greenroom_persona",
    }
    assert set(sdist["exclude"]) >= {
        "/.hypothesis",
        "/.venv",
        "/dist",
        "/**/__pycache__",
        "/docs",
        "/evidence",
        "/personas",
        "/spikes",
        "/tests",
        "/upstream",
    }
