"""Rules that decide which Chinese name belongs to which Traderie product (offline: no browser, no website)."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


build = load("build_item_tables")
audit = load("audit_item_tables")

PRODUCTS = [
    {"name": "Dagger", "slug": "dagger", "category": "base"},
    {"name": "Dreadfang", "slug": "dreadfang", "category": "uniques"},
    {"name": "Belt", "slug": "belt", "category": "base"},
    {"name": "Ars Dul'Mephistos", "slug": "ars", "category": "uniques"},
    {"name": "Blood Body", "slug": "blood-body", "category": "crafted"},
    {"name": "Arctic Gear", "slug": "arctic-gear", "category": "sets"},
    {"name": "Death's Disguise", "slug": "dd", "category": "sets"},
    {"name": "Bane's Oathmaker", "slug": "bo", "category": "sets"},
    {"name": "Ber Rune", "slug": "ber-rune", "category": "runes"},
]


def test_a_weapon_type_word_that_also_heads_a_unique_resolves_to_the_plain_base_item():
    zh, report = build.combine(PRODUCTS, [("匕首", "Dagger"), ("匕首", "Dreadfang")])
    assert zh["匕首"] == "Dagger" and "匕首" not in report["chinese_ambiguous"]


def test_a_name_shared_by_two_uniques_or_sets_is_dropped_rather_than_guessed():
    zh, report = build.combine(PRODUCTS, [("死亡的偽裝", "Death's Disguise"), ("死亡的偽裝", "Bane's Oathmaker")])
    assert "死亡的偽裝" not in zh
    assert sorted(report["chinese_ambiguous"]["死亡的偽裝"]) == ["Bane's Oathmaker", "Death's Disguise"]


def test_category_headings_and_page_comments_are_never_item_names():
    pairs = [("腰帶", "Ars Dul'Mephistos"), ("發表於 2022-5-19", "Dreadfang"), ("啪噠 這翻譯真天才", "Dreadfang")]
    zh, _ = build.combine(PRODUCTS, pairs)
    assert zh == {}


def test_d2r_world_and_traderie_spell_a_few_names_differently():
    zh, _ = build.combine(PRODUCTS, [("血腥系手工護甲", "Blood Body Armor"), ("貝", "Ber")])
    assert zh == {"血腥系手工護甲": "Blood Body", "貝": "Ber Rune"}


def test_a_set_title_after_an_items_two_translations_is_not_a_third_translation():
    text = "Arctic Furs\n北極毛皮\n北極毛皮\n普通\nBerserker's Hauberk\n狂戰士的鎖甲\n狂戰士的鎖甲\n普通\n"
    # the next set's title follows the last item of the previous set; it must not become a translation of that item
    text += "海沙魯的鐵禦\nHsarus' Iron Heel\n鐵禦之踵\n鐵禦之踵\n"
    pairs = build.pairs_from_translations(text)
    assert ("海沙魯的鐵禦", "Berserker's Hauberk") not in pairs
    assert ("鐵禦之踵", "Hsarus' Iron Heel") in pairs


def test_game_only_names_come_from_item_pages_and_never_from_comments():
    trusted = [("貝恩的衣裝", "Bane's Garments"), ("關於洗出來的…", "by kevin82912"), ("北極裝備", "Arctic Gear")]
    assert build.game_only(trusted, PRODUCTS) == ["Bane's Garments"]


def test_the_audit_flags_noise_generic_words_naming_items_and_footer_text():
    data = {
        "products": PRODUCTS,
        "zh": {"咒符": "Dreadfang", "發表於 2022-5-19": "Dreadfang", "匕首": "Dagger"},
        "game_only": ["Contact Us", "Bane's Garments"],
        "bases": ["Dagger"],
    }
    _, problems = audit.audit(data)
    text = " ".join(problems)
    assert "通用字誤配：咒符" in text and "雜訊鍵" in text and "Contact Us" in text
    assert "匕首" not in text


def committed_items() -> dict:
    return json.loads(audit.ITEMS.read_text(encoding="utf-8"))


def synthetic_table(counts: dict[str, int]) -> dict:
    """A table that passes the audit: every product has its own Chinese name and slug."""
    products, zh, number = [], {}, 0
    for category, count in counts.items():
        for _ in range(count):
            number += 1
            name = f"Item {'x' * (number // 26)}{chr(97 + number % 26)} {category}"
            products.append({"name": name, "slug": f"item-{number}", "category": category})
            zh[chr(0x4E00 + number)] = name
    bases = sorted(p["name"] for p in products if p["category"] in audit.BASE_CATEGORIES)
    return {"generated_at": "2026-01-01T00:00:00+00:00", "sources": {}, "products": products, "zh": zh,
            "bases": bases, "game_only": []}  # fmt: skip


def test_the_committed_item_table_passes_the_audit():
    _, problems = audit.audit(committed_items())
    assert problems == []


def test_the_audit_flags_a_missing_category_a_short_category_a_new_duplicate_a_bad_slug_and_a_wrong_base():
    counts = dict(audit.MIN_PRODUCTS)
    data = synthetic_table(counts)
    assert audit.audit(data)[1] == []

    missing = {**data, "products": [p for p in data["products"] if p["category"] != "runes"]}
    assert any("runes" in problem for problem in audit.audit(missing)[1])

    short = {**data, "products": [p for p in data["products"] if p["name"] != data["products"][0]["name"]]}
    assert any("低於下限" in problem for problem in audit.audit(short)[1])

    twin = {"name": "ITEM-twin", "slug": "item-twin", "category": "sets"}
    twin_two = {**twin, "name": "The Item Twin", "slug": "item-twin2"}
    duplicated = {**data, "products": [*data["products"], twin, twin_two]}
    assert any("重複" in problem and "item twin" in problem for problem in audit.audit(duplicated)[1])

    bad_slug = {**data, "products": [*data["products"], {"name": "Odd", "slug": "Odd_Slug", "category": "sets"}]}
    assert any("網址代稱格式" in problem for problem in audit.audit(bad_slug)[1])

    unique_item = next(p["name"] for p in data["products"] if p["category"] == "uniques")
    wrong_base = {**data, "bases": [*data["bases"], unique_item]}
    assert any("不是底材分類" in problem for problem in audit.audit(wrong_base)[1])
    ghost_base = {**data, "bases": [*data["bases"], "No Such Item"]}
    assert any("不存在" in problem for problem in audit.audit(ghost_base)[1])


def test_combine_lists_products_whose_names_collide_after_normalising():
    products = [
        {"name": "Ward", "slug": "ward", "category": "runewords"},
        {"name": "The Ward", "slug": "the-ward", "category": "uniques"},
    ]
    _, report = build.combine(products, [])
    assert report["duplicate_keys"] == {"ward": ["ward", "the-ward"]}


def test_a_category_that_vanished_or_shrank_by_more_than_ten_percent_is_reported():
    old = [{"category": "base"}] * 100 + [{"category": "gems"}] * 10
    assert build.shrink_problems(old, [{"category": "base"}] * 90 + [{"category": "gems"}] * 10) == []
    problems = build.shrink_problems(old, [{"category": "base"}] * 89 + [{"category": "gems"}] * 10)
    assert len(problems) == 1 and "base" in problems[0]
    gone = build.shrink_problems(old, [{"category": "base"}] * 100)
    assert len(gone) == 1 and "gems" in gone[0]


@pytest.fixture
def candidate(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "CANDIDATE", tmp_path / "candidate.json")
    return tmp_path / "candidate.json"


def write_table(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def test_a_rebuild_with_the_same_content_keeps_the_committed_timestamp_and_changed_content_gets_a_new_one(
    tmp_path, candidate
):
    out = tmp_path / "items.json"
    committed = synthetic_table(audit.MIN_PRODUCTS)
    write_table(out, committed)

    same = {k: v for k, v in committed.items() if k != "generated_at"}
    assert build.publish(same, out) is True
    assert json.loads(out.read_text(encoding="utf-8")) == committed
    assert not candidate.exists()

    changed = {**same, "game_only": ["Brand New Item"]}
    assert build.publish(changed, out) is True
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["game_only"] == ["Brand New Item"] and written["generated_at"] != committed["generated_at"]


def test_a_shrunk_table_is_refused_and_the_committed_one_stays_unless_forced(tmp_path, candidate):
    out = tmp_path / "items.json"
    big = synthetic_table({k: round(v * 1.2) for k, v in audit.MIN_PRODUCTS.items()})
    write_table(out, big)
    before = out.read_text(encoding="utf-8")
    small = {k: v for k, v in synthetic_table(audit.MIN_PRODUCTS).items() if k != "generated_at"}

    assert build.publish(small, out) is False
    assert out.read_text(encoding="utf-8") == before and candidate.exists()

    assert build.publish(small, out, force=True) is True
    assert len(json.loads(out.read_text(encoding="utf-8"))["products"]) == len(small["products"])
    assert not candidate.exists()


def test_force_does_not_let_an_audit_problem_through(tmp_path, candidate):
    out = tmp_path / "items.json"
    write_table(out, synthetic_table(audit.MIN_PRODUCTS))
    before = out.read_text(encoding="utf-8")
    broken = {k: v for k, v in synthetic_table(audit.MIN_PRODUCTS).items() if k != "generated_at"}
    broken["zh"] = {**broken["zh"], "咒符": broken["products"][0]["name"]}  # a generic word naming a product
    broken["products"][0]["category"] = "uniques"

    assert build.publish(broken, out, force=True) is False
    assert out.read_text(encoding="utf-8") == before


class FakeTab(build.Tab):
    def __init__(self, values):
        self.values = list(values)

    async def evaluate(self, expression):
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]


@pytest.fixture
def fast_pages(monkeypatch):
    monkeypatch.setattr(build, "PAGE_SETTLE_SECONDS", 0.01)


def test_wait_for_returns_the_value_once_it_stopped_changing(fast_pages):
    assert asyncio.run(FakeTab([0, 3, 7, 7]).wait_for("x", seconds=5)) == 7


def test_wait_for_raises_for_a_page_that_never_settles_or_stays_empty(fast_pages):
    with pytest.raises(TimeoutError):
        asyncio.run(FakeTab(list(range(1000))).wait_for("x", seconds=0.2))
    with pytest.raises(TimeoutError):
        asyncio.run(FakeTab([0]).wait_for("x", seconds=0.2))


def test_wait_for_accepts_an_empty_page_only_when_asked_to(fast_pages):
    assert asyncio.run(FakeTab([0]).wait_for("x", seconds=0.2, allow_empty=True)) == 0
