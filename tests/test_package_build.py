"""The built wheel ships the files the demo page needs - including the ones that are not Python.

`uv build` was in the commands from the start, and nothing looked at what it produced. The demo page is served from
`src/jev_ultrafast/static/`, so a wheel that drops (say) `tokens.css` - added in the token work - installs a package
whose demo has no palette, and nothing in the suite would say a word. This builds the wheel into a temporary
directory and reads its file list.
"""

import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC_ASSETS = ("index.html", "app.js", "style.css", "csv.js", "tokens.css")


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not installed")
def test_the_wheel_carries_the_demo_page_and_nothing_it_should_not(tmp_path):
    result = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        stdin=subprocess.DEVNULL,  # see tests/test_csv_export.py: an invalid inherited stdin fails with WinError 6
        timeout=300,
    )
    assert result.returncode == 0, (result.stdout + result.stderr)[-2000:]
    wheels = list(tmp_path.glob("*.whl"))
    assert len(wheels) == 1, f"expected one wheel, found {wheels}"

    names = zipfile.ZipFile(wheels[0]).namelist()
    assert len(names) >= 30, f"only {len(names)} files in the wheel: the build changed shape"
    missing = [asset for asset in STATIC_ASSETS if not any(name.endswith(f"/static/{asset}") for name in names)]
    assert not missing, f"the wheel does not carry the demo page's {missing}"
    leaked = [name for name in names if name.startswith(("tests/", "artifacts/", "dist/"))]
    assert not leaked, f"the wheel should not carry {leaked[:4]}"
    assert any(name.endswith(".dist-info/entry_points.txt") for name in names), "the console script is gone"
