"""Traderie D2R URL normalization, goal construction, and challenge guard detection."""

from __future__ import annotations

import re
from urllib.parse import urlparse

TRADERIE_D2R_URL = "https://www.traderie.com/diablo2resurrected"
TRADERIE_HOSTS = {"traderie.com", "www.traderie.com"}
PRODUCT_PATH = re.compile(
    r"^/diablo2resurrected/product/(?P<slug>[^/?#]+)(?:/(?P<section>buying|recent|wiki|recipes))?/?$"
)
SEARCH_PATH = re.compile(r"^/diablo2resurrected/(?:search|products)/?$")
ROOT_PATH = "/diablo2resurrected"
WHITESPACE = re.compile(r"\s+")
LOAD_MORE_LIMIT = 2
MAX_LOAD_MORE = 5

CHALLENGE_FRAMES = (
    'iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],'
    'iframe[src*="google.com/recaptcha/api2/anchor"],iframe[src*="google.com/recaptcha/api2/bframe"]'
)


def clean_item_name(item_name: str) -> str:
    """Normalize item name whitespace and ensure non-empty."""
    item = WHITESPACE.sub(" ", str(item_name)).strip()
    if not item:
        raise ValueError("Supply a Traderie item name")
    return item


def validate_load_more(value) -> int:
    """The number of Load More presses per view: an integer from 0 to MAX_LOAD_MORE."""
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_LOAD_MORE:
        raise ValueError(f"載入更多次數必須是 0 到 {MAX_LOAD_MORE} 的整數")
    return value

LOAD_MORE_LABEL = "Load More"


def phase_finish_rule(load_more: int) -> tuple[str, int] | None:
    """(action label, count) after which the Agent ends a phase by itself; None when no press is wanted."""
    return (LOAD_MORE_LABEL, load_more) if load_more else None



def build_goal(item_name: str, load_more: int = LOAD_MORE_LIMIT) -> str:
    """Construct natural-language goal for browser agent."""
    item = clean_item_name(item_name)
    load_more = validate_load_more(load_more)
    if load_more:
        phases = (
            "Phase A (Trading): on the item's Trading view, repeat this cycle: use the Scroll to bottom of page "
            "control, then press Load More. action_counts shows how many times each action was already executed "
            f"in the current phase. The program itself ends the phase after {load_more} Load More presses; "
            "choose DONE only when you have scrolled to the bottom and no Load More button is visible. "
            "Phase B (Recent Trades): click the same item's Recent Trades tab, then repeat the same cycle with "
            "the same rule. "
        )
    else:
        phases = (
            "Phase A (Trading): choose DONE as soon as the item's Trading view is open; do not press Load More. "
            "Phase B (Recent Trades): click the same item's Recent Trades tab, then choose DONE once that view "
            "is open; do not press Load More. "
        )
    return (
        f'Find the Diablo II: Resurrected item "{item}" on Traderie using the site search box, '
        "and open its product page. "
        "If a pop-up or dialog covers the page (for example patch notes), close it with its close control "
        "before doing anything else. "
        + phases
        + "Do not contact sellers, message anyone, make an offer, or leave Traderie D2R product/search pages."
    )


def product_root_url(url: str) -> str | None:
    """Normalize Traderie product URLs to their canonical root path."""
    parsed = urlparse(url)
    if parsed.netloc not in TRADERIE_HOSTS:
        return None
    match = PRODUCT_PATH.match(parsed.path)
    if not match:
        return None
    return f"{TRADERIE_D2R_URL}/product/{match.group('slug')}"



def traderie_scope_reason(url: str) -> str | None:
    """Return a blocking reason when URL leaves allowed Traderie D2R browsing scope."""
    parsed = urlparse(url or "")
    host = parsed.netloc.lower()
    if host not in TRADERIE_HOSTS:
        return f"離開 Traderie：{host or '(unknown host)'}"

    path = parsed.path or "/"
    if "/login" in path or "/signup" in path:
        return "需要登入：請先執行 uv run python scripts/login_traderie.py 登入一次"
    if path.rstrip("/") == ROOT_PATH:
        return None
    if PRODUCT_PATH.match(path) or SEARCH_PATH.match(path):
        return None
    return f"超出 Traderie D2R 範圍：{path}"

def detect_guard(page: dict, browser) -> str | None:
    """Return a reason when the page is challenge, login, or off-scope. Never interacts."""
    reason = traderie_scope_reason(page["url"])
    if reason:
        return reason
    text = page.get("text", "").lower()
    if "just a moment" in page.get("title", "").lower() or "verify you are human" in text or "captcha" in text:
        return "防護頁/驗證碼"
    if browser.evaluate(f"!!document.querySelector({CHALLENGE_FRAMES!r})"):
        return "防護頁/驗證碼"
    return None
