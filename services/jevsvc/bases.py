"""Item-name rules and the fixed list of plain item types ("bases") Jev may pick from.

The server owns the list: a client's own list is never used. Deployed, services/build.py writes `bases.json` next to
this module; in the source tree the same list is read from the extension's item table (one source of truth)."""

import json
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUNDLED = HERE / "bases.json"
SOURCE = HERE.parents[1] / "extension" / "src" / "traderie" / "data" / "items.json"
MAX_BASE_NAME = 80


def is_goal_safe(text) -> bool:
    """Text that is safe inside the goal: no control or invisible format characters (Cc, Cf) and no double quote,
    which frames the item name in the goal."""
    return (
        isinstance(text, str)
        and '"' not in text
        and not any(unicodedata.category(c) in ("Cc", "Cf") for c in text)
    )


def _is_base_list(names) -> bool:
    """A usable list: non-empty, unique, and every name is goal-safe, already trimmed and within MAX_BASE_NAME."""
    return (
        isinstance(names, list)
        and bool(names)
        and all(is_goal_safe(n) and n == n.strip() and 0 < len(n) <= MAX_BASE_NAME for n in names)
        and len(set(names)) == len(names)
    )


def load(path: Path | None = None) -> tuple[str, ...]:
    path = path or (BUNDLED if BUNDLED.exists() else SOURCE)
    names = json.loads(path.read_text(encoding="utf-8"))["bases"]
    if not _is_base_list(names):
        raise ValueError(f"{path.name}: 'bases' must be a non-empty list of unique item names")
    return tuple(names)
