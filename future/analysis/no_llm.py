"""No-LLM Traderie capture entrypoint for known product URLs."""

import argparse

from scripts.capture_traderie import capture_and_analyze


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product_url", help="Traderie product URL")
    parser.add_argument("--item-name", help="Item name (derived from title if omitted)")
    parser.add_argument("--out", help="Output directory")
    parser.add_argument("--debug-artifacts", action="store_true", help="Preserve HTML/TXT/JPG/observe dumps")
    args = parser.parse_args()

    return capture_and_analyze(
        args.product_url,
        item_name=args.item_name,
        out=args.out,
        debug_artifacts=args.debug_artifacts,
    )


if __name__ == "__main__":
    main()
