#!/usr/bin/env python3
"""Create and extract the one canonical, bounded macOS application ZIP."""

from __future__ import annotations

import hashlib
import os
import pathlib
import re
import stat
import struct
import subprocess
import sys
import zipfile

FIXED_TIME = (2000, 1, 1, 0, 0, 0)
APP_ROOT = "The Green Room.app"
JUNK = {".DS_Store", "Thumbs.db", "__MACOSX"}
PATH = re.compile(r"^[A-Za-z0-9._ +@-]+(?:/[A-Za-z0-9._ +@-]+)*/?$")
MAX_ARCHIVE_BYTES = 1_073_741_824
MAX_ENTRIES = 10_000
MAX_ENTRY_BYTES = 536_870_912
MAX_TOTAL_BYTES = 2_147_483_648
MAX_COMPRESSION_RATIO = 200
CHUNK_BYTES = 1024 * 1024


def fail(code: str, detail: str = "") -> None:
    raise ValueError(f"{code}: {detail}" if detail else code)


def safe_parts(name: str) -> tuple[str, ...]:
    if (
        not name
        or len(name.encode("utf-8")) > 4096
        or not PATH.fullmatch(name)
        or name.startswith("/")
        or "\\" in name
        or "//" in name
    ):
        fail("zip_path_invalid", name)
    parts = tuple(part for part in name.rstrip("/").split("/") if part)
    if not parts or parts[0] != APP_ROOT or any(part in {".", ".."} for part in parts):
        fail("zip_path_invalid", name)
    if any(part in JUNK for part in parts):
        fail("zip_junk_forbidden", name)
    return parts


def xattrs(path: pathlib.Path) -> None:
    list_attributes = getattr(os, "listxattr", None)
    if list_attributes is not None:
        attributes: list[str] = []
        try:
            attributes = list_attributes(path, follow_symlinks=False)
        except OSError:
            fail("zip_xattr_forbidden", str(path))
        if attributes:
            fail("zip_xattr_forbidden", str(path))
        return
    if sys.platform != "darwin":
        fail("zip_xattr_forbidden", str(path))
    result = subprocess.run(
        ["/usr/bin/xattr", str(path)], check=False, capture_output=True, text=True, timeout=5
    )
    if result.returncode != 0 or result.stdout.strip():
        fail("zip_xattr_forbidden", str(path))


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_BYTES):
            value.update(chunk)
    return value.hexdigest()


def source_inventory(app: pathlib.Path) -> list[tuple[str, pathlib.Path, int, bool, int, str]]:
    if app.name != APP_ROOT:
        fail("zip_app_name_invalid")
    root = app.lstat()
    if not stat.S_ISDIR(root.st_mode) or stat.S_IMODE(root.st_mode) != 0o555:
        fail("zip_root_invalid")
    xattrs(app)
    records: list[tuple[str, pathlib.Path, int, bool, int, str]] = [
        (APP_ROOT + "/", app, 0o555, True, 0, "")
    ]
    for current, directories, files in os.walk(app, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        for name in [*directories, *files]:
            path = pathlib.Path(current, name)
            relative = path.relative_to(app.parent).as_posix()
            safe_parts(relative)
            details = path.lstat()
            if stat.S_ISLNK(details.st_mode):
                fail("zip_link_forbidden", relative)
            is_directory = stat.S_ISDIR(details.st_mode)
            if not (is_directory or stat.S_ISREG(details.st_mode)):
                fail("zip_special_forbidden", relative)
            if stat.S_ISREG(details.st_mode) and details.st_nlink != 1:
                fail("zip_hardlink_forbidden", relative)
            xattrs(path)
            mode = stat.S_IMODE(details.st_mode)
            if mode not in ({0o555} if is_directory else {0o444, 0o555}):
                fail("zip_mode_invalid", relative)
            size = 0 if is_directory else details.st_size
            if size > MAX_ENTRY_BYTES:
                fail("zip_entry_too_large", relative)
            records.append((relative + "/" if is_directory else relative, path, mode, is_directory, size, "" if is_directory else digest(path)))
    records.sort(key=lambda item: item[0])
    if not records or len(records) > MAX_ENTRIES or sum(item[4] for item in records) > MAX_TOTAL_BYTES:
        fail("zip_inventory_limit")
    return records


def validate_container(path: pathlib.Path) -> None:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_size > MAX_ARCHIVE_BYTES:
        fail("zip_archive_invalid")
    with path.open("rb") as source:
        if source.read(4) != b"PK\x03\x04":
            fail("zip_container_invalid")
        tail_size = min(details.st_size, 65557)
        source.seek(-tail_size, os.SEEK_END)
        tail = source.read()
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or offset + 22 > len(tail):
        fail("zip_container_invalid")
    comment_length = struct.unpack_from("<H", tail, offset + 20)[0]
    if comment_length != 0 or offset + 22 != len(tail):
        fail("zip_container_invalid")


def checked_infos(archive_path: pathlib.Path) -> list[zipfile.ZipInfo]:
    validate_container(archive_path)
    with zipfile.ZipFile(archive_path, "r") as archive:
        if archive.comment:
            fail("zip_metadata_invalid")
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if not infos or len(infos) > MAX_ENTRIES or names != sorted(names) or len(names) != len(set(names)):
            fail("zip_inventory_invalid")
        files: set[tuple[str, ...]] = set()
        directories: set[tuple[str, ...]] = set()
        total = 0
        for info in infos:
            parts = safe_parts(info.filename)
            is_directory = info.filename.endswith("/")
            mode = (info.external_attr >> 16) & 0xFFFF
            expected_kind = stat.S_IFDIR if is_directory else stat.S_IFREG
            permissions = stat.S_IMODE(mode)
            if stat.S_IFMT(mode) != expected_kind or permissions not in ({0o555} if is_directory else {0o444, 0o555}):
                fail("zip_type_or_mode_invalid", info.filename)
            if (
                info.create_system != 3
                or info.date_time != FIXED_TIME
                or info.compress_type != zipfile.ZIP_DEFLATED
                or info.flag_bits not in {0, 0x800}
                or info.extra
                or info.comment
                or info.volume != 0
                or info.internal_attr != 0
                or info.file_size < 0
                or info.file_size > MAX_ENTRY_BYTES
                or info.compress_size < 0
                or info.extract_version >= 45
            ):
                fail("zip_metadata_invalid", info.filename)
            if is_directory and (info.file_size != 0 or info.compress_size > 8):
                fail("zip_directory_invalid", info.filename)
            if not is_directory and info.file_size > 0 and info.file_size > max(1, info.compress_size) * MAX_COMPRESSION_RATIO:
                fail("zip_bomb_forbidden", info.filename)
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                fail("zip_bomb_forbidden")
            if is_directory:
                if parts in files:
                    fail("zip_collision", info.filename)
                directories.add(parts)
            else:
                if parts in directories or any(parts[:index] in files for index in range(1, len(parts))):
                    fail("zip_collision", info.filename)
                files.add(parts)
        # Every descendant directory is explicit, preventing metadata from being
        # synthesized differently by different extractors.
        for parts in files | directories:
            for index in range(1, len(parts)):
                if parts[:index] not in directories:
                    fail("zip_directory_missing", "/".join(parts[:index]))
        return infos


def create(app: pathlib.Path, destination: pathlib.Path) -> None:
    if not app.is_absolute() or not destination.is_absolute() or pathlib.Path(os.path.abspath(app)) != app or pathlib.Path(os.path.abspath(destination)) != destination:
        fail("zip_path_invalid")
    if destination.exists() or destination.is_symlink():
        fail("zip_destination_exists")
    records = source_inventory(app)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        with destination.open("xb") as output, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
            for name, path, mode, is_directory, _size, _digest in records:
                info = zipfile.ZipInfo(name, FIXED_TIME)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((stat.S_IFDIR if is_directory else stat.S_IFREG) | mode) << 16
                info.flag_bits = 0
                archive.writestr(info, b"" if is_directory else path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        infos = checked_infos(destination)
        actual = [(info.filename, stat.S_IMODE(info.external_attr >> 16), info.is_dir(), info.file_size) for info in infos]
        expected = [(name, mode, is_directory, size) for name, _path, mode, is_directory, size, _digest in records]
        if actual != expected:
            fail("zip_created_inventory_drift")
        with zipfile.ZipFile(destination, "r") as archive:
            for info, record in zip(infos, records):
                if not record[3] and hashlib.sha256(archive.read(info)).hexdigest() != record[5]:
                    fail("zip_created_bytes_drift", info.filename)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def extract(archive_path: pathlib.Path, destination: pathlib.Path) -> pathlib.Path:
    if not archive_path.is_absolute() or not destination.is_absolute() or pathlib.Path(os.path.abspath(archive_path)) != archive_path or pathlib.Path(os.path.abspath(destination)) != destination:
        fail("zip_path_invalid")
    if destination.exists() and (destination.is_symlink() or not destination.is_dir() or any(destination.iterdir())):
        fail("zip_extract_not_empty")
    infos = checked_infos(archive_path)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    expected: dict[str, tuple[int, bool, int, str]] = {}
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            for info in infos:
                parts = safe_parts(info.filename)
                mode = stat.S_IMODE(info.external_attr >> 16)
                is_directory = info.is_dir()
                target = destination.joinpath(*parts)
                if is_directory:
                    target.mkdir(mode=0o700, exist_ok=False)
                    expected[info.filename] = (mode, True, 0, "")
                    continue
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                value = hashlib.sha256()
                written = 0
                with archive.open(info, "r") as source, target.open("xb") as output:
                    while chunk := source.read(CHUNK_BYTES):
                        written += len(chunk)
                        if written > info.file_size or written > MAX_ENTRY_BYTES:
                            fail("zip_size_mismatch", info.filename)
                        output.write(chunk)
                        value.update(chunk)
                if written != info.file_size:
                    fail("zip_size_mismatch", info.filename)
                target.chmod(mode)
                expected[info.filename] = (mode, False, written, value.hexdigest())
        for path in sorted((item for item in destination.rglob("*") if item.is_dir()), key=lambda item: len(item.parts), reverse=True):
            path.chmod(0o555)
        actual_names: list[str] = []
        for path in sorted(destination.rglob("*")):
            details = path.lstat()
            relative = path.relative_to(destination).as_posix() + ("/" if stat.S_ISDIR(details.st_mode) else "")
            actual_names.append(relative)
            if relative not in expected or stat.S_ISLNK(details.st_mode) or not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)):
                fail("zip_extracted_inventory_drift", relative)
            mode, is_directory, size, sha = expected[relative]
            if stat.S_IMODE(details.st_mode) != mode or stat.S_ISDIR(details.st_mode) != is_directory or (not is_directory and (details.st_nlink != 1 or details.st_size != size or digest(path) != sha)):
                fail("zip_extracted_metadata_drift", relative)
            xattrs(path)
        actual_names.sort()
        if actual_names != sorted(expected):
            fail("zip_extracted_inventory_drift")
    except Exception:
        # Caller owns cleanup of a partially populated private extraction root.
        raise
    app = destination / APP_ROOT
    if not app.is_dir() or len(list(destination.iterdir())) != 1:
        fail("zip_root_invalid")
    return app


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in {"create", "extract"}:
        raise SystemExit("usage: deterministic_app_zip.py create|extract ABSOLUTE_SOURCE ABSOLUTE_DESTINATION")
    source, destination = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    if sys.argv[1] == "create":
        create(source, destination)
    else:
        print(extract(source, destination))
