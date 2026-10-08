"""The run budgets live in three files that cannot share code: the JS extension, the Python backend, the tooling.

A drift here is user-visible: the extension would stop asking (or keep asking) at a different point than the server
allows, and the run would end in the middle with an error. The constants already name each other in comments; this
test is what actually keeps them in step, the same way `test_docs_paths.py` keeps the documented paths honest.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _declared(path: str, pattern: str) -> int:
    """The number a source file declares with `pattern` (one capture group); fails loudly when the line is gone."""
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(pattern, text)
    assert match, f"{path} no longer declares {pattern!r}"
    return int(match.group(1))


def test_the_jev_call_budget_is_the_same_in_all_three_places():
    assert (
        _declared("extension/src/agent.js", r"const JEV_CALL_LIMIT = (\d+);")
        == _declared("services/jevsvc/app.py", r"MAX_MODEL_CALLS = (\d+)")
        == _declared("scripts/extension_batch.py", r"JEV_CALL_LIMIT = (\d+)")
    )


def test_the_action_budget_is_the_same_in_all_three_places():
    assert (
        _declared("extension/src/agent.js", r"const MAX_STEPS = (\d+);")
        == _declared("services/jevsvc/app.py", r"MAX_HISTORY = (\d+)")
        == _declared("src/jev_ultrafast/config.py", r"MAX_STEPS = (\d+)")
    )
