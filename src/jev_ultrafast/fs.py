"""Filesystem helpers: atomic text writes."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path


def _atomic_write(path: Path | str, write: Callable[[Path], None]) -> None:
    """Atomically write via temporary sibling replacement."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f"{target.name}.tmp")
    try:
        write(temp)
        os.replace(temp, target)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass


def write_text(path: Path | str, text: str) -> None:
    _atomic_write(path, lambda temp: temp.write_text(text, encoding="utf-8"))
