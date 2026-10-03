"""Tests for the no-LLM Traderie entrypoint."""

import sys

from jev_ultrafast import no_llm


def test_main_passes_required_and_default_arguments(monkeypatch):
    calls = []

    def fake_capture(product_url, *, out=None, item_name=None, debug_artifacts=False):
        calls.append(
            {
                "product_url": product_url,
                "out": out,
                "item_name": item_name,
                "debug_artifacts": debug_artifacts,
            }
        )
        return "ok"

    monkeypatch.setattr(no_llm, "capture_and_analyze", fake_capture)
    monkeypatch.setattr(sys, "argv", ["jev-no-llm", "https://traderie.com/diablo2resurrected/product/shako"])

    out = no_llm.main()

    assert out == "ok"
    assert calls == [
        {
            "product_url": "https://traderie.com/diablo2resurrected/product/shako",
            "out": None,
            "item_name": None,
            "debug_artifacts": False,
        }
    ]


def test_main_passes_optional_arguments(monkeypatch, tmp_path):
    calls = []

    def fake_capture(product_url, *, out=None, item_name=None, debug_artifacts=False):
        calls.append(
            {
                "product_url": product_url,
                "out": out,
                "item_name": item_name,
                "debug_artifacts": debug_artifacts,
            }
        )
        return tmp_path

    monkeypatch.setattr(no_llm, "capture_and_analyze", fake_capture)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "jev-no-llm",
            "https://traderie.com/diablo2resurrected/product/shako",
            "--item-name",
            "Harlequin Crest",
            "--out",
            str(tmp_path / "artifacts"),
            "--debug-artifacts",
        ],
    )

    out = no_llm.main()

    assert out == tmp_path
    assert calls == [
        {
            "product_url": "https://traderie.com/diablo2resurrected/product/shako",
            "out": str(tmp_path / "artifacts"),
            "item_name": "Harlequin Crest",
            "debug_artifacts": True,
        }
    ]
