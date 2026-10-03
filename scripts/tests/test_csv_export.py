"""CSV export rules, exercised through node (the helper has no DOM dependency)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

CSV_JS = (Path(__file__).resolve().parent.parent.parent / "future" / "jev_ultrafast" / "static" / "csv.js").as_uri()
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def run_node(expression: str):
    script = f'import("{CSV_JS}").then((m) => console.log(JSON.stringify({expression})));'
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def test_commas_quotes_and_newlines_are_escaped_and_the_file_starts_with_a_bom():
    text = run_node('m.toCsv(["賣家", "要價"], [["a,b", \'say "hi"\'], ["line1\\nline2", null]])')
    assert text == '\ufeff賣家,要價\r\n"a,b","say ""hi"""\r\n"line1\nline2",\r\n'


def test_cells_that_a_spreadsheet_would_run_as_formulas_get_a_leading_apostrophe():
    cells = run_node('["=SUM(1)", "+1", "-1", "@x", "plain", "1 X Mal Rune"].map(m.csvCell)')
    assert cells == ["'=SUM(1)", "'+1", "'-1", "'@x", "plain", "1 X Mal Rune"]


def test_no_rows_still_gives_the_header_and_the_file_name_drops_unsafe_characters():
    assert run_node('m.toCsv(["a", "b"], [])') == "\ufeffa,b\r\n"
    assert run_node('m.csvFileName("Harlequin Crest", "目前掛單")') == "traderie-Harlequin Crest-目前掛單.csv"
    assert run_node('m.csvFileName("../x\\\\y:z", "近期成交")') == "traderie-___x_y_z-近期成交.csv"
