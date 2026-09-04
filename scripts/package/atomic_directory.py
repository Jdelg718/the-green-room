#!/usr/bin/env python3
"""Descriptor-relative directory publication primitives for macOS and Linux.

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
RENAME_NOREPLACE = 0x00000001
PARENT_FD = 3
SOURCE_FD = 4
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    rename_exclusive = libc.renameatx_np
    rename_flags = RENAME_EXCL
elif sys.platform.startswith("linux"):
    rename_exclusive = libc.renameat2
    rename_flags = RENAME_NOREPLACE
else:
    rename_exclusive = None
    rename_flags = 0
if rename_exclusive is not None:
    rename_exclusive.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename_exclusive.restype = ctypes.c_int


def emit(**value: object) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


def rename_no_replace(source: str, destination: str) -> int:
    if rename_exclusive is None:
        return errno.ENOSYS
    result = rename_exclusive(
        PARENT_FD, source.encode(), PARENT_FD, destination.encode(), rename_flags
    )
    return 0 if result == 0 else ctypes.get_errno()


def binding(name: str) -> dict[str, object]:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=PARENT_FD)
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


def remove_owned_binding(parent_fd: int, name: str) -> None:
    details = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISDIR(details.st_mode):
        remove_owned_tree(parent_fd, name)
    elif stat.S_ISREG(details.st_mode):
        os.unlink(name, dir_fd=parent_fd)
    else:
        raise OSError(errno.EPERM, "unexpected staged entry type", name)


def copy_tree(source_fd: int, destination_fd: int) -> None:
    for name in os.listdir(source_fd):
        details = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISDIR(details.st_mode):
            os.mkdir(name, 0o700, dir_fd=destination_fd)
            source_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
            destination_child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination_fd)
            try:
                copy_tree(source_child, destination_child)
                os.fchmod(destination_child, stat.S_IMODE(details.st_mode))
                os.utime(destination_child, ns=(details.st_atime_ns, details.st_mtime_ns))
            finally:
                os.close(destination_child)
                os.close(source_child)
        elif stat.S_ISREG(details.st_mode) and details.st_nlink == 1:
            source_file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_fd)
            destination_file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=destination_fd)
            try:
                while chunk := os.read(source_file, 1024 * 1024):
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(destination_file, view):]
                os.fchmod(destination_file, stat.S_IMODE(details.st_mode))
                os.utime(destination_file, ns=(details.st_atime_ns, details.st_mtime_ns))
            finally:
                os.close(destination_file)
                os.close(source_file)
        else:
            raise OSError(errno.EPERM, "unsafe source entry", name)


def quarantine(
    name: str,
    quarantine_name: str,
    restore_name: str,
    expected: tuple[int, int],
    cleanup_policy: str,
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
    if moved_identity == expected and cleanup_policy == "retain-owned":
        emit(status="retained", quarantine=quarantine_name, reason="owned_quarantine")
        return
    if moved_identity == expected and cleanup_policy == "cleanup":
        try:
            remove_owned_binding(PARENT_FD, quarantine_name)
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
            sys.argv[7],
        )
    elif operation == "copy-tree":
        destination = sys.argv[2]
        try:
            os.mkdir(destination, 0o700, dir_fd=PARENT_FD)
            destination_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=PARENT_FD)
            try:
                source_details = os.fstat(SOURCE_FD)
                copy_tree(SOURCE_FD, destination_fd)
                os.fchmod(destination_fd, stat.S_IMODE(source_details.st_mode))
                os.utime(destination_fd, ns=(source_details.st_atime_ns, source_details.st_mtime_ns))
                destination_details = os.fstat(destination_fd)
                emit(status="ok", dev=destination_details.st_dev, ino=destination_details.st_ino)
            finally:
                os.close(destination_fd)
        except OSError as error:
            emit(status="error", errno=error.errno)
    elif operation == "copy-file":
        destination = sys.argv[2]
        try:
            source_details = os.fstat(SOURCE_FD)
            if not stat.S_ISREG(source_details.st_mode) or source_details.st_nlink != 1:
                raise OSError(errno.EPERM, "unsafe source file")
            destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=PARENT_FD)
            try:
                os.lseek(SOURCE_FD, 0, os.SEEK_SET)
                while chunk := os.read(SOURCE_FD, 1024 * 1024):
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(destination_fd, view):]
                os.fchmod(destination_fd, stat.S_IMODE(source_details.st_mode))
                os.utime(destination_fd, ns=(source_details.st_atime_ns, source_details.st_mtime_ns))
                destination_details = os.fstat(destination_fd)
                emit(status="ok", dev=destination_details.st_dev, ino=destination_details.st_ino)
            finally:
                os.close(destination_fd)
        except OSError as error:
            emit(status="error", errno=error.errno)
    else:
        emit(status="error", errno=errno.EINVAL)


if __name__ == "__main__":
    main()
