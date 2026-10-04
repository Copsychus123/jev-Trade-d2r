"""Many queries through the real extension in one Chrome.

Usage: uv run python scripts/extension_batch.py --api URL --invite CODE

Cases come from scripts/e2e_cases.json (input, expected outcome, expected product). One Chrome and one side panel are
reused; each case reloads the panel, types the input and presses start. Results go to artifacts/e2e-100/
(results.jsonl, one failure screenshot each). A site challenge stops the batch (exit 3); rerun with --resume.
Exit 0 all expected, 1 some cases failed, 2 environment problem, 3 stopped by a site challenge.
"""

import argparse
import asyncio
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extension_e2e import (  # noqa: E402
    DONE,
    Environment,
    build_extension,
    cleanup,
    free_profile,
    launch_chrome,
    load_extension,
    open_panel,
    say,
)

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "scripts" / "e2e_cases.json"
OUT = ROOT / "artifacts" / "e2e-100"
LAYER_LABELS = {"table": "查表直接開啟", "search": "站內搜尋", "base": "底材清單"}
MAX_JEV_CALLS = {"table": 5, "search": 9, "base": 9}
CASE_TIMEOUT = 240
PAUSE_SECONDS = 4
RERUN_FAILED = 1

SNAPSHOT = """JSON.stringify({
  status: document.getElementById('status').textContent,
  quota: document.getElementById('quota').textContent,
  lookup: document.getElementById('lookup').textContent,
  usage: document.getElementById('usage').textContent,
  verification: document.getElementById('verification').textContent,
  pills: ['trading', 'recent-trades'].map((p) => document.getElementById(p + '-status').textContent),
  meta: ['trading', 'recent-trades'].map((p) => document.getElementById(p + '-meta').textContent),
  rows: ['trading', 'recent-trades'].map((p) =>
    parseInt(document.getElementById(p + '-meta').textContent.replace(/^\\D+/, ''), 10) || 0),
  log: [...document.querySelectorAll('#log li')].map((l) => l.textContent),
  idle: !document.getElementById('start').disabled,
  locked: document.getElementById('load-more').disabled
})"""


class Panel:
    def __init__(self, ws):
        self.ws = ws
        self.counter = 0

    async def send(self, method, params=None):
        self.counter += 1
        await self.ws.send(json.dumps({"id": self.counter, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") == self.counter:
                return message.get("result", {})

    async def evaluate(self, expression):
        result = await self.send(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}
        )
        return result.get("result", {}).get("value")

    async def reload(self):
        await self.evaluate("location.reload()")
        for _ in range(60):
            await asyncio.sleep(0.5)
            try:
                if await self.evaluate("document.readyState === 'complete' && !!document.getElementById('start')"):
                    await asyncio.sleep(0.5)
                    return
            except Exception:
                continue
        raise Environment("側邊欄頁面沒有重新載入")

    async def snapshot(self):
        raw = await self.evaluate(SNAPSHOT)
        return json.loads(raw) if raw else None

    async def screenshot(self, path: Path):
        data = (await self.send("Page.captureScreenshot", {"format": "png"})).get("data")
        if data:
            path.write_bytes(base64.b64decode(data))


async def run_case(panel: Panel, case: dict, invites: dict) -> dict:
    await panel.reload()
    code = invites.get(case.get("invite", "main"), case.get("invite", ""))
    if case.get("invite") == "empty":
        code = ""
    await panel.evaluate(
        f"(() => {{ document.getElementById('invite').value = {json.dumps(code)};"
        " document.getElementById('save-invite').click();"
        f" document.getElementById('item').value = {json.dumps(case['input'])};"
        f" document.getElementById('load-more').value = '{case['load_more']}';"
        " })()"
    )
    started = time.time()
    await panel.evaluate("document.getElementById('start').click()")
    if case.get("double_click"):
        await panel.evaluate("document.getElementById('start').click()")
    stopped = False
    result = None
    while time.time() - started < CASE_TIMEOUT:
        await asyncio.sleep(2)
        snap = await panel.snapshot()
        if snap is None:
            continue
        result = snap
        if case.get("stop_after") and not stopped and time.time() - started >= case["stop_after"] and not snap["idle"]:
            await panel.evaluate("document.getElementById('stop').click()")
            stopped = True
        if snap["idle"] and time.time() - started > 4:
            break
    else:
        if result is None:
            raise Environment("讀不到側邊欄的狀態")
        result["timeout"] = True
    result["seconds"] = round(time.time() - started, 1)
    match = re.search(r"Jev 呼叫 (\d+) 次", result["usage"])
    result["jev_calls"] = int(match.group(1)) if match else 0
    urls = [re.search(r"https?://\S+", m) for m in result["meta"]]
    result["urls"] = [u.group(0) if u else None for u in urls]
    return result


def judge(case: dict, result: dict, last_used: int | None) -> tuple[str, str]:
    """Returns (verdict, reason). Verdicts: PASS, FAIL, GAP (known gap, never a failure)."""
    expect = case["expect"]
    status = result["status"]
    if result.get("timeout"):
        return "FAIL", f"逾時（{CASE_TIMEOUT} 秒）"
    if re.search(r"防護頁|驗證碼", status):
        return "BLOCKED", status
    if expect == "error":
        ok = case["contains"] in status and not any(result["rows"])
        return ("PASS", "") if ok else ("FAIL", f"預期訊息含「{case['contains']}」，實際：{status}")
    if expect == "not_found":
        ok = case["contains"] in status and not any(result["rows"])
        return ("PASS", "") if ok else ("FAIL", f"預期找不到，實際：{status} / {result['lookup']}")
    if expect == "stop":
        ok = status == "已停止" and not result["locked"]
        return ("PASS", "") if ok else ("FAIL", f"預期「已停止」且解鎖，實際：{status}")
    has_rows = case.get("allow_empty") or all(n > 0 for n in result["rows"])  # an empty market is a real answer
    passed = status == DONE and result["pills"] == ["PASSED", "PASSED"] and has_rows
    on_slug = bool(case.get("slug")) and all(u and f"/product/{case['slug']}" in u for u in result["urls"])
    if expect == "not_found_or_slug":
        if "找不到這個裝備" in status and not any(result["rows"]):
            return "PASS", "找不到（可接受）"
        return ("PASS", "配到預期商品") if passed and on_slug else ("FAIL", f"配到別的商品：{result['urls']}")
    if expect == "known_gap":
        reason = "全部通過" if passed and on_slug else f"{status}；{result['verification']}；{result['meta']}"
        return "GAP", reason
    # expect == "pass"
    problems = []
    if not passed:
        problems.append(f"狀態 {status}；{result['verification']}；{result['pills']}；{result['rows']}")
    if not on_slug:
        problems.append(f"商品網址不是 {case.get('slug')}：{result['urls']}")
    label = LAYER_LABELS.get(case.get("layer"))
    if label and f"查詢方式：{label}" not in result["lookup"]:
        problems.append(f"查詢方式不是 {label}：{result['lookup']!r}")
    if case.get("layer") and result["jev_calls"] > MAX_JEV_CALLS[case["layer"]]:
        problems.append(f"Jev 呼叫 {result['jev_calls']} 次，超過 {MAX_JEV_CALLS[case['layer']]}")
    if case["load_more"] and not result["rows"][0] > 50:
        problems.append(f"載入更多 {case['load_more']} 次，掛單只有 {result['rows'][0]} 筆")
    if case.get("double_click") and last_used is not None:
        used = re.search(r"已用 (\d+)/", result["quota"])
        if not used or int(used.group(1)) != last_used + 1:
            problems.append(f"連按兩次開始，額度應只加 1：之前 {last_used}，現在 {result['quota']!r}")
    return ("FAIL", "；".join(problems)) if problems else ("PASS", "")


async def drive(ws_url: str, cases: list[dict], invites: dict, done: dict) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    blocked = False
    last_used = None
    async with websockets.connect(ws_url, max_size=None) as ws:
        panel = Panel(ws)
        for number, case in enumerate(cases, 1):
            if case["id"] in done:
                continue
            attempts = []
            for attempt in range(1 + RERUN_FAILED):
                result = await run_case(panel, case, invites)
                verdict, reason = judge(case, result, last_used)
                attempts.append({"verdict": verdict, "reason": reason, "result": result})
                used = re.search(r"已用 (\d+)/", result["quota"])
                if used:
                    last_used = int(used.group(1))
                if verdict != "FAIL":
                    break
                await panel.screenshot(OUT / f"{case['id']}-try{attempt + 1}.png")
                await asyncio.sleep(PAUSE_SECONDS)
            final = attempts[-1]
            flaky = final["verdict"] == "PASS" and len(attempts) > 1
            record = {
                "case": case,
                "verdict": final["verdict"],
                "reason": final["reason"],
                "flaky": flaky,
                "attempts": [{k: a[k] for k in ("verdict", "reason")} | {"result": a["result"]} for a in attempts],
            }
            with (OUT / "results.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            say(
                f"[{number:3d}/{len(cases)}] {case['id']} {final['verdict']:7s}{'（不穩定）' if flaky else ''} "
                f"{case['input'][:30]!r} {final['reason'][:100]}"
            )
            if final["verdict"] == "BLOCKED":
                blocked = True
                break
            await asyncio.sleep(PAUSE_SECONDS)
    return 3 if blocked else 0


def load_done() -> dict:
    path = OUT / "results.jsonl"
    if not path.exists():
        return {}
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {r["case"]["id"]: r for r in rows if r["verdict"] != "BLOCKED"}


def main() -> int:
    parser = argparse.ArgumentParser(description="擴充功能批次端對端測試")
    parser.add_argument("--api", required=True)
    parser.add_argument("--invite", required=True, help="額度夠大的邀請碼")
    parser.add_argument("--tiny-invite", help="額度已被用完的邀請碼（J 類用）")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--resume", action="store_true", help="跳過 results.jsonl 裡已完成的案例")
    parser.add_argument("--only", help="只跑這些案例（逗號分隔的 id 或類別字母，例如 A,D03）")
    args = parser.parse_args()
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    if args.only:
        wanted = {w.strip() for w in args.only.split(",")}
        cases = [c for c in cases if c["id"] in wanted or c["group"] in wanted]
    if not args.resume and (OUT / "results.jsonl").exists():
        (OUT / "results.jsonl").rename(OUT / f"results-{int(time.time())}.jsonl")
    done = load_done() if args.resume else {}
    invites = {"main": args.invite, "tiny": args.tiny_invite or "", "wrong": "inv-wrong0000000000000000"}
    chrome = None
    try:
        build_extension(args.api)
        free_profile()
        chrome = launch_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}），共 {len(cases)} 組")
        code = asyncio.run(drive(open_panel(ext_id), cases, invites, done))
    except Environment as error:
        say(f"環境問題：{error}")
        return 2
    except subprocess.CalledProcessError:
        say("環境問題：擴充功能打包失敗")
        return 2
    finally:
        cleanup(chrome, None)
    rows = list(load_done().values())
    failed = [r for r in rows if r["verdict"] == "FAIL"]
    say(
        f"完成 {len(rows)} 組：通過 {sum(r['verdict'] == 'PASS' for r in rows)}、失敗 {len(failed)}、"
        f"已知缺口 {sum(r['verdict'] == 'GAP' for r in rows)}"
    )
    if code:
        say("被網站防護擋住，已停止。處理完驗證後加 --resume 繼續。")
        return code
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
