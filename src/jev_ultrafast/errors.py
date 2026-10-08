"""Exceptions shared by the browser layer and the Traderie controller (kept apart to avoid an import cycle)."""


class StalePage(ValueError):
    """A decision no longer refers to the observed page."""
