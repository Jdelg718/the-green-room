"""Hatch build hook for a minimal source distribution."""

from __future__ import annotations

from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Remove Hatchling's forced VCS-ignore-file inclusion from the sdist."""

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        force_include = build_data.get("force_include", {})
        for source, destination in tuple(force_include.items()):
            if destination == ".gitignore":
                del force_include[source]
