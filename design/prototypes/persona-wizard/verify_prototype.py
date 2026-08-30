#!/usr/bin/env python3
"""Compatibility entry point for the Playwright behavior verifier."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
if not shutil.which("node") or not shutil.which("npm"):
    print("FAIL Node.js and npm are required for Playwright verification.", file=sys.stderr)
    raise SystemExit(1)
if not (ROOT / "node_modules" / "playwright").exists():
    print("Install verifier dependencies first: npm ci", file=sys.stderr)
    raise SystemExit(1)
raise SystemExit(subprocess.call(["npm", "run", "verify"], cwd=ROOT))
