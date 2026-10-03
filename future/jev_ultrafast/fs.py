"""Filesystem helpers: atomic writes and utf-8 reads."""

from __future__ import annotations

import os
from pathlib import Path


def write_text(path: Path | str, text: str) -> None:
    """Atomically write text via temporary sibling replacement."""
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


def write_bytes(path: Path | str, data: bytes) -> None:
    """Atomically write binary data via temporary sibling replacement."""
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f"{target.name}.tmp")
    try:
        temp.write_bytes(data)
        os.replace(temp, target)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass


def read_text(path: Path | str) -> str:
    """Read a text file strictly with utf-8 encoding."""
    return Path(path).read_text(encoding="utf-8")
