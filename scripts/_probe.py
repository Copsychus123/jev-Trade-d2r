"""What the Traderie probe scripts (probe_stats, probe_listing, probe_blocking) share: a page tab that can wait for
the text to settle and call the site's own API, the JSON writer, and readers for the two API answers every probe
starts from. Import it after `scripts/` is on `sys.path`, like `_cdp`."""

import asyncio
import json
import time
from pathlib import Path

from _cdp import Panel

ROOT = Path(__file__).resolve().parents[1]
FETCH_JSON = (ROOT / "src" / "jev_ultrafast" / "traderie" / "fetch_json.js").read_text(encoding="utf-8").strip()
GAMES_PATH = "/api/games?game=diablo2resurrected"
PROPERTIES_PATH = "/api/diablo2resurrected/properties?global=true"


class Tab(Panel):
    async def settled_text(self, seconds: float = 40) -> tuple[str, str]:
        """(url, visible text) once the text stopped changing for two reads 1.5 s apart."""
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            await asyncio.sleep(1.5)
            state = await self.evaluate(
                "JSON.stringify({u: location.href, r: document.readyState, "
                "t: document.body ? document.body.innerText : ''})"
            )
            page = json.loads(state)
            if page["r"] == "complete" and page["t"] == last and len(page["t"]) > 200:
                return page["u"], page["t"]
            last = page["t"]
        raise TimeoutError("頁面沒有穩定下來")

    async def fetch_json(self, path: str) -> dict:
        return await self.evaluate(f"({FETCH_JSON})({json.dumps(path)})")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")


def game_features(body) -> list:
    """The `features` flags in the body of `GAMES_PATH` (`{games: {...}}` or the game record itself)."""
    if not isinstance(body, dict):
        return []
    found = body.get("games", body)
    return (found.get("features") if isinstance(found, dict) else None) or []


def property_list(reply: dict) -> list[dict]:
    """The `properties` list in the reply of `PROPERTIES_PATH` ([] when the reply has no such body)."""
    return reply["body"].get("properties", []) if isinstance(reply.get("body"), dict) else []
