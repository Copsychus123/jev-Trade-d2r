"""Read-only probe of Traderie's home-page "Search All Stats" in the dedicated Chrome.

    uv run --group e2e python scripts/probe_stats.py [--redact YOUR_TRADERIE_NAME]

Needs the one-time login (`uv run python scripts/login.py`). It only reads: it opens the D2R home page with a few
query strings, fetches the property list and the game settings with the same GET the site's own front end makes,
and writes what it saw to artifacts/probe/ (git-ignored). It also stores two test fixtures in the repository:
tests/fixtures/home_stats.txt (page text with two stat filters on) and
extension/test/fixtures/properties.json (the property list, reduced to id/name/type/options/format).

The last lines of the output are the decisions the stats search is built on (see docs/design.md):
MAX_CONDITIONS, BASE_PARAM, FILTERS_SHOWN_CHECK and the quality properties.

It also answers one open question read-only: can the same filter address also be read as Recent Trades (成交)? It opens
the filtered home page, lists every link on it (so the tab's real address comes from the page, not a guess), then opens
"the same filter + that tab" and records the URL and the first 200 chars of each, plus the page's own words for a
completed trade ("They Give") versus an asking-price listing ("Make an Offer"). Result: report["recent_tab"] and
artifacts/probe/recent_tab.json.
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cdp import Panel, open_dedicated_tab  # noqa: E402

from jev_ultrafast.chrome import close_chrome  # noqa: E402
from jev_ultrafast.traderie.parsing import SIGN_IN_PROMPT, TRADE_MARKERS  # noqa: E402
from jev_ultrafast.traderie.site import TRADING_MARKERS as LISTING_MARKERS  # noqa: E402
from login import LOGGED_OUT_JS  # noqa: E402

HOME = "https://www.traderie.com/diablo2resurrected"
OUT = ROOT / "artifacts" / "probe"
TEXT_FIXTURE = ROOT / "tests" / "fixtures" / "home_stats.txt"
PROPERTIES_FIXTURE = ROOT / "extension" / "test" / "fixtures" / "properties.json"
FETCH_JSON = (ROOT / "src" / "jev_ultrafast" / "traderie" / "fetch_json.js").read_text(encoding="utf-8").strip()
QUALITY_NAME = re.compile(r"^(rare|magic|normal|quality)", re.I)
ITEM_LINE = re.compile(r"^\d+\s*X\s+(.+)$", re.I)
ABSURD_MIN = 99999
LINKS_JS = (
    "JSON.stringify([...document.querySelectorAll('a[href]')].map(a => "
    "({href: a.href, text: (a.innerText || '').trim()})))"
)
RECENT_LINK = re.compile(r"recent|成交|sold|trade history", re.I)


class Tab(Panel):
    async def settled_text(self, seconds: float = 40) -> tuple[str, str]:
        """(url, visible text) once the text stopped changing for two reads 1.5 s apart."""
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            await asyncio.sleep(1.5)
            state = await self.evaluate(
                "JSON.stringify({u: location.href, r: document.readyState, "
                "t: document.body ? document.body.innerText : ''})"
            )
            page = json.loads(state)
            if page["r"] == "complete" and page["t"] == last and len(page["t"]) > 200:
                return page["u"], page["t"]
            last = page["t"]
        raise TimeoutError("頁面沒有穩定下來")

    async def fetch_json(self, path: str) -> dict:
        return await self.evaluate(f"({FETCH_JSON})({json.dumps(path)})")


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")


def listing_count(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() in LISTING_MARKERS)


def item_names(text: str) -> list[str]:
    """The item line of each listing card: the nearest "N X <name>" line before its "Trading For" marker."""
    lines = [line.strip() for line in text.splitlines()]
    names = []
    for i, line in enumerate(lines):
        if line in LISTING_MARKERS:
            for j in range(i - 1, -1, -1):
                match = ITEM_LINE.match(lines[j])
                if match:
                    names.append(match.group(1))
                    break
    return names


def label_of(name: str) -> str:
    return re.sub(r"\{\{[^}]+\}\}", "X", name)


def param_changed_the_list(with_param: list[str], without_param: list[str]) -> bool:
    """Whether a filter address changed what is listed at all: the same page with and without the parameter.

    The cards' own names cannot prove a parameter filters by TYPE: `tags[]=Ring` lists unique rings too (Angelic
    Halo, Nagelring, Dwarf Star), and those names never say "ring". So the honest signal is that the listed set
    differs from the unfiltered page's - not that every name carries the word (which no ring page can satisfy).
    """
    return bool(with_param) and set(with_param) != set(without_param)


def keeps(final_url: str, expected: dict[str, str]) -> bool:
    got = dict(parse_qsl(urlparse(final_url).query))
    return all(got.get(key) == value for key, value in expected.items())


def merge_query(target: str, params: dict[str, str]) -> str:
    """`target` with `params` merged into its query string (the tab's own parameters are kept)."""
    parts = urlparse(target)
    query = dict(parse_qsl(parts.query))
    query.update(params)
    return urlunparse(parts._replace(query=urlencode(query)))


def trade_signs(text: str) -> dict:
    """Which of the page's own words are on it: completed-trade markers vs. asking-price listing markers."""
    lowered = text.lower()
    return {
        "trade_markers": [word for word in TRADE_MARKERS if word.lower() in lowered],
        "listing_markers": [word for word in LISTING_MARKERS if word.lower() in lowered],
        "sign_in_prompt": SIGN_IN_PROMPT.lower() in lowered,
    }


async def page_now(tab: Tab) -> tuple[str, str]:
    """(url, visible text) right now, without the settle/length gate (for pages too short to settle)."""
    state = json.loads(
        await tab.evaluate("JSON.stringify({u: location.href, t: document.body ? document.body.innerText : ''})")
    )
    return state["u"], state["t"]


async def settled_or_now(tab: Tab, name: str) -> tuple[str, str, bool]:
    """The settled page, or the current snapshot when it never settles; writes the text under `name`."""
    try:
        url, text = await tab.settled_text()
        settled = True
    except TimeoutError:
        url, text = await page_now(tab)
        settled = False
    (OUT / f"{name}.txt").write_text(text, encoding="utf-8")
    return url, text, settled


def pick_properties(props: list[dict]) -> tuple[dict, dict]:
    numbers = [p for p in props if p.get("type") == "number"]
    first = next((p for p in numbers if "faster cast" in p["name"].lower()), None)
    second = next((p for p in numbers if "all skills" in p["name"].lower() and p is not first), None)
    rest = [p for p in numbers if p is not first and p is not second]
    first = first or rest.pop(0)
    second = second or rest.pop(0)
    return first, second


async def visit(tab: Tab, name: str, query: str, expected: dict[str, str]) -> dict:
    await tab.goto(f"{HOME}{query}")
    url, text = await tab.settled_text()
    (OUT / f"page_{name}.txt").write_text(text, encoding="utf-8")
    return {"url": url, "text": text, "count": listing_count(text), "kept": keeps(url, expected)}


async def _recent_tab_controls(tab: Tab, query: str, expected: dict[str, str]) -> tuple[dict, str]:
    """No home-page Recent Trades tab exists. As labelled controls, first open the section suffix the site itself uses
    on product pages (/recent) on the same filter address, then a real product's Recent Trades page — the second shows
    what a trade record's own text looks like and that the marker words recognise it. Returns the result keys to record
    and the verdict the section-form control leads to."""
    updates: dict = {}
    control = f"{HOME}/recent{query}"
    updates["section_form_control_url"] = control
    await tab.goto(control)
    c_url, c_text, c_settled = await settled_or_now(tab, "recent_tab_section")
    signs = trade_signs(c_text)
    updates.update(
        section_form_settled=c_settled,
        section_form_final_url=c_url,
        section_form_kept_filter=keeps(c_url, expected),
        section_form_listings=listing_count(c_text),
        section_form_text_head=c_text[:200],
        section_form_trade_markers=signs["trade_markers"],
        section_form_listing_markers=signs["listing_markers"],
        section_form_sign_in_prompt=signs["sign_in_prompt"],
    )
    product_control = f"{HOME}/product/harlequin-crest/recent"
    updates["product_recent_control_url"] = product_control
    await tab.goto(product_control)
    p_url, p_text, p_settled = await settled_or_now(tab, "recent_tab_product")
    p_signs = trade_signs(p_text)
    updates.update(
        product_recent_settled=p_settled,
        product_recent_final_url=p_url,
        product_recent_listings=listing_count(p_text),
        product_recent_text_head=p_text[:200],
        product_recent_trade_markers=p_signs["trade_markers"],
        product_recent_listing_markers=p_signs["listing_markers"],
        product_recent_sign_in_prompt=p_signs["sign_in_prompt"],
    )
    if signs["trade_markers"] and not signs["listing_markers"]:
        verdict = "可用（與首頁 UI 無關）：/recent 寫法讀得到成交紀錄"
    else:
        verdict = (
            "不可用：帶 filter 的首頁沒有任何近期成交分頁的連結，其 /recent 寫法也讀不到東西；"
            "成交紀錄只在商品頁（見 product_recent_*，該頁字串才是成交紀錄）"
        )
    return updates, verdict


async def probe_recent_tab(tab: Tab, query: str, expected: dict[str, str]) -> dict:
    """Can the filtered home page also be read as Recent Trades? The tab's address is read off the page, never guessed.

    Opens the known-good filter address and records its URL and first 200 chars; lists every link on that page so the
    Recent Trades tab's real address shows up if the page has one; then opens "the same filter + that tab" and records
    the URL, the first 200 chars and which of the page's own words (trade records vs. asking-price listings) are there.
    """
    await tab.goto(f"{HOME}{query}")
    url, text, settled = await settled_or_now(tab, "recent_filter")
    links = json.loads(await tab.evaluate(LINKS_JS))
    candidates = [link for link in links if RECENT_LINK.search(f"{link['href']} {link['text']}")]
    result = {
        "filter_query": query,
        "filter_url": url,
        "filter_kept": keeps(url, expected),
        "filter_settled": settled,
        "filter_text_head": text[:200],
        "filter_listings": listing_count(text),
        "links_on_page": len(links),
        "recent_link_candidates": candidates[:20],
    }
    if not candidates:
        # No home-page tab exists: read the two labelled controls instead (see _recent_tab_controls).
        updates, verdict = await _recent_tab_controls(tab, query, expected)
        result.update(updates)
        result["conclusion"] = verdict
        return result
    home_path = urlparse(HOME).path
    tab_link = next(
        (link for link in candidates if urlparse(link["href"]).path.rstrip("/") in (home_path, "")),
        candidates[0],
    )
    combined = merge_query(tab_link["href"], dict(parse_qsl(urlparse(query).query)))
    result.update(tab_text=tab_link["text"], tab_href=tab_link["href"], combined_url_requested=combined)
    await tab.goto(combined)
    tab_url, tab_text, tab_settled = await settled_or_now(tab, "recent_tab")
    signs = trade_signs(tab_text)
    if signs["sign_in_prompt"]:
        verdict = "不可用：讀得到，但要登入才看得到成交紀錄"
    elif signs["trade_markers"] and not signs["listing_markers"]:
        verdict = "可用：同一組 filter 的近期成交分頁讀得到，且頁面是要成交紀錄"
    elif signs["trade_markers"]:
        verdict = "需人工確認：頁面同時有成交與掛單字串"
    else:
        verdict = "不可用：同一組 filter 的這頁仍是要價掛單，沒有成交紀錄字串"
    result.update(
        tab_url=tab_url,
        tab_settled=tab_settled,
        tab_kept_filter=keeps(tab_url, expected),
        tab_listings=listing_count(tab_text),
        tab_text_head=tab_text[:200],
        conclusion=verdict,
        **signs,
    )
    return result


def _print_recent_tab(recent_tab: dict) -> None:
    """What the recent-tab probe found, printed under the JSON report: its filter page, then whichever control ran."""
    print(f"\n近期成交分頁（帶 filter）：{recent_tab['conclusion']}")
    print(f"  filter URL: {recent_tab['filter_url']}")
    print(f"  filter 前 200 字: {recent_tab['filter_text_head']!r}")
    if recent_tab.get("tab_url"):
        print(f"  分頁 URL: {recent_tab['tab_url']}")
        print(f"  分頁前 200 字: {recent_tab['tab_text_head']!r}")
    if recent_tab.get("section_form_final_url"):
        print(f"  /recent 控制 URL: {recent_tab['section_form_final_url']}")
        print(f"  /recent 控制前 200 字: {recent_tab['section_form_text_head']!r}")
        print(
            "  /recent 控制字串: "
            f"成交={recent_tab['section_form_trade_markers']} "
            f"掛單={recent_tab['section_form_listing_markers']} "
            f"要登入={recent_tab['section_form_sign_in_prompt']}"
        )
    if recent_tab.get("product_recent_final_url"):
        print(f"  商品頁成交控制 URL: {recent_tab['product_recent_final_url']}")
        print(f"  商品頁成交控制前 200 字: {recent_tab['product_recent_text_head']!r}")
        print(
            "  商品頁成交控制字串: "
            f"成交={recent_tab['product_recent_trade_markers']} "
            f"掛單={recent_tab['product_recent_listing_markers']} "
            f"要登入={recent_tab['product_recent_sign_in_prompt']}"
        )


def _write_properties_fixture(props: list[dict]) -> None:
    """The property list reduced to the fields the extension keeps, stored as a test fixture."""
    kept = ("id", "name", "type", "options", "format")
    reduced = [{k: p.get(k) for k in kept} for p in props]
    PROPERTIES_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    PROPERTIES_FIXTURE.write_text(
        json.dumps({"properties": reduced}, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def _decisions(report: dict, rarity: dict | None, quality_values: dict[str, str]) -> dict:
    """The decisions the stats search is built on, from what the probe pages showed. An absurd Min on the second
    property: "and" gives nothing, "or" still lists the first property's cards."""
    counts = report["counts"]
    if counts["A"] > 0:
        or_semantics = counts["AX"] > 0
    else:
        or_semantics = True  # inconclusive: one condition at a time is the safe reading
    quality_counts = {k: counts.get(f"Q_{k}") for k in quality_values}
    return {
        "MAX_CONDITIONS": 1 if or_semantics else 8,
        "BASE_PARAM": "search" if report["search_narrows"] else None,
        "FILTERS_SHOWN_CHECK": bool(report["labels_shown"]["A"]),
        "QUALITY_PARAM": "prop_Rarity" if rarity and all(quality_counts.values()) else None,
        "QUALITY_VALUES": quality_values if rarity else None,
        "TAG_PARAM_WORKS": report["tags_narrow"],
        "AB_over_max": counts["AB"] > max(counts["A"], counts["B"]),
    }


async def probe(redact: str | None) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        async with open_dedicated_tab(Tab) as tab:
            await tab.goto(HOME)
            url, text = await tab.settled_text()
            (OUT / "home.txt").write_text(text, encoding="utf-8")
            (OUT / "home.url").write_text(url, encoding="utf-8")
            report: dict = {"logged_in": not await tab.evaluate(LOGGED_OUT_JS), "home_url": url}
            if "just a moment" in text.lower():
                raise SystemExit("Cloudflare 擋住了首頁。請先執行 uv run python scripts/login.py，再試一次")

            games = await tab.fetch_json("/api/games?game=diablo2resurrected")
            write_json(OUT / "games.json", games)
            features = []
            if isinstance(games.get("body"), dict):
                body = games["body"]
                found = body.get("games", body)
                features = (found.get("features") if isinstance(found, dict) else None) or []
            report["games_status"] = games["status"]
            report["stats_flag"] = "LISTINGS:STATS" in features

            props_reply = await tab.fetch_json("/api/diablo2resurrected/properties?global=true")
            write_json(OUT / "properties.json", props_reply)
            report["properties_status"] = props_reply["status"]
            props = props_reply["body"].get("properties", []) if isinstance(props_reply.get("body"), dict) else []
            report["properties_count"] = len(props)
            if props_reply["status"] != 200 or not props:
                report["decision"] = "STOP: no property list"
                write_json(OUT / "report.json", report)
                print(json.dumps(report, ensure_ascii=False, indent=1))
                return 1

            _write_properties_fixture(props)
            p1, p2 = pick_properties(props)
            report["chosen"] = [p1["name"], p2["name"]]
            k1, k2 = f"prop_{p1['id']}Min", f"prop_{p2['id']}Min"
            rarity = next((p for p in props if p["name"] == "Rarity" and p.get("type") == "string"), None)
            quality_props = [p["name"] for p in props if QUALITY_NAME.match(label_of(p["name"]).lstrip("+ "))]
            pages = {
                "HOME": await visit(tab, "HOME", "", {}),
                "A": await visit(tab, "A", f"?{k1}=1", {k1: "1"}),
                "B": await visit(tab, "B", f"?{k2}=1", {k2: "1"}),
                "AB": await visit(tab, "AB", f"?{k1}=1&{k2}=1", {k1: "1", k2: "1"}),
                "AX": await visit(tab, "AX", f"?{k1}=1&{k2}={ABSURD_MIN}", {k1: "1", k2: str(ABSURD_MIN)}),
                "S": await visit(tab, "S", f"?search=Ring&{k1}=1", {"search": "Ring", k1: "1"}),
                "S_ring": await visit(tab, "S_ring", "?search=Ring", {"search": "Ring"}),
                "S_amulet": await visit(tab, "S_amulet", "?search=Caster%20Amulet", {"search": "Caster Amulet"}),
                "T_ring": await visit(tab, "T_ring", "?tags[]=Ring", {"tags[]": "Ring"}),
            }
            quality_values = {"rare": "rare", "magic": "magic", "normal": "normal,superior"}
            if rarity:
                for key, value in quality_values.items():
                    pages[f"Q_{key}"] = await visit(tab, f"Q_{key}", f"?prop_Rarity={value}", {"prop_Rarity": value})
                pages["T_ring_rare"] = await visit(
                    tab, "T_ring_rare", "?tags[]=Ring&prop_Rarity=rare", {"tags[]": "Ring", "prop_Rarity": "rare"}
                )
            names = {key: item_names(page["text"]) for key, page in pages.items()}
            recent_tab = await probe_recent_tab(tab, f"?{k1}=1", {k1: "1"})

            def narrows(key: str, word: str) -> bool:
                return bool(names[key]) and all(word in n.lower() for n in names[key])

            report.update(
                counts={k: v["count"] for k, v in pages.items()},
                url_kept={k: v["kept"] for k, v in pages.items()},
                labels_shown={"A": label_of(p1["name"]) in pages["A"]["text"]},
                item_names={k: sorted(set(v))[:8] for k, v in names.items()},
                search_narrows=narrows("S_ring", "ring") or narrows("S_amulet", "amulet"),
                tags_narrow=param_changed_the_list(names["T_ring"], names["HOME"]),
                rarity_property=None if not rarity else {"id": rarity["id"], "options": rarity.get("options")},
                quality_props=quality_props,
                recent_tab=recent_tab,
            )

            report["decisions"] = _decisions(report, rarity, quality_values)

            sample = pages["A"]["text"]
            if redact:
                sample = sample.replace(redact, "user")
            TEXT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
            TEXT_FIXTURE.write_text(sample, encoding="utf-8")
            write_json(OUT / "report.json", report)
            write_json(OUT / "recent_tab.json", recent_tab)
            print(json.dumps(report, ensure_ascii=False, indent=1))
            _print_recent_tab(recent_tab)
            return 0
    finally:
        close_chrome()  # stops only a Chrome this run started; a Chrome that was already running is left alone


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--redact", help="your Traderie user name: replaced by 'user' in the saved page text")
    args = parser.parse_args()
    return asyncio.run(probe(args.redact))


if __name__ == "__main__":
    sys.exit(main())
