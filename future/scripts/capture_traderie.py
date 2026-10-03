"""Low-resource read-only capture and market analysis for Traderie D2R products."""

import argparse
import base64
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from jev_ultrafast.browser import Browser
from jev_ultrafast.traderie import (
    build_market_report,
    detect_guard,
    product_root_url,
)

VIEWS = (("trading", ""), ("recent", "/recent"))


def save_debug_artifacts(browser, folder, name, page):
    (folder / f"{name}.html").write_text(browser.evaluate("document.documentElement.outerHTML"), encoding="utf-8")
    (folder / f"{name}.txt").write_text(browser.evaluate("document.body.innerText"), encoding="utf-8")
    (folder / f"{name}.jpg").write_bytes(base64.b64decode(page.pop("screenshot")))
    (folder / f"{name}.observe.json").write_text(json.dumps(page, indent=2, ensure_ascii=False), encoding="utf-8")


def resolve_item_name(item_name_arg, trading_title):
    if item_name_arg and item_name_arg.strip():
        return item_name_arg.strip()
    if trading_title and " - Diablo II:" in trading_title:
        candidate = trading_title.split(" - Diablo II:")[0].strip()
        if candidate:
            return candidate
    raise SystemExit("Unable to determine Traderie item name; pass --item-name")


def capture_and_analyze(product_url, *, out=None, item_name=None, debug_artifacts=False, browser_cls=Browser):
    base = product_root_url(product_url)
    if not base:
        raise SystemExit("Not a Traderie D2R product URL")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = Path(out or f"artifacts/traderie/capture/{stamp}")
    folder.mkdir(parents=True, exist_ok=True)

    browser = browser_cls(base)
    try:
        pages = {}
        for name, suffix in VIEWS:
            url = base + suffix
            browser.navigate(url)
            time.sleep(2)
            page = browser.observe(screenshot=True)
            reason = detect_guard(page, browser)
            if reason:
                (folder / "guard.json").write_text(
                    json.dumps({"view": name, "url": page["url"], "reason": reason}, ensure_ascii=False),
                    encoding="utf-8",
                )
                raise SystemExit(f"BLOCKED: {reason}")
            # Keep page from observe() with full screenshot, actions, AX tree, and fetch full text for parsing
            full_text = browser.evaluate("document.body.innerText") or page.get("text", "")
            page["full_text"] = full_text
            pages[name] = page

        effective_item_name = resolve_item_name(item_name, pages["trading"].get("title", ""))
        observed_at = datetime.now(timezone.utc).isoformat()
        sources = {
            "trading": {"url": pages["trading"]["url"], "title": pages["trading"].get("title", "")},
            "recent_trades": {"url": pages["recent"]["url"], "title": pages["recent"].get("title", "")},
        }

        trading_text = pages["trading"].get("full_text") or pages["trading"]["text"]
        recent_text = pages["recent"].get("full_text") or pages["recent"]["text"]
        item_slug = base.rstrip("/").split("/")[-1]
        analysis_data, report_md = build_market_report(
            effective_item_name,
            item_slug,
            trading_text,
            recent_text,
            observed_at=observed_at,
            sources=sources,
        )
        (folder / "analysis.json").write_text(json.dumps(analysis_data, indent=2, ensure_ascii=False), encoding="utf-8")
        (folder / "analysis_report.md").write_text(report_md, encoding="utf-8")

        if debug_artifacts:
            for name, suffix in VIEWS:
                browser.navigate(base + suffix)
                time.sleep(1)
                dbg_page = browser.observe(screenshot=True)
                save_debug_artifacts(browser, folder, name, dbg_page)
                browser.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                time.sleep(1)
                save_debug_artifacts(browser, folder, f"{name}-bottom", browser.observe(screenshot=True))
            (folder / "captured_at.txt").write_text(observed_at, encoding="utf-8")

    finally:
        browser.close()

    print(folder)
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product_url", help="Traderie product URL")
    parser.add_argument("--out", help="Output directory")
    parser.add_argument("--item-name", help="Item name (derived from title if omitted)")
    parser.add_argument("--debug-artifacts", action="store_true", help="Preserve HTML/TXT/JPG/observe dumps")
    args = parser.parse_args()

    capture_and_analyze(
        args.product_url,
        out=args.out,
        item_name=args.item_name,
        debug_artifacts=args.debug_artifacts,
    )


if __name__ == "__main__":
    main()
