"""Build extension/dist and the zip: uv run python extension/build.py [--api URL]."""

import argparse
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
DIST = EXT / "dist"
ZIP = EXT / "jev-traderie-extension.zip"
PKG = ROOT / "core" / "jev_ultrafast"
DEFAULT_API = "https://jev-trade-d2r.vercel.app"
SECRET_NAMES = ("TYPESAFE_API_KEY", "RUN_TOKEN_SECRET", "KV_REST_API_TOKEN")
SECRET_PATTERN = re.compile(r"TYPESAFE_API_KEY|RUN_TOKEN_SECRET|KV_REST_API_TOKEN|Bearer\s+[A-Za-z0-9._-]{20,}")
PAGE_SCRIPTS = ("snapshot.js", "after_input.js", "resolve_target.js", "settle.js")


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values.setdefault(key.strip(), value)
    return values


def secret_values() -> list[str]:
    dotenv = read_dotenv(ROOT / ".env")
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


def build(api: str, out: Path | None = None) -> int:
    """Builds into `out` (no zip) or, by default, extension/dist plus the zip friends receive."""
    DIST_DIR = out or DIST
    api = api.rstrip("/")
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True)

    for source in sorted((EXT / "src").rglob("*")):
        if source.is_file():
            target = DIST_DIR / source.relative_to(EXT / "src")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    manifest = (EXT / "manifest.json").read_text(encoding="utf-8").replace("__API__", api)
    (DIST_DIR / "manifest.json").write_text(manifest, encoding="utf-8")
    (DIST_DIR / "config.js").write_text(f'export const API_BASE = "{api}";\n', encoding="utf-8")

    page = DIST_DIR / "page"
    page.mkdir()
    for name in PAGE_SCRIPTS:
        shutil.copyfile(PKG / name, page / name)
    shutil.copyfile(PKG / "traderie" / "settled_page.js", page / "settled_page.js")
    shutil.copyfile(PKG / "static" / "csv.js", DIST_DIR / "csv.js")

    files = sorted(p for p in DIST_DIR.rglob("*") if p.is_file())
    leaked = scan(files)
    if leaked:
        for path in leaked:
            print(f"secret found in dist: {path.relative_to(DIST_DIR).as_posix()}", file=sys.stderr)
        shutil.rmtree(DIST_DIR)
        return 1

    if out is None:
        if ZIP.exists():
            ZIP.unlink()
        with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in files:
                archive.write(path, path.relative_to(DIST_DIR).as_posix())
    print(f"built {DIST_DIR} ({len(files)} files) for {api}")
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
