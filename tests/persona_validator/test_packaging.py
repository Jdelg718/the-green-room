from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import tomllib
import zipfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = REPOSITORY_ROOT / "src" / "greenroom_persona"


def test_package_declares_pep_561_typing_support() -> None:
    marker = PACKAGE_ROOT / "py.typed"

    assert marker.is_file()
    assert marker.read_bytes() == b""


def test_built_wheel_and_sdist_include_typing_marker(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    assert uv is not None

    subprocess.run(  # noqa: S603 -- fixed local build command, no untrusted input
        [uv, "build", "--out-dir", str(tmp_path)],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    (wheel,) = tmp_path.glob("*.whl")
    with zipfile.ZipFile(wheel) as archive:
        assert "greenroom_persona/py.typed" in archive.namelist()

    (sdist,) = tmp_path.glob("*.tar.gz")
    with tarfile.open(sdist, "r:gz") as archive:
        marker_names = [
            name for name in archive.getnames() if name.endswith("/src/greenroom_persona/py.typed")
        ]
    assert len(marker_names) == 1


def test_wheel_scope_is_explicit() -> None:
    configuration = tomllib.loads((REPOSITORY_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    wheel = configuration["tool"]["hatch"]["build"]["targets"]["wheel"]

    assert wheel["packages"] == ["src/greenroom_persona"]


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


def test_wheel_installs_non_editably_and_absolute_console_runs_from_foreign_cwd(
    tmp_path: Path,
) -> None:
    uv = shutil.which("uv")
    assert uv is not None
    wheelhouse = tmp_path / "wheelhouse"
    venv = tmp_path / "fresh-venv"
    foreign_cwd = tmp_path / "foreign-cwd"
    foreign_cwd.mkdir()

    subprocess.run(  # noqa: S603 -- fixed local build command, no untrusted input
        [uv, "build", "--wheel", "--out-dir", str(wheelhouse)],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    (wheel,) = wheelhouse.glob("*.whl")
    subprocess.run(  # noqa: S603 -- fixed uv executable and temporary test paths
        [uv, "venv", str(venv)],
        check=True,
        capture_output=True,
        text=True,
    )
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(  # noqa: S603 -- fixed uv executable and built local wheel
        [uv, "pip", "install", "--python", str(python), str(wheel)],
        check=True,
        capture_output=True,
        text=True,
    )
    console = venv / (
        "Scripts/greenroom-persona.exe" if os.name == "nt" else "bin/greenroom-persona"
    )
    fixture = REPOSITORY_ROOT / "tests/fixtures/persona-validator/valid-minimal.greenroom"
    result = subprocess.run(  # noqa: S603 -- fresh-venv console and fixed fixture
        [str(console), "validate", "--format", "json", "--", str(fixture)],
        cwd=foreign_cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert report == {
        "diagnostics_omitted": 0,
        "diagnostics_truncated": False,
        "errors": [],
        "loadable": True,
        "prompt_sha256": "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df",
        "prompt_utf8_bytes": 383,
        "report_version": "1",
        "runtime_files": ["AGENTS.md", "BACKGROUND.md", "VOICE.md"],
        "valid": True,
        "warnings": [],
    }
