"""Offline checks for the DOM snapshot's native control mapping. No paid APIs."""

import json
import subprocess
from pathlib import Path

import pytest

SNAPSHOT = Path(__file__).resolve().parents[1] / "jev_ultrafast" / "snapshot.js"


def snapshot_role(tag, type_="", *, explicit_role=None, content_editable=False):
    src = SNAPSHOT.read_text(encoding="utf-8")
    start = src.index("const roles=")
    end = src.index("\n  cache.pageKey")
    script = src[start:end] + (
        "const e={"
        f"tagName:{tag!r},type:{type_!r},isContentEditable:{str(bool(content_editable)).lower()},"
        f"getAttribute:(k)=>k==='role'?{json.dumps(explicit_role)}:null"
        "};process.stdout.write(JSON.stringify(role(e)));"
    )
    result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


@pytest.mark.parametrize("type_", ["date", "datetime-local", "month", "week", "time"])
def test_native_date_and_time_inputs_are_textboxes(type_):
    assert snapshot_role("INPUT", type_) == "textbox"


@pytest.mark.parametrize(
    ("type_", "expected"),
    [
        ("text", "textbox"),
        ("email", "textbox"),
        ("url", "textbox"),
        ("tel", "textbox"),
        ("search", "searchbox"),
        ("number", "spinbutton"),
        ("checkbox", "checkbox"),
        ("radio", "radio"),
        ("submit", "button"),
    ],
)
def test_existing_input_roles_stay_mapped(type_, expected):
    assert snapshot_role("INPUT", type_) == expected


def test_unknown_input_type_is_still_skipped():
    assert snapshot_role("INPUT", "color") is None
    assert snapshot_role("INPUT", "range") is None
    assert snapshot_role("INPUT", "hidden") is None
