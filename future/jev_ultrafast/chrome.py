"""Dedicated Chrome for automation: headless by default, the user's own Chrome on request."""

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

try:
    from browser_harness import _ipc
    from browser_harness import admin as _admin
    from browser_harness import helpers as _helpers
except ImportError:  # offline tests install a stub package without these modules
    _ipc = _admin = _helpers = None

from .config import VIEWPORT_HEIGHT, VIEWPORT_WIDTH

CHROME_PORT = 9355
PROFILE_DIR = Path(__file__).resolve().parent.parent / ".tmp-jev-chrome"
_MODES = ("headless", "window", "existing")
_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
_LAUNCHED: subprocess.Popen | None = None
_DAEMON: str | None = None
_ATEXIT_REGISTERED = False

# Hosts of advertising and tracking scripts. They are blocked only in the dedicated Chrome: they cost memory and
# keep the page changing, and none of them carries listing or trade data.
BLOCKED_HOSTS = (
    "mediavine.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.google.com",
    "tiktok.com",
    "grow.me",
    "maze.co",
    "sentry.io",
    "ad-delivery.net",
    "adnxs.com",
    "criteo.com",
    "scorecardresearch.com",
)
# The page cache is capped (it keeps repeat visits fast). These re-creatable folders (small caches and the
# models/components Chrome downloads on its own) are removed when the dedicated Chrome closes. Cookies and
# local storage (the login) stay.
DISK_CACHE_BYTES = 50 * 1024 * 1024
CACHE_DIRS = (
    "Default/GPUCache",
    "Default/Service Worker",
    "GrShaderCache",
    "ShaderCache",
    "optimization_guide_model_store",
    "component_crx_cache",
    "WasmTtsEngine",
)


def blocked_url_patterns() -> list[str]:
    return [f"*://*.{host}/*" for host in BLOCKED_HOSTS] + [f"*://{host}/*" for host in BLOCKED_HOSTS]


IMAGE_EXTENSIONS = ("png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico")


def image_url_patterns() -> list[str]:
    """Picture URLs, blocked only when nobody looks at screenshots (they cost load time, not data)."""
    return [f"*.{ext}*" for ext in IMAGE_EXTENSIONS]


def chrome_mode() -> str:
    mode = (os.environ.get("JEV_CHROME") or "").strip() or "headless"
    if mode not in _MODES:
        raise ValueError("JEV_CHROME must be headless, window or existing")
    return mode


def chrome_binary() -> str:
    raw = os.environ.get("BH_CHROME_PATH") or os.environ.get("CHROME_PATH")
    if raw and Path(raw).is_file():
        return str(Path(raw))
    for candidate in _CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    found = shutil.which("google-chrome") or shutil.which("chromium")
    if found:
        return found
    raise RuntimeError("找不到 Chrome，請安裝 Chrome 或設定 CHROME_PATH")


def _answering(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/json/version", timeout=1):
            return True
    except Exception:
        return False


_ENSURE_LOCK = threading.Lock()


def ensure_chrome() -> str | None:
    """Thread-safe: the demo pre-warms Chrome in the background while a request may ask for it too."""
    with _ENSURE_LOCK:
        return _ensure_chrome()


def _ensure_chrome() -> str | None:
    """Point browser_harness at the dedicated Chrome, starting it if needed.

    Returns None in `existing` mode, "reused" when the port already answered,
    "started" when this call launched Chrome.
    """
    global _LAUNCHED, _DAEMON, _ATEXIT_REGISTERED
    mode = chrome_mode()
    if mode == "existing":
        return None
    url = f"http://127.0.0.1:{CHROME_PORT}"
    # One daemon per process: a daemon left over from an earlier run still points at a dead Chrome.
    _DAEMON = f"jev-{os.getpid()}"
    os.environ["BU_NAME"] = _DAEMON
    os.environ["BU_CDP_URL"] = url
    _bind_harness(_DAEMON)
    if not _ATEXIT_REGISTERED:
        atexit.register(close_chrome)
        _ATEXIT_REGISTERED = True
    if _answering(url):
        return "reused"
    _LAUNCHED = subprocess.Popen(
        [
            chrome_binary(),
            *(["--headless=new"] if mode == "headless" else []),
            f"--remote-debugging-port={CHROME_PORT}",
            f"--user-data-dir={PROFILE_DIR}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--mute-audio",
            "--disable-gpu",
            "--disable-component-update",
            f"--disk-cache-size={DISK_CACHE_BYTES}",
            "--media-cache-size=1",
            "--renderer-process-limit=1",
            "--disable-site-isolation-trials",
            "--disable-features=IsolateOrigins,site-per-process,OptimizationHints,"
            "OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel",
            f"--window-size={VIEWPORT_WIDTH},{VIEWPORT_HEIGHT}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if _answering(url):
            return "started"
        time.sleep(0.3)
    close_chrome()
    raise RuntimeError("專用 Chrome 沒有在 30 秒內啟動")


def _bind_harness(name: str) -> None:
    """browser_harness reads BU_NAME once, at import. Point the modules we imported at our daemon."""
    if _admin is None or _helpers is None or _ipc is None:
        return
    _admin.NAME = name
    _helpers.NAME = name
    _helpers.SOCK = _ipc.sock_addr(name)


def _stop_daemon(name: str) -> None:
    """The browser_harness daemon of this process holds a socket to the Chrome we just stopped."""
    if _admin is None:
        return
    try:
        _admin.restart_daemon(name)
    except Exception:
        pass


def _graceful_close(timeout: float = 3.0) -> bool:
    """Ask the dedicated Chrome to quit through its own DevTools socket (about 0.5 s). True once the port is dead."""
    url = f"http://127.0.0.1:{CHROME_PORT}"
    try:
        with urllib.request.urlopen(f"{url}/json/version", timeout=1) as response:
            socket_url = json.load(response)["webSocketDebuggerUrl"]
        from websockets.sync.client import connect

        with connect(socket_url, open_timeout=2, close_timeout=1) as sock:
            sock.send(json.dumps({"id": 1, "method": "Browser.close"}))
            try:
                sock.recv(timeout=1)
            except Exception:
                pass  # Chrome may drop the socket while quitting
    except Exception:
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _answering(url):
            time.sleep(0.3)  # let Chrome release its files before the cache folders are removed
            return True
        time.sleep(0.1)
    return False


def _kill_profile_processes() -> None:
    """Fallback: stop every process whose --user-data-dir is our profile (never any other Chrome)."""
    if sys.platform == "win32":
        script = (
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
            f"Where-Object {{ $_.CommandLine -like '*--user-data-dir=*{PROFILE_DIR.name}*' }} | "
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, check=False)
    else:
        subprocess.run(["pkill", "-f", f"--user-data-dir={PROFILE_DIR}"], capture_output=True, check=False)
    time.sleep(1.0)  # let Chrome release its files before the cache folders are removed


def close_chrome() -> None:
    """Stop this process's daemon and the Chrome it started; never touches any other Chrome.

    Chrome's first process is only a launcher that exits, so the real browser is not a child of
    `proc`. It is asked to quit first; if it keeps answering, every process of our own profile
    (matched by its --user-data-dir) is stopped instead.
    """
    global _LAUNCHED, _DAEMON
    proc, _LAUNCHED = _LAUNCHED, None
    daemon, _DAEMON = _DAEMON, None
    if proc is not None:
        if not _graceful_close():
            _kill_profile_processes()
        for relative in CACHE_DIRS:
            shutil.rmtree(PROFILE_DIR / relative, ignore_errors=True)
    if daemon:
        _stop_daemon(daemon)
