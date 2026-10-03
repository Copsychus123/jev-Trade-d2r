"""Open the dedicated Chrome with a visible window so you can log in to Traderie once."""

import os

from jev_ultrafast.browser import Browser
from jev_ultrafast.chrome import close_chrome, ensure_chrome

LOGIN_URL = "https://traderie.com/login?redirect=%2F"
HOME_URL = "https://traderie.com/diablo2resurrected"

# Traderie shows a "Log In" link in the header only while nobody is logged in.
LOGGED_OUT_JS = (
    "[...document.querySelectorAll('a,button')].some(e => (e.innerText || '').trim().toLowerCase() === 'log in')"
)

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


def needs_login():
    """True when the dedicated Chrome is not logged in to Traderie. Always leaves Chrome closed."""
    ensure_chrome()
    browser = None
    try:
        browser = Browser(HOME_URL)
        return bool(browser.evaluate(LOGGED_OUT_JS))
    finally:
        _close_tab(browser)
        close_chrome()


def main():
    os.environ["JEV_CHROME"] = "window"
    started = ensure_chrome()
    if started != "started":
        print("專用 Chrome 已在背景執行，請先關閉它再登入：結束使用 .tmp-jev-chrome 的 chrome.exe 後重新執行本指令。")
        raise SystemExit(1)
    browser = None
    try:
        browser = Browser(LOGIN_URL)
        browser.call("Page.addScriptToEvaluateOnNewDocument", source=BANNER_JS)
        browser.evaluate(BANNER_JS)
        print("請在剛開啟的視窗登入 Traderie（視窗上方有操作說明）。登入完成後回到這裡按 Enter")
        input()
    finally:
        _close_tab(browser)
        close_chrome()


if __name__ == "__main__":
    main()
