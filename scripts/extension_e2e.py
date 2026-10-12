"""Real-Chrome end-to-end check of the extension: uv run --group e2e python scripts/extension_e2e.py [--headed].

Windows-only tool (Chrome paths and fonts of a Windows install; it was never run elsewhere). Builds the extension into
extension/dist-e2e, starts the local backend, loads it into the dedicated Chrome profile (already logged in to
Traderie), runs one query through the side panel and checks the tables and CSV files. It closes the dedicated Chrome
first (same profile) and spends one real Jev query per run. Exit 0 pass, 1 failed, 2 environment.

--stub-chooser runs the same checks on the same real pages for nothing: the local backend answers every step itself
(scripts/stub_backend.py serves services/jevsvc's own routes with a chooser injected), so TypeSafe is never reached
and TYPESAFE_API_KEY is not needed. The plan follows the goal the backend builds: it scrolls the Trading list to the
bottom when Load More batches were asked for (the panel's own phase-finish rule then makes the presses), answers DONE
on the view it must end on, and clicks the page's Recent Trades tab before ending phase B.

`--item` (default Harlequin Crest) is the name typed into the panel, `--load-more` (default 2) is how many times the
載入更多 button is pressed before the query starts, and `--timeout` (default 300 s) is how long the panel may take
before the run counts as a timeout. `--api URL` with `--invite CODE` targets a deployed backend instead of the local
one (both must be given together, and `--stub-chooser` cannot be combined with them); `--hold N` keeps the window
open for N seconds after the query, for a demo. The `--expect-*` flags assert the layer the query used, the name in
the CSV file name and a 「找不到這個裝備」 outcome.
"""

import argparse
import asyncio
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]
E2E_DIST = ROOT / "extension" / "dist-e2e"  # never extension/dist: that one is what friends load
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cdp import Environment, attach, new_tab  # noqa: E402
from stub_backend import STUB_SERVER  # noqa: E402

from jev_ultrafast.chrome import CHROME_PORT, PROFILE_DIR, chrome_binary  # noqa: E402

DEBUG_PORT = 9356
BACKEND_PORT = 8788
LOCAL_API = f"http://127.0.0.1:{BACKEND_PORT}"
DONE = "查詢完成，兩段資料都通過檢查"


def say(message: str) -> None:
    print(message, flush=True)


def environment_failure(error: Exception) -> int:
    """The exit every Chrome script takes when something outside the extension is wrong: report it and return 2.

    A failed extension build carries no message of its own, so it gets its own line.
    """
    say(f"環境問題：{error}" if isinstance(error, Environment) else "環境問題：擴充功能打包失敗")
    return 2


def _version(port: int) -> dict | None:
    try:
        return httpx.get(f"http://127.0.0.1:{port}/json/version", timeout=1).json()
    except Exception:
        return None


async def _cdp(port: int, method: str, params: dict | None = None, wait: float = 10):
    version = _version(port)
    if version is None:
        return None
    async with websockets.connect(version["webSocketDebuggerUrl"], max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        try:
            return json.loads(await asyncio.wait_for(ws.recv(), wait))
        except Exception:
            return None


def build_extension(api: str) -> None:
    say("打包擴充功能…")
    command = [sys.executable, "extension/build.py", "--api", api, "--out", str(E2E_DIST)]
    subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


def port_free(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) != 0


class BackendLog:
    """The backend's stdout/stderr kept on disk while a thread empties the pipe.

    The pipe must keep being read (an unread one fills up and stalls the backend), so nothing is discarded: every
    line is also written to artifacts/perf/backend-<timestamp>.log, which a later hung run can be diagnosed from.
    """

    def __init__(self) -> None:
        PERF_DIR.mkdir(parents=True, exist_ok=True)
        self.path = PERF_DIR / f"backend-{time.strftime('%Y%m%d-%H%M%S')}.log"
        self._handle = self.path.open("w", encoding="utf-8")
        self._thread: threading.Thread | None = None

    def keep(self, line: str) -> None:
        if self._handle.closed:
            return
        self._handle.write(line)
        self._handle.flush()

    def drain(self, process: subprocess.Popen) -> None:
        self._thread = threading.Thread(target=self._pump, args=(process,), daemon=True)
        self._thread.start()

    def _pump(self, process: subprocess.Popen) -> None:
        for line in process.stdout:
            self.keep(line)

    def close(self) -> None:
        if self._thread is not None:
            self._thread.join(timeout=5)
        if not self._handle.closed:
            self._handle.close()


def start_backend(stub: bool = False) -> tuple[subprocess.Popen, str, BackendLog]:
    """Starts the local backend: returns it, its dev invite code and its log.

    Without `stub` it is services/dev_server.py, which needs TYPESAFE_API_KEY in .env because every step asks Jev.
    With `stub` the same routes are served by serve_stub_backend in a child process with an injected chooser: a query
    finishes with zero Jev calls and no key at all.
    """
    if not port_free(BACKEND_PORT):
        raise Environment(f"本機後端的連接埠 {BACKEND_PORT} 已被佔用（舊的後端還在跑？），請先關閉")
    say("啟動本機後端（stub 選擇器，不會呼叫 Jev）…" if stub else "啟動本機後端…")
    log = BackendLog()
    inherited = os.environ.get("PYTHONPATH", "")
    # The parent reads this pipe as UTF-8, so the child must write UTF-8: without this it uses the Windows ANSI codepage
    # (cp950 on this machine) and the backend's first Chinese line kills the run with a UnicodeDecodeError.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    if stub:
        env["PYTHONPATH"] = os.pathsep.join(
            part for part in (str(Path(__file__).resolve().parent), inherited) if part
        )
        command, missing = [sys.executable, "-u", "-c", STUB_SERVER], "stub 後端沒有啟動（見上面的後端輸出）"
    else:
        command = [sys.executable, "-u", "services/dev_server.py"]
        missing = "後端沒有啟動（.env 需要有 TYPESAFE_API_KEY）"
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
    )
    code, deadline, output = "", time.time() + 30, []
    try:
        while time.time() < deadline:
            line = process.stdout.readline()
            if not line:
                break
            log.keep(line)
            output.append(line)
            if "開發用邀請碼：" in line:
                code = line.split("開發用邀請碼：", 1)[1].strip()
            if "Jev backend:" in line and code:
                log.drain(process)
                return process, code, log
    except BaseException:
        # A crashed parent must not leave the backend holding the port: the next run then refuses to start.
        process.terminate()
        log.close()
        raise
    process.terminate()
    log.close()
    say("".join(output[-10:]))  # whatever the backend printed before dying: the log file is not printed on this path
    raise Environment(missing)


def free_profile() -> None:
    if _version(CHROME_PORT) is None:
        return
    say("關閉專用 Chrome（它和測試共用登入資料夾）…")
    asyncio.run(_cdp(CHROME_PORT, "Browser.close", wait=3))
    for _ in range(20):
        if _version(CHROME_PORT) is None:
            time.sleep(1)
            return
        time.sleep(0.5)
    raise Environment("專用 Chrome 還在執行，請先關閉")


def headless_user_agent() -> str:
    """Headless Chrome announces itself as HeadlessChrome and Cloudflare then rejects the saved clearance, which
    belongs to a normal Chrome UA. Same rule as Browser._prepare: only that label is replaced."""
    binary = Path(chrome_binary())
    versions = [d.name for d in binary.parent.iterdir() if re.fullmatch(r"\d+(\.\d+){3}", d.name)]  # Windows layout
    if not versions:
        out = subprocess.run(
            [str(binary), "--version"], capture_output=True, text=True, errors="replace", timeout=20
        ).stdout
        versions = re.findall(r"\d+(?:\.\d+){3}", out)
    if not versions:
        raise Environment("讀不到 Chrome 版本，請加 --headed")
    major = max(versions, key=lambda v: [int(n) for n in v.split(".")]).split(".")[0]
    return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{major}.0.0.0 Safari/537.36"
    )


def launch_chrome(headed: bool, extra_args: tuple[str, ...] = ()) -> subprocess.Popen:
    say("啟動 Chrome（有視窗）…" if headed else "啟動 Chrome（無視窗）…")
    args = [
        chrome_binary(),
        f"--user-data-dir={PROFILE_DIR}",
        "--enable-unsafe-extension-debugging",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        *([] if headed else ["--headless=new", f"--user-agent={headless_user_agent()}"]),
        *extra_args,
        "about:blank",
    ]
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if _version(DEBUG_PORT):
            return process
        time.sleep(0.5)
    raise Environment("Chrome 沒有啟動")


def load_extension() -> str:
    path = str(E2E_DIST.resolve())
    response = asyncio.run(_cdp(DEBUG_PORT, "Extensions.loadUnpacked", {"path": path}))
    if not response or "result" not in response:
        raise Environment("Chrome 無法載入擴充功能（headless 可能不支援，請加 --headed）")
    return response["result"]["id"]


def open_panel(ext_id: str) -> str:
    url = urllib.parse.quote(f"chrome-extension://{ext_id}/sidepanel.html", safe=":/?=")
    return new_tab(DEBUG_PORT, url)["webSocketDebuggerUrl"]


def start_chrome(headed: bool, extra_args: tuple[str, ...] = ()) -> subprocess.Popen:
    """Free the dedicated profile and start Chrome on it. The caller loads the extension next, so its `chrome`
    handle is already bound when loading can fail (a lost handle would leave Chrome running on the profile)."""
    free_profile()
    return launch_chrome(headed, extra_args)


HOOKS = """(() => {
  window.__blobs = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blob.text().then((t) => window.__blobs.push(t)); return original.call(URL, blob); };
  HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; };
  window.__copied = [];
  navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
})()"""

# One picture of the side panel for the Chrome checks. `status` is the old one-line summary, worked out from the
# screen: the banner text, "已停止", or "查詢完成…" when the trust line says the data was checked.
SNAPSHOT = """(() => {
  const $ = (id) => document.getElementById(id);
  const text = (id) => $(id).textContent.trim();
  const view = document.body.dataset.view;
  const labels = { table: '查表直接開啟', search: '站內搜尋', base: '底材清單' };
  const trust = $('trust').dataset.kind;
  const reasons = [...$('trust-reasons').children].map((li) => li.textContent).join('、');
  const verification = trust === 'ok' ? text('trust-line')
    : trust === 'warn' ? text('trust-head') + '：' + reasons : '';
  const banner = $('banner').hidden ? '' : [text('banner-message'), text('banner-hint')].filter(Boolean).join(' ');
  const status = banner || (view === 'stopped' ? '已停止' : view === 'done'
    ? (trust === 'ok' ? '查詢完成，兩段資料都通過檢查' : '查詢完成，但檢查未通過：' + reasons) : '');
  const layer = $('trust').dataset.layer;
  // The step counter under the four-step list and, once a query has ended, the decisions of its run: a stuck query
  // freezes the counter (the harness prints it, so a hung run and a slow one look different in the log).
  const decisions = ((window.__jevLastRun ?? {}).decisions ?? []).slice(-4)
    .map((d) => `${d.label ?? d.choice}·${d.phase}·${d.step}${d.by_rule ? '·規則' : ''}`);
  return JSON.stringify({
    view,
    status,
    verification,
    lookup: [layer ? '查詢方式：' + labels[layer] : '', text('part-notes')].filter(Boolean).join('。'),
    quota: text('quota'),
    pills: ['trading', 'recent-trades'].map((p) => $(p + '-tab').dataset.status),
    meta: ['trading', 'recent-trades'].map((p) => text(p + '-meta')),
    rows: ['trading', 'recent-trades'].map((p) => parseInt($(p + '-count').textContent, 10) || 0),
    shown: ['#trading-list li', '#recent-trades-list li'].map((s) => document.querySelectorAll(s).length),
    pager: ['trading', 'recent-trades'].map((p) => text(p + '-page')),
    step: text('progress-status'),
    decisions,
    idle: view !== 'running',
    locked: ['item', 'more-minus', 'more-plus', 'settings-open'].every((id) => $(id).disabled),
    run: window.__jevLastRun ?? null
  });
})()"""

PERF_DIR = ROOT / "artifacts" / "perf"


def timing_rows(run: dict | None) -> list[tuple[str, int]]:
    """(stage, ms) for each timeline entry of the panel's last query, in order."""
    return [(entry["stage"], int(entry["ms"])) for entry in (run or {}).get("timeline", [])]


def report_timing(run: dict | None) -> None:
    """Prints the per-stage table of the last query and keeps the raw record in artifacts/perf/run-<timestamp>.json."""
    if not run:
        say("沒有計時資料（側邊欄沒有留下 __jevLastRun）")
        return
    rows = timing_rows(run)
    width = max((len(stage) for stage, _ in rows), default=5)
    for stage, ms in rows:
        print(f"  {stage:<{width}}  {ms:>7} ms", flush=True)
    timeline = run.get("timeline", [])
    total = max((e["start_ms"] + e["ms"] for e in timeline), default=0)
    print(f"  {'total':<{width}}  {total:>7} ms   (visibility: {run.get('visibility')})", flush=True)
    PERF_DIR.mkdir(parents=True, exist_ok=True)
    path = PERF_DIR / f"run-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    say(f"計時資料：{path.relative_to(ROOT)}")

ROW_SELECTOR = {"trading": "#trading-list li", "recent-trades": "#recent-trades-list li"}

PROGRESS_KEYS = ("view", "status", "step", "pills", "rows", "quota", "locked")


def progress_key(sample: dict) -> tuple:
    """A comparable picture of the fields a wait-loop sample can change, so equal samples print no line."""
    return tuple(
        tuple(sample.get(key) or []) if isinstance(sample.get(key), list) else sample.get(key)
        for key in PROGRESS_KEYS
    )


def parse_sample(raw: str | None) -> dict | None:
    """A sample's raw JSON as a state dict, or None when the panel gave nothing usable (no answer, or not JSON)."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def progress_fields(sample: dict) -> str:
    """The fields a hung run leaves behind: the step counter, view, rows, status, per-tab pills, quota and lock."""
    rows = sample.get("rows") or [0, 0]
    pills = sample.get("pills") or []
    state = sample.get("status") or sample.get("verification") or "—"
    decisions = sample.get("decisions") or []
    log = f"  決策：{' | '.join(decisions)}" if decisions else ""
    return (
        f"{sample.get('view') or '?'}  步驟：{sample.get('step') or '—'}"
        f"  掛單 {rows[0]}/近期 {rows[1]}  狀態：{state}"
        f"  兩段：{'/'.join(str(pill or '—') for pill in pills)}"
        f"  額度：{sample.get('quota') or '—'}  鎖定：{'是' if sample.get('locked') else '否'}{log}"
    )


SET_FILTER = """(() => {
  document.getElementById('settings-open').click();
  const select = document.getElementById('filter-platform');
  select.value = 'PC';
  select.dispatchEvent(new Event('change'));
  document.getElementById('settings-back').click();
  document.getElementById('trading-tab').click();
  return document.getElementById('trading-count').textContent;
})()"""
CLEAR_FILTER = """(() => {
  document.getElementById('settings-open').click();
  document.getElementById('filter-clear').click();
  document.getElementById('settings-back').click();
  return document.getElementById('trading-count').textContent;
})()"""


async def csv_blob(evaluate) -> str:
    """Click 匯出 CSV on the selected tab and return the text of the file it produced (HOOKS captures the blob)."""
    await evaluate("window.__blobs.length = 0")
    await evaluate("document.getElementById('result-csv').click()")
    await asyncio.sleep(0.5)
    return await evaluate("window.__blobs[0] || ''")


def csv_lines(text: str) -> list[str]:
    """The CSV's rows: a trailing CRLF (the last line's terminator) must not leave an empty row behind."""
    return text.split("\r\n")[:-1] if text.endswith("\r\n") else text.split("\r\n")


async def check_filter(evaluate) -> dict:
    """A display filter (platform PC) changes the visible count without a new query; CSV rows are the kept rows."""
    active = await evaluate(SET_FILTER)
    kept, _, read = active.partition("/")
    text = await csv_blob(evaluate)
    lines = csv_lines(text)
    cleared = await evaluate(CLEAR_FILTER)
    return {
        "active_count": active,
        "kept": int(kept),
        "read": int(read or 0),
        "csv_lines": len(lines) if text else 0,
        "cleared_count": cleared,
    }

# The pages each tab was read from, taken from what 前往網站 would open (opening is intercepted, nothing opens).
OPEN_URLS = """(async () => {
  const opened = [];
  chrome.tabs.create = async (options) => { opened.push(options.url); };
  const selected = document.querySelector('[role=tab][aria-selected=true]');
  const urls = [];
  for (const prefix of ['trading', 'recent-trades']) {
    document.getElementById(prefix + '-tab').click();
    const button = document.getElementById('result-open');
    opened.length = 0;
    if (!button.disabled) button.click();
    urls.push(opened[0] ?? null);
  }
  selected.click();
  return urls;
})()"""


def timed_out(result: dict | None) -> dict:
    """A wait-loop that ran out: nothing read is an environment problem, otherwise the last sample is marked."""
    if result is None:
        raise Environment("讀不到側邊欄的狀態")
    result["timeout"] = True
    return result


async def _read_paging(evaluate, prefix: str, rows: str) -> dict:
    """First page, then the second page and back: the three reads `check` compares for one tab's paging."""
    first = await evaluate(f"document.querySelector('{rows}').textContent")
    await evaluate(f"document.getElementById('{prefix}-next').click()")
    page2 = await evaluate(
        f"JSON.stringify({{page: document.getElementById('{prefix}-page').textContent,"
        f" shown: document.querySelectorAll('{rows}').length,"
        f" first: document.querySelector('{rows}').textContent,"
        f" prev: !document.getElementById('{prefix}-prev').disabled}})"
    )
    await evaluate(f"document.getElementById('{prefix}-prev').click()")
    back = await evaluate(f"document.getElementById('{prefix}-page').textContent")
    return {"first": first, "page2": json.loads(page2), "back": back}


async def _sample_until_idle(evaluate, timeout: int) -> tuple[dict, bool | None, int, int]:
    """Poll the side panel every 3 s until the query ends or `timeout` runs out, printing a line whenever a sample
    changes something. Returns (last state, locked while running, samples read, samples that failed to answer)."""
    started, result, locked = time.time(), None, None
    seen = None
    samples_ok = samples_failed = 0
    while time.time() - started < timeout:
        await asyncio.sleep(3)
        parsed = parse_sample(await evaluate(SNAPSHOT))
        if parsed is None:  # the panel did not answer, or answered with something that is not JSON
            samples_failed += 1
            if samples_failed == 1:
                say(
                    f"  [{int(time.time() - started):>3d}s] 取樣失敗："
                    "側邊欄沒有回應或回傳的不是 JSON（之後只記錄次數）"
                )
            continue
        samples_ok += 1
        result = parsed
        sample = progress_key(result)
        if sample != seen:  # only the samples that changed something get a line
            seen = sample
            say(f"  [{int(time.time() - started):>3d}s] {progress_fields(result)}")
        if locked is None and not result["idle"]:
            locked = result["locked"]  # the first look while the query is running
        if result["idle"] and time.time() - started > 10:
            break
    else:
        result = timed_out(result)
        say(f"最後一次看到的狀態：{progress_fields(result)}")
    return result, locked, samples_ok, samples_failed


async def _collect_csv(evaluate, prefixes) -> dict:
    """For each filled tab: 匯出 CSV and 複製 must produce the same rows. Returns each tab's name, text and copy."""
    csv: dict = {}
    for prefix in prefixes:
        await evaluate(f"document.getElementById('{prefix}-tab').click()")  # the buttons act on the selected tab
        text = await csv_blob(evaluate)
        csv[prefix] = {"name": await evaluate("window.__dl"), "text": text}
        await evaluate("window.__copied.length = 0")
        await evaluate("document.getElementById('result-copy').click()")
        await asyncio.sleep(0.3)
        csv[prefix]["copied"] = await evaluate("window.__copied[0] || ''")
    return csv


async def drive(ws_url: str, code: str, item: str, load_more: int, timeout: int) -> dict:
    async with attach(ws_url) as panel:
        evaluate = panel.evaluate

        for _ in range(40):  # the panel page must be loaded before it can be driven
            if await evaluate("document.readyState === 'complete' && !!document.getElementById('start')"):
                break
            await asyncio.sleep(0.5)
        else:
            raise Environment("側邊欄頁面沒有載入")
        await evaluate(HOOKS)
        # The code is only held in memory until the backend accepts it (first successful start).
        await evaluate(
            f"(() => {{ document.getElementById('welcome-invite').value = {json.dumps(code)};"
            " document.getElementById('welcome-go').click();"
            " document.getElementById('choose-name').click();"
            f" document.getElementById('item').value = {json.dumps(item)};"
            f" for (let i = 0; i < {load_more}; i++) document.getElementById('more-plus').click();"
            " })()"
        )
        await evaluate("document.getElementById('start').click()")
        say("查詢中…")
        result, locked, samples_ok, samples_failed = await _sample_until_idle(evaluate, timeout)
        result["samples_ok"], result["samples_failed"] = samples_ok, samples_failed
        result["locked_while_running"], result["locked_after"] = locked, result["locked"]
        report_timing(result.get("run"))
        result["urls"] = await evaluate(OPEN_URLS)
        if result["rows"] == [0, 0]:  # nothing was read (for example "not found"): no tables to page through
            result["paging"], result["csv"] = {}, {}
            return result
        result["paging"] = {}
        filled = [prefix for prefix, n in zip(("trading", "recent-trades"), result["rows"], strict=True) if n]
        for prefix in filled:
            result["paging"][prefix] = await _read_paging(evaluate, prefix, ROW_SELECTOR[prefix])
        result["csv"] = await _collect_csv(evaluate, filled)
        if "trading" in filled:
            result["filter"] = await check_filter(evaluate)
        return result


def check(
    result: dict, item: str, load_more: int, expect_layer: str | None = None, expect_not_found: bool = False
) -> list[str]:
    failures = []
    labels = {"table": "查詢方式：查表直接開啟", "search": "查詢方式：站內搜尋", "base": "查詢方式：底材清單"}
    if expect_layer and labels[expect_layer] not in result["lookup"]:
        failures.append(f"查詢方式不對，預期 {labels[expect_layer]}，實際：{result['lookup']!r}")
    if expect_not_found:
        if "找不到這個裝備" not in result["status"]:
            failures.append(f"預期「找不到這個裝備」，實際狀態：{result['status']}")
        if any(result["rows"]):
            failures.append(f"找不到時不該有資料：{result['rows']}")
        return failures
    if result.get("timeout"):
        failures.append("查詢逾時")
    if result["status"] != DONE:
        failures.append(f"狀態不是完成：{result['status']}")
    if result["pills"] != ["PASSED", "PASSED"]:
        failures.append(f"兩段狀態不是 PASSED：{result['pills']}")
    if not all(n > 0 for n in result["rows"]):
        failures.append(f"表格是空的：{result['rows']}")
    if load_more and not result["rows"][0] > 50:
        failures.append(f"載入更多 {load_more} 批，掛單只有 {result['rows'][0]} 筆")
    for index, (prefix, label) in enumerate((("trading", "目前掛單"), ("recent-trades", "近期成交"))):
        total, paging = result["rows"][index], result["paging"].get(prefix)
        if total > 10:
            if result["shown"][index] != 10:
                failures.append(f"{label} 第一頁顯示 {result['shown'][index]} 筆，應為 10 筆")
            if not paging["page2"]["page"].startswith("第 2 /") or not paging["page2"]["prev"]:
                failures.append(f"{label} 下一頁沒有切到第 2 頁：{paging['page2']['page']}")
            if paging["page2"]["first"] == paging["first"]:
                failures.append(f"{label} 第 2 頁的第一筆和第 1 頁相同")
            if not paging["back"].startswith("第 1 /"):
                failures.append(f"{label} 上一頁沒有回到第 1 頁：{paging['back']}")
    if result["locked_while_running"] is not True:
        failures.append("查詢中輸入欄、載入批數或設定沒有被鎖住")
    if result["locked_after"]:
        failures.append("查詢結束後欄位沒有解鎖")
    roots = [re.sub(r"/recent/?$", "", url or "") for url in result["urls"]]
    if not roots[0] or roots[0] != roots[1]:
        failures.append(f"兩段讀的不是同一個商品頁：{result['urls']}")
    safe = "".join(c if c.isascii() and (c.isalnum() or c in " _-") else "_" for c in item).strip()
    views = (("trading", "目前掛單", result["rows"][0]), ("recent-trades", "近期成交", result["rows"][1]))
    for prefix, label, rows in views:
        if not rows:
            continue
        csv = result["csv"][prefix]
        lines = csv_lines(csv["text"])
        if len(lines) != rows + 1:
            failures.append(f"{label} CSV 有 {len(lines)} 行，應為 {rows + 1}")
        copied = csv["copied"].rstrip("\n").split("\n") if csv["copied"] else []
        if len(copied) != rows + 1 or len({line.count("\t") for line in copied}) != 1:
            failures.append(f"{label} 複製內容不對：{len(copied)} 行，應為 {rows + 1} 行且欄數一致")
        if csv["name"] != f"traderie-{safe}-{label}.csv":
            failures.append(f"{label} CSV 檔名不對：{csv['name']}")
    flt = result.get("filter")
    if flt:
        if flt["kept"] > flt["read"]:
            failures.append(f"篩選後的筆數 {flt['kept']} 比讀到的 {flt['read']} 還多")
        if flt["active_count"] != f"{flt['kept']}/{flt['read']}":
            failures.append(f"篩選中分頁筆數應為「{flt['kept']}/{flt['read']}」，實際：{flt['active_count']!r}")
        expected = flt["kept"] + 1 if flt["kept"] else 0  # nothing kept: the download button is off, no file
        if flt["csv_lines"] != expected:
            failures.append(f"篩選後 CSV 有 {flt['csv_lines']} 行，應為 {expected}")
        if flt["cleared_count"] != str(flt["read"]):
            failures.append(f"清除篩選後筆數應回到 {flt['read']}，實際：{flt['cleared_count']!r}")
    return failures


def cleanup(chrome, backend) -> None:
    for step in (
        lambda: asyncio.run(_cdp(DEBUG_PORT, "Browser.close", wait=3)),
        lambda: chrome and chrome.wait(timeout=10),
    ):
        try:
            step()
        except Exception:
            pass
    for process in (chrome, backend):
        try:
            if process and process.poll() is None:
                process.terminate()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="擴充功能真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true", help="顯示 Chrome 視窗（預設無視窗）")
    parser.add_argument("--item", default="Harlequin Crest", help="要查的商品名稱（面板的裝備名稱欄）")
    parser.add_argument("--load-more", type=int, default=2, help="查詢前按幾次「載入更多」（按過時掛單要多於 50 筆）")
    parser.add_argument("--timeout", type=int, default=300, help="查詢最多等幾秒（每 3 秒取樣一次側邊欄）")
    parser.add_argument("--api", help="測已部署的後端網址（需要同時給 --invite）；省略時用本機後端")
    parser.add_argument("--invite", help="已部署後端的邀請碼")
    parser.add_argument(
        "--stub-chooser",
        action="store_true",
        help="用 stub 選擇器跑同一組檢查：後端自己回答，不會呼叫 Jev，也不需要 TYPESAFE_API_KEY",
    )
    parser.add_argument("--hold", type=int, default=0, help="查完後讓視窗再開幾秒再關閉（展示用）")
    parser.add_argument("--expect-layer", choices=["table", "search", "base"], help="預期用哪一層找到商品")
    parser.add_argument("--expect-name", help="預期實際查的名稱（CSV 檔名用）；省略時等於 --item")
    parser.add_argument("--expect-not-found", action="store_true", help="預期結果是「找不到這個裝備」")
    args = parser.parse_args()
    chrome = backend = backend_log = None
    try:
        if bool(args.api) != bool(args.invite):
            raise Environment("--api 和 --invite 要一起給")
        if args.stub_chooser and args.api:
            raise Environment("--stub-chooser 只適用本機後端，不能和 --api 一起用")
        build_extension(args.api or LOCAL_API)
        backend, code, backend_log = (None, args.invite, None) if args.api else start_backend(args.stub_chooser)
        chrome = start_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        result = asyncio.run(drive(open_panel(ext_id), code, args.item, args.load_more, args.timeout))
        if args.hold:
            say(f"查詢結束，視窗保留 {args.hold} 秒…")
            time.sleep(args.hold)
    except (Environment, subprocess.CalledProcessError) as error:
        return environment_failure(error)
    finally:
        cleanup(chrome, backend)
        if backend_log is not None:
            backend_log.close()  # flushed and closed even on failure or timeout: a hung run must still leave a log
            if args.stub_chooser:
                say("這次執行了 0 次 Jev 呼叫：每一步都由 stub 選擇器回答，這個後端從頭到尾沒有連到 TypeSafe。")
            say(f"後端紀錄：{backend_log.path.relative_to(ROOT)}")
    failures = check(result, args.expect_name or args.item, args.load_more, args.expect_layer, args.expect_not_found)
    say(f"取樣：成功 {result['samples_ok']} 次、失敗 {result['samples_failed']} 次")
    if failures:
        say("失敗：")
        for failure in failures:
            say(f"  - {failure}")
        return 1
    say(f"通過：掛單 {result['rows'][0]} 筆、成交 {result['rows'][1]} 筆")
    say(f"畫面上的查詢方式：{result['lookup']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
