"""Real-Chrome end-to-end check of the gear scanner: uv run --group e2e python scripts/scan_e2e.py [--headed].

Windows-only tool (Windows Chrome paths). Builds the extension into extension/dist-e2e, loads it into the dedicated
Chrome, opens scripts/data/scan_sim.html as a tab and drives the side panel:
  1. put a placeholder invite code on the panel (held in memory, never sent anywhere: nothing starts a query);
  2. pick the third query mode (choose-scan), start the scan (scan-start) and let missing models download
     automatically — the panel opens the share dialog itself, Chrome auto-selects the "D2R-SIM" tab;
  3. let the simulated sweep run twice (the same four tooltips) and wait until document.title is D2R-SIM-DONE,
     then until the OCR queue is empty (#scan-status says 待辨識 0 件);
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

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cdp import Environment, attach  # noqa: E402
from _cdp import Panel as CdpPanel  # noqa: E402
from extension_e2e import (  # noqa: E402
    DEBUG_PORT,
    LOCAL_API,
    build_extension,
    cleanup,
    free_profile,
    launch_chrome,
    load_extension,
    open_panel,
    say,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "scripts" / "data"
TRUTH = DATA / "ocr_truth.json"
SIM = DATA / "scan_sim.html"
OUT = ROOT / "artifacts" / "scan-e2e"
INVITE = "dummy-invite"
# The four pictures the sim loops over; their expect values in the truth file are the names the panel must show.
SIM_FILES = ["image-14.png", "image-15.png", "image-17.png", "image-18.png"]
ITEM_FILE = "image-17.png"  # a non-base record (Alma Negra): 模糊搜尋 must leave the base box alone
BASE_FILE = "image-14.png"  # the base-kind record (Grand Charm): 模糊搜尋 may pre-fill the base box
# The sim tab is picked by its title; the canvas is exactly 1280x720. The backgrounding flags keep Chrome rendering the
# (background) sim tab at full speed while it is being captured, instead of throttling it to about 1 fps.
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
    stats: $('scan-stats')?.textContent || '',
    downloadNotice: !!$('scan-download') && !$('scan-download').hidden,
    progress: Number($('scan-progress')?.value || 0),
    csv: !!$('scan-csv') && !$('scan-csv').disabled,
    item: $('item')?.value || '',
    statsBase: $('stats-base')?.value || '',
    ticks: [...document.querySelectorAll('#affix-list .affix-on')].filter((b) => b.checked).length,
    records: [...document.querySelectorAll('#scan-list li')].map((li) => li.textContent),
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


class Panel(CdpPanel):
    STATE_JS = STATE
    READY_JS = "document.readyState === 'complete' && !!document.getElementById('choose-scan')"


def open_sim() -> str:
    """Opens the sim page as its own tab and returns the tab's debugger websocket URL."""
    url = SIM.resolve().as_uri()
    target = httpx.put(f"http://127.0.0.1:{DEBUG_PORT}/json/new?{urllib.parse.quote(url, safe=':/')}").json()
    return target["webSocketDebuggerUrl"]


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


async def click_record(panel: Panel, name: str, label: str) -> str:
    """Clicks one record's 精準搜尋 / 模糊搜尋 button; returns 'clicked', 'no-record', 'no-button' or 'disabled'."""
    return await panel.evaluate(CLICK_RECORD % (json.dumps(name), json.dumps(label)))


async def _run_scan(panel: Panel, sim: CdpPanel, report: dict) -> None:
    """Start the scan, let the models download, restart the sim inside a live capture, then wait for it to drain."""
    say("開始掃描（分享模擬視窗）…")
    await panel.evaluate("document.getElementById('scan-start').click()")
    state = await panel.wait(lambda s: s["downloadNotice"] or "掃描中" in s["status"], 60)
    if state["downloadNotice"]:
        report["download_without_question"] = True
        say("側邊欄正在下載辨識模型…")
        state = await panel.wait(lambda s: s["progress"] > 0 or "掃描中" in s["status"], 60)
        if state["progress"] > 0:
            report["progress_seen"] = True
        state = await panel.wait(lambda s: "掃描中" in s["status"], 300)
        if state["progress"] > 0:
            report["progress_seen"] = True
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
        clicks.append(
            {"name": name, "outcome": outcome, "mode": after["mode"], "view": after["view"], "item": after["item"]}
        )
        names.append(after["item"])
        say(f"  精準搜尋 {name!r} -> {outcome}，item={after['item']!r}")
    report["exact_clicks"] = clicks
    report["names"] = names

    # 模糊搜尋 on a non-base record: conditions ticked, the base box left empty for the player.
    await ensure_scan(panel)
    outcome = await click_record(panel, item_name, "模糊搜尋")
    await asyncio.sleep(0.3)
    after = await panel.state()
    report["fuzzy_item"] = {
        "outcome": outcome, "mode": after["mode"], "view": after["view"],
        "ticks": after["ticks"], "statsBase": after["statsBase"],
    }
    say(
        f"  模糊搜尋 {item_name!r} -> {outcome}，mode={after['mode']} 勾選={after['ticks']}"
        f" 底材={after['statsBase']!r}"
    )

    # 模糊搜尋 on the base record: the base box is pre-filled with the base's own name.
    await ensure_scan(panel)
    outcome = await click_record(panel, base_name, "模糊搜尋")
    await asyncio.sleep(0.3)
    after = await panel.state()
    report["fuzzy_base"] = {
        "outcome": outcome, "mode": after["mode"], "view": after["view"],
        "ticks": after["ticks"], "statsBase": after["statsBase"],
    }
    say(f"  模糊搜尋 {base_name!r} -> {outcome}，底材={after['statsBase']!r}")

    report["views"] = after["views"]
    report["banner"] = after["banner"]


async def drive(panel_ws: str, sim_ws: str, expects: list[str], item_name: str, base_name: str) -> dict:
    report: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "expects": expects, "base_name": base_name}
    async with attach(panel_ws, Panel, collect_events=True) as panel, attach(sim_ws) as sim:
        await panel.send("Page.enable")
        await panel.send("Runtime.enable")
        await panel.wait_ready("側邊欄頁面沒有載入（掃描畫面還不存在？）")
        # The placeholder code sits in storage, is never sent, and only exists so the panel shows the form screens.
        had_invite = await panel.evaluate("chrome.storage.local.get('invite').then((r) => Boolean(r.invite))")
        if not had_invite:
            await panel.evaluate(f"chrome.storage.local.set({{ invite: {json.dumps(INVITE)} }})")
        await panel.reload()
        await panel.evaluate(HOOK)

        await panel.evaluate("document.getElementById('choose-scan').click()")
        await panel.wait(lambda s: s["view"] == "scan", 30)

        # The sim sweeps from load and reaches D2R-SIM-DONE ~7.2 s later, while the by-title auto-select flag needs
        # the title to be "D2R-SIM" at the moment getDisplayMedia() runs. Restart it here so the title is right
        # when the share dialog opens; it is restarted again below once frames really flow.
        await sim_ready(sim)
        await sim.evaluate("window.D2R_SIM.restart()")

        await _run_scan(panel, sim, report)
        await _collect_record_clicks(panel, expects, item_name, base_name, report)
    return report


def verdict(report: dict) -> list[str]:
    """The section-6 assertions; returns one Traditional Chinese message per failed one. Pure: no Chrome needed."""
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
    for click in report.get("exact_clicks", []):
        if (
            click["outcome"] != "clicked"
            or click["mode"] != "name"
            or click["view"] != "ready"
            or click["item"] != click["name"]
        ):
            failures.append(f"「精準搜尋」（{click['name']}）沒有正確填入：{click}")
    fuzzy = report.get("fuzzy_item")
    if not fuzzy or fuzzy["outcome"] != "clicked" or fuzzy["mode"] != "stats" or fuzzy["view"] != "ready":
        failures.append(f"暗金紀錄的「模糊搜尋」沒有切到詞綴表單：{fuzzy}")
    else:
        if fuzzy["ticks"] < 1:
            failures.append(f"暗金紀錄的「模糊搜尋」沒有勾選任何詞綴條件：{fuzzy}")
        if fuzzy["statsBase"] != "":
            failures.append(f"暗金紀錄不該預填底材，實際 {fuzzy['statsBase']!r}")
    base = report.get("fuzzy_base")
    if not base or base["outcome"] != "clicked" or base["mode"] != "stats" or base["view"] != "ready":
        failures.append(f"底材紀錄的「模糊搜尋」沒有切到詞綴表單：{base}")
    elif base["statsBase"] != report.get("base_name"):
        failures.append(f"底材紀錄應預填 {report.get('base_name')!r} 到 #stats-base，實際 {base['statsBase']!r}")
    if report.get("banner"):
        failures.append("查詢橫幅出現：掃描過程不該送出任何查詢")
    if any(view == "running" for view, _ in report.get("views", [])):
        failures.append("掃描過程中畫面變成 running：有查詢被送出")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="裝備掃描真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    args = parser.parse_args()
    truth = json.loads(TRUTH.read_text(encoding="utf-8"))
    by_file = {entry["file"]: entry for entry in truth}
    expects = [by_file[name]["expect"] for name in SIM_FILES]
    item_name = by_file[ITEM_FILE]["expect"]
    base_name = by_file[BASE_FILE]["expect"]
    chrome = None
    try:
        build_extension(LOCAL_API)
        free_profile()
        chrome = launch_chrome(args.headed, EXTRA_ARGS)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        report = asyncio.run(drive(open_panel(ext_id), open_sim(), expects, item_name, base_name))
    except Environment as error:
        say(f"環境問題：{error}")
        return 2
    except subprocess.CalledProcessError:
        say("環境問題：擴充功能打包失敗")
        return 2
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
