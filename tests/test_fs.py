"""Unit tests for jev_ultrafast.fs: atomic writes leave no temporary file behind when the write fails."""

import pathlib

import pytest

from jev_ultrafast import fs


def test_a_failed_write_removes_the_temporary_file_and_leaves_the_original_target_untouched(tmp_path, monkeypatch):
    target = tmp_path / "report.md"
    target.write_text("original", encoding="utf-8")
    real_write_text = pathlib.Path.write_text

    def exploding_write_text(self, *args, **kwargs):
        real_write_text(self, "half-written", encoding="utf-8")
        raise OSError("disk full")

    monkeypatch.setattr(pathlib.Path, "write_text", exploding_write_text)
    with pytest.raises(OSError, match="disk full"):
        fs.write_text(target, "new content")
    assert not (tmp_path / "report.md.tmp").exists()
    assert target.read_text(encoding="utf-8") == "original"
