from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from .fixture_builder import minimal_files, write_zip


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
