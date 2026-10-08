"""The page-side snapshot caps must still fit the backend's hard limits.

`snapshot.js` truncates the page text and the action list before sending an observation; the backend rejects a whole
observation that is over its limits instead of truncating it (`_clean_page` in `services/jevsvc/app.py`). If the two
numbers ever disagree, every call 400s. These tests read both sources and compare the numbers: no browser, no server.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SNAPSHOT = (REPO / "src" / "jev_ultrafast" / "snapshot.js").read_text(encoding="utf-8")
APP = (REPO / "services" / "jevsvc" / "app.py").read_text(encoding="utf-8")


def _app_limit(name: str) -> int:
    match = re.search(rf"^{name} = (\d+)$", APP, re.MULTILINE)
    assert match, f"{name} not found in services/jevsvc/app.py"
    return int(match.group(1))


def test_page_text_caps_equal_the_backend_text_limit():
    # The walker's stop condition and the final slice both cap the text; both must be the backend's MAX_TEXT.
    caps = {int(value) for value in re.findall(r"(?:length<|slice\(0,)(\d+)", SNAPSHOT)}
    assert caps == {_app_limit("MAX_TEXT")}


def test_every_action_a_snapshot_can_send_fits_the_backend_action_limit():
    max_actions = _app_limit("MAX_ACTIONS")
    # The page keeps this many real actions ...
    kept = int(re.search(r"actions\.splice\((\d+)\)", SNAPSHOT).group(1))
    assert kept == int(re.search(r"actions\.length-(\d+)", SNAPSHOT).group(1))
    # ... then appends the scroll/wait controls (one push each); each one counts against the backend's cap.
    tail = SNAPSHOT[SNAPSHOT.index(f"actions.splice({kept});") :]
    controls = len(re.findall(r"actions\.push\(", tail))
    assert controls > 0
    assert kept + controls <= max_actions
