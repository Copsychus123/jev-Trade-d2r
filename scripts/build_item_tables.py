"""Build the item tables used by the extension: uv run python scripts/build_item_tables.py [--out PATH]

Opens the dedicated Chrome (Traderie blocks plain downloads), then reads
  1. Traderie D2R product lists  -> English name -> product slug (+ category)
  2. d2r.world zh-TW item pages  -> Chinese name -> English name
and writes extension/src/traderie/data/items.json plus a report of what did not match.
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "extension" / "src" / "traderie" / "data" / "items.json"
PAIRS_CACHE = ROOT / "artifacts" / "item_pairs.json"
PROFILE = ROOT / ".tmp-jev-chrome"
PORT = 9357
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
TRADERIE = "https://traderie.com/diablo2resurrected"
D2R_WORLD = "https://d2r.world/zh-TW/info/item"
TRADERIE_CATEGORIES = ["uniques", "runes", "runewords", "sets", "base", "crafted", "charms", "gems", "misc"]
D2R_CATEGORIES = ["unique", "sets", "runes", "runewords", "base", "crafted", "magic"]
# Categories that hold the plain item types a quality word ("Rare", "Magic", "White") can be dropped from
# (Traderie files Ring, Amulet and Jewel under misc).
BASE_CATEGORIES = {"base", "charms", "misc"}
PAGE_SETTLE_SECONDS = 1.0
MIN_GAME_NAME_CHARS = 4  # shorter English strings on d2r.world are page furniture ("Q", "Pal"), not item names
# The type line of a magic/rare item in a Traditional Chinese client. d2r.world only shows these as plural headings
# ("Rings"), so the pair reader misses them; they are what a screenshot of a rare item can be matched on.
EXTRA_ZH = {
    "戒指": "Ring",
    "護身符": "Amulet",
    "珠寶": "Jewel",
    "小型咒符": "Small Charm",
    "大型咒符": "Large Charm",
    "特大咒符": "Grand Charm",
    "腰帶": "Belt",
    "頭環": "Circlet",
}

CARDS = """(() => [...document.querySelectorAll('a[href*="/diablo2resurrected/product/"]')].map(a => {
  const box = a.closest('.item-container-img-icon') || a.parentElement;
  const name = box && box.querySelector('.item-name');
  const variant = box && box.querySelector('.desktop-variant-name');
  return [a.getAttribute('href'), name ? name.innerText.trim() : (a.querySelector('img') || {}).alt || '',
          variant ? variant.innerText.replace(/\\u00a0/g, ' ').trim() : ''];
}))()"""
SUBLINKS = """(cat) => [...new Set([...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
  .filter(h => h && h.includes('/info/item/' + cat + '/')).map(h => h.split('#')[0]))]"""
PAGE_TEXT = "document.body.innerText"

PRIVATE_USE = re.compile(r"[\ue000-\uf8ff]")
CJK = re.compile(r"[\u3400-\u9fff]")
LATIN_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9'’\- .,:]*$")


def normalize(name: str) -> str:
    """Same idea as the extension: lower case, no accents or apostrophes, words only, no leading 'the'."""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"['’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text[4:] if text.startswith("the ") else text


def chrome_binary() -> str:
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    raise SystemExit("找不到 Chrome")


def ensure_chrome() -> None:
    def up() -> bool:
        try:
            httpx.get(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
            return True
        except Exception:
            return False

    if up():
        return
    subprocess.Popen(
        [
            chrome_binary(),
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={PROFILE}",
            "--no-first-run",
            "--window-position=-2000,0",
            "--window-size=1280,900",
            "about:blank",
        ]
    )
    for _ in range(60):
        time.sleep(0.5)
        if up():
            return
    raise SystemExit("Chrome 沒有啟動")


class Tab:
    async def __aenter__(self):
        ensure_chrome()
        target = httpx.put(f"http://127.0.0.1:{PORT}/json/new?about:blank", timeout=10).json()
        self.id = target["id"]
        self.ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=None)
        self.n = 0
        return self

    async def __aexit__(self, *exc):
        await self.ws.close()
        httpx.get(f"http://127.0.0.1:{PORT}/json/close/{self.id}")

    async def send(self, method, params=None):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") == self.n:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message["result"]

    async def evaluate(self, expression):
        result = await self.send(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}
        )
        return result["result"].get("value")

    async def goto(self, url):
        await self.send("Page.navigate", {"url": url})

    async def wait_for(self, expression, seconds=25):
        """Poll until `expression` is truthy and then stays the same for PAGE_SETTLE_SECONDS."""
        deadline = time.time() + seconds
        last = None
        while time.time() < deadline:
            await asyncio.sleep(PAGE_SETTLE_SECONDS)
            value = await self.evaluate(expression)
            if value and value == last:
                return value
            last = value
        return last


async def read_traderie(tab: Tab) -> list[dict]:
    products: dict[str, dict] = {}
    for category in TRADERIE_CATEGORIES:
        page, empty_pages = 0, 0
        while empty_pages < 2:
            url = f"{TRADERIE}/products/{category}" + (f"?page={page}" if page else "")
            await tab.goto(url)
            await tab.wait_for("document.querySelectorAll('a[href*=\"/diablo2resurrected/product/\"]').length")
            cards = await tab.evaluate(CARDS) or []
            new = 0
            for href, name, variant in cards:
                slug = href.rstrip("/").rsplit("/", 1)[-1]
                if slug and name and slug not in products:
                    products[slug] = {"name": name, "slug": slug, "category": category}
                    new += 1
            empty_pages = 0 if new else empty_pages + 1
            print(f"  Traderie {category} 第 {page} 頁：{len(cards)} 個，新增 {new}", flush=True)
            page += 1
            if page > 120:
                raise RuntimeError(f"{category} 分頁太多，停止")
    return list(products.values())


SET_NAME_MAX_CHARS = 12  # a set name, not a stat sentence


def pairs_from_text(text: str, set_list: bool = False) -> list[tuple[str, str]]:
    lines = [line.strip() for line in PRIVATE_USE.sub("", text).splitlines() if line.strip()]
    pairs = []
    for i, line in enumerate(lines):
        same = re.match(r"^(.+?)\s+\(([^()]+)\)$", line)
        if same and CJK.search(same.group(1)) and LATIN_NAME.match(same.group(2).strip()):
            pairs.append((same.group(1).strip(), same.group(2).strip()))
            continue
        if CJK.search(line) and i + 1 < len(lines):
            nxt = lines[i + 1]
            alone = re.match(r"^\(([^()]+)\)$", nxt)
            if alone and LATIN_NAME.match(alone.group(1).strip()):
                pairs.append((line, alone.group(1).strip()))
            elif LATIN_NAME.match(nxt) and i + 2 < len(lines) and re.match(r"^#\d+$", lines[i + 2]):
                pairs.append((line, nxt))  # rune tables: name, English name, "#number"
            elif (
                set_list
                and LATIN_NAME.match(nxt)
                and len(nxt) >= MIN_GAME_NAME_CHARS
                and len(line) <= SET_NAME_MAX_CHARS
            ):
                # The set list on /info/item/sets: Chinese set name, then its English name on the next line.
                pairs.append((line, nxt))
    return pairs


async def read_d2r_world(tab: Tab) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """All (Chinese, English) pairs, plus the subset from pages whose every pair is a real game item name."""
    pairs: list[tuple[str, str]] = []
    trusted: list[tuple[str, str]] = []
    for category in D2R_CATEGORIES:
        await tab.goto(f"{D2R_WORLD}/{category}")
        await tab.wait_for("document.body.innerText.length")
        subs = await tab.evaluate(f"({SUBLINKS})({json.dumps(category)})") or []
        pages = [f"{D2R_WORLD}/{category}"] + ["https://d2r.world" + sub for sub in subs]
        for url in pages:
            await tab.goto(url)
            text = await tab.wait_for(PAGE_TEXT)
            top = url == pages[0]
            found = pairs_from_text(text or "", set_list=(category == "sets" and top))
            pairs.extend(found)
            if top and category in ("sets", "crafted"):
                trusted.extend(found)
            print(f"  d2r.world {url.rsplit('/info/item/', 1)[-1]}：{len(found)} 組", flush=True)
    return pairs, trusted


TRANSLATION_PAGES = ["runewords", "unique", "sets", "base"]
TRANSLATION_NOISE = {"普通", "卓越", "精英", "英文", "舊版", "新版", "級別", "新手閱讀"}


GENERIC_TYPE_WORDS = {"手套", "鞋子", "腰帶", "頭盔", "頭環", "護甲", "盾牌", "評論", "戒指", "護身符", "珠寶", "咒符"}


def pairs_from_translations(text: str) -> list[tuple[str, str]]:
    """d2r.world's old/new translation tables: an English name, then the old and the new Chinese name, then a tier.

    A set's title row is Chinese only and comes right after the last item of the previous set, so each English name
    takes at most two Chinese names (old and new); anything after that is a title, not a translation."""
    lines = [line.strip() for line in PRIVATE_USE.sub("", text).splitlines() if line.strip()]
    pairs, english, taken = [], None, 0
    for line in lines:
        if CJK.search(line):
            if english and taken < 2 and line not in TRANSLATION_NOISE and len(line) <= 20:
                pairs.append((line, english))
                taken += 1
        elif LATIN_NAME.match(line) and len(line) >= MIN_GAME_NAME_CHARS:
            english, taken = line, 0
        else:
            english = None
    return pairs


async def read_translations(tab: Tab) -> list[tuple[str, str]]:
    """The names a Traditional Chinese client may show: the current translation and the older ones."""
    pairs: list[tuple[str, str]] = []
    for page in TRANSLATION_PAGES:
        await tab.goto(f"https://d2r.world/zh-TW/info/misc/translates/{page}")
        text = await tab.wait_for(PAGE_TEXT)
        found = pairs_from_translations(text or "")
        pairs.extend(found)
        print(f"  d2r.world 新舊譯名 {page}：{len(found)} 組", flush=True)
    return pairs


def combine(products: list[dict], pairs: list[tuple[str, str]]) -> tuple[dict, dict]:
    by_key = {normalize(p["name"]): p for p in products}
    by_name = {p["name"]: p for p in products}
    zh: dict[str, str] = {}
    unmatched: dict[str, str] = {}
    ambiguous: dict[str, set[str]] = {}

    def plausible_name(chinese: str, product: dict) -> bool:
        """Page text such as a reader's comment or a category heading is not an item name."""
        if re.search(r"\s|\d|發表於", chinese):
            return False
        # A bare category word ("腰帶") is a heading on these pages, followed by some item: it never names that item.
        # The few that are real item types are listed in EXTRA_ZH.
        return chinese not in GENERIC_TYPE_WORDS

    for chinese, english in pairs:
        product = find_product(english, by_key)
        if product is not None and not plausible_name(chinese, product):
            continue
        if product is None:
            if len(english) >= MIN_GAME_NAME_CHARS:
                unmatched[chinese] = english
        elif zh.setdefault(chinese, product["name"]) != product["name"]:
            ambiguous.setdefault(chinese, {zh[chinese]}).add(product["name"])
    for chinese, names in list(ambiguous.items()):
        # A weapon-type word ("匕首") is also a heading followed by the first unique of that type. When exactly one
        # candidate is a plain base item and the others are uniques or sets, the base item is the answer.
        bases = [n for n in names if by_name[n]["category"] == "base"]
        others = [n for n in names if by_name[n]["category"] in ("uniques", "sets")]
        if len(bases) == 1 and len(others) == len(names) - 1:
            zh[chinese] = bases[0]
            del ambiguous[chinese]
        else:
            del zh[chinese]  # one Chinese name for two products: better no translation than the wrong one
    matched_keys = {normalize(name) for name in zh.values()}
    no_chinese = sorted(p["name"] for p in products if normalize(p["name"]) not in matched_keys)
    report = {
        "products": len(products),
        "chinese_names": len(zh),
        "products_without_chinese": no_chinese,
        "chinese_pairs_not_on_traderie": unmatched,
        "chinese_ambiguous": {k: sorted(v) for k, v in ambiguous.items()},
    }
    return zh, report


def find_product(english: str, by_key: dict) -> dict | None:
    """d2r.world says "Ber" / "Blood Body Armor", Traderie says "Ber Rune" / "Blood Body"."""
    key = normalize(english)
    return by_key.get(key) or by_key.get(normalize(english + " Rune")) or by_key.get(key.removesuffix(" armor"))


def game_only(trusted: list[tuple[str, str]], products: list[dict]) -> list[str]:
    """English names the game data has but Traderie's catalog does not ("not on Traderie", not "typo"). Only the
    set list and the crafted page are trusted for this: other pages also carry footer and comment text."""
    by_key = {normalize(p["name"]): p for p in products}
    return sorted(
        {
            english
            for _, english in trusted
            if len(english) >= MIN_GAME_NAME_CHARS
            and re.fullmatch(r"[A-Z][A-Za-z' \-]+", english)  # not a comment such as "by kevin82912"
            and not find_product(english, by_key)
        }
    )


async def main_async(out: Path, reuse_products: bool, add_translations: bool = False, from_cache: bool = False) -> None:
    if add_translations:
        existing = json.loads(out.read_text(encoding="utf-8"))
        async with Tab() as tab:
            pairs = await read_translations(tab)
        added, _ = combine(existing["products"], pairs)
        fresh = {k: v for k, v in added.items() if k not in existing["zh"]}
        existing["zh"] = dict(sorted({**existing["zh"], **fresh}.items()))
        out.write_text(json.dumps(existing, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"新增 {len(fresh)} 個中文名稱（含舊譯名），共 {len(existing['zh'])} 個。已寫入 {out}")
        return
    if from_cache:
        cached = json.loads(PAIRS_CACHE.read_text(encoding="utf-8"))
        pairs, trusted = [tuple(p) for p in cached["pairs"]], [tuple(p) for p in cached["trusted"]]
        products = json.loads(out.read_text(encoding="utf-8"))["products"]
    else:
        async with Tab() as tab:
            if reuse_products:
                products = json.loads(out.read_text(encoding="utf-8"))["products"]
            else:
                print("讀 Traderie 商品清單…", flush=True)
                products = await read_traderie(tab)
            print("讀 d2r.world 中英文名稱…", flush=True)
            d2r_pairs, trusted = await read_d2r_world(tab)
            pairs = d2r_pairs + await read_translations(tab)
        PAIRS_CACHE.parent.mkdir(parents=True, exist_ok=True)
        PAIRS_CACHE.write_text(json.dumps({"pairs": pairs, "trusted": trusted}, ensure_ascii=False), encoding="utf-8")
    zh, report = combine(products, pairs)
    names = {p["name"] for p in products}
    zh.update({chinese: english for chinese, english in EXTRA_ZH.items() if english in names})
    bases = [p for p in products if p["category"] in BASE_CATEGORIES]
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {"products": f"{TRADERIE}/products/<category>", "chinese": D2R_WORLD},
        "products": sorted(products, key=lambda p: p["slug"]),
        "zh": dict(sorted(zh.items())),
        "bases": sorted({p["name"] for p in bases}),
        # English names the game data has but Traderie's catalog does not: "not on Traderie" rather than "typo".
        "game_only": game_only(trusted, products),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    report_path = ROOT / "artifacts" / "item_tables_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"商品 {len(products)} 筆，中文名 {len(zh)} 筆，底材 {len(data['bases'])} 筆")
    print(
        f"沒有中文名的商品 {len(report['products_without_chinese'])} 筆；"
        f"d2r.world 有、Traderie 沒有的 {len(report['chinese_pairs_not_on_traderie'])} 筆"
    )
    print(f"已寫入 {out}\n報告 {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--reuse-products", action="store_true", help="skip Traderie, reuse products already in --out")
    parser.add_argument(
        "--add-translations",
        action="store_true",
        help="only read d2r.world's old/new translation pages and add their names to the zh table already in --out",
    )
    parser.add_argument(
        "--from-cache",
        action="store_true",
        help="do not open any website: rebuild the table from the pairs saved by the last full run",
    )
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.out, args.reuse_products, args.add_translations, args.from_cache))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
