"""Stage a deployable copy of the backend in services/.build/."""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PKG = ROOT.parent / "core" / "jev_ultrafast"
BUILD = ROOT / ".build"
KEEP = ".vercel"


def main() -> None:
    if BUILD.exists():
        for child in BUILD.iterdir():
            if child.name != KEEP:
                shutil.rmtree(child) if child.is_dir() else child.unlink()
    BUILD.mkdir(exist_ok=True)
    for name in ("jevsvc",):
        shutil.copytree(ROOT / name, BUILD / name, ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("app.py", "requirements.txt", "vercel.json", ".python-version"):
        shutil.copy2(ROOT / name, BUILD / name)
    target = BUILD / "jev_ultrafast"
    (target / "traderie").mkdir(parents=True)
    for name in ("config.py", "fs.py", "model.py", "questions.py"):
        shutil.copy2(PKG / name, target / name)
    shutil.copy2(PKG / "traderie" / "site.py", target / "traderie" / "site.py")
    # The real package __init__ imports agent/browser, which would pull browser_harness.
    (target / "__init__.py").write_text('"""Slim copy of jev_ultrafast for the backend."""\n', encoding="utf-8")
    (target / "traderie" / "__init__.py").write_text('"""Traderie site rules."""\n', encoding="utf-8")
    print("next: cd services/.build && npx vercel@latest deploy --prod")


if __name__ == "__main__":
    main()
