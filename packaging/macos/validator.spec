# -*- mode: python ; coding: utf-8 -*-
"""Native arm64, one-folder Green Room persona validator spike.

One-folder output is deliberate: the interpreter and every imported library stay
visible to inventory/signing, and runtime does not extract executable code into a
mutable temporary directory. This spec is development/build input only.
"""

from pathlib import Path


repository_root = Path(SPECPATH).parents[1]

analysis = Analysis(
    [str(repository_root / "packaging/macos/validator_entry.py")],
    pathex=[str(repository_root / "src")],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pip", "pytest", "setuptools", "tests", "uv"],
    noarchive=False,
    optimize=2,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="greenroom-persona",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
    contents_directory="_internal",
)

payload = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="greenroom-persona",
)
