"""Real-Chrome end-to-end check of the screenshot reader: uv run --group e2e python scripts/ocr_e2e.py [--headed].

Windows-only tool (Windows Chrome paths). Builds the extension into extension/dist-e2e, loads it into the dedicated
Chrome, then in the side panel:
  C  download group: first use asks nothing and downloads by itself, with no download UI on the page (no notice,
     progress bar or cancel button), checks and stores the four PP-OCR assets, a second run and a reload do not
     download again, a blocked download is reported (one attempt, not retried);
  A/B accuracy and speed group: every picture in scripts/data listed in the tuned truth file (default ocr_truth.json)
     and in the held-out truth file (scripts/data/ocr_truth_holdout.json) goes through the real panel and is compared
     with it; each group's numbers must not fall below the same group of the last accepted run
     (artifacts/ocr-e2e/report.json) or, without one, below FALLBACK_FLOORS. --only narrows the tuned list and skips
     the held-out group. A read the panel is not sure about fills nothing and shows its candidates as decision
     buttons (`data-unsure`); it is scored on those buttons in the matcher's order (`candidate_order`), so top1/top3
     keep their meaning, and `asked`/`auto_right`/`auto_wrong` count what the player met - any `auto_wrong` fails;
  D affix group: a base-kind picture read in the 模糊搜尋 form fills the base and every recognised affix condition by
     itself, with the value boxes empty and the label in 中文（English） form, without starting a query.
It downloads the model files from www.modelscope.cn (the panel's auto-download flow) and closes the
dedicated Chrome first. Writes artifacts/ocr-e2e/report.json only for a complete passing accuracy run (any other run
goes to report-last.json, so the last accepted numbers survive). Exit 0 all good, 1 something failed, 2 environment.

Flags: `--headed` shows the Chrome window (headless by default). `--skip-download` drops the C download group and
`--skip-accuracy` drops the A/B accuracy and speed group, so a run can check just one part. `--truth` picks the tuned
answer file inside scripts/data/ (default ocr_truth.json), and `--only` narrows the tuned list to the named pictures.
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cdp import Environment, attach  # noqa: E402
from _cdp import Panel as CdpPanel  # noqa: E402
from extension_e2e import (  # noqa: E402
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
OUT = ROOT / "artifacts" / "ocr-e2e"
# The pictures the reader was never tuned on, scored in the same run beside the tuned group. They are read after the
# tuned rows, by the same reader. With --only given the tuned list is narrowed to the named pictures and this group is
# not scored at all (see HOLDOUT_NOTE, which every report carries).
HOLDOUT = "ocr_truth_holdout.json"
# Used only while there is no accepted report.json for the same truth file: scored pictures and the hits the browser
# PP-OCRv6 small reached (measured 2026-10 with browser PP-OCRv6 small).
FALLBACK_FLOORS = {
    "ocr_truth.json": {"scored": 22, "top1": 20, "top3": 21, "screenshots_top3": 17, "phone_top3": 4},
    HOLDOUT: {"scored": 30, "top1": 22, "top3": 26, "screenshots_top3": 16, "phone_top3": 10},
}
HOLDOUT_NOTE = (
    "保留組（scripts/data/ocr_truth_holdout.json，調校過的圖片之外的 30 張）也一起評分：沒有 --only 時每次都會評，"
    "給了 --only 只挑調校組的圖片，保留組就不評。"
)
_MS = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2"
MODELS = {
    "det": f"{_MS}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
    "rec": f"{_MS}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
    "cls": f"{_MS}/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "dict": f"{_MS}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
}
# D group: the base-kind picture whose truth entry names a base the item table has a Chinese name for, so the
# 中文（English） label can be asserted (measured 2026-10: image-4.png reads as base "Small Charm" = 小型咒符, with one
# affix condition and no value).
AFFIX_PICTURE = "image-4.png"
STATE = """JSON.stringify({
  status: document.getElementById('ocr-status').textContent,
  kind: document.getElementById('ocr-status').dataset.kind || '',
  time: document.getElementById('ocr-time').textContent,
  text: document.getElementById('ocr-text').textContent,
  tones: JSON.parse(document.getElementById('ocr-text').dataset.tones || 'null'),
  consentGone: document.getElementById('ocr-consent') === null,
  item: document.getElementById('item').value,
  go: !document.getElementById('ocr-go').disabled,
  candidates: [...document.querySelectorAll('#ocr-candidates button')].map((b) => ({
    kind: b.dataset.kind || '', name: b.dataset.name || '', learned: b.dataset.learned || '' })),
  firstKind: document.getElementById('ocr-candidates').dataset.firstKind || '',
  firstName: document.getElementById('ocr-candidates').dataset.firstName || '',
  unsure: document.getElementById('ocr-candidates').dataset.unsure === 'true',
  mode: document.body.dataset.mode || '',
  view: document.body.dataset.view || '',
  base: document.getElementById('stats-base').value,
  affixRows: [...document.querySelectorAll('#affix-list li')].map((li) => ({
    key: li.dataset.key, on: li.querySelector('.affix-on')?.checked ?? null,
    unmapped: li.classList.contains('unmapped'),
    box: li.querySelector('.affix-min') !== null,
    marked: li.querySelectorAll('input.from-capture').length,
    min: li.querySelector('.affix-min')?.value ?? null, max: li.querySelector('.affix-max')?.value ?? null })),
  external: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !n.startsWith('chrome-extension://'))
})"""


class Panel(CdpPanel):
    STATE_JS = STATE
    READY_JS = "document.readyState === 'complete' && !!document.getElementById('ocr-go')"

    async def set_files(self, selector, paths):
        document = await self.send("DOM.getDocument", {"depth": 0})
        node = await self.send("DOM.querySelector", {"nodeId": document["root"]["nodeId"], "selector": selector})
        await self.send(
            "DOM.setFileInputFiles", {"nodeId": node["nodeId"], "files": [str(Path(p).resolve()) for p in paths]}
        )

    async def wipe_models(self):
        await self.evaluate(
            "new Promise((ok) => { const r = indexedDB.deleteDatabase('keyval-store');"
            " r.onsuccess = r.onerror = r.onblocked = ok; })"
        )

    async def load_picture(self, path):
        await self.evaluate("document.getElementById('ocr-file').value = ''")
        await self.evaluate("document.getElementById('ocr-status').textContent = ''")
        await self.set_files("#ocr-file", [path])
        await self.wait(lambda s: s["go"] and "已讀入圖片" in s["status"], 30)


def model_requests(state):
    return [u for u in state["external"] if "www.modelscope.cn" in u]


async def _wait_read(panel: Panel, seconds: int) -> dict:
    """Wait until a read ends: the panel shows a time, or reports an error."""
    return await panel.wait(lambda s: s["time"] or s["kind"] == "error", seconds)


async def _read_picture(panel: Panel, path: Path, seconds: int = 240) -> dict:
    """Load one picture, press go and wait for the read to end."""
    await panel.load_picture(path)
    await panel.evaluate("document.getElementById('ocr-go').click()")
    return await _wait_read(panel, seconds)


async def _fail_paused_requests(panel: Panel) -> int:
    """Answer every paused model-download request with a connection error; returns how many were answered."""
    failed = 0
    for event in list(panel.events):
        if event.get("method") == "Fetch.requestPaused":
            failed += 1
            await panel.send(
                "Fetch.failRequest", {"requestId": event["params"]["requestId"], "errorReason": "ConnectionRefused"}
            )
            panel.events.remove(event)
    return failed


async def download_group(panel: Panel, report: dict, first_image: Path) -> None:
    checks = report.setdefault("download", {})
    await panel.reload()
    await panel.wipe_models()
    await panel.reload()
    await panel.load_picture(first_image)

    await _no_download_ui_checks(panel, checks)
    await _first_download_checks(panel, checks, first_image)
    await _blocked_download_checks(panel, checks, first_image)

    # The blocked-download test wiped the models; the reading groups below need them, so download them again.
    await _read_picture(panel, first_image)


async def _no_download_ui_checks(panel: Panel, checks: dict) -> None:
    """The first-time download is silent: no notice, progress bar or cancel button is on the page at all."""
    checks["no_download_ui"] = await panel.evaluate(
        "document.getElementById('ocr-download') === null"
        " && document.getElementById('ocr-progress') === null"
        " && document.getElementById('ocr-cancel') === null"
    )


async def _first_download_checks(panel: Panel, checks: dict, first_image: Path) -> None:
    """First use: it asks nothing, downloads by itself from the fixed URLs; a second read downloads nothing."""
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await _wait_read(panel, 180)
    checks["no_consent_element"] = state["consentGone"]
    checks["requests_started_by_themselves"] = bool(model_requests(state))
    checks["first_run_status"] = state["status"]
    checks["download_urls"] = sorted(set(model_requests(state)))
    checks["only_fixed_urls"] = set(checks["download_urls"]) <= set(MODELS.values())

    # Second picture, same page: no new download.
    await panel.load_picture(first_image)
    before = len(model_requests(await panel.state()))
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await _wait_read(panel, 180)
    checks["second_run_no_download"] = len(model_requests(state)) == before

    # Reload the panel (the models must survive in IndexedDB).
    await panel.reload()
    state = await _read_picture(panel, first_image, 180)
    checks["after_reload_no_download"] = not model_requests(state)


async def _blocked_download_checks(panel: Panel, checks: dict, first_image: Path) -> None:
    """A download that cannot get through: one attempt per model, a clear message, no automatic retry."""
    await panel.wipe_models()
    await panel.reload()
    await panel.send(
        "Fetch.enable", {"patterns": [{"urlPattern": "*www.modelscope.cn*", "requestStage": "Request"}]}
    )
    await panel.load_picture(first_image)
    await panel.evaluate("document.getElementById('ocr-go').click()")
    blocked = 0
    end = time.time() + 20
    while time.time() < end:
        blocked += await _fail_paused_requests(panel)
        state = await panel.state()
        if state["kind"] == "error":
            break
        await asyncio.sleep(0.3)
    await asyncio.sleep(3)  # a silent retry would show up as another paused request
    blocked += await _fail_paused_requests(panel)
    state = await panel.state()
    checks["blocked_message"] = state["status"]
    checks["blocked_is_clear"] = state["kind"] == "error" and ("下載" in state["status"] or "連不到" in state["status"])
    checks["blocked_requests"] = blocked
    checks["blocked_not_retried"] = blocked <= 1
    await panel.send("Fetch.disable")


def accuracy_metrics(rows: list[dict]) -> dict:
    """The scored hit counts and timings of one group of rows; both groups report the same keys."""
    scored = [r for r in rows if not r["skip"]]
    asked = [r for r in scored if r.get("unsure")]
    small = [r["seconds"] for r in rows if not r["phone"] and r["seconds"]]
    phone = [r["seconds"] for r in rows if r["phone"] and r["seconds"]]
    return {
        "scored": len(scored),
        "top1": sum(r["top1"] for r in scored),
        "top3": sum(r["ok"] for r in scored),
        "screenshots_top3": sum(r["ok"] for r in scored if not r["phone"]),
        "screenshots_scored": sum(1 for r in scored if not r["phone"]),
        "phone_top3": sum(r["ok"] for r in scored if r["phone"]),
        "phone_scored": sum(1 for r in scored if r["phone"]),
        # Reads that were not sure: how many had the right name among the three buttons the matcher gave, and among
        # the up to five possible names the panel now lists (the extra ones are only ever offered, never filled in).
        "asked_top3": sum(r["ok"] for r in asked),
        "asked_top5": sum(r.get("ok5", r["ok"]) for r in asked),
        # What the player met: reads the panel asked about (nothing filled in), and the names it filled in by itself,
        # right or wrong. A wrong name filled in by itself is what the unsure rule exists to prevent.
        "asked": len(asked),
        "auto_right": sum(r["top1"] for r in scored if not r.get("unsure")),
        "auto_wrong": sum(not r["top1"] for r in scored if not r.get("unsure")),
        "avg_seconds_screenshot": round(sum(small) / len(small), 1) if small else None,
        "avg_seconds_phone_photo": round(sum(phone) / len(phone), 1) if phone else None,
        "max_seconds": max((r["seconds"] for r in rows if r["seconds"]), default=None),
    }


def possible_names(state: dict) -> list[str]:
    """Every name button of an unsure read as `kind:name` (up to five: the matcher's three, then the next best table
    names, `extendCandidates`); the same as the candidates of a sure read."""
    return [f"{c['kind']}:{c['name']}" for c in state["candidates"] if c["name"]]


def candidate_order(state: dict) -> list[str]:
    """The candidates of one read as `kind:name`, the matcher's best first. A sure read fills its best name into the
    field (the status says so) and shows the others as buttons; an unsure read fills nothing and every candidate is a
    decision button (the 都不是 button names nothing and is not a candidate). A read that found nothing has none.
    An unsure read may list up to five possible names; the matcher's own three come first and are the ones scored
    here (`possible_names` has all of them), so top1/top3 keep their meaning."""
    buttons = [(c["kind"], c["name"]) for c in state["candidates"] if c["name"]]
    if state["unsure"]:
        return [f"{kind}:{name}" for kind, name in buttons[:3]]
    if "填入裝備名稱" not in state["status"]:
        return []
    first = state["firstName"]  # the English query value; the field shows Chinese
    others = [(kind, name) for kind, name in buttons if name != first]
    return [f"{state['firstKind'] or 'item'}:{first}"] + [f"{kind}:{name}" for kind, name in others]


async def accuracy_speed_group(
    panel: Panel, report: dict, files: list[dict], key: str = "accuracy", rows_key: str = "rows",
    label: str = "調校組"
) -> None:
    rows = []
    say(f"  {label}：{len(files)} 張圖逐張辨識…")
    for item in files:
        await panel.reload()
        await panel.evaluate("document.getElementById('choose-name').click()")
        await panel.evaluate("document.getElementById('item').value = ''")
        state = await _read_picture(panel, DATA / item["file"])
        seconds = float(state["time"].split()[1]) if state["time"] else None
        # The best result is written into the name field; the kinds and names of the other candidates come from the
        # data-kind/data-name attributes the panel sets (the label alone no longer says which is a base).
        unsure = state["unsure"]
        top = candidate_order(state)
        possible = possible_names(state)
        want = f"{item['kind']}:{item['expect']}"
        rows.append(
            {
                "file": item["file"],
                "want": want,
                "top": top,
                "seconds": seconds,
                "ok": item["kind"] != "skip" and want in top,
                "ok5": item["kind"] != "skip" and want in possible,
                "possible": possible,
                "top1": bool(top) and top[0] == want,
                "phone": item["phone_photo"],
                "skip": item["kind"] == "skip",
                "unsure": unsure,
                "field": state["item"],
                "status": state["status"],
                "text": state["text"][:3000],
                "tones": state["tones"],
            }
        )
        say(f"  {item['file'][:14]:14s} {want:32s} -> {'（問玩家）' if unsure else ''}{top} {seconds}s")
    report[key] = accuracy_metrics(rows)
    report[rows_key] = rows


async def _affix_start_gate(panel: Panel, checks: dict) -> None:
    """The captured numbers are in the boxes, so the gate is open. Emptying every box through the page (real input
    events, the way the listener hears them) must close it and show startBlocker's NEED_VALUES reason; giving one
    value back must open it again."""
    gate = (
        "JSON.stringify({ disabled: document.getElementById('start').disabled,"
        " whyVisible: !document.getElementById('start-why').hidden })"
    )
    checks["start_gate_after_capture"] = json.loads(await panel.evaluate(gate))
    emptied = await panel.evaluate(
        "(() => { const boxes = [...document.querySelectorAll('#affix-list .affix-min')];"
        " if (!boxes.length) return false;"
        " for (const box of boxes) { box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); }"
        " return true; })()"
    )
    if emptied:
        checks["start_gate_after_clearing"] = json.loads(await panel.evaluate(gate))
        checks["start_why_after_clearing"] = await panel.evaluate("document.getElementById('start-why').textContent")
        filled = await panel.evaluate(
            "(() => { const li = [...document.querySelectorAll('#affix-list li')]"
            ".find((l) => l.querySelector('.affix-min')); if (!li) return false;"
            " const box = li.querySelector('.affix-min'); box.value = '5';"
            " box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"
        )
        if filled:
            checks["start_enabled_after_value"] = json.loads(await panel.evaluate(gate))


async def affix_group(panel: Panel, report: dict, item: dict) -> None:
    """A base-kind picture read in the affix (模糊搜尋) form: the reading itself fills the base and every recognised
    condition — the attributes are ticked, and the numbers the reader read are filled in and marked as captured — the
    status names the item as 中文（English）, and no query is started. `item` is the truth entry of the picture."""
    checks = report.setdefault("affix", {})
    checks["file"] = item["file"]
    checks["expect"] = item["expect"]
    checks["visible_zh"] = item["visible_zh"]
    # The auto group leaves auto-recognise on; reading by itself would race the button click this group needs.
    await panel.evaluate("chrome.storage.local.set({ ocrAuto: false })")
    await panel.reload()
    await panel.evaluate("document.getElementById('choose-stats').click()")
    await panel.evaluate(
        "(() => { const b = document.getElementById('stats-base'); b.value = ''; b.dataset.from = '';"
        " b.dispatchEvent(new Event('input')); })()"
    )
    state = await _read_picture(panel, DATA / item["file"])
    status, rows = state["status"], state["affixRows"]
    # (a) the status holds the recognised name as 中文（English）: some Chinese, a full-width open bracket, a Latin name
    # and the closing bracket. The 「只認出底材（不會依品質篩選）」 prefix has no Latin name before its bracket.
    label = re.search(r"[\u3400-\u9fff][^（）]*（[A-Za-z][A-Za-z0-9' \-]*）", status)
    boxed = [r for r in rows if r["box"] and r["on"] and not r["unmapped"]]
    checks["status"] = status
    checks["label"] = label.group(0) if label else ""
    checks["base"] = state["base"]
    checks["mode"] = state["mode"]
    checks["view"] = state["view"]
    checks["rows"] = rows
    checks["label_ok"] = bool(label)
    checks["rows_present"] = len(rows) >= 1
    checks["all_mapped_on"] = all(r["on"] is True for r in rows if not r["unmapped"])
    # The reader read a number for every non-bool condition it yielded (it drops the ones without one), so each ticked
    # row with a box must carry a value, and that value must be marked as coming from the capture for the player to
    # confirm. A bool row has no box and is left out of both. `marked` counts the marked boxes of a row, and only the
    # box that carries a number is marked, so a filled row has at least one.
    checks["values_filled"] = bool(boxed) and all(r["min"] or r["max"] for r in boxed)
    checks["values_marked"] = bool(boxed) and all(r["marked"] >= 1 for r in boxed)
    checks["no_query_started"] = state["mode"] == "stats" and state["view"] == "ready"
    await _affix_start_gate(panel, checks)
    say(
        f"  詞綴：{checks['label']!r} 底材 {state['base']!r} {len(rows)} 條"
        f"（值填了 {checks['values_filled']}／標記 {checks['values_marked']}，沒查詢 {checks['no_query_started']}）"
        f" 開始閘門 {checks['start_gate_after_capture']} 清空後 {checks.get('start_gate_after_clearing')}"
        f" 填值後 {checks.get('start_enabled_after_value')}"
    )


async def drive(
    ws_url: str, truth: list[dict], skip_download: bool, skip_accuracy: bool,
    affix_item: dict | None = None, holdout: list[dict] | None = None
) -> dict:
    report: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "holdout_note": HOLDOUT_NOTE}
    async with attach(ws_url, Panel, collect_events=True) as panel:
        await panel.send("Page.enable")
        await panel.send("DOM.enable")
        await panel.send("Runtime.enable")
        await panel.wait_ready("側邊欄頁面沒有載入")
        # Choices remembered by the panel (auto-recognise) must not leak between runs. The picture groups drive the
        # buttons themselves, so auto-recognise is off for them; auto_group turns it on.
        await panel.evaluate("chrome.storage.local.set({ ocrAuto: false })")
        # What the reader learned from earlier choices (jevCorrections) must not decide a read of this run: start empty.
        await panel.evaluate("chrome.storage.local.remove('jevCorrections')")
        # Without a saved invite code the panel shows the welcome screen, where "no query started" proves nothing:
        # a placeholder code puts it on the query form (it is never sent anywhere unless a query starts).
        had_invite = await panel.evaluate("chrome.storage.local.get('invite').then((r) => Boolean(r.invite))")
        if not had_invite:
            await panel.evaluate("chrome.storage.local.set({ invite: 'ocr-e2e-placeholder' })")
        await panel.reload()
        if not skip_download:
            say("C 組：下載、驗證、儲存、載入…")
            await download_group(panel, report, DATA / "image-5.png")
        if not skip_accuracy:
            say(f"A/B 組：調校組 {len(truth)} 張圖逐張辨識…")
            await accuracy_speed_group(panel, report, truth, "accuracy", "rows", "調校組")
            if holdout:
                say(f"A/B 組：保留組 {len(holdout)} 張圖逐張辨識…")
                await accuracy_speed_group(panel, report, holdout, "accuracy_holdout", "rows_holdout", "保留組")
        if not skip_download and not skip_accuracy:
            say("自動辨識組：有模型時自動讀，沒模型時不自動下載…")
            await auto_group(panel, report)
        if not skip_accuracy:
            say("學習組：不確定的圖，選同一個名稱兩次後第三次自動填入…")
            await learning_group(panel, report, [*report.get("rows", []), *report.get("rows_holdout", [])])
        if affix_item:
            say("詞綴組：讀一張底材圖，條件自動填入、值留空…")
            await affix_group(panel, report, affix_item)
        await panel.evaluate("chrome.storage.local.remove('ocrAuto')")  # leave nothing chosen behind
        await panel.evaluate("chrome.storage.local.remove('jevCorrections')")
        if not had_invite:
            await panel.evaluate("chrome.storage.local.remove('invite')")
    return report


PICK_CANDIDATE = """(() => {
  const b = [...document.querySelectorAll('#ocr-candidates button')].find((x) => x.dataset.name === %s);
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()"""


async def _fresh_read(panel: Panel, picture: Path) -> dict:
    """The panel restarted (what it stored is read again), the name form open, one picture read."""
    await panel.reload()
    await panel.evaluate("document.getElementById('choose-name').click()")
    await panel.evaluate("document.getElementById('item').value = ''")
    return await _read_picture(panel, picture)


async def learning_group(panel: Panel, report: dict, rows: list[dict]) -> None:
    """The correction memory in the real panel: a picture the reader is not sure about is read three times, each time
    after a restart of the panel. The player picks the right name on the first two; the second read lists it first
    with 「你上次選過這個」 and still asks, the third fills it by itself. The store is emptied before and after, so
    nothing here depends on what an earlier run left. A run with no unsure picture in the accuracy groups skips it."""
    checks = report.setdefault("learning", {})
    row = next((r for r in rows if r.get("unsure") and r.get("ok")), None)
    if not row:
        checks["skipped"] = "沒有不確定的圖片可用"
        say("  學習組：沒有不確定的圖片，略過")
        return
    name = row["want"].split(":", 1)[1]
    checks["file"] = row["file"]
    checks["expect"] = name
    await panel.evaluate("chrome.storage.local.remove('jevCorrections')")
    first = await _fresh_read(panel, DATA / row["file"])
    checks["first_asks"] = first["unsure"] and not first["item"]
    checks["first_pick"] = await panel.evaluate(PICK_CANDIDATE % json.dumps(name)) == "clicked"
    await asyncio.sleep(3)  # the memory writes after a short delay
    second = await _fresh_read(panel, DATA / row["file"])
    top = second["candidates"][0] if second["candidates"] else {}
    checks["second_lists_first"] = top.get("name") == name and top.get("learned") == "1"
    checks["second_still_asks"] = second["unsure"] and not second["item"]
    checks["second_pick"] = await panel.evaluate(PICK_CANDIDATE % json.dumps(name)) == "clicked"
    await asyncio.sleep(3)
    third = await _fresh_read(panel, DATA / row["file"])
    checks["third_fills_by_itself"] = not third["unsure"] and bool(third["item"]) and third["firstName"] == name
    checks["third_status"] = third["status"]
    await panel.evaluate("chrome.storage.local.remove('jevCorrections')")
    say(f"  學習組：{row['file']} {name}：{checks}")


async def auto_group(panel: Panel, report: dict) -> None:
    """With auto-recognise on: a picture is read by itself when the model is already stored (and nothing is
    searched); with no model stored it neither reads nor downloads nor asks."""
    row = report.setdefault("auto", {})
    await panel.evaluate("chrome.storage.local.set({ ocrAuto: true })")
    await panel.reload()
    await panel.evaluate("document.getElementById('choose-name').click()")
    await panel.evaluate("document.getElementById('item').value = ''")
    await panel.set_files("#ocr-file", [DATA / "image-4.png"])
    state = await _wait_read(panel, 120)
    row["reads_by_itself_with_model"] = bool(state["time"]) and state["firstName"] == "Small Charm"
    row["did_not_start_a_query"] = await panel.evaluate(
        "document.body.dataset.view === 'ready' && document.getElementById('banner').hidden"
    )
    await panel.wipe_models()
    await panel.reload()
    await panel.evaluate("chrome.storage.local.set({ ocrAuto: false })")
    await panel.reload()
    await panel.set_files("#ocr-file", [DATA / "image-4.png"])
    await asyncio.sleep(3)
    state = await panel.state()
    row["no_model_no_auto_read"] = not state["time"]
    row["no_model_nothing_downloaded"] = not model_requests(state)
    say(f"  自動辨識：{row}")
    # Leave the profile usable for the next run: read once by hand, which downloads the models.
    await panel.evaluate("document.getElementById('ocr-go').click()")
    await _wait_read(panel, 120)


ACCURACY_KEYS = ("top1", "top3", "screenshots_top3", "phone_top3")


def _previous_report() -> dict | None:
    try:
        return json.loads((OUT / "report.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _group_floors(previous: dict | None, truth_file: str, block: str, fallback_key: str) -> dict | None:
    if previous and previous.get("truth") == truth_file and block in previous:
        return {key: previous[block][key] for key in ("scored", *ACCURACY_KEYS) if key in previous[block]}
    return FALLBACK_FLOORS.get(fallback_key)


def accuracy_floors(truth_file: str) -> dict | None:
    """The numbers a run must not fall below: the last accepted run on the same truth file, else FALLBACK_FLOORS."""
    return _group_floors(_previous_report(), truth_file, "accuracy", truth_file)


def holdout_floors(truth_file: str) -> dict | None:
    """The held-out group's floors: the same group of the last accepted run. No floor is invented while the accepted
    report has no accuracy_holdout block yet (None), so that first run is accepted and records the numbers."""
    return _group_floors(_previous_report(), truth_file, "accuracy_holdout", HOLDOUT)


def _floor_failures(got: dict, floors: dict, *, label: str = "", skip_prefix: str = "準確度下限") -> list[str]:
    """Accuracy keys that fell below their floor; nothing when the two were measured on different picture counts."""
    if got["scored"] != floors["scored"]:
        say(f"  略過{skip_prefix}：這次評 {got['scored']} 張，下限是以 {floors['scored']} 張量的")
        return []
    return [
        f"{label}準確度 {key} 掉到 {got[key]}/{got['scored']}，下限 {floors[key]}"
        for key in ACCURACY_KEYS if key in floors and got[key] < floors[key]
    ]


def verdict(report: dict, floors: dict | None = None, holdout: dict | None = None) -> list[str]:
    failures = []
    accuracy = report.get("accuracy")
    if accuracy and floors:
        failures += _floor_failures(accuracy, floors)
    accuracy_holdout = report.get("accuracy_holdout")
    # A name the panel filled in by itself must be the right one: the unsure rule keeps the wrong ones off the field.
    for label, block in (("調校組", accuracy), ("保留組", accuracy_holdout)):
        if block and block.get("auto_wrong"):
            failures.append(f"{label}有 {block['auto_wrong']} 張圖自己填了錯的名稱（這種讀法應該請玩家選）")
    if accuracy_holdout:
        if holdout is None:
            say("  保留組下限剛建立：這次的數字會成為下一次的保留組下限")
        else:
            failures += _floor_failures(accuracy_holdout, holdout, label="保留組", skip_prefix="保留組準確度下限")
    download = report.get("download")
    if download:
        for key in (
            "no_consent_element",
            "no_download_ui",
            "requests_started_by_themselves",
            "only_fixed_urls",
            "second_run_no_download",
            "after_reload_no_download",
            "blocked_is_clear",
            "blocked_not_retried",
        ):
            if not download.get(key):
                failures.append(f"C 組：{key} 沒通過（{download.get(key)!r}）")
    for key, value in (report.get("auto") or {}).items():
        if isinstance(value, bool) and not value:
            failures.append(f"自動辨識：{key} 沒通過（{report['auto']}）")
    learning = report.get("learning") or {}
    for key, value in learning.items():
        if isinstance(value, bool) and not value:
            failures.append(f"學習組：{key} 沒通過（{learning}）")
    affix = report.get("affix")
    if affix:
        for key in ("label_ok", "rows_present", "all_mapped_on", "values_filled", "values_marked", "no_query_started"):
            if not affix.get(key):
                failures.append(f"詞綴組：{key} 沒通過（{affix.get(key)!r}；狀態={affix.get('status')!r}）")
        # The captured numbers open 開始查詢; emptying them must close it and show the reason, and one value must open
        # it again.
        capture = affix.get("start_gate_after_capture")
        if not (isinstance(capture, dict) and capture.get("disabled") is False):
            failures.append(f"詞綴組：start_gate_after_capture 沒通過（{capture!r}）")
        cleared = affix.get("start_gate_after_clearing")
        if cleared is not None and not (
            isinstance(cleared, dict) and cleared.get("disabled") is True and cleared.get("whyVisible") is True
        ):
            failures.append(f"詞綴組：start_gate_after_clearing 沒通過（{cleared!r}）")
        opened = affix.get("start_enabled_after_value")
        if opened is not None and not (isinstance(opened, dict) and opened.get("disabled") is False):
            failures.append(f"詞綴組：start_enabled_after_value 沒通過（{opened!r}）")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="截圖辨識真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    parser.add_argument("--only", help="只跑這些圖片檔（逗號分隔）")
    parser.add_argument("--skip-download", action="store_true", help="跳過 C 下載組（不檢查模型首次下載的流程）")
    parser.add_argument("--skip-accuracy", action="store_true", help="跳過 A/B 準確度與速度組")
    parser.add_argument("--truth", default="ocr_truth.json", help="答案清單（在 scripts/data/ 裡）")
    args = parser.parse_args()
    truth = json.loads((DATA / args.truth).read_text(encoding="utf-8"))
    # The D group always reads its own base-kind picture, even under --only (which narrows the accuracy list only).
    affix_item = next((t for t in truth if t["file"] == AFFIX_PICTURE and t.get("kind") == "base"), None)
    only = {o for o in (args.only or "").split(",") if o}
    if only:
        truth = [t for t in truth if t["file"] in only]
    # The held-out pictures are scored in the same run, unless --only narrowed the tuned list (then they are skipped).
    holdout = [] if only else json.loads((DATA / HOLDOUT).read_text(encoding="utf-8"))
    floors = accuracy_floors(args.truth)  # read before this run replaces report.json
    holdout_floor = holdout_floors(args.truth)
    chrome = None
    try:
        build_extension(LOCAL_API)
        chrome = start_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        report = asyncio.run(
            drive(
                open_panel(ext_id), truth, args.skip_download, args.skip_accuracy,
                affix_item=affix_item, holdout=holdout
            )
        )
    except (Environment, subprocess.CalledProcessError) as error:
        return environment_failure(error)
    finally:
        cleanup(chrome, None)
    report["truth"] = args.truth
    failures = verdict(report, floors, holdout_floor)
    if not holdout:
        say("保留組：這次沒有評（--only 只挑調校組的圖片）" if only else "保留組：沒有評")
    # Only a complete, passing accuracy run becomes the baseline the next run is compared with.
    accepted = not failures and "accuracy" in report and not only
    report_path = OUT / ("report.json" if accepted else "report-last.json")
    OUT.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    if "accuracy" in report:
        say("調校組準確度與速度：" + json.dumps(report["accuracy"], ensure_ascii=False))
    if "accuracy_holdout" in report:
        say("保留組準確度與速度：" + json.dumps(report["accuracy_holdout"], ensure_ascii=False))
    if "download" in report:
        say(
            "下載組："
            + json.dumps({k: v for k, v in report["download"].items() if isinstance(v, bool)}, ensure_ascii=False)
        )
    if "affix" in report:
        say("詞綴組：" + json.dumps(report["affix"], ensure_ascii=False))
    for failure in failures:
        say(f"失敗：{failure}")
    say(f"報告：{report_path}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
