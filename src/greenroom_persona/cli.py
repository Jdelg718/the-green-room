from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from .report import render_human, render_json
from .runtime_policy import install_runtime_policy
from .validator import inspect_pack


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="greenroom-persona")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("validate", "inspect"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--format", choices=("human", "json"), default="human")
        if command == "inspect":
            subparser.add_argument("--include-prompt", action="store_true")
            subparser.add_argument("--prompt-output", metavar="PATH")
        subparser.add_argument("pack", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    install_runtime_policy()
    arguments = _parser().parse_args(argv)
    result = inspect_pack(arguments.pack)
    include_prompt = bool(getattr(arguments, "include_prompt", False))
    if arguments.format == "json":
        report = render_json(result, include_prompt=include_prompt)
    else:
        report = render_human(result)
    prompt_output = getattr(arguments, "prompt_output", None)

    if prompt_output == "-":
        if result.valid:
            sys.stdout.buffer.write(result.prompt)
            return 0
        sys.stderr.write(report)
        return 1
    if prompt_output:
        if result.valid:
            try:
                Path(prompt_output).write_bytes(result.prompt)
            except OSError as exc:
                sys.stderr.write(f"prompt output failed: {os.strerror(exc.errno or 5)}\n")
                return 2
        else:
            sys.stderr.write(report)
            return 1
    sys.stdout.write(report)
    return 0 if result.valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
