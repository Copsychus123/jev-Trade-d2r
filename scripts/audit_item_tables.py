"""Audit of the item tables: uv run python scripts/audit_item_tables.py [--json]

Reads extension/src/traderie/data/items.json and prints, per category, how many Traderie products have a Chinese name,
and fails (exit 1) when the table has page noise, generic words naming a unique or set item, a coverage drop below the
floors, or a "game only" list with footer text. Run it after every `build_item_tables.py`.
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
GENERIC_WORDS = {"手套", "鞋子", "腰帶", "頭盔", "頭環", "護甲", "盾牌", "評論", "戒指", "護身符", "珠寶", "咒符"}
NOISE_KEY = re.compile(r"\s|\d|發表於|評論")
FOOTER_ENGLISH = {"contact us", "runeword guide", "dan brown", "david hsu"}


def normalize(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"['’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text.removeprefix("the ")


def audit(data: dict) -> tuple[dict, list[str]]:
    by_name = {p["name"]: p for p in data["products"]}
    named = {normalize(english) for english in data["zh"].values()}
    coverage: dict[str, dict] = {}
    for product in data["products"]:
        row = coverage.setdefault(product["category"], {"total": 0, "named": 0, "missing": []})
        row["total"] += 1
        if normalize(product["name"]) in named:
            row["named"] += 1
        else:
            row["missing"].append(product["name"])

    problems = []
    for category, floor in FLOORS.items():
        row = coverage.get(category)
        if row and row["named"] / row["total"] < floor:
            problems.append(f"{category} 覆蓋率 {row['named']}/{row['total']} 低於下限 {floor:.0%}")
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
