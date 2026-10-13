"""Minimal Chrome DevTools Protocol client shared by the Chrome scripts (extension_e2e, extension_batch, ocr_e2e,
scan_e2e, build_item_tables, probe_stats). One websocket, one command at a time. Needs `websockets` and this project's
own package importable (uv run --group e2e ...)."""

import asyncio
import json
import time
from contextlib import asynccontextmanager

import httpx
import websockets

from jev_ultrafast.chrome import CHROME_PORT, chrome_mode, ensure_chrome


class Environment(Exception):
    """Something outside the extension is wrong (exit code 2)."""


class Panel:
    """One page (or the extension's side-panel page) driven over its debugger websocket."""

    STATE_JS = ""  # a JS expression answering this page's state; only the panels that use state() set it
    READY_JS = ""  # a JS expression that is true once this page is loaded; only the panels that wait for it set it

    def __init__(self, ws, *, raise_errors: bool = True, collect_events: bool = False):
        self.ws = ws
        self.counter = 0
        self.raise_errors = raise_errors  # False: a protocol error answers {} like a command with no result
        self.collect_events = collect_events  # keep events that arrive while a command is waited for
        self.events: list[dict] = []

    async def send(self, method: str, params: dict | None = None) -> dict:
        self.counter += 1
        mine = self.counter
        await self.ws.send(json.dumps({"id": mine, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") == mine:
                if "error" in message and self.raise_errors:
                    raise RuntimeError(message["error"])
                return message.get("result", {})
            if self.collect_events:
                self.events.append(message)

    async def evaluate(self, expression: str):
        result = await self.send(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}
        )
        return result.get("result", {}).get("value")

    async def goto(self, url: str) -> None:
        await self.send("Page.navigate", {"url": url})

    async def state(self):
        """This page's state as an object (see STATE_JS)."""
        if not self.STATE_JS:
            raise Environment("this panel page declares no STATE_JS")
        return json.loads(await self.evaluate(self.STATE_JS))

    async def wait(self, predicate, seconds=120, step=0.5):
        """The first state matching `predicate`, checked every `step` seconds; Environment after `seconds`."""
        end = time.time() + seconds
        while time.time() < end:
            state = await self.state()
            if predicate(state):
                return state
            await asyncio.sleep(step)
        raise Environment(f"等不到預期的畫面狀態（{seconds} 秒）：{await self.state()}")

    async def _poll_ready(self, message, tries: int, *, ignore_errors: bool = False) -> None:
        """Poll READY_JS every half-second up to `tries` times; Environment(`message`) when it never turns true.
        `ignore_errors` keeps polling through a page that is navigating (an evaluate that throws)."""
        for _ in range(tries):
            try:
                if await self.evaluate(self.READY_JS):
                    return
            except Exception:
                if not ignore_errors:
                    raise
            await asyncio.sleep(0.5)
        raise Environment(message)

    async def wait_ready(self, message, tries=40):
        """Wait up to `tries` half-seconds for READY_JS; raise Environment(`message`) when it never turns true."""
        await self._poll_ready(message, tries)

    async def reload(self, message="側邊欄沒有重新載入"):
        """Reload the page and wait for READY_JS; raise Environment(`message`) when it never comes back."""
        await self.evaluate("location.reload()")
        await asyncio.sleep(1)
        await self._poll_ready(message, 60, ignore_errors=True)

    async def hide_headless_label(self):
        """Headless Chrome names itself in the user agent, which some sites reject: report a plain Chrome instead.
        Same rule as Browser._prepare: only the browser's own "HeadlessChrome" label is dropped."""
        agent = await self.evaluate("navigator.userAgent")
        if isinstance(agent, str) and "HeadlessChrome" in agent:
            await self.send("Emulation.setUserAgentOverride", {"userAgent": agent.replace("HeadlessChrome", "Chrome")})


@asynccontextmanager
async def attach(ws_url: str, panel_class=Panel, **options):
    """A Panel (or `panel_class`) on an existing page's debugger websocket."""
    async with websockets.connect(ws_url, max_size=None) as ws:
        yield panel_class(ws, **options)


def new_tab(port: int, url: str = "about:blank", *, timeout: float = 5.0) -> dict:
    """Ask the Chrome on `port` for a new tab and return its `/json` target (websocket URL and id); the tab is left
    open for the caller to drive and close. `url` is the part after `/json/new?` and is inserted as given."""
    return httpx.put(f"http://127.0.0.1:{port}/json/new?{url}", timeout=timeout).json()


def new_tab_ws(port: int, url: str = "about:blank", *, timeout: float = 5.0) -> str:
    """A new tab's debugger websocket URL, for a caller that drives the tab through `attach`; the tab is left open."""
    return new_tab(port, url, timeout=timeout)["webSocketDebuggerUrl"]


@asynccontextmanager
async def open_tab(port: int, panel_class=Panel, **options):
    """A new blank tab in the Chrome listening on `port`; the tab is closed on exit."""
    target = new_tab(port, timeout=10)
    try:
        async with attach(target["webSocketDebuggerUrl"], panel_class, **options) as panel:
            yield panel
    finally:
        httpx.get(f"http://127.0.0.1:{port}/json/close/{target['id']}", timeout=10)


@asynccontextmanager
async def open_dedicated_tab(panel_class=Panel, **options):
    """A new tab in the dedicated Chrome, with the headless label hidden; the tab is closed on exit.

    Refuses a Chrome the user started by hand (JEV_CHROME=existing), and starts the headless one when it is not
    already running. The port is the dedicated Chrome's own, so a caller cannot point it at a different browser."""
    if chrome_mode() == "existing":
        raise SystemExit("這個工具要用專用 Chrome：請不要設 JEV_CHROME=existing")
    ensure_chrome()
    async with open_tab(CHROME_PORT, panel_class, **options) as tab:
        await tab.hide_headless_label()
        yield tab
