"""Jev chooses an observed action. Code owns execution."""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .agent import Agent
    from .browser import Browser

__all__ = ["Agent", "Browser"]


def __getattr__(name: str) -> Any:
    """Import Agent/Browser on first access so pure submodules stay light.

    Importing this package must not drag in the browser stack (browser_harness,
    chrome, httpx); only touching ``Agent`` or ``Browser`` does.
    """
    if name == "Agent":
        from .agent import Agent

        return Agent
    if name == "Browser":
        from .browser import Browser

        return Browser
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
