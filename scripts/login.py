"""Open the dedicated Chrome with a visible window so you can log in to Traderie once."""

import os
import threading
import time
from contextlib import contextmanager

from jev_ultrafast.browser import Browser
from jev_ultrafast.chrome import close_chrome, ensure_chrome

LOGIN_URL = "https://traderie.com/login?redirect=%2F"
HOME_URL = "https://traderie.com/diablo2resurrected"

# Traderie shows a "Log In" link in the header only while nobody is logged in.
LOGGED_OUT_JS = (
    "[...document.querySelectorAll('a,button')].some(e => (e.innerText || '').trim().toLowerCase() === 'log in')"
)

# Logged in only on a fully rendered Traderie page with no "Log In" link left. A blank, still-loading
# or challenge tab has no "Log In" link either (an empty DOM during a navigation), so `readyState` and a
# non-empty body must hold before "no Log In link" is read as a finished login.
LOGGED_IN_JS = (
    "location.hostname.endsWith('traderie.com') && document.readyState === 'complete' && "
    "!!(document.body && document.body.innerText.trim()) && "
    f"!({LOGGED_OUT_JS})"
)

DEFAULT_WAIT_SECONDS = 600
POLL_SECONDS = 1.0

# Patch points for tests: the wait must not really sleep for minutes.
_clock = time.monotonic
_sleep = time.sleep

# A fixed banner shown on every page of this window, including after the login redirect.
BANNER_JS = """(() => {
  const show = () => {
    if (!document.body || document.getElementById('jev-login-guide')) return;
    const box = document.createElement('div');
    box.id = 'jev-login-guide';
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 16px;' +
      'background:#fff3cd;color:#1f2d3d;border-bottom:3px solid #e0a800;font:16px/1.6 sans-serif;';
    box.innerHTML = '<b>第 1 步：</b>在這個視窗登入 Traderie（Discord、Google、Email 都可以）。<br>' +
      '<b>第 2 步：</b>如果看到「Patch Notes」之類的公告視窗，請按右上角的 <b>×</b> 關掉' +
      '（關掉後專用 Chrome 會記得）。<br>' +
      '<b>第 3 步：</b>看到 Traderie 首頁後，回到終端機（黑色視窗）按 <b>Enter</b>，這個視窗會自動關閉。';
    document.body.appendChild(box);
    document.body.style.marginTop = '110px';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})()"""


def _close_tab(browser):
    """The tab may already be gone (the user closed it, or the login page opened and closed a popup).
    The login lives in the Chrome profile, so a dead tab must not stop Chrome from being closed properly."""
    if browser is None:
        return
    try:
        browser.close()
    except RuntimeError:
        pass


@contextmanager
def _tab(url):
    """A Browser on `url` that leaves the tab and Chrome closed when the block ends, whatever happens inside it."""
    browser = None
    try:
        browser = Browser(url)
        yield browser
    finally:
        _close_tab(browser)
        close_chrome()


def needs_login():
    """True when the dedicated Chrome is not logged in to Traderie. Always leaves Chrome closed."""
    ensure_chrome()
    with _tab(HOME_URL) as browser:
        return bool(browser.evaluate(LOGGED_OUT_JS))


def wait_seconds():
    """How long to keep the login window open (`JEV_LOGIN_WAIT_SECONDS` overrides the default)."""
    raw = (os.environ.get("JEV_LOGIN_WAIT_SECONDS") or "").strip()
    if not raw:
        return float(DEFAULT_WAIT_SECONDS)
    try:
        return max(float(raw), 0.0)
    except ValueError:
        print(f"JEV_LOGIN_WAIT_SECONDS={raw} 不是數字，改用預設 {DEFAULT_WAIT_SECONDS} 秒。", flush=True)
        return float(DEFAULT_WAIT_SECONDS)


def _read_enter(entered):
    """Wait for Enter on a background thread. On a terminal that cannot wait (EOF) it just stops."""
    try:
        input()
    except EOFError:
        return
    entered.set()


def _logged_in(browser):
    """True once this tab is a logged-in Traderie page (`LOGGED_OUT_JS` finds no `Log In` link)."""
    try:
        return bool(browser.evaluate(LOGGED_IN_JS))
    except RuntimeError:
        return False  # the tab is navigating or gone; keep waiting until the bound


def wait_for_login(browser):
    """Keep the window open until the login shows up, Enter is pressed, or the bound is reached.

    Enter ends the wait when the terminal can deliver it. When the terminal cannot wait (EOF, e.g. the
    input is redirected), the login state is still polled, so the human can log in and this finishes
    by itself. Returns True when a login was detected or Enter was pressed, False on the bound."""
    entered = threading.Event()
    threading.Thread(target=_read_enter, args=(entered,), daemon=True).start()
    deadline = _clock() + wait_seconds()
    while True:
        if _logged_in(browser):
            print("已偵測到登入，正在關閉視窗…", flush=True)
            return True
        if entered.is_set():
            return True
        if _clock() >= deadline:
            return False
        _sleep(POLL_SECONDS)


def main():
    os.environ["JEV_CHROME"] = "window"
    started = ensure_chrome()
    if started != "started":
        print(
            "專用 Chrome 已在背景執行，請先關閉它再登入：結束使用 .tmp-jev-chrome 的 chrome.exe 後重新執行本指令。",
            flush=True,
        )
        raise SystemExit(1)
    with _tab(LOGIN_URL) as browser:
        browser.call("Page.addScriptToEvaluateOnNewDocument", source=BANNER_JS)
        browser.evaluate(BANNER_JS)
        print("請在剛開啟的視窗登入 Traderie（視窗上方有操作說明）。登入完成後回到這裡按 Enter", flush=True)
        if not wait_for_login(browser):
            print(
                f"沒偵測到登入（已等待約 {int(wait_seconds())} 秒），這個視窗會自動關閉。"
                "請重新執行 uv run python scripts/login.py，並在視窗開啟後完成 Traderie 登入；"
                "登入成功後視窗會自己關閉，不需要按鍵。",
                flush=True,
            )
            raise SystemExit(1)


if __name__ == "__main__":
    main()
