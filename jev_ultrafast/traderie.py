"""Traderie D2R helpers for goal construction and independent verification."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urlparse

TRADERIE_D2R_URL = "https://www.traderie.com/diablo2resurrected"
_TRADERIE_HOSTS = {"traderie.com", "www.traderie.com"}
_PRODUCT_PATH = re.compile(
    r"^/diablo2resurrected/product/(?P<slug>[^/?#]+)(?:/(?P<section>buying|recent|wiki|recipes))?/?$"
)
_WHITESPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^a-z0-9]+")
_RECENT_MARKERS = ("Sold For", "Closed For", "Traded For", "They Got", "Received")
_TRADING_MARKERS = ("Trading For", "Offering", "They Want This")
_NOISE_LINES = {
    "amount:",
    "apply this search",
    "community value:",
    "ethereal",
    "free",
    "game version",
    "ladder",
    "looking for",
    "make offers",
    "mode",
    "note: to make a trade click the listing and make an offer.",
    "platform",
    "posted: newest",
    "price history chart",
    "rarity",
    "recent trades",
    "region",
    "related items",
    "stats",
    "this value is updated by our expert team.",
    "trading",
    "user rating",
    "value",
    "wiki",
}


def build_goal(item_name):
    item = _clean_item_name(item_name)
    return (
        f'Find the Diablo II: Resurrected item "{item}" on Traderie. Open the matching product page. '
        "Stop only when the item page is visible and both the Trading and Recent Trades views for the same "
        "item can be checked. Do not contact sellers, message anyone, or make an offer."
    )


def product_root_url(url):
    parsed = urlparse(url)
    if parsed.netloc not in _TRADERIE_HOSTS:
        return None
    match = _PRODUCT_PATH.match(parsed.path)
    if not match:
        return None
    return f"{TRADERIE_D2R_URL}/product/{match.group('slug')}"


def verify_market(item_name, final_page, trading_page, recent_page, trading_text, recent_text):
    item = _clean_item_name(item_name)
    base_url = product_root_url(final_page["url"])
    tabs = _page_text(final_page)
    title = _WHITESPACE.sub(" ", final_page.get("title", "")).strip()
    trading_evidence = extract_market_evidence(trading_text, "trading")
    recent_evidence = extract_market_evidence(recent_text, "recent")
    checks = {
        "product_page": bool(base_url),
        "item_match": _matches_item(item, title) or _matches_item(item, tabs),
        "tabs_visible": "Trading" in tabs and "Recent Trades" in tabs,
        "trading_view": trading_page["url"] == base_url,
        "recent_view": bool(base_url) and recent_page["url"] == base_url + "/recent",
        "trading_summary": bool(trading_evidence),
        "recent_summary": bool(recent_evidence),
    }
    return {
        "passed": all(checks.values()),
        "item_name": item,
        "product_url": base_url,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "final_page": {
            "url": final_page["url"],
            "title": final_page.get("title", ""),
            "text_excerpt": tabs[:1200],
        },
        "trading": {
            "url": trading_page["url"],
            "summary": " | ".join(trading_evidence[:6]),
            "evidence": trading_evidence,
        },
        "recent_trades": {
            "url": recent_page["url"],
            "summary": " | ".join(recent_evidence[:6]),
            "evidence": recent_evidence,
        },
    }


def collect_market_snapshot(browser, item_name, final_page):
    base_url = product_root_url(final_page["url"])
    if not base_url:
        return {
            "passed": False,
            "item_name": _clean_item_name(item_name),
            "product_url": None,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "checks": {
                "product_page": False,
                "item_match": False,
                "tabs_visible": False,
                "trading_view": False,
                "recent_view": False,
                "trading_summary": False,
                "recent_summary": False,
            },
            "final_page": {
                "url": final_page["url"],
                "title": final_page.get("title", ""),
                "text_excerpt": _page_text(final_page)[:1200],
            },
            "trading": {"url": None, "summary": "", "evidence": []},
            "recent_trades": {"url": None, "summary": "", "evidence": []},
        }
    browser.navigate(base_url)
    trading_page = browser.observe(screenshot=False)
    trading_text = browser.evaluate("document.body.innerText")
    browser.navigate(base_url + "/recent")
    recent_page = browser.observe(screenshot=False)
    recent_text = browser.evaluate("document.body.innerText")
    return verify_market(item_name, final_page, trading_page, recent_page, trading_text, recent_text)


def extract_market_evidence(text, mode, *, limit=12):
    lines = _normalize_lines(text)
    anchor = _find_anchor(lines, mode)
    evidence = []
    seen = set()
    for line in lines[anchor:]:
        key = _NON_WORD.sub(" ", line.lower()).strip()
        if not key or key in _NOISE_LINES or key in seen:
            continue
        if len(line) == 1:
            continue
        evidence.append(line)
        seen.add(key)
        if len(evidence) >= limit:
            break
    return evidence


def _find_anchor(lines, mode):
    markers = _TRADING_MARKERS if mode == "trading" else _RECENT_MARKERS
    if mode == "recent":
        for index, line in enumerate(lines):
            if line == "Recent Trades":
                return min(index + 1, len(lines))
    for index, line in enumerate(lines):
        if any(marker in line for marker in markers):
            return max(index - 4, 0) if mode == "trading" else index
    for index, line in enumerate(lines):
        if line == "Stats":
            return min(index + 1, len(lines))
    return 0


def _normalize_lines(text):
    return [_WHITESPACE.sub(" ", line).strip() for line in text.splitlines() if line.strip()]


def _clean_item_name(item_name):
    item = _WHITESPACE.sub(" ", str(item_name)).strip()
    if not item:
        raise ValueError("Supply a Traderie item name")
    return item


def _matches_item(item_name, text):
    expected = _slug(item_name)
    actual = _slug(text)
    return bool(expected and actual and (expected in actual or actual in expected))


def _slug(text):
    return _NON_WORD.sub(" ", text.lower()).strip()


def _page_text(page):
    return _WHITESPACE.sub(" ", page.get("text", "")).strip()
