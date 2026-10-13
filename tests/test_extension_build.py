"""The extension build ships only what the extension reads from the item table (offline: no browser, no website)."""

import importlib.util
import json
import re
import sys
from pathlib import Path

from tests._harness_stub import install

ROOT = Path(__file__).resolve().parents[1]
ITEMS = ROOT / "extension" / "src" / "traderie" / "data" / "items.json"
CDP = ROOT / "extension" / "src" / "cdp.js"
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


def test_build_refuses_a_dist_that_carries_a_secret_and_discards_it(tmp_path, monkeypatch):
    """A key that reaches the dist must never ship: the build refuses, removes the directory and returns 1.

    The leak is injected through `ship_table` (the one function that rewrites the copied item table), so this runs the
    real build path: the file lands in the dist, the scan finds it, and nothing survives to be shipped.
    """
    out = tmp_path / "dist"
    table_with_a_key_name = {"products": [{"name": "TYPESAFE_API_KEY", "slug": "shako"}]}
    monkeypatch.setattr(build, "ship_table", lambda _table: table_with_a_key_name)

    assert build.build("https://example.test", out) == 1
    assert not out.exists()  # discarded, not shipped


def test_every_page_script_the_run_injects_is_shipped_into_page(tmp_path):
    """`cdp.js` injects these files by name from `page/`; the build must copy every one, or the run loads a 404.

    The two lists live in different languages and are read at different times, so only this test ties them: the names
    come from the panel's own table, the shipped set from the build's copy lists and the built tree.
    """
    table = re.search(r"PAGE_SCRIPT_FILES\s*=\s*\{(.*?)\};", CDP.read_text(encoding="utf-8"), re.S)
    injected = set(re.findall(r'"([^"]+\.js)"', table.group(1)))
    assert injected, "no page-script names found in extension/src/cdp.js"

    out = tmp_path / "dist"
    assert build.build("https://example.test", out) == 0
    shipped_names = set(build.PAGE_SCRIPTS) | set(build.PAGE_SCRIPTS_SUBDIR)
    assert injected <= shipped_names, f"cdp.js injects what the build does not copy: {sorted(injected - shipped_names)}"
    missing = sorted(name for name in injected if not (out / "page" / name).is_file())
    assert not missing, f"the built page/ folder is missing: {missing}"


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
