"""Build extension/dist and the zip: uv run python extension/build.py [--api URL]."""

import argparse
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from jev_ultrafast.config import load_dotenv  # noqa: E402

EXT = ROOT / "extension"
DIST = EXT / "dist"
ZIP = EXT / "jev-traderie-extension.zip"
PKG = ROOT / "src" / "jev_ultrafast"
DEFAULT_API = "https://jev-trade-d2r.vercel.app"
SECRET_NAMES = ("TYPESAFE_API_KEY", "RUN_TOKEN_SECRET", "KV_REST_API_TOKEN")
SECRET_PATTERN = re.compile(r"TYPESAFE_API_KEY|RUN_TOKEN_SECRET|KV_REST_API_TOKEN|Bearer\s+[A-Za-z0-9._-]{20,}")
PAGE_SCRIPTS = ("snapshot.js", "after_input.js", "resolve_target.js", "covered_overlay.js", "settle.js")
# Page scripts that sit beside the traderie modules rather than at the package root.
PAGE_SCRIPTS_SUBDIR = ("settled_page.js", "fetch_json.js")
# Shared assets the panel also needs: the CSV export and the colour tokens (see tests/test_ui_tokens.py).
STATIC_FILES = ("csv.js", "tokens.css")
# What extension/src/traderie/lookup.js (indexTables, productUrlFor) reads; audit-only fields stay in the source table.
SHIPPED_TABLE_KEYS = ("generated_at", "version", "products", "zh", "bases", "game_only")
SHIPPED_PRODUCT_KEYS = ("name", "slug")
# Editor and tool leftovers that can land inside extension/src: a build must never copy them into the shipped tree
# (a backup of a module once rode along into dist and the zip: 75 files where the source has 70).
NOT_SHIPPED_SUFFIXES = (".bak", ".orig", ".tmp", ".swp", "~")


def ship_table(table: dict) -> dict:
    """The committed table reduced to what the extension reads at runtime (`lookup.js` indexTables/productUrlFor)."""
    shipped = {key: table[key] for key in SHIPPED_TABLE_KEYS}
    shipped["products"] = [{key: product[key] for key in SHIPPED_PRODUCT_KEYS} for product in table["products"]]
    return shipped


def secret_values() -> list[str]:
    dotenv: dict[str, str] = {}
    load_dotenv(ROOT / ".env", environ=dotenv)
    values = []
    for name in SECRET_NAMES:
        value = os.environ.get(name) or dotenv.get(name) or ""
        if len(value) >= 8:
            values.append(value)
    return values


def scan(files: list[Path]) -> list[Path]:
    secrets = secret_values()
    leaked = []
    for path in files:
        text = path.read_bytes().decode("utf-8", errors="ignore")
        if SECRET_PATTERN.search(text) or any(secret in text for secret in secrets):
            leaked.append(path)
    return leaked


def is_shipped(source: Path) -> bool:
    """True for a source file the extension ships; backup and scratch files (NOT_SHIPPED_SUFFIXES) stay behind."""
    return source.is_file() and not source.name.endswith(NOT_SHIPPED_SUFFIXES)


def copy_file(source: Path, target: Path) -> None:
    """Copies one file, creating the folders it lands in (the built tree mirrors the source layout)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def write_shipped_table(dist_dir: Path) -> None:
    """`items.json` ships as one line: the source stays readable, the shipped copy is what the panel parses."""
    items = dist_dir / "traderie" / "data" / "items.json"
    table = ship_table(json.loads(items.read_text(encoding="utf-8")))
    items.write_text(json.dumps(table, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_manifest(dist_dir: Path, api: str) -> None:
    """`manifest.json` ships with its `__API__` placeholder replaced by the backend this build points at."""
    manifest = (EXT / "manifest.json").read_text(encoding="utf-8").replace("__API__", api)
    (dist_dir / "manifest.json").write_text(manifest, encoding="utf-8")


def write_config(dist_dir: Path, api: str) -> None:
    """`config.js` is the one file the panel reads its backend address from."""
    (dist_dir / "config.js").write_text(f'export const API_BASE = "{api}";\n', encoding="utf-8")


def build(api: str, out: Path | None = None) -> int:
    """Builds into `out` (no zip) or, by default, extension/dist plus the zip friends receive."""
    dist_dir = out or DIST
    api = api.rstrip("/")
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
    dist_dir.mkdir(parents=True)

    for source in sorted((EXT / "src").rglob("*")):
        if is_shipped(source):
            copy_file(source, dist_dir / source.relative_to(EXT / "src"))
    write_shipped_table(dist_dir)
    write_manifest(dist_dir, api)
    write_config(dist_dir, api)

    page = dist_dir / "page"
    page.mkdir()
    for name in PAGE_SCRIPTS:
        copy_file(PKG / name, page / name)
    for name in PAGE_SCRIPTS_SUBDIR:
        copy_file(PKG / "traderie" / name, page / name)
    for name in STATIC_FILES:
        copy_file(PKG / "static" / name, dist_dir / name)

    files = sorted(p for p in dist_dir.rglob("*") if p.is_file())
    leaked = scan(files)
    if leaked:
        for path in leaked:
            print(f"secret found in dist: {path.relative_to(dist_dir).as_posix()}", file=sys.stderr)
        shutil.rmtree(dist_dir)  # never ship, and never zip, a dist that carries a secret
        return 1

    if out is None:
        if ZIP.exists():
            ZIP.unlink()
        with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in files:
                archive.write(path, path.relative_to(dist_dir).as_posix())
    print(f"built {dist_dir} ({len(files)} files) for {api}")
    if out is None:
        print(f"zip: {ZIP}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=DEFAULT_API, help="backend base URL baked into the extension")
    parser.add_argument("--out", type=Path, help="build only into this folder (no zip); default extension/dist")
    args = parser.parse_args()
    return build(args.api, args.out)


if __name__ == "__main__":
    sys.exit(main())
