"""The extension build ships only what the extension reads from the item table (offline: no browser, no website)."""

import importlib.util
import json
import sys
from pathlib import Path

from tests._harness_stub import install

ROOT = Path(__file__).resolve().parents[1]
ITEMS = ROOT / "extension" / "src" / "traderie" / "data" / "items.json"
TOKENS = ROOT / "src" / "jev_ultrafast" / "static" / "tokens.css"

install()  # the build imports the package: nothing here may start the Chrome daemon


def load_build():
    spec = importlib.util.spec_from_file_location("extension_build", ROOT / "extension" / "build.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["extension_build"] = module
    spec.loader.exec_module(module)
    return module


build = load_build()  # noqa: E402


def test_the_shipped_table_keeps_only_what_the_build_declares():
    source = json.loads(ITEMS.read_text(encoding="utf-8"))
    shipped = build.ship_table(source)

    assert set(shipped) == set(build.SHIPPED_TABLE_KEYS)
    assert len(shipped["products"]) == len(source["products"])
    assert all(set(product) == set(build.SHIPPED_PRODUCT_KEYS) for product in shipped["products"])
    for key in ("zh", "bases", "game_only", "generated_at"):
        assert shipped[key] == source[key]


def test_build_writes_a_one_line_shipped_table_into_the_out_dir(tmp_path):
    out = tmp_path / "dist"

    assert build.build("https://example.test", out) == 0

    text = (out / "traderie" / "data" / "items.json").read_text(encoding="utf-8")
    assert "\n" not in text
    assert json.loads(text) == build.ship_table(json.loads(ITEMS.read_text(encoding="utf-8")))
    assert (out / "config.js").read_text(encoding="utf-8") == 'export const API_BASE = "https://example.test";\n'
    # The panel's stylesheet names its colours through tokens.css: without the copy the shipped panel has no palette.
    tokens = out / "tokens.css"
    assert tokens.read_text(encoding="utf-8") == TOKENS.read_text(encoding="utf-8")
    assert '<link rel="stylesheet" href="tokens.css" />' in (out / "sidepanel.html").read_text(encoding="utf-8")
