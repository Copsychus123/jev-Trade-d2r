"""Export traderie.com cookies from the running Chrome profile into .env (no values printed)."""

import sys
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp

from jev_ultrafast import fs
from jev_ultrafast.config import get_settings

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
ORIGIN = "https://www.traderie.com/"


def upsert_dotenv(path: Path | str, updates: Mapping[str, str]) -> None:
    """Update or append specific KEY=value pairs in a dotenv file, preserving comments."""
    target = Path(path)
    existing_lines: list[str] = []
    if target.exists():
        existing_lines = fs.read_text(target).splitlines()

    pending = dict(updates)
    result_lines: list[str] = []
    for line in existing_lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in pending:
                result_lines.append(f"{key}={pending.pop(key)}")
                continue
        result_lines.append(line)

    for k, v in pending.items():
        result_lines.append(f"{k}={v}")

    fs.write_text(target, "\n".join(result_lines) + "\n")


def main():
    ensure_daemon()
    target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
    try:
        session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
        resp = cdp("Network.getCookies", session_id=session, urls=[ORIGIN])
    finally:
        cdp("Target.closeTarget", targetId=target)
    cookies = resp.get("cookies", [])
    names = sorted(c["name"] for c in cookies)
    print("traderie.com cookies found:", ", ".join(names) if names else "(none)")

    if not cookies:
        print("NOT WRITTEN: no traderie.com cookies in this Chrome profile.")
        print("ACTION: open https://www.traderie.com in this Chrome and sign in "
              "(Discord/Google), then rerun scripts/export_traderie_session.py")
        return 1

    settings = get_settings()
    session_name = settings.traderie_session_cookie_name
    if session_name in names:
        value = next(c["value"] for c in cookies if c["name"] == session_name)
        upsert_dotenv(ENV_PATH, {"TRADERIE_SESSION_TOKEN": value})
        print("Wrote TRADERIE_SESSION_TOKEN in .env")
        written = "TRADERIE_SESSION_TOKEN"
    else:
        pairs = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
        upsert_dotenv(ENV_PATH, {"TRADERIE_COOKIE": pairs})
        print("Wrote TRADERIE_COOKIE in .env")
        written = "TRADERIE_COOKIE"
    print(f"SUCCESS: {written} set from {len(cookies)} cookie(s); values not printed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
