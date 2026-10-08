"""Read-only probe of Traderie's home-page "Search All Stats" in the dedicated Chrome.

    uv run --group e2e python scripts/probe_stats.py [--redact YOUR_TRADERIE_NAME]

Needs the one-time login (`uv run python scripts/login.py`). It only reads: it opens the D2R home page with a few
query strings, fetches the property list and the game settings with the same GET the site's own front end makes,
and writes what it saw to artifacts/probe/ (git-ignored). It also stores two test fixtures in the repository:
tests/fixtures/home_stats.txt (page text with two stat filters on) and
extension/test/fixtures/properties.json (the property list, reduced to id/name/type/options/format).

The last lines of the output are the decisions the stats search is built on (see docs/design.md):
MAX_CONDITIONS, BASE_PARAM, FILTERS_SHOWN_CHECK and the quality properties.
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cdp import Panel, open_tab  # noqa: E402

from jev_ultrafast.chrome import CHROME_PORT, chrome_mode, close_chrome, ensure_chrome  # noqa: E402

HOME = "https://www.traderie.com/diablo2resurrected"
OUT = ROOT / "artifacts" / "probe"
TEXT_FIXTURE = ROOT / "tests" / "fixtures" / "home_stats.txt"
PROPERTIES_FIXTURE = ROOT / "extension" / "test" / "fixtures" / "properties.json"
FETCH_JSON = (ROOT / "src" / "jev_ultrafast" / "traderie" / "fetch_json.js").read_text(encoding="utf-8").strip()
LOGGED_OUT_JS = (
    "[...document.querySelectorAll('a,button')].some(e => (e.innerText || '').trim().toLowerCase() === 'log in')"
)
QUALITY_NAME = re.compile(r"^(rare|magic|normal|quality)", re.I)
ITEM_LINE = re.compile(r"^\d+\s*X\s+(.+)$", re.I)
ABSURD_MIN = 99999


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


def listing_count(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() in ("Trading For", "Make an Offer"))


def item_names(text: str) -> list[str]:
    """The item line of each listing card: the nearest "N X <name>" line before its "Trading For" marker."""
    lines = [line.strip() for line in text.splitlines()]
    names = []
    for i, line in enumerate(lines):
        if line in ("Trading For", "Make an Offer"):
            for j in range(i - 1, -1, -1):
                match = ITEM_LINE.match(lines[j])
                if match:
                    names.append(match.group(1))
                    break
    return names


def label_of(name: str) -> str:
    return re.sub(r"\{\{[^}]+\}\}", "X", name)


def keeps(final_url: str, expected: dict[str, str]) -> bool:
    got = dict(parse_qsl(urlparse(final_url).query))
    return all(got.get(key) == value for key, value in expected.items())


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


async def probe(redact: str | None) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if chrome_mode() == "existing":
        raise SystemExit("這個工具要用專用 Chrome：請不要設 JEV_CHROME=existing")
    ensure_chrome()
    try:
        async with open_tab(CHROME_PORT, Tab) as tab:
            await tab.hide_headless_label()
            await tab.goto(HOME)
            url, text = await tab.settled_text()
            (OUT / "home.txt").write_text(text, encoding="utf-8")
            (OUT / "home.url").write_text(url, encoding="utf-8")
            report: dict = {"logged_in": not await tab.evaluate(LOGGED_OUT_JS), "home_url": url}
            if "just a moment" in text.lower():
                raise SystemExit("Cloudflare 擋住了首頁。請先執行 uv run python scripts/login.py，再試一次")

            games = await tab.fetch_json("/api/games?game=diablo2resurrected")
            (OUT / "games.json").write_text(json.dumps(games, ensure_ascii=False, indent=1), encoding="utf-8")
            features = []
            if isinstance(games.get("body"), dict):
                body = games["body"]
                found = body.get("games", body)
                features = (found.get("features") if isinstance(found, dict) else None) or []
            report["games_status"] = games["status"]
            report["stats_flag"] = "LISTINGS:STATS" in features

            props_reply = await tab.fetch_json("/api/diablo2resurrected/properties?global=true")
            (OUT / "properties.json").write_text(
                json.dumps(props_reply, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            report["properties_status"] = props_reply["status"]
            props = props_reply["body"].get("properties", []) if isinstance(props_reply.get("body"), dict) else []
            report["properties_count"] = len(props)
            if props_reply["status"] != 200 or not props:
                report["decision"] = "STOP: no property list"
                (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
                print(json.dumps(report, ensure_ascii=False, indent=1))
                return 1

            kept_fields = ("id", "name", "type", "options", "format")
            reduced = [{k: p.get(k) for k in kept_fields} for p in props]
            PROPERTIES_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
            PROPERTIES_FIXTURE.write_text(
                json.dumps({"properties": reduced}, ensure_ascii=False, indent=1), encoding="utf-8"
            )
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

            def narrows(key: str, word: str) -> bool:
                return bool(names[key]) and all(word in n.lower() for n in names[key])

            report.update(
                counts={k: v["count"] for k, v in pages.items()},
                url_kept={k: v["kept"] for k, v in pages.items()},
                labels_shown={"A": label_of(p1["name"]) in pages["A"]["text"]},
                item_names={k: sorted(set(v))[:8] for k, v in names.items()},
                search_narrows=narrows("S_ring", "ring") or narrows("S_amulet", "amulet"),
                tags_narrow=narrows("T_ring", "ring"),
                rarity_property=None if not rarity else {"id": rarity["id"], "options": rarity.get("options")},
                quality_props=quality_props,
            )

            # An absurd Min on the second property: "and" gives nothing, "or" still lists the first property's cards.
            counts = report["counts"]
            if counts["A"] > 0:
                or_semantics = counts["AX"] > 0
            else:
                or_semantics = True  # inconclusive: one condition at a time is the safe reading
            quality_counts = {k: counts.get(f"Q_{k}") for k in quality_values}
            report["decisions"] = {
                "MAX_CONDITIONS": 1 if or_semantics else 8,
                "BASE_PARAM": "search" if report["search_narrows"] else None,
                "FILTERS_SHOWN_CHECK": bool(report["labels_shown"]["A"]),
                "QUALITY_PARAM": "prop_Rarity" if rarity and all(quality_counts.values()) else None,
                "QUALITY_VALUES": quality_values if rarity else None,
                "TAG_PARAM_WORKS": report["tags_narrow"],
                "AB_over_max": counts["AB"] > max(counts["A"], counts["B"]),
            }

            sample = pages["A"]["text"]
            if redact:
                sample = sample.replace(redact, "user")
            TEXT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
            TEXT_FIXTURE.write_text(sample, encoding="utf-8")
            (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False, indent=1))
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
