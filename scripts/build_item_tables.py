"""Build the item tables used by the extension: uv run --group e2e python scripts/build_item_tables.py [--out PATH]

Windows-only tool (it starts the dedicated Chrome of jev_ultrafast.chrome, headless, with the Traderie login that
scripts/login.py saved; Traderie blocks plain downloads). It reads
  1. Traderie D2R product lists  -> English name -> product slug (+ category)
  2. d2r.world zh-TW item pages  -> Chinese name -> English name
and writes extension/src/traderie/data/items.json plus a report of what did not match,
written locally to artifacts/item_tables_report.json (artifacts/ is git-ignored; the report is not committed).

The new table is built as a candidate file (artifacts/item_tables_candidate.json, also local and git-ignored)
first. It replaces the committed table, atomically, only when
  * no category disappeared or shrank by more than 10% (unless --force), and
  * scripts/audit_item_tables.py finds no problem in it (--force does not skip this).
Otherwise the committed table stays and the candidate is left for inspection (exit 1). `generated_at` only changes when
the content changes.

The raw (Chinese, English) pairs of a full run are saved to scripts/data/item_pairs.json (artifacts/item_pairs.json
when that file would exceed 300 KB, because only a small snapshot belongs in git). `--from-cache` rebuilds from that
file without opening any website. Commit the snapshot after a full run so the rebuild does not depend on a
git-ignored folder.

`--reuse-products` skips the Traderie list and reuses the products already in `--out` (handy when only the names need
re-reading); `--add-translations` goes further and reads only d2r.world's translation pages, adding their names to the
`zh` table already in `--out`.
"""

import argparse
import asyncio
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cdp import Panel, open_dedicated_tab  # noqa: E402
from audit_item_tables import BASE_CATEGORIES, GENERIC_WORDS, audit, duplicate_keys, normalize  # noqa: E402

from jev_ultrafast.chrome import close_chrome  # noqa: E402
from jev_ultrafast.fs import write_text  # noqa: E402

OUT = ROOT / "extension" / "src" / "traderie" / "data" / "items.json"
CANDIDATE = ROOT / "artifacts" / "item_tables_candidate.json"
REPORT = ROOT / "artifacts" / "item_tables_report.json"
PAIRS_SNAPSHOT = ROOT / "scripts" / "data" / "item_pairs.json"
PAIRS_LOCAL = ROOT / "artifacts" / "item_pairs.json"  # where a snapshot over the size limit goes (git-ignored)
PAIRS_SNAPSHOT_MAX_BYTES = 300_000
MAX_SHRINK = 0.10  # a category may lose at most this share of its products against the committed table
TRADERIE = "https://traderie.com/diablo2resurrected"
D2R_WORLD = "https://d2r.world/zh-TW/info/item"
TRADERIE_CATEGORIES = ["uniques", "runes", "runewords", "sets", "base", "crafted", "charms", "gems", "misc"]
D2R_CATEGORIES = ["unique", "sets", "runes", "runewords", "base", "crafted", "magic"]
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
    # Sunder Charms (2.5 破免咒符)
    "黑洞之隙": "The Black Cleft",
    "魔法破免": "The Black Cleft",
    "骨裂": "The Bone Break",
    "物理破免": "The Bone Break",
    "冷裂": "The Cold Rupture",
    "冰冷破免": "The Cold Rupture",
    "天裂": "The Crack Of The Heavens",
    "閃電破免": "The Crack Of The Heavens",
    "電破免": "The Crack Of The Heavens",
    "焰裂": "The Flame Rift",
    "火焰破免": "The Flame Rift",
    "火破免": "The Flame Rift",
    "腐爛裂口": "The Rotting Fissure",
    "毒素破免": "The Rotting Fissure",
    "毒破免": "The Rotting Fissure",
    # Hellfire Torch (地獄火炬)
    "地獄火炬": "Hellfire Torch",
    "火炬": "Hellfire Torch",
    # Runewords (符文之語)
    "毀滅": "Destruction",
    "催促": "Hustle (Weapon)",
    "疾馳": "Hustle (Weapon)",
    "催促(武器)": "Hustle (Weapon)",
    "催促(防具)": "Hustle (Armor)",
    # Rainbow Facets (彩虹刻面細分版)
    "彩虹刻面(冰死)": "Rainbow Facet: Cold Death",
    "彩虹刻面(冰升)": "Rainbow Facet: Cold Level-Up",
    "彩虹刻面(火死)": "Rainbow Facet: Fire Death",
    "彩虹刻面(火升)": "Rainbow Facet: Fire Level-Up",
    "彩虹刻面(電死)": "Rainbow Facet: Lightning Death",
    "彩虹刻面(電升)": "Rainbow Facet: Lightning Level-Up",
    "彩虹刻面(毒死)": "Rainbow Facet: Poison Death",
    "彩虹刻面(毒升)": "Rainbow Facet: Poison Level-Up",
    # Sets (套裝名)
    "死亡的偽裝": "Death's Disguise",
    "孤兒的呼喚": "Orphan's Call",
    # Bases (常用底材)
    "頭盔": "Helm",
    "夜視之盔": "Darksight Helm",
    "暗視之盔": "Darksight Helm",
    "短劍": "Short Sword",
    "塔盾": "Tower Shield",
    "飛斧": "Throwing Axe",
    "飛刀": "Throwing Knife",
    "重斧": "Bearded Axe",
    "吉得賓": "The Gidbinn",
    "懷特之腳": "Wirt's Leg",
    # Essences, Tokens, Keys, Potions (常用雜項)
    "重置徽章": "Token Of Absolution",
    "赦免徽章": "Token Of Absolution",
    "毀滅之鑰": "Key Of Destruction",
    "仇恨之鑰": "Key Of Hate",
    "恐懼之鑰": "Key Of Terror",
    "扭曲的痛苦精華": "Twisted Essence Of Suffering",
    "充能的憎恨精華": "Charged Essence Of Hatred",
    "燃燒的恐懼精華": "Burning Essence Of Terror",
    "潰爛的毀滅精華": "Festering Essence Of Destruction",
    "英雄旗幟": "Standard Of Heroes",
    "全面回復藥劑": "Full Rejuvenation Potion",
    "回復藥劑": "Rejuvenation Potion",
    "重型生命藥劑": "Greater Healing Potion",
    "超級生命藥劑": "Super Healing Potion",
    "重型法力藥劑": "Greater Mana Potion",
    "超級法力藥劑": "Super Mana Potion",
    "解毒藥劑": "Antidote Potion",
    "融冰藥劑": "Thawing Potion",
    "耐力藥劑": "Stamina Potion",
    # Gems (寶石全系列 36 款)
    "碎裂的紫寶石": "Chipped Amethyst",
    "瑕疵的紫寶石": "Flawed Amethyst",
    "紫寶石": "Amethyst",
    "無瑕的紫寶石": "Flawless Amethyst",
    "完美紫寶石": "Perfect Amethyst",
    "完紫": "Perfect Amethyst",
    "碎裂的紅寶石": "Chipped Ruby",
    "瑕疵的紅寶石": "Flawed Ruby",
    "紅寶石": "Ruby",
    "無瑕的紅寶石": "Flawless Ruby",
    "完美紅寶石": "Perfect Ruby",
    "完紅": "Perfect Ruby",
    "碎裂的藍寶石": "Chipped Sapphire",
    "瑕疵的藍寶石": "Flawed Sapphire",
    "藍寶石": "Sapphire",
    "無瑕的藍寶石": "Flawless Sapphire",
    "完美藍寶石": "Perfect Sapphire",
    "完藍": "Perfect Sapphire",
    "碎裂的黃寶石": "Chipped Topaz",
    "瑕疵的黃寶石": "Flawed Topaz",
    "黃寶石": "Topaz",
    "無瑕的黃寶石": "Flawless Topaz",
    "完美黃寶石": "Perfect Topaz",
    "完黃": "Perfect Topaz",
    "碎裂的綠寶石": "Chipped Emerald",
    "瑕疵的綠寶石": "Flawed Emerald",
    "綠寶石": "Emerald",
    "無瑕的綠寶石": "Flawless Emerald",
    "完美綠寶石": "Perfect Emerald",
    "完綠": "Perfect Emerald",
    "碎裂的鑽石": "Chipped Diamond",
    "瑕疵的鑽石": "Flawed Diamond",
    "鑽石": "Diamond",
    "無瑕的鑽石": "Flawless Diamond",
    "完美鑽石": "Perfect Diamond",
    "完鑽": "Perfect Diamond",
    "完白": "Perfect Diamond",
    "碎裂的骷髏": "Chipped Skull",
    "瑕疵的骷髏": "Flawed Skull",
    "骷髏": "Skull",
    "無瑕的骷髏": "Flawless Skull",
    "完美骷髏": "Perfect Skull",
    "完骷": "Perfect Skull",
    "隨機寶石": "Random Gems",
    "雜碎寶石": "Random Gems",
    # Remaining Uniques
    "毒蛇護身符": "Amulet Of The Viper",
    "蝮蛇護身符": "Amulet Of The Viper",
    "束縛之戒": "Constricting Ring",
    "緊縮之戒": "Constricting Ring",
    # Remaining Sets
    "軍閥的權威": "Warlord's Authority",
    "軍閥的征服": "Warlord's Conquest",
    "軍閥的粉碎者": "Warlord's Crushers",
    "軍閥的慾望": "Warlord's Lust",
    "軍閥的披風": "Warlord's Mantle",
    # Remaining Runewords
    "狂熱之語": "Mania",
    "躁狂": "Mania",
    # Remaining Runes
    "全套符文": "Rune Set",
    "符文全套": "Rune Set",
    "符文禮包": "Rune Set",
    # Remaining Bases (potions & throwables)
    "窒息瓦斯藥劑": "Choking Gas Potion",
    "窒息瓦斯毒劑": "Choking Gas Potion",
    "爆炸藥劑": "Exploding Potion",
    "爆裂藥劑": "Fulminating Potion",
    "燃油藥劑": "Oil Potion",
    "酸臭瓦斯藥劑": "Rancid Gas Potion",
    "扼殺瓦斯藥劑": "Strangling Gas Potion",
    "吉得賓匕首": "The Gidbinn",
    # Misc items (organs, portals, tomes, scrolls, quest items)
    "巴爾之眼": "Baal's Eye",
    "迪亞布羅之角": "Diablo's Horn",
    "墨菲斯托之腦": "Mephisto's Brain",
    "崔斯特姆傳送門": "Portal To Uber Tristram",
    "秘密牛關傳送門": "Portal To The Secret Cow Level",
    "遺忘沙漠傳送門": "Portal To Forgotten Sands",
    "痛苦之爐傳送門": "Portal To Furnace Of Pain",
    "女妖巢穴傳送門": "Portal To Matron's Den",
    "城鎮傳送之書": "Tome Of Town Portal",
    "辨識之書": "Tome Of Identify",
    "城鎮傳送卷軸": "Scroll Of Town Portal",
    "辨識卷軸": "Scroll Of Identify",
    "赫拉迪克方塊": "Horadric Cube",
    "方塊": "Horadric Cube",
    "赫拉迪克法杖": "Horadric Staff",
    "國王之杖": "Staff Of Kings",
    "克林姆的連枷": "Khalim's Flail",
    "克林姆的意志": "Khalim's Will",
    "克林姆之眼": "Khalim's Eye",
    "克林姆之心": "Khalim's Heart",
    "克林姆之腦": "Khalim's Brain",
    "墨菲斯托的靈魂石": "Mephisto's Soulstone",
    "靈魂石": "Mephisto's Soulstone",
    "藍依森之書": "Lam Esen's Tome",
    "技能之書": "Book Of Skill",
    "黃金之鳥": "The Golden Bird",
    "玉製小人": "A Jade Figurine",
    "玉石小人": "A Jade Figurine",
    "艾尼弗斯卷軸": "Scroll Of Inifuss",
    "抗性卷軸": "Scroll Of Resistance",
    "瑪菈的藥劑": "Malah's Potion",
    "生命藥劑": "Potion Of Life",
    "全套鑰匙": "3x3 Key Set",
    "九把鑰匙": "3x3 Key Set",
    "鑰匙": "Key",
    "金幣": "Gold",
    "黃金": "Gold",
    "耳朵": "Ear",
}

CARDS = """(() => [...document.querySelectorAll('a[href*="/diablo2resurrected/product/"]')].map(a => {
  const box = a.closest('.item-container-img-icon') || a.parentElement;
  const name = box && box.querySelector('.item-name');
  return [a.getAttribute('href'), name ? name.innerText.trim() : (a.querySelector('img') || {}).alt || ''];
}))()"""
SUBLINKS = """(cat) => [...new Set([...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
  .filter(h => h && h.includes('/info/item/' + cat + '/')).map(h => h.split('#')[0]))]"""
PAGE_TEXT = "document.body.innerText"

PRIVATE_USE = re.compile(r"[\ue000-\uf8ff]")
CJK = re.compile(r"[\u3400-\u9fff]")
LATIN_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9'’\- .,:]*$")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=1) + "\n")


class Tab(Panel):
    async def wait_for(self, expression, seconds=25, allow_empty=False):
        """Poll until `expression` gives the same truthy value twice in a row, PAGE_SETTLE_SECONDS apart.

        A page that never settles raises TimeoutError instead of returning whatever it showed last. `allow_empty`
        accepts a value that stayed falsy and unchanged until the time ran out (a result list with no more items)."""
        deadline = time.monotonic() + seconds
        last, value, stable = None, None, False
        while time.monotonic() < deadline:
            await asyncio.sleep(PAGE_SETTLE_SECONDS)
            value = await self.evaluate(expression)
            stable = value == last
            if stable and value:
                return value
            last = value
        if stable and allow_empty:
            return value
        raise TimeoutError(f"頁面 {seconds} 秒內沒有穩定：{expression[:60]!r}，最後讀到 {str(value)[:60]!r}")


async def read_traderie(tab: Tab) -> list[dict]:
    products: dict[str, dict] = {}
    for category in TRADERIE_CATEGORIES:
        page, empty_pages = 0, 0
        while empty_pages < 2:
            url = f"{TRADERIE}/products/{category}" + (f"?page={page}" if page else "")
            await tab.goto(url)
            await tab.wait_for(
                "document.querySelectorAll('a[href*=\"/diablo2resurrected/product/\"]').length", allow_empty=True
            )
            cards = await tab.evaluate(CARDS) or []
            new = 0
            for href, name in cards:
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


def text_lines(text: str) -> list[str]:
    """The page text as stripped, non-empty lines, with private-use glyphs (the site's own icons) removed."""
    return [line.strip() for line in PRIVATE_USE.sub("", text).splitlines() if line.strip()]


def pairs_from_text(text: str, set_list: bool = False) -> list[tuple[str, str]]:
    lines = text_lines(text)
    pairs = []
    for i, line in enumerate(lines):
        same = re.match(r"^(.+?)\s+\(([^()]+)\)$", line)
        if same and CJK.search(same.group(1)) and LATIN_NAME.match(same.group(2).strip()):
            pairs.append((same.group(1).strip(), same.group(2).strip()))
            continue
        if CJK.search(line) and i + 1 < len(lines):
            next_line = lines[i + 1]
            alone = re.match(r"^\(([^()]+)\)$", next_line)
            if alone and LATIN_NAME.match(alone.group(1).strip()):
                pairs.append((line, alone.group(1).strip()))
            elif LATIN_NAME.match(next_line) and i + 2 < len(lines) and re.match(r"^#\d+$", lines[i + 2]):
                pairs.append((line, next_line))  # rune tables: name, English name, "#number"
            elif (
                set_list
                and LATIN_NAME.match(next_line)
                and len(next_line) >= MIN_GAME_NAME_CHARS
                and len(line) <= SET_NAME_MAX_CHARS
            ):
                # The set list on /info/item/sets: Chinese set name, then its English name on the next line.
                pairs.append((line, next_line))
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


def pairs_from_translations(text: str) -> list[tuple[str, str]]:
    """d2r.world's old/new translation tables: an English name, then the old and the new Chinese name, then a tier.

    A set's title row is Chinese only and comes right after the last item of the previous set, so each English name
    takes at most two Chinese names (old and new); anything after that is a title, not a translation."""
    lines = text_lines(text)
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


def by_normalized_name(products: list[dict]) -> dict[str, dict]:
    """Product by its normalised name: the key `find_product` looks a source name up with."""
    return {normalize(p["name"]): p for p in products}


def combine(products: list[dict], pairs: list[tuple[str, str]]) -> tuple[dict, dict]:
    by_key = by_normalized_name(products)
    by_name = {p["name"]: p for p in products}
    zh: dict[str, str] = {}
    unmatched: dict[str, str] = {}
    ambiguous: dict[str, set[str]] = {}

    def plausible_name(chinese: str) -> bool:
        """Page text such as a reader's comment or a category heading is not an item name."""
        if re.search(r"\s|\d|發表於", chinese):
            return False
        # A bare category word ("腰帶") is a heading on these pages, followed by some item: it never names that item.
        # The few that are real item types are listed in EXTRA_ZH.
        return chinese not in GENERIC_WORDS

    for chinese, english in pairs:
        product = find_product(english, by_key)
        if product is not None and not plausible_name(chinese):
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
        # Products whose names normalise to the same key: by_key keeps one of them, the audit lists the unexpected ones.
        "duplicate_keys": duplicate_keys(products),
    }
    return zh, report


def find_product(english: str, by_key: dict) -> dict | None:
    """d2r.world says "Ber" / "Blood Body Armor", Traderie says "Ber Rune" / "Blood Body"."""
    key = normalize(english)
    return by_key.get(key) or by_key.get(normalize(english + " Rune")) or by_key.get(key.removesuffix(" armor"))


def game_only(trusted: list[tuple[str, str]], products: list[dict]) -> list[str]:
    """English names the game data has but Traderie's catalog does not ("not on Traderie", not "typo"). Only the
    set list and the crafted page are trusted for this: other pages also carry footer and comment text."""
    by_key = by_normalized_name(products)
    return sorted(
        {
            english
            for _, english in trusted
            if len(english) >= MIN_GAME_NAME_CHARS
            and re.fullmatch(r"[A-Z][A-Za-z' \-]+", english)  # not a comment such as "by kevin82912"
            and not find_product(english, by_key)
        }
    )


def build_table(
    products: list[dict], pairs: list[tuple[str, str]], trusted: list[tuple[str, str]]
) -> tuple[dict, dict]:
    """The table's committed shape and the report of what did not match: the names a Chinese client may show, with
    the shipped item types (EXTRA_ZH) folded in for the products that exist."""
    zh, report = combine(products, pairs)
    names = {p["name"] for p in products}
    zh.update({chinese: english for chinese, english in EXTRA_ZH.items() if english in names})
    bases = [p for p in products if p["category"] in BASE_CATEGORIES]
    data = {
        "sources": {"products": f"{TRADERIE}/products/<category>", "chinese": D2R_WORLD},
        "products": sorted(products, key=lambda p: p["slug"]),
        "zh": dict(sorted(zh.items())),
        "bases": sorted({p["name"] for p in bases}),
        # English names the game data has but Traderie's catalog does not: "not on Traderie" rather than "typo".
        "game_only": game_only(trusted, products),
    }
    return data, report


def category_counts(products: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for product in products:
        counts[product["category"]] = counts.get(product["category"], 0) + 1
    return counts


def shrink_problems(old_products: list[dict], new_products: list[dict]) -> list[str]:
    """A category that vanished or lost more than MAX_SHRINK of its products against the committed table."""
    before, after = category_counts(old_products), category_counts(new_products)
    problems = []
    for category, was in sorted(before.items()):
        now = after.get(category, 0)
        if now == 0:
            problems.append(f"分類 {category} 不見了（原本 {was} 筆）")
        elif now < was * (1 - MAX_SHRINK):
            problems.append(f"分類 {category} 從 {was} 筆縮到 {now} 筆（減少超過 {MAX_SHRINK:.0%}）")
    return problems


def content_of(data: dict) -> dict:
    return {key: value for key, value in data.items() if key != "generated_at"}


def stamp(data: dict, existing: dict | None) -> dict:
    """`generated_at` is the time the content last changed: an identical rebuild keeps the committed stamp."""
    if existing and content_of(existing) == content_of(data) and "generated_at" in existing:
        return {**data, "generated_at": existing["generated_at"]}
    return {**data, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def publish(data: dict, out: Path, force: bool = False) -> bool:
    """Write the candidate, check it, and only then replace `out` (atomically). False when it was refused."""
    existing = read_json(out) if out.exists() else None
    data = stamp(data, existing)
    write_json(CANDIDATE, data)
    problems = []
    if existing and not force:
        problems += shrink_problems(existing["products"], data["products"])
    problems += audit(data)[1]
    if problems:
        for problem in problems:
            print("問題：" + problem)
        hint = "" if force else "（分類縮水可用 --force 放行，稽核問題不行）"
        print(f"沒有替換 {out}。候選檔留在 {CANDIDATE}{hint}")
        return False
    if data == existing:
        print(f"內容和 {out} 完全相同，沒有改動。")
    else:
        write_text(out, CANDIDATE.read_text(encoding="utf-8"))
        print(f"已寫入 {out}")
    CANDIDATE.unlink(missing_ok=True)
    return True


def save_pairs(pairs: list, trusted: list) -> Path:
    """Compact, in the order they were read (the first Chinese reading of a name wins in `combine`)."""
    text = json.dumps({"pairs": pairs, "trusted": trusted}, ensure_ascii=False, separators=(",", ":")) + "\n"
    big = len(text.encode("utf-8")) > PAIRS_SNAPSHOT_MAX_BYTES
    path = PAIRS_LOCAL if big else PAIRS_SNAPSHOT
    write_text(path, text)
    print(f"{'檔案超過 300 KB，只存在本機（不要放進 git）' if big else '已存成可提交的快照'}：{path}")
    return path


def load_pairs() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    found = [path for path in (PAIRS_SNAPSHOT, PAIRS_LOCAL) if path.exists()]
    if not found:
        raise SystemExit(f"找不到 {PAIRS_SNAPSHOT}（也沒有 {PAIRS_LOCAL}）：先完整跑一次（不加 --from-cache）")
    cached = read_json(max(found, key=lambda path: path.stat().st_mtime))
    return [tuple(p) for p in cached["pairs"]], [tuple(p) for p in cached["trusted"]]


async def main_async(
    out: Path, reuse_products: bool, *, add_translations: bool = False, from_cache: bool = False, force: bool = False
) -> bool:
    if add_translations:
        existing = read_json(out)
        async with open_dedicated_tab(Tab) as tab:
            pairs = await read_translations(tab)
        added, _ = combine(existing["products"], pairs)
        fresh = {k: v for k, v in added.items() if k not in existing["zh"]}
        existing["zh"] = dict(sorted({**existing["zh"], **fresh}.items()))
        print(f"新增 {len(fresh)} 個中文名稱（含舊譯名），共 {len(existing['zh'])} 個。")
        return publish(existing, out, force)
    if from_cache:
        pairs, trusted = load_pairs()
        products = read_json(out)["products"]
    else:
        async with open_dedicated_tab(Tab) as tab:
            if reuse_products:
                products = read_json(out)["products"]
            else:
                print("讀 Traderie 商品清單…", flush=True)
                products = await read_traderie(tab)
            print("讀 d2r.world 中英文名稱…", flush=True)
            d2r_pairs, trusted = await read_d2r_world(tab)
            pairs = d2r_pairs + await read_translations(tab)
        save_pairs(pairs, trusted)
    data, report = build_table(products, pairs, trusted)
    write_json(REPORT, report)
    print(f"商品 {len(products)} 筆，中文名 {len(data['zh'])} 筆，底材 {len(data['bases'])} 筆")
    print(
        f"沒有中文名的商品 {len(report['products_without_chinese'])} 筆；"
        f"d2r.world 有、Traderie 沒有的 {len(report['chinese_pairs_not_on_traderie'])} 筆；"
        f"報告 {REPORT}"
    )
    for key, slugs in report["duplicate_keys"].items():
        print(f"  名稱正規化後重複：{key!r} → {', '.join(slugs)}")
    return publish(data, out, force)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        type=Path,
        default=OUT,
        help="where to write the table (default: extension/src/traderie/data/items.json)",
    )
    parser.add_argument("--reuse-products", action="store_true", help="skip Traderie, reuse products already in --out")
    parser.add_argument(
        "--add-translations",
        action="store_true",
        help="only read d2r.world's old/new translation pages and add their names to the zh table already in --out",
    )
    parser.add_argument(
        "--from-cache",
        action="store_true",
        help="do not open any website: rebuild the table from the pairs saved by the last full run "
        "(scripts/data/item_pairs.json)",
    )
    parser.add_argument(
        "--force", action="store_true", help="accept a table where a category vanished or shrank by more than 10%%"
    )
    args = parser.parse_args()
    try:
        ok = asyncio.run(
            main_async(
                args.out,
                args.reuse_products,
                add_translations=args.add_translations,
                from_cache=args.from_cache,
                force=args.force,
            )
        )
    except KeyboardInterrupt:
        sys.exit(130)
    finally:
        close_chrome()  # stops only a Chrome this run started; a Chrome that was already running is left alone
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
