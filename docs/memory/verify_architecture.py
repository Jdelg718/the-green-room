#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "jsonschema==4.25.1",
# ]
# ///
"""Run the architecture gate from any working directory via `uv run`."""

from __future__ import annotations

import runpy
from pathlib import Path

TEST = Path(__file__).resolve().parents[2] / "tests" / "test_memory_adapter_architecture.py"
namespace = runpy.run_path(str(TEST), run_name="memory_adapter_architecture")
raise SystemExit(namespace["main"]())
