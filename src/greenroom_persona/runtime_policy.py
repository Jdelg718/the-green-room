from __future__ import annotations

import sys
from typing import Any

_installed = False


def _deny_network(event: str, _arguments: tuple[Any, ...]) -> None:
    if event == "socket.__new__" or event.startswith("socket."):
        raise PermissionError("validator network access is disabled")


def install_runtime_policy() -> None:
    """Deny network use in both source and frozen CLI processes."""
    global _installed
    if _installed:
        return
    sys.addaudithook(_deny_network)
    _installed = True
