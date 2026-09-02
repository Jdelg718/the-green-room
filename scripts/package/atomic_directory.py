#!/usr/bin/env python3
"""Descriptor-relative macOS directory publication primitives.

All results are one JSON object. This helper never follows symlinks and never
uses overwrite-capable rename for public, quarantine, or restoration names.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import stat
import sys

RENAME_EXCL = 0x00000004
PARENT_FD = 3
libc = ctypes.CDLL(None, use_errno=True)
renameatx_np = libc.renameatx_np
renameatx_np.argtypes = [
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
]
renameatx_np.restype = ctypes.c_int


def emit(**value: object) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


def rename_no_replace(source: str, destination: str) -> int:
    result = renameatx_np(PARENT_FD, source.encode(), PARENT_FD, destination.encode(), RENAME_EXCL)
    return 0 if result == 0 else ctypes.get_errno()


def binding(name: str) -> dict[str, object]:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=PARENT_FD)
    except OSError as error:
        if error.errno == errno.ENOENT:
            return {"status": "absent"}
        return {"status": "error", "errno": error.errno}
    try:
        details = os.fstat(descriptor)
        return {"status": "ok", "dev": details.st_dev, "ino": details.st_ino}
    finally:
        os.close(descriptor)


def remove_owned_tree(parent_fd: int, name: str) -> None:
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        os.fchmod(descriptor, 0o700)
        for child in os.listdir(descriptor):
            details = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(details.st_mode):
                remove_owned_tree(descriptor, child)
            elif stat.S_ISREG(details.st_mode):
                os.unlink(child, dir_fd=descriptor)
            else:
                raise OSError(errno.EPERM, "unexpected staged entry type", child)
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=parent_fd)


def quarantine(
    name: str,
    quarantine_name: str,
    restore_name: str,
    expected: tuple[int, int],
    cleanup_expected: bool,
) -> None:
    rename_errno = rename_no_replace(name, quarantine_name)
    if rename_errno == errno.ENOENT:
        emit(status="absent")
        return
    if rename_errno:
        emit(status="error", errno=rename_errno)
        return
    moved = binding(quarantine_name)
    moved_identity = (moved.get("dev"), moved.get("ino"))
    if moved.get("status") != "ok":
        emit(
            status="retained",
            quarantine=quarantine_name,
            reason="quarantine_unverifiable",
            moved=moved,
        )
        return
    if moved_identity == expected and cleanup_expected:
        try:
            remove_owned_tree(PARENT_FD, quarantine_name)
            emit(status="owned_cleaned")
        except OSError as error:
            emit(
                status="retained",
                quarantine=quarantine_name,
                reason="owned_cleanup_failed",
                errno=error.errno,
            )
        return
    restore_errno = rename_no_replace(quarantine_name, restore_name)
    if restore_errno == 0:
        emit(
            status="competitor_restored", restored=restore_name, dev=moved["dev"], ino=moved["ino"]
        )
    else:
        emit(
            status="retained",
            quarantine=quarantine_name,
            reason="identity_mismatch" if moved_identity != expected else "owned_retained",
            restore_errno=restore_errno,
            dev=moved["dev"],
            ino=moved["ino"],
        )


def main() -> None:
    operation = sys.argv[1]
    if operation == "stat":
        emit(**binding(sys.argv[2]))
    elif operation == "rename":
        rename_errno = rename_no_replace(sys.argv[2], sys.argv[3])
        emit(status="ok" if rename_errno == 0 else "error", errno=rename_errno)
    elif operation == "quarantine":
        quarantine(
            sys.argv[2],
            sys.argv[3],
            sys.argv[4],
            (int(sys.argv[5]), int(sys.argv[6])),
            sys.argv[7] == "cleanup",
        )
    else:
        emit(status="error", errno=errno.EINVAL)


if __name__ == "__main__":
    main()
