"""Real-Chrome end-to-end check of the gear scanner: uv run --group e2e python scripts/scan_e2e.py [--headed]
[--page PATH].

`--page` runs the same drive against another sim page (default scripts/data/scan_sim.html); a page only has to keep
the "D2R-SIM" title so Chrome's auto-select still finds it. It exists for measurements such as the same tooltips at
their native size on a bigger stage. `--minimize-after SECONDS` minimizes the browser window that many seconds into
the sweep, i.e. makes the side-panel page invisible the way it is when the game covers Chrome - the condition the
capture path is built for (measured 2026-10-13: all four records still land).

Windows-only tool (Windows Chrome paths). Builds the extension into extension/dist-e2e, loads it into the dedicated
Chrome, opens scripts/data/scan_sim.html as a tab and drives the side panel:
  1. put a placeholder invite code on the panel (held in memory, never sent anywhere);
  2. the panel opens on the scan screen (the home screen): start the scan (scan-start) and let missing models download
     automatically — the panel opens the share dialog itself, Chrome auto-selects the "D2R-SIM" tab;
  3. let the simulated sweep run twice (the same four tooltips) and wait until document.title is D2R-SIM-DONE,
     then until the OCR queue is empty (#scan-status says 待辨識 0 件);
  3b. when the matcher was not sure about a read (an item with its type line under it, name not in a unique/set
     colour) the row must sit on the list as 不確定 with both search buttons disabled; the script then picks the right
     name on each, like the player, and the row must come out named with the buttons enabled. No unsure row is a pass
     too (the name-colour rule makes all four sim items sure): the check is that the unsure path is consistent, and
     every row is named in the end;
  4. assert what the capture plan's section 6 lists: exactly four records, the names equal the expect values of the
     four pictures in scripts/data/ocr_truth.json, no duplicates, #scan-csv enabled, and that the scan phase itself
     never started a query (no "running" view, no banner);
  5. press each record's search buttons. A started query must be PROVEN: before the clicks the panel's fetch and
     chrome.windows.create are replaced by a stub that counts a /api/run/start call and refuses to open a query window,
     so each 精準搜尋 must start the name query at once (one /api/run/start, a window attempt, the "running" screen,
     then the problem the refused window ends in) and each 模糊搜尋 must start the affix query at once with the
     record's base and no ticked condition (no /api/run/start: the affix search never asks the backend). No real
     query, no quota. `--shots` also writes screenshots of the screens at side-panel widths to
     artifacts/scan-e2e/shots/.
Writes artifacts/scan-e2e/report.json. Exit 0 all good, 1 an assertion failed, 2 environment.
Clears the shared dedicated Chrome profile at its own startup (free_profile, like its siblings) and starts no backend
(the placeholder invite code is never used).
"""

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cdp import Environment, attach, new_tab_ws  # noqa: E402
from _cdp import Panel as CdpPanel  # noqa: E402
from extension_e2e import (  # noqa: E402
    DEBUG_PORT,
    LOCAL_API,
    build_extension,
    cleanup,
    environment_failure,
    load_extension,
    open_panel,
    say,
    start_chrome,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "scripts" / "data"
TRUTH = DATA / "ocr_truth.json"
SIM = DATA / "scan_sim.html"
OUT = ROOT / "artifacts" / "scan-e2e"
INVITE = "dummy-invite"
HIDDEN_NOTICE = "蓋住了這個面板"  # the words of the panel's covered-window notice (extension/src/scan/scan-panel.js)
# The four pictures the sim loops over; their expect values in the truth file are the names the panel must show.
SIM_FILES = ["image-14.png", "image-15.png", "image-17.png", "image-18.png"]
ITEM_FILE = "image-17.png"  # a non-base record (Alma Negra): 模糊搜尋 must leave the base box alone
BASE_FILE = "image-14.png"  # the base-kind record (Grand Charm): 模糊搜尋 may pre-fill the base box
# The sim tab is picked by its title; the canvas is exactly 1280x720. The backgrounding flags keep Chrome rendering the
# (background) sim tab at full speed while it is being captured, instead of throttling it to about 1 fps.
# Test-only, and the flag must never be copied into src/jev_ultrafast/chrome.py: it auto-accepts Chrome's own
# share dialog, which the product keeps as a user-consent gate (scan/capture.js uses the real picker).
EXTRA_ARGS = (
    "--window-size=1280,720",
    "--auto-select-tab-capture-source-by-title=D2R-SIM",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
)

# Everything the driver reads back from the side panel in one go. Every field goes through the plan's ids; `views`
# is the observer `HOOK` installs, which records every view/mode change so "no query started" can be proven.
STATE = """(() => {
  const $ = (id) => document.getElementById(id);
  return JSON.stringify({
    view: document.body.dataset.view || '',
    mode: document.body.dataset.mode || '',
    status: $('scan-status')?.textContent || '',
    visibility: document.visibilityState,
    stats: $('scan-stats')?.textContent || '',
    csv: !!$('scan-csv') && !$('scan-csv').disabled,
    item: $('item')?.value || '',
    summary: $('summary-text')?.textContent || '',
    statsBase: $('stats-base')?.value || '',
    statsBaseFrom: $('stats-base')?.dataset.from || '',
    statsBaseMarked: $('stats-base')?.classList.contains('from-capture') || false,
    affixRows: document.querySelectorAll('#affix-list li').length,
    baseOptions: document.querySelectorAll('#stats-base-options option').length,
    ticks: [...document.querySelectorAll('#affix-list .affix-on')].filter((b) => b.checked).length,
    records: [...document.querySelectorAll('#scan-list li')].map((li) => li.textContent),
    rows: [...document.querySelectorAll('#scan-list li')].map((li) => ({
      name: li.dataset.name || '', unsure: li.dataset.unsure === 'true',
      options: [...li.querySelectorAll('.options button')].map((b) => b.dataset.name),
      searchesDisabled: [...li.querySelectorAll('.actions button')].map((b) => b.disabled) })),
    banner: !!$('banner') && !$('banner').hidden,
    e2e: window.__jevE2E ?? null,
    views: window.__scanViews || []
  });
})()"""

# Records every view/mode the panel derives, including a screen that came and went inside one batch of mutations (each
# record carries the value the attribute had before it changed). A scan that never searches must never show "running";
# a search that really started must.
HOOK = """(() => {
  window.__scanViews = [];
  const snap = () => window.__scanViews.push([document.body.dataset.view || '', document.body.dataset.mode || '']);
  snap();
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName === 'data-view' && r.oldValue) window.__scanViews.push([r.oldValue, '']);
    }
    snap();
  }).observe(document.body, {
    attributes: true, attributeOldValue: true, attributeFilter: ['data-view', 'data-mode'],
  });
})()"""

CLICK_RECORD = """(() => {
  const li = [...document.querySelectorAll('#scan-list li')].find((l) => l.textContent.includes(%s));
  if (!li) return 'no-record';
  const button = [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === %s);
  if (!button) return 'no-button';
  if (button.disabled) return 'disabled';
  button.click();
  return 'clicked';
})()"""

# The panel's three correction memories (chrome.storage.local keys): names, bases of the affix search, affix numbers.
FORGET_MEMORIES = "chrome.storage.local.remove(['jevCorrections', 'jevBaseCorrections', 'jevValueCorrections'])"

# The player's pick on an unsure row: the button of the wanted name among the row's decision buttons.
PICK_OPTION = """(() => {
  const button = [...document.querySelectorAll('#scan-list li[data-unsure="true"] .options button')]
    .find((b) => b.dataset.name === %s);
  if (!button) return 'no-option';
  button.click();
  return 'picked';
})()"""


# A search button on a record starts a real query, so before the clicks the panel's backend call and its query window
# are replaced: /api/run/start is counted and answered with a run (never sent anywhere), every other /api/ call is a
# 404, and chrome.windows.create counts and refuses. A started query then ends in the problem "no query window" - which
# is how the check proves it started without a backend, a quota or a Traderie window.
QUERY_STUB = """(() => {
  window.__jevE2E = { runStarts: 0, windows: 0 };
  const realFetch = window.fetch.bind(window);
  const json = (body, status) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  window.fetch = (url, init) => {
    const href = String(url);
    if (href.includes('/api/run/start')) {
      window.__jevE2E.runStarts += 1;
      const asked = JSON.parse((init && init.body) || '{}');
      const run = { run_token: 'e2e', item_name: asked.item_name || 'e2e', load_more: 0, used: 0, limit: 1 };
      return Promise.resolve(json(run, 200));
    }
    if (href.includes('/api/')) return Promise.resolve(json({}, 404));
    return realFetch(url, init);
  };
  const refuse = async () => { window.__jevE2E.windows += 1; throw new Error('scan_e2e: no query window'); };
  try { chrome.windows.create = refuse; } catch (error) { /* read-only: defineProperty below */ }
  if (chrome.windows.create !== refuse) {
    Object.defineProperty(chrome.windows, 'create', { value: refuse, configurable: true });
  }
  return chrome.windows.create === refuse;
})()"""

# `--shots`: the screens a player sees, at the widths of a Chrome side panel (320-400 px).
SHOTS = (("scan", 320), ("scan", 400), ("ready", 360), ("listing", 360), ("settings", 360))

# The layout facts of the screen on show at the current width: sideways scroll, rows, the lines the record buttons
# take, the widest main button and the heading order.
SHOT_LAYOUT = """(() => {
  const wide = ['#scan-start', '#scan-stop', '#start', '#listing-post']
    .map((id) => document.querySelector(id))
    .find((b) => b && b.offsetParent !== null && b.getBoundingClientRect().width > 0);
  const actions = [...document.querySelectorAll('#scan-list li .actions')];
  const rowsOf = (a) => [...a.children].map((b) => b.getBoundingClientRect().top);
  const lines = actions.map((a) => new Set(rowsOf(a)).size);
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .filter((h) => h.offsetParent !== null)
    .map((h) => h.tagName);
  return JSON.stringify({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    rows: document.querySelectorAll('#scan-list li').length,
    maxLines: lines.length ? Math.max(...lines) : 0,
    wide: wide ? Math.round(wide.getBoundingClientRect().width) : null,
    headings: headings.join(','),
  });
})()"""


class Panel(CdpPanel):
    STATE_JS = STATE
    READY_JS = "document.readyState === 'complete' && !!document.getElementById('scan-start')"

    async def choose_mode(self, mode: str) -> None:
        await self.evaluate(f"window.__jevChooseMode('{mode}')")


def open_sim(page: Path = SIM) -> str:
    """Opens the sim page as its own tab and returns the tab's debugger websocket URL."""
    url = page.resolve().as_uri()
    return new_tab_ws(DEBUG_PORT, urllib.parse.quote(url, safe=":/"))


async def sim_state(sim) -> dict:
    return json.loads(await sim.evaluate("JSON.stringify(window.D2R_SIM)"))


async def sim_ready(sim) -> None:
    for _ in range(40):
        if await sim.evaluate("document.readyState === 'complete' && !!window.D2R_SIM"):
            return
        await asyncio.sleep(0.5)
    raise Environment("模擬頁（scan_sim.html）沒有載入")


async def wait_title(sim, wanted: str, seconds: float) -> str:
    """Waits for the sim's title; returns whatever the title is when the time is up (so a slow sweep is reported)."""
    end = time.time() + seconds
    while time.time() < end:
        title = await sim.evaluate("document.title")
        if title == wanted:
            return title
        await asyncio.sleep(0.5)
    return await sim.evaluate("document.title")


async def ensure_scan(panel: Panel) -> dict:
    """Back to the scan list (records survive leaving the screen); returns the state once it is showing."""
    state = await panel.state()
    if state["view"] != "scan":
        await panel.choose_mode("scan")
        state = await panel.wait(lambda s: s["view"] == "scan", 30)
    return state


async def _wait_or_state(panel: Panel, ready, seconds: float) -> dict:
    """`panel.wait` for `ready`; when the time is up the state as it is (the assertions then report what is missing)."""
    try:
        return await panel.wait(ready, seconds)
    except Environment:
        return await panel.state()


# What the name field must show after 精準搜尋 on the record named %s: the Chinese part of its 中文（English） label.
SHOWN_NAME = """(() => {
  const li = [...document.querySelectorAll('#scan-list li')].find((l) => l.dataset.name === %s);
  const text = li?.querySelector('strong')?.textContent || '';
  const m = /^(.+)（.+）$/u.exec(text);
  return m ? m[1] : text;
})()"""

# The conditions line (`.line2`) of the record named %s.
RECORD_CONDITIONS = """(() => {
  const li = [...document.querySelectorAll('#scan-list li')].find((l) => l.dataset.name === %s);
  return li ? (li.querySelector('.line2')?.textContent || '') : '';
})()"""


async def click_record(panel: Panel, name: str, label: str) -> str:
    """Clicks one record's 精準搜尋 / 模糊搜尋 button; returns 'clicked', 'no-record', 'no-button' or 'disabled'."""
    return await panel.evaluate(CLICK_RECORD % (json.dumps(name), json.dumps(label)))


async def _run_scan(panel: Panel, sim: CdpPanel, report: dict) -> None:
    """Start the scan, let the models download by themselves, restart the sim inside a live capture, then drain it."""
    say("開始掃描（分享模擬視窗）…")
    await panel.evaluate("document.getElementById('scan-start').click()")
    # The first-time model download is silent now: nothing on screen to watch but the scan itself starting, which
    # happens only after the models are stored.
    state = await panel.wait(lambda s: "掃描中" in s["status"], 300)
    report["capture_status"] = state["status"]

    # Frames really flow now; restart once more so the whole sweep is inside a live capture.
    await sim.evaluate("window.D2R_SIM.restart()")
    report["sim_after_restart"] = await sim_state(sim)

    say("等模擬掃描跑完…")
    title = await wait_title(sim, "D2R-SIM-DONE", 90)
    report["sim_title"] = title
    report["sim_final"] = await sim_state(sim)
    if title != "D2R-SIM-DONE":
        say(f"模擬頁沒有跑完（標題 {title!r}，狀態 {report['sim_final']}）")

    say("等 OCR 佇列排空…")
    try:
        drained = await panel.wait(lambda s: "待辨識 0 件" in s["status"], 120)
        report["drained_status"] = drained["status"]
    except Environment as error:
        report["drain_timeout"] = str(error)
    # 待辨識 0 件 can be true while the last blob is still being recognised, so also wait (bounded) for the records
    # themselves; the assertions are unchanged and still require exactly len(expects) records.
    state = await _wait_or_state(panel, lambda s: len(s["records"]) >= len(report["expects"]), 30)
    report["records"] = state["records"]
    report["record_count"] = len(state["records"])
    report["csv_enabled"] = state["csv"]
    report["status"] = state["status"]
    report["stats"] = state["stats"]
    report["visibility"] = state["visibility"]
    last_run = await panel.evaluate("window.__jevLastRun || {}")
    crop_timings = last_run.get("scan", {}).get("cropTimings", [])
    report["cropTimings"] = crop_timings
    read_times = [c.get("readMs") for c in crop_timings]
    wait_times = [c.get("waitMs") for c in crop_timings]
    if wait_times:
        waits_sorted = sorted(wait_times)
        report["wait_median_ms"] = waits_sorted[len(waits_sorted) // 2]
        report["wait_max_ms"] = max(wait_times)
    say(f"  各筆辨識時間（readMs）：{read_times} ms")
    say(f"  各筆等待時間（waitMs）：{wait_times} ms")
    say(f"  各筆名稱出現時間（perceivedLatencyMs）：{[c.get('perceivedLatencyMs') for c in crop_timings]} ms")


async def _resolve_unsure(panel: Panel, expects: list[str], report: dict) -> None:
    """The rows the matcher was not sure about: they are listed without a name and with both searches disabled; picking
    the right name on each (the player's click) names the row and enables them. Rows that were sure are left alone."""
    await ensure_scan(panel)
    before = (await panel.state())["rows"]
    report["unsure_before"] = [row for row in before if row["unsure"]]
    picks = []
    for name in expects:
        if any(name in row["options"] for row in before if row["unsure"]):
            picks.append({"name": name, "outcome": await panel.evaluate(PICK_OPTION % json.dumps(name))})
    await asyncio.sleep(0.3)
    report["unsure_picks"] = picks
    report["unsure_after"] = (await panel.state())["rows"]
    # Every pick is a decision the reader's memory keeps (the 學習紀錄 block of the settings screen counts them).
    report["learn_count"] = await panel.evaluate("document.getElementById('learn-count').textContent")
    names = [row["name"] for row in report["unsure_after"]]
    say(f"  不確定的紀錄 {len(report['unsure_before'])} 筆，選完名稱後：{names}")


def _e2e_counts(state: dict) -> tuple[int, int]:
    """(query windows the panel tried to open, /api/run/start calls) so far, from the stub's own counters."""
    counters = state.get("e2e") or {}
    return counters.get("windows", 0), counters.get("runStarts", 0)


async def _press_search(panel: Panel, name: str, label: str) -> tuple[dict, dict]:
    """Presses one record's search button and waits for its query to end (with the stub it can only end as a problem).
    Returns what the click did - the screen it left on, what the form shows and how far the stub's counters moved -
    and the state after it."""
    await ensure_scan(panel)
    before = await panel.state()
    outcome = await click_record(panel, name, label)
    if outcome == "clicked":
        after = await _wait_or_state(panel, lambda s: s["view"] in ("problem", "done", "stopped"), 40)
    else:
        after = await panel.state()
    windows_before, starts_before = _e2e_counts(before)
    windows, starts = _e2e_counts(after)
    click = {
        "outcome": outcome, "mode": after["mode"], "view": after["view"], "item": after["item"],
        "summary": after["summary"], "ticks": after["ticks"], "statsBase": after["statsBase"],
        "statsBaseFrom": after["statsBaseFrom"], "statsBaseMarked": after["statsBaseMarked"],
        "baseOptions": after["baseOptions"], "banner": after["banner"],
        "windows_before": windows_before, "windows": windows, "starts_before": starts_before, "starts": starts,
        # a screen that came and went (the running screen) is in the observer's log even when no poll saw it
        "ran": any(view == "running" for view, _ in after["views"][len(before["views"]):]),
    }
    return click, after


async def _collect_record_clicks(
    panel: Panel, expects: list[str], item_name: str, base_name: str, report: dict
) -> None:
    """Press each record's 精準搜尋 (the name query), then 模糊搜尋 on a non-base and on the base record (the affix
    query with the base and no condition), and record what each did. Each must really start its query."""
    start = await panel.state()
    report["scan_views"] = start["views"]  # everything the panel showed up to here: the scan phase, no query
    report["banner"] = start["banner"]
    ok = await panel.evaluate(QUERY_STUB)
    say(f"  查詢替身已就位（chrome.windows.create 已換掉：{ok}）")

    names, clicks = [], []
    for name in expects:
        click, after = await _press_search(panel, name, "精準搜尋")
        # The record shows 中文（English） (plain English without a Chinese name) and the field gets the Chinese part;
        # the English name stays in data-name, which is also what Traderie is queried with.
        click["name"] = name
        click["shown_field"] = await panel.evaluate(SHOWN_NAME % json.dumps(name))
        clicks.append(click)
        names.append(name if after["item"] == click["shown_field"] else after["item"])
        say(
            f"  精準搜尋 {name!r} -> {click['outcome']}，畫面={click['view']} 查詢={click['summary']!r}"
            f" 開窗 {click['windows_before']}->{click['windows']} 後端 {click['starts_before']}->{click['starts']}"
        )
    report["exact_clicks"] = clicks
    report["names"] = names

    # 模糊搜尋 on a non-base record: the base box carries the same read's base candidate, no condition is ticked.
    click, _ = await _press_search(panel, item_name, "模糊搜尋")
    report["fuzzy_item"] = click
    say(
        f"  模糊搜尋 {item_name!r} -> {click['outcome']}，畫面={click['view']} 勾選={click['ticks']}"
        f" 底材={click['statsBase']!r} 開窗 {click['windows_before']}->{click['windows']}"
    )

    # 模糊搜尋 on the base record: the base is the record's own name.
    click, last = await _press_search(panel, base_name, "模糊搜尋")
    report["fuzzy_base"] = click
    say(f"  模糊搜尋 {base_name!r} -> {click['outcome']}，畫面={click['view']} 底材={click['statsBase']!r}")
    report["views"] = last["views"]


# The listing screen a record's 「TR交易」 opens: what it shows for that record. Nothing on it is pressed but 返回.
LISTING_STATE = """(() => {
  const $ = (id) => document.getElementById(id);
  return JSON.stringify({
    view: document.body.dataset.view || '',
    item: $('listing-item')?.textContent || '',
    affixes: $('listing-affixes')?.children.length ?? -1,
    marked: $('listing-affixes')?.querySelectorAll('input.from-capture').length ?? -1,
    postDisabled: $('listing-post')?.disabled ?? null,
    why: $('listing-why')?.textContent || '',
    status: $('listing-status')?.textContent || '',
    createRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/listings/create')).length,
    runeOptions: document.querySelector('#listing-groups select')?.children.length ?? -1,
    selectOptions: $('listing-affix-select')?.children.length ?? -1,
  });
})()"""


async def _collect_listing(panel: Panel, name: str, report: dict) -> None:
    """「TR交易」 on the record named `name`: the listing screen opens prefilled from the record, 上架 is off with the
    price reason (nothing else is missing), 返回 brings the scan list back unchanged. No create request may leave."""
    before = await ensure_scan(panel)
    conditions = await panel.evaluate(RECORD_CONDITIONS % json.dumps(name))
    outcome = await click_record(panel, name, "TR交易")
    await asyncio.sleep(0.3)
    shown = json.loads(await panel.evaluate(LISTING_STATE))
    await panel.evaluate("document.getElementById('listing-change').click()")
    await asyncio.sleep(0.3)
    after = await panel.state()
    report["listing"] = {
        "name": name, "outcome": outcome, "line2": conditions, **shown,
        "back_view": after["view"], "records_before": len(before["records"]), "records_after": len(after["records"]),
    }
    say(
        f"  TR交易 {name!r} -> {outcome}，view={shown['view']} 詞綴列={shown['affixes']}"
        f" 上架停用={shown['postDisabled']} 原因={shown['why']!r}"
    )


async def _clear_records(panel: Panel, report: dict) -> None:
    """清除紀錄 with records on the list: they go, the crops still waiting for OCR go with them, and - the part a
    crop already being recognised could break - no record comes back a moment later."""
    await ensure_scan(panel)
    before = await panel.state()
    await panel.evaluate("document.getElementById('scan-clear').click()")
    try:
        await panel.wait(lambda s: not s["records"], 20)
    except Environment as error:
        report["clear_timeout"] = str(error)
    await asyncio.sleep(1.5)  # a result of a crop taken before the click would land right after it
    after = await panel.state()
    report["clear"] = {
        "before": len(before["records"]),
        "after": len(after["records"]),
        "csv": after["csv"],
        "status": after["status"],
    }
    say(f"  清除紀錄：{len(before['records'])} 筆 -> {len(after['records'])} 筆（CSV 可用 {after['csv']}）")


async def _minimize_window(panel: Panel) -> None:
    """Minimizes the browser window: its side-panel page stops being visible, the way it is when the game covers
    Chrome - the condition `MediaStreamTrackProcessor` is chosen for instead of a timer or requestVideoFrameCallback."""
    window = await panel.send("Browser.getWindowForTarget", {})
    await panel.send(
        "Browser.setWindowBounds", {"windowId": window["windowId"], "bounds": {"windowState": "minimized"}}
    )


async def _show_view(panel: Panel, view: str, name: str) -> None:
    """Brings one of the screenshot screens up from wherever the panel is (settings first closed)."""
    await panel.evaluate(
        "(() => { const b = document.getElementById('settings-back'); if (b && b.offsetParent) b.click(); })()"
    )
    if view == "listing":
        await panel.choose_mode("scan")
        await click_record(panel, name, "TR交易")
    elif view == "settings":
        await panel.evaluate("document.getElementById('settings-open').click()")
    else:  # "scan" is the scan list, "ready" is the name form
        await panel.choose_mode("name" if view == "ready" else "scan")
    await panel.wait(lambda s: s["view"] == view, 15)
    await asyncio.sleep(0.4)


async def _take_shots(panel: Panel, name: str, report: dict) -> None:
    """A screenshot of each `SHOTS` screen at its width (artifacts/scan-e2e/shots/<view>-<width>.png), and whether the
    page scrolls sideways there. Leaves the panel on the scan screen."""
    folder = OUT / "shots"
    folder.mkdir(parents=True, exist_ok=True)
    await panel.send("Page.bringToFront")  # a screenshot of a background tab never answers
    taken = []
    for view, width in SHOTS:
        await panel.send(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": 900, "deviceScaleFactor": 1, "mobile": False},
        )
        try:
            await _show_view(panel, view, name)
            shot = json.loads(await panel.evaluate(SHOT_LAYOUT))
            picture = await panel.send("Page.captureScreenshot", {"format": "png"})
            path = folder / f"{view}-{width}.png"
            path.write_bytes(base64.b64decode(picture["data"]))
            taken.append({"view": view, "width": width, "file": str(path), **shot})
        finally:
            await panel.send("Emulation.clearDeviceMetricsOverride")
    await _show_view(panel, "scan", name)
    report["shots"] = taken
    say(f"  畫面截圖 {len(taken)} 張 -> {folder}")


async def drive(panel_ws: str, sim_ws: str, expects: list[str], item_name: str, base_name: str,
                minimize_after: float = 0.0, sim_page_type: str = "normal", shots: bool = False) -> dict:
    report: dict = {
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        "expects": expects,
        "base_name": base_name,
        "sim_page_type": sim_page_type,
    }
    async with attach(panel_ws, Panel, collect_events=False) as panel, attach(sim_ws) as sim:
        await panel.send("Page.enable")
        await panel.send("Runtime.enable")
        await panel.wait_ready("側邊欄頁面沒有載入（掃描畫面還不存在？）")
        # The placeholder code sits in storage and only exists so the panel is past its invite screen; the backend call
        # of a started query is stubbed (QUERY_STUB), so it is never sent anywhere.
        had_invite = await panel.evaluate("chrome.storage.local.get('invite').then((r) => Boolean(r.invite))")
        if not had_invite:
            await panel.evaluate(f"chrome.storage.local.set({{ invite: {json.dumps(INVITE)} }})")
        # What the reader learned in an earlier run (the three correction memories) must not decide a read of this one.
        await panel.evaluate(FORGET_MEMORIES)
        await panel.reload()
        await panel.evaluate(HOOK)
        # The sweep scans four items: the 「識別到 1 件就自動結束」 checkbox (shipped checked) is off here.
        await panel.evaluate("document.getElementById('scan-stop-first').click()")
        await panel.wait(lambda s: s["view"] == "scan", 30)  # the panel opens on the scan screen

        # The sim sweeps from load and reaches D2R-SIM-DONE ~7.2 s later, while the by-title auto-select flag needs
        # the title to be "D2R-SIM" at the moment getDisplayMedia() runs. Restart it here so the title is right
        # when the share dialog opens; it is restarted again below once frames really flow.
        await sim_ready(sim)
        await sim.evaluate("window.D2R_SIM.restart()")

        if minimize_after:
            sweep = asyncio.ensure_future(_run_scan(panel, sim, report))
            await asyncio.sleep(minimize_after)
            await _minimize_window(panel)
            say("已把視窗最小化（模擬遊戲蓋住 Chrome），繼續等待掃描結果…")
            await sweep
        else:
            await _run_scan(panel, sim, report)
        await _resolve_unsure(panel, expects, report)
        click_targets = list(dict.fromkeys(expects))
        await _collect_record_clicks(panel, click_targets, item_name, base_name, report)
        await _collect_listing(panel, item_name, report)
        if shots:
            await _take_shots(panel, item_name, report)
        await _clear_records(panel, report)
        await panel.evaluate(FORGET_MEMORIES)  # leave nothing learned behind
    return report


def _query_failures(label: str, click: dict | None, *, mode: str) -> list[str]:
    """What a record's search button must do: switch to its kind of query and REALLY start it - the running screen
    showed, the panel tried to open its query window, and the backend's /api/run/start was asked exactly once (both
    searches count one use of the invite) - then end on the problem the refused window gives. One message at most."""
    if not click or click["outcome"] != "clicked" or click["mode"] != mode:
        return [f"{label}沒有切到{'名稱' if mode == 'name' else '詞綴'}查詢：{click}"]
    asked = click["starts"] - click["starts_before"]
    if not click["ran"] or click["windows"] <= click["windows_before"] or asked != 1:
        return [
            f"{label}沒有真的開始查詢（running 畫面 {click['ran']}、"
            f"開窗 {click['windows_before']}->{click['windows']}、"
            f"後端 /api/run/start {asked} 次，應為 1）：{click}"
        ]
    if click["view"] != "problem" or not click["banner"]:
        return [f"{label}的查詢應停在「無法開啟查詢視窗」的問題畫面，實際畫面 {click['view']!r}：{click}"]
    return []


def _exact_click_failures(report: dict) -> list[str]:
    """精準搜尋 on every record: the name query for exactly that record's name, started at once."""
    failures = []
    for click in report.get("exact_clicks", []):
        label = f"「精準搜尋」（{click['name']}）"
        if click["outcome"] == "clicked" and click["mode"] == "name" and (
            click["item"] != click["shown_field"] or click["summary"] != f"查詢：{click['shown_field']}"
        ):
            failures.append(f"{label}查的不是這一筆的名稱 {click['shown_field']!r}：{click}")
        else:
            failures += _query_failures(label, click, mode="name")
    return failures


def _fuzzy_item_failures(fuzzy: dict | None) -> list[str]:
    """模糊搜尋 on a non-base record: the affix query starts at once with the base the same read produced (marked as
    coming from the capture, from the table's own suggestions) and with no ticked condition."""
    label = "暗金紀錄的「模糊搜尋」"
    failures = _query_failures(label, fuzzy, mode="stats")
    if not fuzzy or fuzzy["outcome"] != "clicked":
        return failures
    if fuzzy["ticks"] != 0:
        failures.append(f"{label}不該帶詞綴條件（要在結果畫面之後才加），實際勾選 {fuzzy['ticks']} 個：{fuzzy}")
    # A unique item's tooltip does not name its base, so the record carries the base candidate of the same read
    # (scan/session.js baseCandidate) and 模糊搜尋 searches by it, marked as coming from the capture.
    if not fuzzy["statsBase"]:
        failures.append(f"暗金紀錄應預填同一輪讀到的底材候選，實際 {fuzzy['statsBase']!r}")
    elif fuzzy.get("statsBaseFrom") != "ocr":
        failures.append(f"預填的底材要標記為來自擷取，實際 from={fuzzy.get('statsBaseFrom')!r}")
    elif not fuzzy.get("statsBaseMarked"):
        failures.append(f"預填的底材看不出是擷取來的：marked={fuzzy.get('statsBaseMarked')!r}")
    # The base is still required, but the form offers the shipped item types (a unique's tooltip never names its
    # base): the datalist must be filled from the table, not from a list written in code.
    if (fuzzy.get("baseOptions") or 0) < 50:
        failures.append(f"底材欄沒有出貨清單的建議選項，實際 {fuzzy.get('baseOptions')!r}")
    return failures


def _query_phase_failures(report: dict) -> list[str]:
    """The scan phase started no query (no running screen, no banner); the search buttons did (at least three running
    screens: the observer sees one per started query); and no screenshot screen scrolls sideways."""
    failures = []
    if report.get("banner"):
        failures.append("查詢橫幅出現：掃描過程不該送出任何查詢")
    if any(view == "running" for view, _ in report.get("scan_views", [])):
        failures.append("掃描過程中畫面變成 running：有查詢被送出")
    ran = sum(1 for view, _ in report.get("views", []) if view == "running")
    if ran < 3:
        failures.append(f"按下搜尋鈕之後只看到 {ran} 次 running 畫面：查詢沒有真的開始")
    failures += _shot_layout_failures(report)
    return failures


def _shot_layout_failures(report: dict) -> list[str]:
    """The `--shots` layout checks, one per screenshot: no sideways scroll, the heading order h1 -> h2 -> h3 with no
    skipped level, the screen's wide button filling the panel's width, and the record's three buttons on one line at
    400 px (wrapped cleanly, at most two lines, at 320 px)."""
    failures = []
    for shot in report.get("shots", []):
        label = f"畫面「{shot['view']}」({shot['width']} px)"
        if shot["overflow"]:
            failures.append(f"{label}會左右捲動：{shot['file']}")
        if not shot["headings"].startswith("H1"):
            failures.append(f"{label}的第一個標題不是 h1：{shot['headings']}")
        elif "H3" in shot["headings"] and "H2" not in shot["headings"].split("H3")[0]:
            failures.append(f"{label}的 h3 前面沒有 h2（跳了層級）：{shot['headings']}")
        if shot["wide"] is not None and shot["width"] - shot["wide"] > 28:
            failures.append(f"{label}的主要按鈕只有 {shot['wide']} px 寬，沒有填滿畫面")
        if shot["view"] == "scan" and shot["rows"]:
            if shot["width"] >= 400 and shot["maxLines"] != 1:
                failures.append(f"{label}的紀錄三顆按鈕沒有排成一行（{shot['maxLines']} 行）")
            elif shot["maxLines"] > 2:
                failures.append(f"{label}的紀錄按鈕換行超過兩行（{shot['maxLines']} 行）")
    return failures


def _unsure_failures(report: dict) -> list[str]:
    """The decision flow, consistent whether or not there were unsure rows (the name-colour rule makes the four sim
    items sure, so none is a pass): unsure rows wait with both searches disabled, every pick names its row and enables
    them, and no row is left undecided."""
    failures = []
    before = report.get("unsure_before") or []
    for row in before:
        if not all(row["searchesDisabled"]):
            failures.append(f"不確定的紀錄在選名稱之前，兩個搜尋按鈕都應該停用：{row}")
    for pick in report.get("unsure_picks", []):
        if pick["outcome"] != "picked":
            failures.append(f"不確定的紀錄找不到要點的名稱「{pick['name']}」：{pick}")
    picked = any(pick["outcome"] == "picked" for pick in report.get("unsure_picks", []))
    if picked and "learn_count" in report and "已記住" not in report["learn_count"]:
        failures.append(f"點選過名稱，但設定裡的學習紀錄沒有記住：{report.get('learn_count')!r}")
    for row in report.get("unsure_after", []):
        if row["unsure"] or not row["name"]:
            failures.append(f"選完名稱後仍有沒決定的紀錄：{row}")
        elif row["searchesDisabled"][0]:
            failures.append(f"選完名稱後「精準搜尋」仍是停用的：{row}")
    return failures


def _csv_and_visibility_failures(report: dict) -> list[str]:
    """#scan-csv is usable once there are records, and the side panel's "game covers this panel" notice shows exactly
    while the page reports itself hidden (the sim tab is in front of the panel tab here, so the run is normally hidden;
    the anti-throttle flags keep it fast)."""
    failures = []
    if not report.get("csv_enabled"):
        failures.append("#scan-csv 不是可用（下載 CSV 不需要先查詢）")
    hidden = report.get("visibility") == "hidden"
    if hidden != (HIDDEN_NOTICE in report.get("status", "")):
        failures.append(
            f"蓋住面板的提醒和頁面可見狀態不一致（visibility={report.get('visibility')!r}）：{report.get('status')!r}"
        )
    return failures


def _clear_failures(cleared: dict | None, *, left_note: str = "", csv_note: str = "") -> list[str]:
    """清除紀錄 was pressed with records on the list, left none, and turned #scan-csv off. The notes are the part of
    the two messages that says why (they differ between the two sim pages)."""
    if not cleared or cleared.get("before", 0) < 1:
        return [f"清除紀錄沒有在有紀錄時按下去：{cleared}"]
    if cleared.get("after") != 0:
        return [f"清除紀錄之後仍有紀錄{left_note}：{cleared}"]
    if cleared.get("csv"):
        return [f"清除紀錄之後 #scan-csv 還可以用{csv_note}：{cleared}"]
    return []


def _verdict_failures(report: dict) -> list[str]:
    failures = []
    count = report.get("record_count", 0)
    if count < 6:
        failures.append(f"備援偵測救回件數不足，預期至少 6 筆，實際 {count} 筆：{report.get('records')}")
    expected_names = {"Alpha Helm", "Diadem", "Ring", "The Redeemer"}
    records_text = " ".join(report.get("records", []))
    for name in expected_names:
        if name not in records_text:
            failures.append(f"未找到預期的救回紀錄：{name}")
    report["known_gap"] = (
        "image-43.png (Light Plated Boots): rare boots with Chinese base unmapped in Traderie products table"
    )
    failures += _csv_and_visibility_failures(report)
    failures += _exact_click_failures(report)
    failures += _query_failures("底材紀錄的「模糊搜尋」", report.get("fuzzy_base"), mode="stats")
    failures += _query_phase_failures(report)
    failures += _listing_failures(report.get("listing"))
    failures += _clear_failures(report.get("clear"))
    return failures


def _listing_failures(listing: dict | None) -> list[str]:
    """The 「TR交易」 assertions: the listing screen opened for the record, prefilled, with 上架 off for want of a
    price, 返回 came back to the same scan list, and no create request was made."""
    if not listing or listing["outcome"] != "clicked" or listing["view"] != "listing":
        return [f"「TR交易」沒有打開上架畫面：{listing}"]
    failures = []
    if listing["name"] not in listing["item"]:
        failures.append(f"上架畫面沒有顯示這筆的英文名稱 {listing['name']!r}：{listing['item']!r}")
    if listing["affixes"] < 1:
        failures.append(f"上架畫面沒有列出讀到的詞綴：{listing}")
    if listing["marked"] < 1:
        failures.append(f"上架畫面讀到的數值沒有標成「從擷取讀到」：{listing}")
    if not listing["postDisabled"] or "符文" not in listing["why"]:
        failures.append(f"上架鈕應因沒有標價而停用並說明：停用={listing['postDisabled']} 原因={listing['why']!r}")
    if listing["back_view"] != "scan" or listing["records_after"] != listing["records_before"]:
        failures.append(f"上架畫面的「返回」沒有回到同一份掃描清單：{listing}")
    if listing["createRequests"] != 0:
        failures.append(f"側邊欄送出了 {listing['createRequests']} 次 listings/create 請求（不該有）")
    if listing.get("runeOptions", -1) < 10:
        failures.append(f"符文選單是空的（{listing.get('runeOptions')} 項）")
    if listing.get("selectOptions", -1) < 2:
        failures.append("新增屬性選單是空的")
    return failures


def verdict(report: dict) -> list[str]:
    """The section-6 assertions; returns one Traditional Chinese message per failed one. Pure: no Chrome needed."""
    if report.get("sim_page_type") == "failures":
        return _verdict_failures(report)
    failures = []
    expects = report.get("expects", [])
    names = report.get("names", [])
    if report.get("record_count") != len(expects):
        failures.append(f"紀錄應為 {len(expects)} 筆，實際 {report.get('record_count')} 筆：{report.get('records')}")
    if sorted(names) != sorted(expects):
        failures.append(f"名稱集合不符，預期 {sorted(expects)}，實際 {sorted(names)}")
    if len(set(names)) != len(names):
        failures.append(f"名稱有重複：{names}")
    failures += _csv_and_visibility_failures(report)
    failures += _exact_click_failures(report)
    failures += _unsure_failures(report)
    failures += _fuzzy_item_failures(report.get("fuzzy_item"))
    base = report.get("fuzzy_base")
    failures += _query_failures("底材紀錄的「模糊搜尋」", base, mode="stats")
    if base and base["outcome"] == "clicked":
        if base["statsBase"] != report.get("base_name"):
            failures.append(f"底材紀錄應以 {report.get('base_name')!r} 搜尋（#stats-base），實際 {base['statsBase']!r}")
        elif base["ticks"] != 0:
            failures.append(f"底材紀錄的「模糊搜尋」不該帶詞綴條件，實際勾選 {base['ticks']} 個：{base}")
    failures += _query_phase_failures(report)
    failures += _listing_failures(report.get("listing"))
    failures += _clear_failures(
        report.get("clear"), left_note="（清除前已取走的裁圖不該回來）", csv_note="（清單應該是空的）"
    )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="裝備掃描真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    parser.add_argument("--page", type=Path, help="改跑另一個模擬頁（預設 scripts/data/scan_sim.html）")
    parser.add_argument("--minimize-after", type=float, default=0.0, metavar="SECONDS",
                        help="掃描開始後幾秒把瀏覽器視窗最小化（模擬遊戲蓋住 Chrome；預設 0 不最小化）")
    parser.add_argument("--shots", action="store_true",
                        help="另外把各畫面在側邊欄寬度（320、360、400 px）下截圖到 artifacts/scan-e2e/shots/")
    args = parser.parse_args()
    truth = json.loads(TRUTH.read_text(encoding="utf-8"))
    if (DATA / "ocr_truth_holdout.json").exists():
        truth += json.loads((DATA / "ocr_truth_holdout.json").read_text(encoding="utf-8"))
    by_file = {entry["file"]: entry for entry in truth}
    sim_page = args.page or SIM
    sim_page_type = "failures" if "failures" in str(sim_page) else "normal"
    if sim_page_type == "failures":
        sim_files = [
            "image-11.png", "image-13.png", "image-16.png", "image-20.png",
            "image-41.png", "image-43.png", "image-49.png",
        ]
        # image-49 is The Redeemer (scripts/data/ocr_truth_holdout.json). Its fallback crop also holds part of a second
        # tooltip, so the whole read names it Ars Dul'Mephistos or The Redeemer depending on how its lines were batched;
        # an earlier version of this check expected Ars, which was the wrong one of the two.
        expects = ["Ring", "Alpha Helm", "Diadem", "Ring", "Ring", "The Redeemer"]
        item_name = "The Redeemer"
        base_name = "Diadem"
    else:
        sim_files = SIM_FILES
        item_name = by_file[ITEM_FILE]["expect"]
        base_name = by_file[BASE_FILE]["expect"]
        expects = [by_file[name]["expect"] for name in sim_files]
    chrome = None
    try:
        build_extension(LOCAL_API)
        chrome = start_chrome(args.headed, EXTRA_ARGS)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        report = asyncio.run(
            drive(open_panel(ext_id), open_sim(sim_page), expects, item_name, base_name,
                  minimize_after=args.minimize_after, sim_page_type=sim_page_type, shots=args.shots)
        )
    except (Environment, subprocess.CalledProcessError) as error:
        return environment_failure(error)
    finally:
        cleanup(chrome, None)
    failures = verdict(report)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    report.pop("views", None)
    if failures:
        say("失敗：")
        for failure in failures:
            say(f"  - {failure}")
        say(f"報告：{path}")
        return 1
    say(f"通過：紀錄 {report['record_count']} 筆，名稱 {sorted(report['names'])}")
    say("搜尋鈕都真的開始了查詢（替身擋下，沒有用到次數）")
    say(f"報告：{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
