"""Filesystem helpers: atomic text writes."""

from __future__ import annotations

import os
from pathlib import Path


def write_text(path: Path | str, text: str) -> None:
    """Write text atomically: a temporary sibling is replaced into place, and removed on any failure."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f"{target.name}.tmp")
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, target)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
