"""Offline guard for the demo page: moving an element between tabs must not break app.js lookups."""

import re
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent.parent / "core" / "jev_ultrafast" / "static"
HTML = (STATIC / "index.html").read_text(encoding="utf-8")
JS = (STATIC / "app.js").read_text(encoding="utf-8")
TABS = ("run", "results", "usage")


def test_every_element_looked_up_by_app_js_exists_in_the_page():
    ids = set(re.findall(r'id="([^"]+)"', HTML))
    used = set(re.findall(r'\$\("([^"]+)"\)', JS))
    # Ids built from a view prefix: $(`${p}-status`) and friends.
    for prefix in ("trading", "recent-trades"):
        used |= {f"{prefix}-{suffix}" for suffix in ("status", "meta", "table", "raw", "csv")}
    assert used - ids == set()


def test_each_tab_button_controls_one_panel():
    for name in TABS:
        assert f'data-tab="{name}"' in HTML
        assert f'id="tab-{name}"' in HTML
    assert len(re.findall(r'role="tab"', HTML)) == len(TABS)
    # Only the first tab is visible before a run starts.
    assert re.search(r'id="tab-run"[^>]*\bhidden\b', HTML) is None
    for name in TABS[1:]:
        assert re.search(rf'id="tab-{name}"[^>]*\bhidden\b', HTML)


def test_app_js_is_served_with_its_csv_module():
    assert 'from "/csv.js"' in JS
    assert (STATIC / "csv.js").is_file()
