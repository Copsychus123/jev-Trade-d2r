"""Traderie cookie extraction, normalization, and CDP injection specs."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from jev_ultrafast.config import Settings

COOKIE_ORIGIN = "https://www.traderie.com/"

COOKIE_ATTRS = {
    "domain",
    "expires",
    "httponly",
    "max-age",
    "path",
    "partitioned",
    "priority",
    "samesite",
    "secure",
}


def parse_cookie_pairs(raw: str) -> list[tuple[str, str]]:
    """Parse name=value pairs from a semicolon-separated cookie header string."""
    if not raw or not raw.strip():
        return []
    pairs: list[tuple[str, str]] = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        name = name.strip()
        if not name or name.lower() in COOKIE_ATTRS:
            continue
        pairs.append((name, value.strip()))
    if not pairs:
        raise ValueError("TRADERIE_COOKIE must contain at least one name=value pair")
    return pairs


def cookie_specs(settings: Settings) -> list[dict[str, Any]]:
    """Generate Network.setCookie parameter dictionaries from settings."""
    pairs = parse_cookie_pairs(settings.traderie_cookie)
    specs = [{"url": COOKIE_ORIGIN, "name": name, "value": value} for name, value in pairs]
    if settings.traderie_session_token:
        name = settings.traderie_session_cookie_name or "session"
        specs.append({"url": COOKIE_ORIGIN, "name": name, "value": settings.traderie_session_token})
    return specs
