"""Rules that decide which Chinese name belongs to which Traderie product (offline: no browser, no website)."""

import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent


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
