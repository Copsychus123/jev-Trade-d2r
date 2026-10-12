"""Audit of the item tables: uv run python scripts/audit_item_tables.py [--json]

Reads extension/src/traderie/data/items.json and prints, per category, how many Traderie products have a Chinese name,
and fails (exit 1) when the table has page noise, generic words naming a unique or set item, a coverage drop below the
floors, a category that is missing or has fewer products than its floor, product names that collide after
normalising (except ALLOWED_DUPLICATE_KEYS), a malformed or repeated slug, a base list with products that are not
plain item types, or a "game only" list with footer text. `build_item_tables.py` runs this audit on every candidate
table and refuses to replace the committed one when it finds a problem; `tests/test_item_tables.py` runs it
on the committed file.
"""

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

ITEMS = Path(__file__).resolve().parents[1] / "extension" / "src" / "traderie" / "data" / "items.json"
# Lowest coverage (share of products with a Chinese name) each category must keep. d2r.world has no gems or misc page,
# so those two have no floor; raise a floor when a new source closes a gap.
FLOORS = {"base": 0.95, "sets": 0.95, "uniques": 0.95, "runes": 0.95, "runewords": 0.95, "crafted": 0.9, "charms": 1.0}
# Fewest Traderie products each category must hold (about 10% under the count of the committed table, the same margin
# `build_item_tables.py` allows a category to shrink): a page that half-loaded during a build must not shrink the
# table silently. Every category here must exist.
MIN_PRODUCTS = {
    "base": 465,
    "uniques": 375,
    "sets": 155,
    "runewords": 90,
    "misc": 75,
    "gems": 32,
    "crafted": 32,
    "runes": 30,
    "charms": 3,
}
# Categories that hold the plain item types a quality word ("Rare", "Magic", "White") can be dropped from
# (Traderie files Ring, Amulet and Jewel under misc). The `bases` list is made only from these.
BASE_CATEGORIES = {"base", "charms", "misc"}
# Product names that normalise to the same key and are two different products on Traderie (a unique and a runeword
# both called "Crescent Moon", "The Ward" next to "Ward", two "Wirt's Leg"). The extension treats these keys as
# ambiguous and never jumps by table for them. A new collision is a problem until someone checks it and lists it here.
ALLOWED_DUPLICATE_KEYS = {"crescent moon", "ward", "wirts leg"}
GENERIC_WORDS = {"手套", "鞋子", "腰帶", "頭盔", "頭環", "護甲", "盾牌", "評論", "戒指", "護身符", "珠寶", "咒符"}
NOISE_KEY = re.compile(r"\s|\d|發表於|評論")
FOOTER_ENGLISH = {"contact us", "runeword guide", "dan brown", "david hsu"}
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def normalize(name: str) -> str:
    """Same idea as the extension: lower case, no accents or apostrophes, words only, no leading 'the'."""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"['’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text.removeprefix("the ")


def duplicate_keys(products: list[dict]) -> dict[str, list[str]]:
    """Normalised key -> the distinct product slugs behind it, for keys that more than one product has."""
    slugs: dict[str, list[str]] = {}
    for product in products:
        slugs.setdefault(normalize(product["name"]), []).append(product["slug"])
    return {key: found for key, found in slugs.items() if len(found) > 1}


def _coverage(products: list[dict], named: set[str]) -> dict[str, dict]:
    """Per category: how many products it holds, how many have a Chinese name, and which ones do not."""
    coverage: dict[str, dict] = {}
    for product in products:
        row = coverage.setdefault(product["category"], {"total": 0, "named": 0, "missing": []})
        row["total"] += 1
        if normalize(product["name"]) in named:
            row["named"] += 1
        else:
            row["missing"].append(product["name"])
    return coverage


def audit(data: dict) -> tuple[dict, list[str]]:
    by_name = {p["name"]: p for p in data["products"]}
    named = {normalize(english) for english in data["zh"].values()}
    coverage = _coverage(data["products"], named)

    problems = []
    for category, minimum in MIN_PRODUCTS.items():
        row = coverage.get(category)
        if row is None:
            problems.append(f"缺少分類 {category}（商品 0 筆）")
        elif row["total"] < minimum:
            problems.append(f"{category} 只有 {row['total']} 筆商品，低於下限 {minimum}")
    for category, floor in FLOORS.items():
        row = coverage.get(category)
        if row and row["named"] / row["total"] < floor:
            problems.append(f"{category} 覆蓋率 {row['named']}/{row['total']} 低於下限 {floor:.0%}")
    for key, slugs in duplicate_keys(data["products"]).items():
        if key not in ALLOWED_DUPLICATE_KEYS:
            problems.append(f"商品名稱正規化後重複：{key!r} → {', '.join(slugs)}")
    seen_slugs: set[str] = set()
    for product in data["products"]:
        slug = product["slug"]
        if not SLUG.fullmatch(slug):
            problems.append(f"網址代稱格式不對：{slug!r}")
        if slug in seen_slugs:
            problems.append(f"網址代稱重複：{slug!r}")
        seen_slugs.add(slug)
    for chinese, english in data["zh"].items():
        if NOISE_KEY.search(chinese):
            problems.append(f"雜訊鍵：{chinese!r} → {english}")
        product = by_name.get(english)
        if chinese in GENERIC_WORDS and product and product["category"] in ("uniques", "sets"):
            problems.append(f"通用字誤配：{chinese} → {english}")
        if english not in by_name:
            problems.append(f"對到不存在的商品：{chinese} → {english}")
    for english in data["game_only"]:
        if english.lower() in FOOTER_ENGLISH or re.search(r"\d", english):
            problems.append(f"game_only 含頁尾雜訊：{english!r}")
    for base in data["bases"]:
        if base not in by_name:
            problems.append(f"底材清單裡有不存在的商品：{base}")
        elif by_name[base]["category"] not in BASE_CATEGORIES:
            problems.append(f"底材清單裡的商品不是底材分類：{base}（{by_name[base]['category']}）")
    return coverage, problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    parser.add_argument("--items", type=Path, default=ITEMS)
    args = parser.parse_args()
    data = json.loads(args.items.read_text(encoding="utf-8"))
    coverage, problems = audit(data)
    if args.json:
        print(json.dumps({"coverage": coverage, "problems": problems}, ensure_ascii=False, indent=1))
    else:
        total = sum(r["named"] for r in coverage.values())
        print(f"中文名稱 {len(data['zh'])} 個；商品 {len(data['products'])} 個，其中 {total} 個有中文名稱")
        for category, row in coverage.items():
            print(f"  {category:10s} {row['named']:4d}/{row['total']:<4d} {row['named'] / row['total']:5.0%}")
        for problem in problems:
            print("問題：" + problem)
        if not problems:
            print("沒有發現問題。")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
