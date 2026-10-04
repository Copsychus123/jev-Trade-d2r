"""Real-Chrome end-to-end check of the extension: uv run python scripts/extension_e2e.py [--headed].

Starts the local backend, loads extension/dist into the dedicated Chrome profile (already logged in to Traderie),
runs one query through the side panel and checks the tables and CSV files. Exit 0 pass, 1 failed, 2 environment.
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]
E2E_DIST = ROOT / "extension" / "dist-e2e"  # never extension/dist: that one is what friends load
sys.path.insert(0, str(ROOT / "core"))

from jev_ultrafast.chrome import CHROME_PORT, PROFILE_DIR, chrome_binary  # noqa: E402

DEBUG_PORT = 9356
LOCAL_API = "http://127.0.0.1:8788"
DONE = "查詢完成，兩段資料都通過檢查"


class Environment(Exception):
    """Something outside the extension is wrong (exit code 2)."""


def say(message: str) -> None:
    print(message, flush=True)


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


def start_backend() -> tuple[subprocess.Popen, str]:
    say("啟動本機後端…")
    process = subprocess.Popen(
        [sys.executable, "-u", "services/dev_server.py"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
    )
    code, deadline = "", time.time() + 30
    while time.time() < deadline:
        line = process.stdout.readline()
        if not line:
            break
        if "開發用邀請碼：" in line:
            code = line.split("開發用邀請碼：", 1)[1].strip()
        if "Jev backend:" in line and code:
            return process, code
    process.terminate()
    raise Environment("後端沒有啟動（.env 需要有 TYPESAFE_API_KEY）")


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
        out = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=20).stdout
        versions = re.findall(r"\d+(?:\.\d+){3}", out)
    if not versions:
        raise Environment("讀不到 Chrome 版本，請加 --headed")
    major = max(versions, key=lambda v: [int(n) for n in v.split(".")]).split(".")[0]
    return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{major}.0.0.0 Safari/537.36"
    )


def launch_chrome(headed: bool) -> subprocess.Popen:
    say("啟動 Chrome（有視窗）…" if headed else "啟動 Chrome（無視窗）…")
    args = [
        chrome_binary(),
        f"--user-data-dir={PROFILE_DIR}",
        "--enable-unsafe-extension-debugging",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        *([] if headed else ["--headless=new", f"--user-agent={headless_user_agent()}"]),
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
    return httpx.put(f"http://127.0.0.1:{DEBUG_PORT}/json/new?{url}").json()["webSocketDebuggerUrl"]


HOOKS = """(() => {
  window.__blobs = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blob.text().then((t) => window.__blobs.push(t)); return original.call(URL, blob); };
  HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; };
  window.__copied = [];
  navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
})()"""

SNAPSHOT = """JSON.stringify({
  status: document.getElementById('status').textContent,
  verification: document.getElementById('verification').textContent,
  usage: document.getElementById('usage').textContent,
  lookup: document.getElementById('lookup').textContent,
  pills: ['trading', 'recent-trades'].map((p) => document.getElementById(p + '-status').textContent),
  rows: ['trading', 'recent-trades'].map((p) =>
    parseInt(document.getElementById(p + '-meta').textContent.replace(/^\\D+/, ''), 10) || 0),
  shown: ['trading', 'recent-trades'].map((p) => document.querySelectorAll('#' + p + '-table tbody tr').length),
  pager: ['trading', 'recent-trades'].map((p) => document.getElementById(p + '-page').textContent),
  log: [...document.querySelectorAll('#log li')].map((l) => l.textContent),
  idle: !document.getElementById('start').disabled,
  locked: document.getElementById('load-more').disabled
})"""


async def drive(ws_url: str, code: str, item: str, load_more: int, timeout: int) -> dict:
    async with websockets.connect(ws_url, max_size=None) as ws:
        counter = 0

        async def evaluate(expression: str):
            nonlocal counter
            counter += 1
            params = {"expression": expression, "returnByValue": True, "awaitPromise": True}
            await ws.send(json.dumps({"id": counter, "method": "Runtime.evaluate", "params": params}))
            while True:
                message = json.loads(await ws.recv())
                if message.get("id") == counter:
                    return message["result"].get("result", {}).get("value")

        for _ in range(40):  # the panel page must be loaded before it can be driven
            if await evaluate("document.readyState === 'complete' && !!document.getElementById('start')"):
                break
            await asyncio.sleep(0.5)
        else:
            raise Environment("側邊欄頁面沒有載入")
        await evaluate(HOOKS)
        await evaluate(
            f"(() => {{ document.getElementById('invite').value = {json.dumps(code)};"
            " document.getElementById('save-invite').click();"
            f" document.getElementById('item').value = {json.dumps(item)};"
            f" document.getElementById('load-more').value = '{load_more}';"
            " document.getElementById('load-more').dispatchEvent(new Event('change'));"
            " })()"
        )
        await evaluate("document.getElementById('start').click()")
        say("查詢中…")
        started, result, locked = time.time(), None, None
        while time.time() - started < timeout:
            await asyncio.sleep(3)
            raw = await evaluate(SNAPSHOT)
            if raw is None:
                continue
            result = json.loads(raw)
            if locked is None and not result["idle"]:
                locked = result["locked"]  # the first look while the query is running
            if result["idle"] and time.time() - started > 10:
                break
        else:
            if result is None:
                raise Environment("讀不到側邊欄的狀態")
            result["timeout"] = True
        result["locked_while_running"], result["locked_after"] = locked, result["locked"]
        if result["rows"] == [0, 0]:  # nothing was read (for example "not found"): no tables to page through
            result["paging"], result["csv"] = {}, {}
            return result
        result["paging"] = {}
        for prefix in ("trading", "recent-trades"):
            first = await evaluate(f"document.querySelector('#{prefix}-table tbody tr').textContent")
            await evaluate(f"document.getElementById('{prefix}-next').click()")
            page2 = await evaluate(
                f"JSON.stringify({{page: document.getElementById('{prefix}-page').textContent,"
                f" shown: document.querySelectorAll('#{prefix}-table tbody tr').length,"
                f" first: document.querySelector('#{prefix}-table tbody tr').textContent,"
                f" prev: !document.getElementById('{prefix}-prev').disabled}})"
            )
            await evaluate(f"document.getElementById('{prefix}-prev').click()")
            back = await evaluate(f"document.getElementById('{prefix}-page').textContent")
            result["paging"][prefix] = {"first": first, "page2": json.loads(page2), "back": back}
        result["csv"] = {}
        for prefix in ("trading", "recent-trades"):
            await evaluate("window.__blobs.length = 0")
            await evaluate(f"document.getElementById('{prefix}-csv').click()")
            await asyncio.sleep(0.5)
            text = await evaluate("window.__blobs[0] || ''")
            result["csv"][prefix] = {"name": await evaluate("window.__dl"), "text": text}
            await evaluate("window.__copied.length = 0")
            await evaluate(f"document.getElementById('{prefix}-copy').click()")
            await asyncio.sleep(0.3)
            result["csv"][prefix]["copied"] = await evaluate("window.__copied[0] || ''")
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
    if not any("Recent Trades" in line for line in result["log"]):
        failures.append("步驟紀錄裡沒有點 Recent Trades")
    if load_more and not any(line.endswith("（規則）") for line in result["log"]):
        failures.append("步驟紀錄裡沒有規則步驟")
    for index, (prefix, label) in enumerate((("trading", "目前掛單"), ("recent-trades", "近期成交"))):
        total, paging = result["rows"][index], result["paging"][prefix]
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
        failures.append("查詢中「載入更多次數」沒有被鎖住")
    if result["locked_after"]:
        failures.append("查詢結束後「載入更多次數」沒有解鎖")
    if "Jev 呼叫 0 次" in result["usage"]:
        failures.append("Jev 呼叫 0 次")
    safe = "".join(c if c.isascii() and (c.isalnum() or c in " _-") else "_" for c in item).strip()
    views = (("trading", "目前掛單", result["rows"][0]), ("recent-trades", "近期成交", result["rows"][1]))
    for prefix, label, rows in views:
        csv = result["csv"][prefix]
        lines = csv["text"].split("\r\n")[:-1] if csv["text"].endswith("\r\n") else csv["text"].split("\r\n")
        if len(lines) != rows + 1:
            failures.append(f"{label} CSV 有 {len(lines)} 行，應為 {rows + 1}")
        copied = csv["copied"].rstrip("\n").split("\n") if csv["copied"] else []
        if len(copied) != rows + 1 or len({line.count("\t") for line in copied}) != 1:
            failures.append(f"{label} 複製內容不對：{len(copied)} 行，應為 {rows + 1} 行且欄數一致")
        if csv["name"] != f"traderie-{safe}-{label}.csv":
            failures.append(f"{label} CSV 檔名不對：{csv['name']}")
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
    parser.add_argument("--item", default="Harlequin Crest")
    parser.add_argument("--load-more", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--api", help="測已部署的後端網址（需要同時給 --invite）；省略時用本機後端")
    parser.add_argument("--invite", help="已部署後端的邀請碼")
    parser.add_argument("--hold", type=int, default=0, help="查完後讓視窗再開幾秒再關閉（展示用）")
    parser.add_argument("--expect-layer", choices=["table", "search", "base"], help="預期用哪一層找到商品")
    parser.add_argument("--expect-name", help="預期實際查的名稱（CSV 檔名用）；省略時等於 --item")
    parser.add_argument("--expect-not-found", action="store_true", help="預期結果是「找不到這個裝備」")
    args = parser.parse_args()
    chrome = backend = None
    try:
        if bool(args.api) != bool(args.invite):
            raise Environment("--api 和 --invite 要一起給")
        build_extension(args.api or LOCAL_API)
        backend, code = (None, args.invite) if args.api else start_backend()
        free_profile()
        chrome = launch_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        result = asyncio.run(drive(open_panel(ext_id), code, args.item, args.load_more, args.timeout))
        if args.hold:
            say(f"查詢結束，視窗保留 {args.hold} 秒…")
            time.sleep(args.hold)
    except Environment as error:
        say(f"環境問題：{error}")
        return 2
    except subprocess.CalledProcessError:
        say("環境問題：擴充功能打包失敗")
        return 2
    finally:
        cleanup(chrome, backend)
    failures = check(result, args.expect_name or args.item, args.load_more, args.expect_layer, args.expect_not_found)
    if failures:
        say("失敗：")
        for failure in failures:
            say(f"  - {failure}")
        say("步驟紀錄：" + (" → ".join(result["log"]) or "（空）"))
        return 1
    calls = result["usage"].split("次")[0].replace("Jev 呼叫", "").strip()
    say(f"通過：掛單 {result['rows'][0]} 筆、成交 {result['rows'][1]} 筆、Jev 呼叫 {calls} 次")
    say(f"畫面上的查詢方式：{result['lookup']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
