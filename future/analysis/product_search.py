"""Product-page search by item name (legacy, not part of the current flow)."""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote_plus

from jev_ultrafast.traderie.site import TRADERIE_D2R_URL, clean_item_name, detect_guard, product_root_url
from jev_ultrafast.traderie.verification import NON_WORD, WHITESPACE, matches_item, read_settled_page, slug

def page_text(page: dict) -> str:
    return WHITESPACE.sub(" ", page.get("text", "")).strip()


SEARCH_PRODUCT_LINKS_SCRIPT = """(() => {
  const out = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="/diablo2resurrected/product/"]')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      const url = new URL(href, location.href).href;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    } catch {
      continue;
    }
  }
  return out;
})()"""



def _item_slug(item_name: str) -> str:
    return NON_WORD.sub("-", item_name.lower()).strip("-")


def _rank_product_urls(item_name: str, product_urls: list[str]) -> list[str]:
    item = clean_item_name(item_name)
    expected_slug = _item_slug(item)
    expected_tokens = set(slug(item).split())
    ranked: list[tuple[tuple[int, int, int, int, int], str]] = []
    seen: set[str] = set()
    for index, url in enumerate(product_urls):
        root = product_root_url(url)
        if not root or root in seen:
            continue
        seen.add(root)
        candidate_slug = root.rstrip("/").split("/")[-1]
        normalized_candidate_slug = _item_slug(candidate_slug)
        candidate_tokens = set(candidate_slug.replace("-", " ").split())
        overlap = len(expected_tokens & candidate_tokens)
        score = (
            int(normalized_candidate_slug == expected_slug),
            overlap,
            int(
                normalized_candidate_slug.startswith(expected_slug)
                or expected_slug.startswith(normalized_candidate_slug)
            ),
            -abs(len(normalized_candidate_slug) - len(expected_slug)),
            -index,
        )
        ranked.append((score, root))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [root for _score, root in ranked]


def resolve_product_page(browser: Any, item_name: str) -> dict[str, Any]:
    """Resolve a Traderie product page from item name without model inference."""
    item = clean_item_name(item_name)
    direct_url = f"{TRADERIE_D2R_URL}/product/{_item_slug(item)}"

    browser.navigate(direct_url)
    time.sleep(2)
    direct_page = read_settled_page(browser)
    reason = detect_guard(direct_page, browser)
    if reason:
        raise RuntimeError(reason)

    if product_root_url(direct_page["url"]) and (
        matches_item(item, direct_page.get("title", "")) or matches_item(item, page_text(direct_page))
    ):
        return direct_page

    search_url = f"{TRADERIE_D2R_URL}/search?query={quote_plus(item)}"
    browser.navigate(search_url)
    time.sleep(2)
    search_page = read_settled_page(browser)
    reason = detect_guard(search_page, browser)
    if reason:
        raise RuntimeError(reason)

    fallback_page = search_page if product_root_url(search_page["url"]) else direct_page
    if product_root_url(search_page["url"]) and (
        matches_item(item, search_page.get("title", "")) or matches_item(item, page_text(search_page))
    ):
        return search_page

    raw_links = browser.evaluate(SEARCH_PRODUCT_LINKS_SCRIPT)
    links = raw_links if isinstance(raw_links, list) else []
    for index, product_url in enumerate(_rank_product_urls(item, links)):
        browser.navigate(product_url)
        time.sleep(2)
        candidate_page = read_settled_page(browser)
        reason = detect_guard(candidate_page, browser)
        if reason:
            raise RuntimeError(reason)
        if index == 0:
            fallback_page = candidate_page
        if product_root_url(candidate_page["url"]) and (
            matches_item(item, candidate_page.get("title", "")) or matches_item(item, page_text(candidate_page))
        ):
            return candidate_page

    if product_root_url(fallback_page["url"]):
        return fallback_page
    raise ValueError(f'Unable to resolve Traderie product page for "{item}"')
