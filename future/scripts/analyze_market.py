"""CLI script to analyze Traderie market capture data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from jev_ultrafast.traderie import (
    analyze_market_data,
    generate_markdown_report,
    parse_recent_trades,
    parse_trading_html,
    parse_trading_txt,
)


def run_analysis(
    folder: Path,
    item_name: str = "Harlequin Crest",
    item_slug: str = "harlequin-crest",
    *,
    include_raw: bool = False,
):
    trading_cards = []
    # Try parsing HTML first (most structured), fallback or supplement with txt
    html_file = folder / "trading.html"
    txt_file = folder / "trading.txt"

    if html_file.exists():
        trading_cards = parse_trading_html(
            html_file.read_text(encoding="utf-8"),
            item_name=item_name,
        )
    elif txt_file.exists():
        trading_cards = parse_trading_txt(
            txt_file.read_text(encoding="utf-8"),
            item_name=item_name,
        )

    # Recent trades analysis
    recent_txt_file = folder / "recent.txt"
    recent_observe_file = folder / "recent.observe.json"

    recent_text = recent_txt_file.read_text(encoding="utf-8") if recent_txt_file.exists() else ""
    recent_observe = (
        json.loads(recent_observe_file.read_text(encoding="utf-8"))
        if recent_observe_file.exists()
        else None
    )

    recent_result = parse_recent_trades(recent_text, recent_observe)

    analysis_data = analyze_market_data(
        trading_cards=trading_cards,
        recent_result=recent_result,
        item_name=item_name,
        item_slug=item_slug,
        include_raw=include_raw,
    )

    report_md = generate_markdown_report(analysis_data)

    out_json = folder / "analysis.json"
    out_md = folder / "analysis_report.md"

    out_json.write_text(json.dumps(analysis_data, indent=2, ensure_ascii=False), encoding="utf-8")
    out_md.write_text(report_md, encoding="utf-8")

    print(f"Analysis successfully written to:\n- {out_json}\n- {out_md}")
    print(f"Report mode: {analysis_data['report_mode']}")
    print(f"Valid listings: {analysis_data['summary']['valid_count']}")


def main():
    parser = argparse.ArgumentParser(description="Analyze Traderie capture data")
    parser.add_argument(
        "--folder",
        default="artifacts/traderie/capture/harlequin-crest",
        help="Capture folder path",
    )
    parser.add_argument("--item-name", default="Harlequin Crest", help="Item name")
    parser.add_argument("--item-slug", default="harlequin-crest", help="Item URL slug")
    parser.add_argument("--include-raw", action="store_true", help="Preserve raw listing text in JSON")
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.exists():
        raise SystemExit(f"Folder does not exist: {folder}")

    run_analysis(
        folder,
        item_name=args.item_name,
        item_slug=args.item_slug,
        include_raw=args.include_raw,
    )


if __name__ == "__main__":
    main()
