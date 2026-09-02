from __future__ import annotations

import hashlib
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from .fixture_builder import minimal_files, write_zip


def pytest_configure() -> None:
    """Capture every concrete suite input for source/frozen CLI replay."""
    capture_root = os.environ.get("GREENROOM_VALIDATOR_CAPTURE_ROOT")
    if capture_root is None:
        return
    import greenroom_persona

    root = Path(capture_root)
    root.mkdir(parents=True, exist_ok=True)
    original = greenroom_persona.inspect_pack

    def capturing_inspect(path: Path, *args: Any, **kwargs: Any) -> Any:
        try:
            descriptor = os.open(os.fspath(path), os.O_RDONLY)
            try:
                chunks: list[bytes] = []
                while True:
                    chunk = os.read(descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                payload = b"".join(chunks)
            finally:
                os.close(descriptor)
            digest = hashlib.sha256(payload).hexdigest()
            destination = root / f"{digest}.greenroom"
            try:
                output = os.open(
                    os.fspath(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
            except FileExistsError:
                output = None
            if output is not None:
                try:
                    view = memoryview(payload)
                    while view:
                        written = os.write(output, view)
                        view = view[written:]
                finally:
                    os.close(output)
        except OSError:
            pass
        return original(path, *args, **kwargs)

    greenroom_persona.inspect_pack = capturing_inspect


@pytest.fixture
def pack_factory(tmp_path: Path) -> Callable[..., Path]:
    counter = 0

    def build(*, files: dict[str, bytes] | None = None, order: list[str] | None = None) -> Path:
        nonlocal counter
        counter += 1
        return write_zip(
            tmp_path / f"fixture-{counter}.greenroom",
            files or minimal_files(),
            order=order,
        )

    return build
