"""Stage a deployable copy of the backend in services/.build/ (or in the directory given as the first argument)."""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from jevsvc import bases  # noqa: E402

PKG = ROOT.parent / "src" / "jev_ultrafast"
BUILD = ROOT / ".build"
KEEP = ".vercel"


def build(target: Path = BUILD) -> None:
    if target.exists():
        for child in target.iterdir():
            if child.name == KEEP:
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "jevsvc", target / "jevsvc", ignore=shutil.ignore_patterns("__pycache__", "bases.json"))
    for name in ("app.py", "requirements.txt", "vercel.json", ".python-version"):
        shutil.copy2(ROOT / name, target / name)
    # The server's own list of item types Jev may pick from (the extension's item table has much more than that).
    names = bases.load(bases.SOURCE)
    (target / "jevsvc" / "bases.json").write_text(json.dumps({"bases": names}, ensure_ascii=False), encoding="utf-8")
    package = target / "jev_ultrafast"
    (package / "traderie").mkdir(parents=True)
    for name in ("config.py", "model.py", "questions.py"):
        shutil.copy2(PKG / name, package / name)
    shutil.copy2(PKG / "traderie" / "site.py", package / "traderie" / "site.py")
    # The real package __init__ imports agent/browser, which would pull browser_harness.
    (package / "__init__.py").write_text('"""Slim copy of jev_ultrafast for the backend."""\n', encoding="utf-8")
    (package / "traderie" / "__init__.py").write_text('"""Traderie site rules."""\n', encoding="utf-8")


def main() -> None:
    build(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else BUILD)
    print("next: cd services/.build && npx vercel@latest deploy --prod")


if __name__ == "__main__":
    main()
