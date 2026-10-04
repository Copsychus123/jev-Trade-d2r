"""Page reading and item-name matching used by the controller."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

NON_WORD = re.compile(r"[^a-z0-9]+")
WHITESPACE = re.compile(r"\s+")


def slug(text: str) -> str:
    return NON_WORD.sub(" ", text.lower()).strip()


def matches_item(item_name: str, text: str) -> bool:
    expected = slug(item_name)
    actual = slug(text)
    return bool(expected and actual and (expected in actual or actual in expected))


SETTLED_PAGE = Path(__file__).with_name("settled_page.js").read_text(encoding="utf-8").strip()


def read_settled_page(browser: Any, *, quiet_ms: int = 500, timeout_ms: int = 5000) -> dict[str, Any]:
    """Read url/title/text after the page settles, without Jev observation."""
    result = browser.evaluate(f"{SETTLED_PAGE}({quiet_ms}, {timeout_ms})", await_promise=True)
    if not isinstance(result, dict) or "url" not in result:
        raise TimeoutError("Settled page read did not return url/title/text")
    return result
