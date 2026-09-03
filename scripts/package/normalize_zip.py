#!/usr/bin/env python3
"""Rewrite a ZIP with deterministic member and container metadata."""

from __future__ import annotations

import contextlib
import os
import pathlib
import sys
import tempfile
import zipfile

FIXED_ZIP_TIME = (2000, 1, 1, 0, 0, 0)


def normalize(path: pathlib.Path) -> None:
    with zipfile.ZipFile(path, "r") as source:
        names = source.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate ZIP member")
        members = [
            (name, source.read(name), source.getinfo(name).is_dir()) for name in sorted(names)
        ]

    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as target:
            for name, payload, is_directory in members:
                info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o40755 if is_directory else 0o100644) << 16
                info.internal_attr = 0
                info.flag_bits = 0
                target.writestr(info, payload, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize_zip.py ABSOLUTE_ZIP_PATH")
    candidate = pathlib.Path(sys.argv[1])
    if not candidate.is_absolute():
        raise SystemExit("ZIP path must be absolute")
    normalize(candidate)
