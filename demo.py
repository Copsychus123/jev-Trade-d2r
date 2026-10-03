"""Start the Jev inspector: `uv run python demo.py`. Asks you to log in to Traderie first when needed."""

import os

from scripts.login import main as login
from scripts.login import needs_login

from jev_ultrafast.chrome import chrome_mode
from jev_ultrafast.config import load_dotenv
from jev_ultrafast.demo import main


def ensure_login():
    """Only the dedicated Chrome keeps its own login; in `existing` mode the user's Chrome is already theirs."""
    load_dotenv()
    if chrome_mode() == "existing" or not needs_login():
        return
    print("專用 Chrome 還沒有登入 Traderie，先開視窗讓你登入一次。", flush=True)
    mode = os.environ.get("JEV_CHROME")
    try:
        login()  # opens a visible window and waits for Enter
    finally:
        if mode is None:
            os.environ.pop("JEV_CHROME", None)
        else:
            os.environ["JEV_CHROME"] = mode


if __name__ == "__main__":
    ensure_login()
    main()
