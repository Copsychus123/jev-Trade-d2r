"""Observed actions through Browser Harness; one CDP session, no per-step subprocess."""

import hashlib
import json
import sys
import time
from pathlib import Path

import browser_harness.helpers
from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp

from .chrome import blocked_url_patterns, chrome_mode, ensure_chrome, image_url_patterns
from .config import VIEWPORT_HEIGHT, VIEWPORT_WIDTH, get_settings
from .traderie.auth import cookie_specs

browser_harness.helpers.DEFAULT_IPC_RESPONSE_TIMEOUT_SECONDS = 30.0
browser_harness.helpers.IPC_CONNECT_TIMEOUT_SECONDS = 30.0

# Atomically read visible content and controls, preserving actual DOM node identity.
READ_STATE = Path(__file__).with_name("snapshot.js").read_text(encoding="utf-8")
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"
AFTER_INPUT = Path(__file__).with_name("after_input.js").read_text(encoding="utf-8").strip()
RESOLVE_TARGET = Path(__file__).with_name("resolve_target.js").read_text(encoding="utf-8").strip()
SETTLE = Path(__file__).with_name("settle.js").read_text(encoding="utf-8").strip()

def _inject_traderie_auth(call):
    for spec in cookie_specs(get_settings()):
        result = call("Network.setCookie", **spec)
        if result.get("success") is False:
            raise RuntimeError(f"Failed to set Traderie cookie {spec['name']!r}")


class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class Browser:
    def __init__(self, url, *, images=True):
        """Open an owned tab. A headless Chrome's self-declared "HeadlessChrome" label is
        replaced with "Chrome"; nothing else about the browser is disguised."""
        ensure_chrome()
        ensure_daemon()
        # A background tab gets no rendered frames in headless Chrome and screenshots hang; the dedicated
        # Chrome has no user to disturb. The user's own Chrome keeps the background tab.
        background = chrome_mode() == "existing"
        self.target = cdp("Target.createTarget", url="about:blank", background=background)["targetId"]
        try:
            self._prepare(url, images)
        except Exception:
            try:
                self.close()  # a failed open must not leave an orphan tab behind
            except Exception:
                pass
            raise

    def _prepare(self, url, images):
        self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        self.call(
            "Emulation.setDeviceMetricsOverride",
            width=VIEWPORT_WIDTH,
            height=VIEWPORT_HEIGHT,
            deviceScaleFactor=1,
            mobile=False,
        )
        # Keep rAF/menus rendering in an owned background tab, without activating the user's Chrome tab.
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        ua = self.evaluate("navigator.userAgent")
        if isinstance(ua, str) and "HeadlessChrome" in ua:
            self.call("Emulation.setUserAgentOverride", userAgent=ua.replace("HeadlessChrome", "Chrome"))
        if chrome_mode() != "existing":
            self.call("Network.enable")
            blocked = blocked_url_patterns() + ([] if images else image_url_patterns())
            self.call("Network.setBlockedURLs", urls=blocked)
        _inject_traderie_auth(self.call)
        self.navigate(url)
        self.settle()

    def settle(self, quiet_ms=600, timeout_ms=15000, min_chars=100):
        """Read-only: wait until the page has text and stops changing, so the first observation is not a
        blank or half-rendered app (a cold cache makes single-page apps render late)."""
        self.evaluate(f"{SETTLE}({quiet_ms}, {timeout_ms}, {min_chars})", await_promise=True)

    def call(self, method, _response_timeout=30.0, **params):
        return cdp(method, session_id=self.session, _response_timeout=_response_timeout, **params)

    def evaluate(self, expression, *, await_promise=False):
        response = self.call(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=await_promise,
        )
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    def navigate(self, url, *, timeout=30, interactive_grace=1.5):
        """Wait for load. A page that is interactive but never reaches `complete` (a hung ad or
        tracker request) is accepted after `interactive_grace` seconds; `settle()` covers the rest."""
        self.call("Page.navigate", url=url)
        deadline = time.monotonic() + timeout
        interactive_since = None
        while time.monotonic() < deadline:
            state = self.evaluate("document.readyState")
            if state == "complete":
                return
            if state == "interactive":
                if interactive_since is None:
                    interactive_since = time.monotonic()
                if time.monotonic() - interactive_since >= interactive_grace:
                    return
            time.sleep(0.02)
        raise TimeoutError(f"Navigation to {url} did not finish")


    def wait_until_ready(self, *, timeout=2.0, interval=0.05):
        """Poll document readiness before stale-page recovery observation."""
        deadline = time.monotonic() + max(timeout, 0)
        while True:
            try:
                if self.evaluate("document.readyState === 'complete' && !!document.body"):
                    return True
            except StalePage:
                pass
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval)
    def wait_for_selector(self, selector: str, *, timeout=30.0, interval=0.5) -> bool:
        """Poll for element to appear in DOM. Return True if found, False on timeout."""
        deadline = time.monotonic() + max(timeout, 0)
        while True:
            try:
                element_present = self.evaluate(f"!!document.querySelector({repr(selector)})")
                if element_present:
                    return True
            except StalePage:
                pass
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval)

    def observe(self, screenshot=True):
        if getattr(self, "after_input", None):
            action, self.after_input = self.after_input, None
            # This is read-only and happens after execution was logged, even if navigation interrupts it.
            try:
                self.call(
                    "Runtime.evaluate",
                    expression=f"{AFTER_INPUT}({json.dumps(action)})",
                    awaitPromise=True,
                    returnByValue=True,
                )
            except RuntimeError:
                pass
        for attempt in range(10):
            try:
                return browser_operation(
                    {"operation": "observe", "session": self.session, "screenshot": screenshot}
                )
            except StalePage:
                if attempt == 9:
                    raise
                time.sleep(0.02)
        raise StalePage("Page did not settle")

    def fresh(self, page, action=None):
        if action is not None and action["kind"] in {"click", "select", "fill"}:
            node = action["node"]
            if type(node) is not int:
                return False
            current = self.evaluate(
                "(() => { const c=window.__jevFast; "
                f"return c ? [c.pageKey(),c.guard(c.nodes.get({node}))] : null; }})()"
            )
            return current == [page["page_key"], page["guards"].get(str(node))]
        return self.evaluate(MARKER) == page["marker"]

    def act(self, action, page, text=None):
        if not self.fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")
        if action["kind"] == "wait":
            time.sleep(4.0)  # slow XHR content (search results, Load More) needs real time, not one frame
        result = browser_operation({"operation": "act", "session": self.session, "action": action, "text": text})
        self.after_input = action if action["kind"] != "wait" else None
        return result

    def close(self):
        if self.target:
            cdp("Target.closeTarget", targetId=self.target)
            self.target = None


def fingerprint(state):
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def browser_operation(request):
    operation = request["operation"]
    session = request["session"]

    def call(method, _response_timeout=30.0, **params):
        return cdp(method, session_id=session, _response_timeout=_response_timeout, **params)

    def evaluate(expression):
        result = call("Runtime.evaluate", expression=expression, returnByValue=True)
        if result.get("exceptionDetails"):
            if operation == "act" and request["action"]["kind"] == "select":
                raise RuntimeError("Dropdown execution was interrupted; inspect before retrying.")
            raise StalePage("Document changed during evaluation")
        return result.get("result", {}).get("value")

    if operation == "act":
        action = request["action"]
        kind = action["kind"]
        if kind == "scroll":
            call("Input.dispatchMouseEvent", type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action["delta"])
        elif kind != "wait":
            if type(action["node"]) is not int:
                raise ValueError("Invalid observed node")
            # Code-owned node IDs refer to actual observed elements, never model-generated selectors.
            target = evaluate(f"{RESOLVE_TARGET}({json.dumps(action)})")
            if target is None:
                if kind == "select":
                    raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
                raise StalePage("Target changed or is covered. Observe again.")
            if kind != "select":
                x, y = target["x"], target["y"]
                for event in ("mousePressed", "mouseReleased"):
                    call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)
                if kind == "fill":
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyDown",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                        commands=["selectAll"],
                    )
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyUp",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                    )
                    call("Input.insertText", text=request["text"])
        return {"executed": action["id"]}

    info = evaluate(READ_STATE)
    if info is None:
        raise StalePage("Document is navigating")
    info["fingerprint"] = fingerprint(info)
    if request.get("screenshot", True):
        info["screenshot"] = call("Page.captureScreenshot", format="jpeg", quality=60, optimizeForSpeed=True)["data"]
    return info
