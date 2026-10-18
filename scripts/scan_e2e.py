"""Real-Chrome end-to-end check of the gear scanner: uv run --group e2e python scripts/scan_e2e.py [--headed]
[--page PATH].

`--page` runs the same drive against another sim page (default scripts/data/scan_sim.html); a page only has to keep
the "D2R-SIM" title so Chrome's auto-select still finds it. It exists for measurements such as the same tooltips at
their native size on a bigger stage. `--minimize-after SECONDS` minimizes the browser window that many seconds into
the sweep, i.e. makes the side-panel page invisible the way it is when the game covers Chrome - the condition the
capture path is built for (measured 2026-10-13: all four records still land).

Windows-only tool (Windows Chrome paths). Builds the extension into extension/dist-e2e, loads it into the dedicated
Chrome, opens scripts/data/scan_sim.html as a tab and drives the side panel:
  1. put a placeholder invite code on the panel (held in memory, never sent anywhere: nothing starts a query);
  2. pick the third query mode (choose-scan), start the scan (scan-start) and let missing models download
     automatically — the panel opens the share dialog itself, Chrome auto-selects the "D2R-SIM" tab;
  3. let the simulated sweep run twice (the same four tooltips) and wait until document.title is D2R-SIM-DONE,
     then until the OCR queue is empty (#scan-status says 待辨識 0 件);
  3b. when the matcher was not sure about a read (an item with its type line under it, name not in a unique/set
     colour) the row must sit on the list as 不確定 with both search buttons disabled; the script then picks the right
     name on each, like the player, and the row must come out named with the buttons enabled. No unsure row is a pass
     too (the name-colour rule makes all four sim items sure): the check is that the unsure path is consistent, and
     every row is named in the end;
  4. assert what the capture plan's section 6 lists: exactly four records, the names equal the expect values of the
     four pictures in scripts/data/ocr_truth.json, no duplicates, #scan-csv enabled, and the two per-record buttons
     only pre-fill the existing name/stats forms (精準搜尋 leaves mode "name", 模糊搜尋 leaves mode "stats" with at
     least one ticked condition and an empty #stats-base for an item, filled for the base record) — and that no query
     ever started.
Writes artifacts/scan-e2e/report.json. Exit 0 all good, 1 an assertion failed, 2 environment.
Clears the shared dedicated Chrome profile at its own startup (free_profile, like its siblings) and starts no backend
(the placeholder invite code is never used).
"""

import argparse
import asyncio
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
    views: window.__scanViews || []
  });
})()"""

# Records every view/mode the panel derives; a scan that never searches must never show "running".
HOOK = """(() => {
  window.__scanViews = [];
  const snap = () => window.__scanViews.push([document.body.dataset.view || '', document.body.dataset.mode || '']);
  snap();
  new MutationObserver(snap).observe(document.body, { attributes: true, attributeFilter: ['data-view', 'data-mode'] });
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

# The player's pick on an unsure row: the button of the wanted name among the row's decision buttons.
PICK_OPTION = """(() => {
  const button = [...document.querySelectorAll('#scan-list li[data-unsure="true"] .options button')]
    .find((b) => b.dataset.name === %s);
  if (!button) return 'no-option';
  button.click();
  return 'picked';
})()"""


class Panel(CdpPanel):
    STATE_JS = STATE
    READY_JS = "document.readyState === 'complete' && !!document.getElementById('choose-scan')"


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
        await panel.evaluate("document.getElementById('choose-scan').click()")
        state = await panel.wait(lambda s: s["view"] == "scan", 30)
    return state


# What the name field must show after 精準搜尋 on the record named %s: the Chinese part of its 中文（English） label.
SHOWN_NAME = """(() => {
  const li = [...document.querySelectorAll('#scan-list li')].find((l) => l.dataset.name === %s);
  const text = li?.querySelector('strong')?.textContent || '';
  const m = /^(.+)（.+）$/u.exec(text);
  return m ? m[1] : text;
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
    try:
        state = await panel.wait(lambda s: len(s["records"]) >= len(report["expects"]), 30)
    except Environment:
        state = await panel.state()
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


async def _collect_record_clicks(
    panel: Panel, expects: list[str], item_name: str, base_name: str, report: dict
) -> None:
    """Click each record's 精準搜尋 button, then 模糊搜尋 on a non-base and on the base record, and record what they
    pre-filled. No click may start a query."""
    # Each record's 精準搜尋: it fills #item with that record's name and nothing starts a query.
    names, clicks = [], []
    for name in expects:
        await ensure_scan(panel)
        outcome = await click_record(panel, name, "精準搜尋")
        await asyncio.sleep(0.3)
        after = await panel.state()
        # The record shows 中文（English） (plain English without a Chinese name) and the field gets the Chinese part;
        # the English name stays in data-name, which is also what Traderie is queried with.
        shown = await panel.evaluate(SHOWN_NAME % json.dumps(name))
        clicks.append(
            {"name": name, "outcome": outcome, "mode": after["mode"], "view": after["view"], "item": after["item"],
             "shown_field": shown}
        )
        names.append(name if after["item"] == shown else after["item"])
        say(f"  精準搜尋 {name!r} -> {outcome}，item={after['item']!r}")
    report["exact_clicks"] = clicks
    report["names"] = names

    # 模糊搜尋 on a non-base record: conditions ticked, the base box prefilled with the same read's base candidate.
    # The fill is asynchronous (the first one may have to read Traderie's property list), so wait until the affix list
    # shows rows rather than for a fixed moment.
    await ensure_scan(panel)
    outcome = await click_record(panel, item_name, "模糊搜尋")
    await wait_for_fill(panel)
    after = await panel.state()
    report["fuzzy_item"] = {
        "outcome": outcome, "mode": after["mode"], "view": after["view"],
        "ticks": after["ticks"], "statsBase": after["statsBase"], "statsBaseFrom": after["statsBaseFrom"],
        "statsBaseMarked": after["statsBaseMarked"], "baseOptions": after["baseOptions"],
    }
    say(
        f"  模糊搜尋 {item_name!r} -> {outcome}，mode={after['mode']} 勾選={after['ticks']}"
        f" 底材={after['statsBase']!r}"
    )

    # 模糊搜尋 on the base record: the base box is pre-filled with the base's own name.
    await ensure_scan(panel)
    outcome = await click_record(panel, base_name, "模糊搜尋")
    await wait_for_fill(panel)
    after = await panel.state()
    report["fuzzy_base"] = {
        "outcome": outcome, "mode": after["mode"], "view": after["view"],
        "ticks": after["ticks"], "statsBase": after["statsBase"],
    }
    say(f"  模糊搜尋 {base_name!r} -> {outcome}，底材={after['statsBase']!r}")

    report["views"] = after["views"]
    report["banner"] = after["banner"]


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


async def drive(panel_ws: str, sim_ws: str, expects: list[str], item_name: str, base_name: str,
                minimize_after: float = 0.0, sim_page_type: str = "normal") -> dict:
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
        # The placeholder code sits in storage, is never sent, and only exists so the panel shows the form screens.
        had_invite = await panel.evaluate("chrome.storage.local.get('invite').then((r) => Boolean(r.invite))")
        if not had_invite:
            await panel.evaluate(f"chrome.storage.local.set({{ invite: {json.dumps(INVITE)} }})")
        # What the reader learned in an earlier run (jevCorrections) must not decide a read of this one: start empty.
        await panel.evaluate("chrome.storage.local.remove('jevCorrections')")
        await panel.reload()
        await panel.evaluate(HOOK)
        await panel.evaluate("document.getElementById('choose-scan').click()")
        await panel.wait(lambda s: s["view"] == "scan", 30)

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
        await _clear_records(panel, report)
        await panel.evaluate("chrome.storage.local.remove('jevCorrections')")  # leave nothing learned behind
    return report


async def wait_for_fill(panel: Panel, seconds: int = 25) -> None:
    """The affix form fills asynchronously: the first fill of a session may have to read Traderie's property list (this
    e2e starts from a cleared profile, so the panel's cache is empty). Wait until the list shows rows; a timeout is left
    for the verdict to report rather than raised here."""
    try:
        await panel.wait(lambda state: state["affixRows"] > 0, seconds)
    except Environment:
        say(f"  等不到詞綴表單填好（{seconds} 秒），交給判定處理：{await panel.state()}")


def _fuzzy_item_failures(fuzzy: dict | None) -> list[str]:
    """The 模糊搜尋 assertions on a non-base record: it switches to the affix form, ticks a condition, and pre-fills
    the base the same read produced (marked as coming from the capture), from the table's own suggestions."""
    if not fuzzy or fuzzy["outcome"] != "clicked" or fuzzy["mode"] != "stats" or fuzzy["view"] != "ready":
        return [f"暗金紀錄的「模糊搜尋」沒有切到詞綴表單：{fuzzy}"]
    failures = []
    if fuzzy["ticks"] < 1:
        failures.append(f"暗金紀錄的「模糊搜尋」沒有勾選任何詞綴條件：{fuzzy}")
    # A unique item's tooltip does not name its base, so the record carries the base candidate of the same read
    # (scan/session.js baseCandidate) and 模糊搜尋 prefills it, marked as coming from the capture. The player can
    # still edit it, and nothing is searched until they press start.
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


def _verdict_failures(report: dict) -> list[str]:
    failures = []
    count = report.get("record_count", 0)
    if count < 6:
        failures.append(f"備援偵測救回件數不足，預期至少 6 筆，實際 {count} 筆：{report.get('records')}")
    expected_names = {"Alpha Helm", "Diadem", "Ring", "Ars Dul'Mephistos"}
    records_text = " ".join(report.get("records", []))
    for name in expected_names:
        if name not in records_text:
            failures.append(f"未找到預期的救回紀錄：{name}")
    report["known_gap"] = (
        "image-43.png (Light Plated Boots): rare boots with Chinese base unmapped in Traderie products table"
    )
    if not report.get("csv_enabled"):
        failures.append("#scan-csv 不是可用（下載 CSV 不需要先查詢）")
    hidden = report.get("visibility") == "hidden"
    if hidden != (HIDDEN_NOTICE in report.get("status", "")):
        failures.append(f"蓋住面板的提醒和頁面可見狀態不一致（visibility={report.get('visibility')!r}）：{report.get('status')!r}")
    for click in report.get("exact_clicks", []):
        if (
            click["outcome"] != "clicked"
            or click["mode"] != "name"
            or click["view"] != "ready"
            or click["item"] != click["shown_field"]
        ):
            failures.append(f"「精準搜尋」（{click['name']}）沒有正確填入：{click}")
    base = report.get("fuzzy_base")
    if not base or base["outcome"] != "clicked" or base["mode"] != "stats" or base["view"] != "ready":
        failures.append(f"底材紀錄的「模糊搜尋」沒有切到詞綴表單：{base}")
    if report.get("banner"):
        failures.append("查詢橫幅出現：掃描過程不該送出任何查詢")
    if any(view == "running" for view, _ in report.get("views", [])):
        failures.append("掃描過程中畫面變成 running：有查詢被送出")
    cleared = report.get("clear")
    if not cleared or cleared.get("before", 0) < 1:
        failures.append(f"清除紀錄沒有在有紀錄時按下去：{cleared}")
    elif cleared.get("after") != 0:
        failures.append(f"清除紀錄之後仍有紀錄：{cleared}")
    elif cleared.get("csv"):
        failures.append(f"清除紀錄之後 #scan-csv 還可以用：{cleared}")
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
    if not report.get("csv_enabled"):
        failures.append("#scan-csv 不是可用（下載 CSV 不需要先查詢）")
    # The side panel's "game covers this panel" notice must show exactly while the page reports itself hidden (the sim
    # tab is in front of the panel tab here, so the run is normally hidden; the anti-throttle flags keep it fast).
    hidden = report.get("visibility") == "hidden"
    if hidden != (HIDDEN_NOTICE in report.get("status", "")):
        failures.append(f"蓋住面板的提醒和頁面可見狀態不一致（visibility={report.get('visibility')!r}）：{report.get('status')!r}")
    for click in report.get("exact_clicks", []):
        if (
            click["outcome"] != "clicked"
            or click["mode"] != "name"
            or click["view"] != "ready"
            or click["item"] != click["shown_field"]
        ):
            failures.append(f"「精準搜尋」（{click['name']}）沒有正確填入：{click}")
    failures += _unsure_failures(report)
    failures += _fuzzy_item_failures(report.get("fuzzy_item"))
    base = report.get("fuzzy_base")
    if not base or base["outcome"] != "clicked" or base["mode"] != "stats" or base["view"] != "ready":
        failures.append(f"底材紀錄的「模糊搜尋」沒有切到詞綴表單：{base}")
    elif base["statsBase"] != report.get("base_name"):
        failures.append(f"底材紀錄應預填 {report.get('base_name')!r} 到 #stats-base，實際 {base['statsBase']!r}")
    if report.get("banner"):
        failures.append("查詢橫幅出現：掃描過程不該送出任何查詢")
    if any(view == "running" for view, _ in report.get("views", [])):
        failures.append("掃描過程中畫面變成 running：有查詢被送出")
    cleared = report.get("clear")
    if not cleared or cleared.get("before", 0) < 1:
        failures.append(f"清除紀錄沒有在有紀錄時按下去：{cleared}")
    elif cleared.get("after") != 0:
        failures.append(f"清除紀錄之後仍有紀錄（清除前已取走的裁圖不該回來）：{cleared}")
    elif cleared.get("csv"):
        failures.append(f"清除紀錄之後 #scan-csv 還可以用（清單應該是空的）：{cleared}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="裝備掃描真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    parser.add_argument("--page", type=Path, help="改跑另一個模擬頁（預設 scripts/data/scan_sim.html）")
    parser.add_argument("--minimize-after", type=float, default=0.0, metavar="SECONDS",
                        help="掃描開始後幾秒把瀏覽器視窗最小化（模擬遊戲蓋住 Chrome；預設 0 不最小化）")
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
        expects = ["Ring", "Alpha Helm", "Diadem", "Ring", "Ring", "Ars Dul'Mephistos"]
        item_name = "Ars Dul'Mephistos"
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
                  minimize_after=args.minimize_after, sim_page_type=sim_page_type)
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
    say(f"通過：紀錄 {report['record_count']} 筆，名稱 {sorted(report['names'])}，沒有查詢被送出")
    say(f"報告：{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
