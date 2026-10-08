"""The extension's fixed item-type list must equal the one the server validates against.

`extension/src/traderie/data/items.json` holds the `bases` the extension offers; the server owns its own copy
(`services/jevsvc/bases.py`, written to `bases.json` by `services/build.py`) and rejects any other value as `bad_base`
(`services/jevsvc/app.py`). Rebuild the table without redeploying and the extension offers a base the server refuses.
"""

import json
from pathlib import Path

from jevsvc import bases

REPO = Path(__file__).resolve().parents[1]
ITEMS = REPO / "extension" / "src" / "traderie" / "data" / "items.json"


def test_the_extension_offers_exactly_the_bases_the_server_accepts():
    extension = json.loads(ITEMS.read_text(encoding="utf-8"))["bases"]
    # `load()` prefers a deployed bases.json when it exists, else falls back to the extension's table.
    assert list(bases.load()) == extension
