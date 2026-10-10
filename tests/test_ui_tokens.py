"""The two surfaces share one colour vocabulary: `static/tokens.css` owns the names, the stylesheets use them.

Two palettes that drifted apart is how the same product came to look like two products: a name per role (and one
file that defines the values) is what makes a future "make them match" a one-line decision instead of a hunt through
1,900 lines of CSS. The values in `tokens.css` are the side panel's own - the shipped surface keeps the look it had,
which the before/after panel screenshots of the change show - and the local demo declares its own skin by overriding
the same names.

The panel is migrated, so it may not contain a colour literal at all. The demo's palette was kept as it is (the user
chose 維持現狀 on 2026-10-10), so its literal count is a ceiling: a new colour there has to become a token, and a
future "make them look alike" is one line per role rather than a hunt through the stylesheet.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "jev_ultrafast" / "static"
TOKENS = STATIC / "tokens.css"
PANEL_CSS = ROOT / "extension" / "src" / "sidepanel.css"
PANEL_HTML = ROOT / "extension" / "src" / "sidepanel.html"
DEMO_CSS = STATIC / "style.css"

COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)")
USED = re.compile(r"var\((--[a-z0-9-]+)")
DEFINED = re.compile(r"^\s*(--[a-z0-9-]+)\s*:", re.M)
DEMO_CEILING = 119  # measured when the panel was migrated; it may shrink, never grow


def test_the_token_file_names_everything_the_panel_uses():
    defined = set(DEFINED.findall(TOKENS.read_text(encoding="utf-8")))
    used = set(USED.findall(PANEL_CSS.read_text(encoding="utf-8")))
    assert used, "the panel no longer uses any token"
    assert used <= defined, f"the panel uses names tokens.css does not define: {sorted(used - defined)}"


def test_the_panel_stylesheet_holds_no_colour_of_its_own():
    leftovers = COLOUR.findall(PANEL_CSS.read_text(encoding="utf-8"))
    assert not leftovers, f"sidepanel.css should use token names, found {leftovers[:4]}"


def test_the_panel_loads_the_tokens(): 
    assert '<link rel="stylesheet" href="tokens.css" />' in PANEL_HTML.read_text(encoding="utf-8")


def test_the_demo_palette_is_still_its_own_and_may_only_shrink():
    count = len(COLOUR.findall(DEMO_CSS.read_text(encoding="utf-8")))
    assert count <= DEMO_CEILING, (
        f"the demo has {count} colour literals, more than the {DEMO_CEILING} it had before the token work: "
        "a new colour should become a token instead"
    )
