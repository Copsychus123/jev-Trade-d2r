"""Smoke test for scripts/check_guards.py.

Runs the guard-check script against a real headless Chrome (the dedicated one `Browser` starts itself) with an
inline HTML page: no model calls and no external websites. It starts a browser, so it belongs to the live group.
"""

import pytest

from jev_ultrafast.chrome import close_chrome
from scripts import check_guards


@pytest.mark.live
def test_check_guards_reports_pass_count(capsys):
    try:
        check_guards.main()
    finally:
        close_chrome()
    out = capsys.readouterr().out
    lines = out.strip().splitlines()
    assert lines, "guard script printed nothing"
    pass_lines = [line for line in lines if line.startswith("PASS: ")]
    assert pass_lines, f"no PASS summary in guard output: {out!r}"
    count = int(pass_lines[-1].split()[1])
    assert count > 0, "guard script reported zero passing checks"
    assert "no model calls" in pass_lines[-1]
    # The individual check names must all appear before the PASS summary.
    assert len(lines) >= count + 1
