"""Real Chrome + TypeSafe + Traderie: the extension runs one query through its side panel."""

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.live


def test_extension_runs_a_real_query_end_to_end():
    result = subprocess.run(
        [sys.executable, "scripts/extension_e2e.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=420,
    )
    assert result.returncode == 0, result.stdout + result.stderr
