"""Page reading and item-name matching used by the controller."""

from __future__ import annotations

import re
from typing import Any

NON_WORD = re.compile(r"[^a-z0-9]+")
WHITESPACE = re.compile(r"\s+")


def slug(text: str) -> str:
    return NON_WORD.sub(" ", text.lower()).strip()


def matches_item(item_name: str, text: str) -> bool:
    expected = slug(item_name)
    actual = slug(text)
    return bool(expected and actual and (expected in actual or actual in expected))


_SETTLED_PAGE_TEMPLATE = """(() => new Promise(resolve => {
  const finish = (timedOut) => {
    if (observer) observer.disconnect();
    resolve({url: location.href, title: document.title, text: document.body?.innerText ?? "", settled: !timedOut});
  };
  let observer = null, timer = null, done = false;
  const complete = () => { if (!done) { done = true; clearTimeout(timer); clearTimeout(cap); finish(false); } };
  const cap = setTimeout(() => { if (!done) { done = true; clearTimeout(timer); finish(true); } }, TIMEOUT_MS);
  const arm = () => { clearTimeout(timer); timer = setTimeout(complete, QUIET_MS); };
  let last = document.body?.innerText ?? "";
  try {
    // Only changes of the visible text restart the quiet period; ad or script churn that adds no text does not.
    observer = new MutationObserver(() => {
      const now = document.body?.innerText ?? "";
      if (now !== last) { last = now; arm(); }
    });
    observer.observe(document.body ?? document.documentElement, {childList: true, subtree: true, characterData: true});
  } catch { observer = null; }
  arm();
}))()"""


def read_settled_page(browser: Any, *, quiet_ms: int = 500, timeout_ms: int = 5000) -> dict[str, Any]:
    """Read url/title/text after the page settles, without Jev observation."""
    expression = _SETTLED_PAGE_TEMPLATE.replace("QUIET_MS", repr(quiet_ms)).replace(
        "TIMEOUT_MS", repr(timeout_ms)
    )
    result = browser.evaluate(expression, await_promise=True)
    if not isinstance(result, dict) or "url" not in result:
        raise TimeoutError("Settled page read did not return url/title/text")
    return result
