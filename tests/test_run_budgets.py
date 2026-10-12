"""The run budgets live in three files that cannot share code: the JS extension, the Python backend, the tooling.

A drift here is user-visible: the extension would stop asking (or keep asking) at a different point than the server
allows, and the run would end in the middle with an error. The constants already name each other in comments; this
test is what actually keeps them in step, the same way `test_docs_paths.py` keeps the documented paths honest.
"""

import re
from pathlib import Path

from tests.test_docs_numbers import _code_number, _doc_number

ROOT = Path(__file__).resolve().parents[1]


def test_the_jev_call_budget_is_the_same_everywhere():
    assert (
        _code_number("extension/src/agent.js", r"const JEV_CALL_LIMIT = (\d+);")
        == _code_number("services/jevsvc/app.py", r"MAX_MODEL_CALLS = (\d+)")
        == _code_number("scripts/extension_batch.py", r"JEV_CALL_LIMIT = (\d+)")
        == _doc_number("AGENTS.md", r"one budget of (\d+) Jev calls per run")
    )


def test_the_action_budget_is_the_same_everywhere():
    assert (
        _code_number("extension/src/agent.js", r"const MAX_STEPS = (\d+);")
        == _code_number("services/jevsvc/app.py", r"MAX_HISTORY = (\d+)")
        == _code_number("src/jev_ultrafast/config.py", r"MAX_STEPS = (\d+)")
        == _doc_number("AGENTS.md", r"\((\d+) actions, \d+ decisions,")
    )


def test_the_browser_cache_cap_is_the_size_the_rulebook_states():
    assert _code_number("src/jev_ultrafast/chrome.py", r"DISK_CACHE_BYTES = (\d+) \* 1024 \* 1024") == _doc_number(
        "AGENTS.md", r"page cache is capped at (\d+) MB"
    )


def _budget_rows() -> dict[str, list[str]]:
    """docs/design.md's Budgets table, one entry per owner (the header and the rule line are skipped)."""
    document = (ROOT / "docs" / "design.md").read_text(encoding="utf-8")
    assert "## Budgets" in document, "docs/design.md no longer has a Budgets section"
    section = document.split("## Budgets", 1)[1].split("\n## ", 1)[0]
    rows: dict[str, list[str]] = {}
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells or cells[0] in ("", "Owner") or all(set(cell) <= {"-", ":"} for cell in cells):
            continue
        rows[cells[0]] = cells[1:]
    return rows


def test_the_design_document_states_the_same_budgets_as_the_code():
    """`docs/design.md` is the document the rulebook sends a reader to for the budgets; it states the same numbers
    the code declares, and nothing but this test keeps the two from drifting apart."""
    rows = _budget_rows()

    def first_number(cell: str) -> int | None:
        found = re.findall(r"\d+", cell)
        return int(found[0]) if found else None

    def row(hint: str) -> list[str]:
        for owner, cells in rows.items():
            if hint in owner:
                return cells
        raise AssertionError(f"docs/design.md's Budgets table has no row for {hint}")

    steps = _code_number("src/jev_ultrafast/config.py", r"MAX_STEPS = (\d+)")
    calls = _code_number("extension/src/agent.js", r"const JEV_CALL_LIMIT = (\d+);")
    core, extension, backend = row("config.py"), row("agent.js"), row("app.py")
    assert first_number(core[0]) == steps and first_number(core[1]) == steps * 2
    assert first_number(extension[0]) == steps and first_number(extension[1]) == calls
    assert first_number(backend[1]) == calls
