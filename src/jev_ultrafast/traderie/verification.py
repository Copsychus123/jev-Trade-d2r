"""Page reading and item-name matching used by the controller."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

NON_WORD = re.compile(r"[^a-z0-9]+")


def words(text: str) -> str:
    """The text as lower-case words: every run of non-alphanumeric characters becomes one space.
    Whole-word matching compares these strings, so 'Ist' is not found inside 'listing'."""
    return NON_WORD.sub(" ", text.lower()).strip()


def title_has_words(title: str) -> bool:
    """True when the page title says anything at all; a title-less page falls back to its visible text."""
    return bool(words(title))


def matches_item(item_name: str, text: str) -> bool:
    """Whole-word match: 'Ist' must not be found inside 'listing'."""
    expected = words(item_name)
    actual = words(text)
    if not (expected and actual):
        return False
    return f" {expected} " in f" {actual} " or f" {actual} " in f" {expected} "


def page_matches_item(item_name: str, title: str, text: str) -> bool:
    """Is this page the item's page? The title decides when the page has one; the visible text is only a fallback for
    a page without a title, because the text of any product page mentions other items too."""
    return matches_item(item_name, title if title_has_words(title) else text)


SETTLED_PAGE = Path(__file__).with_name("settled_page.js").read_text(encoding="utf-8").strip()


def read_settled_page(browser: Any, *, quiet_ms: int = 500, timeout_ms: int = 5000) -> dict[str, Any]:
    """Read url/title/text after the page settles, without Jev observation."""
    result = browser.evaluate(f"{SETTLED_PAGE}({quiet_ms}, {timeout_ms})", await_promise=True)
    if not isinstance(result, dict) or "url" not in result:
        raise TimeoutError("Settled page read did not return url/title/text")
    return result
