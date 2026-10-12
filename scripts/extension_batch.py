"""Many queries through the real extension in one Chrome. Windows-only tool (see extension_e2e.py).

Usage: JEV_INVITE=<code> [JEV_TINY_INVITE=<code>] uv run --group e2e python scripts/extension_batch.py --api URL --yes

Cases come from scripts/e2e_cases.json (input, expected outcome, expected product). One Chrome and one side panel are
reused; each case reloads the panel, types the input and presses start. Results go to artifacts/e2e-100/
(results.jsonl, one failure screenshot each). A site challenge stops the batch (exit 3); rerun with --resume.
Every case is a real query against the deployed backend: it spends invite quota, up to JEV_CALL_LIMIT paid Jev calls
and live Traderie page loads. The script prints that estimate and refuses to start without --yes. A failed case is
run once only; --rerun-failed N repeats it up to N more times (each repeat costs the same again).
The invite codes come from the environment, not the command line (command lines are visible to other programs).
Exit 0 all expected, 1 some cases failed, 2 environment problem or no --yes, 3 stopped by a site challenge.
"""

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cdp import Environment, Panel, attach  # noqa: E402
from extension_e2e import (  # noqa: E402
    DONE,
    OPEN_URLS,
    SNAPSHOT,
    build_extension,
    cleanup,
    environment_failure,
    free_profile,
    launch_chrome,
    load_extension,
    open_panel,
    say,
    timed_out,
)

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "scripts" / "e2e_cases.json"
OUT = ROOT / "artifacts" / "e2e-100"
LAYER_LABELS = {"table": "查表直接開啟", "search": "站內搜尋", "base": "底材清單"}
CASE_TIMEOUT = 240
PAUSE_SECONDS = 4
JEV_CALL_LIMIT = 30  # extension/src/agent.js JEV_CALL_LIMIT; services/jevsvc/app.py MAX_MODEL_CALLS


class BatchPanel(Panel):
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


async def run_case(panel: BatchPanel, case: dict, invites: dict) -> dict:
    await panel.reload()
    code = invites.get(case.get("invite", "main"), case.get("invite", ""))
    # The code is held in memory until the backend accepts it; "empty" means no saved code at all.
    if case.get("invite") == "empty":
        code = ""
        await panel.evaluate("chrome.storage.local.remove('invite')")
        await panel.reload()
    await panel.evaluate(
        f"(() => {{ if ({json.dumps(code)}) {{ document.getElementById('welcome-invite').value = {json.dumps(code)};"
        " document.getElementById('welcome-go').click(); }"
        " document.getElementById('choose-name').click();"
        f" document.getElementById('item').value = {json.dumps(case['input'])};"
        f" for (let i = 0; i < {case['load_more']}; i++) document.getElementById('more-plus').click();"
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
        result = timed_out(result)
    result["seconds"] = round(time.time() - started, 1)
    result["urls"] = await panel.evaluate(OPEN_URLS)
    return result


def quota_used(quota: str) -> int | None:
    """The used-calls count the panel shows ("已用 N/M"), or None when the line does not carry one."""
    found = re.search(r"已用 (\d+)/", quota)
    return int(found.group(1)) if found else None


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
    if case["load_more"] and not result["rows"][0] > 50:
        problems.append(f"載入更多 {case['load_more']} 次，掛單只有 {result['rows'][0]} 筆")
    if case.get("double_click") and last_used is not None:
        if quota_used(result["quota"]) != last_used + 1:
            problems.append(f"連按兩次開始，額度應只加 1：之前 {last_used}，現在 {result['quota']!r}")
    return ("FAIL", "；".join(problems)) if problems else ("PASS", "")


async def drive(ws_url: str, cases: list[dict], invites: dict, done: dict, reruns: int) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    blocked = False
    last_used = None
    async with attach(ws_url, BatchPanel, raise_errors=False) as panel:
        for number, case in enumerate(cases, 1):
            if case["id"] in done:
                continue
            attempts = []
            for attempt in range(1 + reruns):
                result = await run_case(panel, case, invites)
                verdict, reason = judge(case, result, last_used)
                attempts.append({"verdict": verdict, "reason": reason, "result": result})
                used = quota_used(result["quota"])
                if used is not None:
                    last_used = used
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
                "attempts": [dict(attempt) for attempt in attempts],
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
    parser.add_argument("--yes", action="store_true", help="確認要花費真實額度與 Jev 呼叫（不給就只印預估後結束）")
    parser.add_argument("--rerun-failed", type=int, default=0, metavar="N", help="失敗的案例最多再跑 N 次（預設 0）")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--resume", action="store_true", help="跳過 results.jsonl 裡已完成的案例")
    parser.add_argument("--only", help="只跑這些案例（逗號分隔的 id 或類別字母，例如 A,D03）")
    args = parser.parse_args()
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    if args.only:
        wanted = {w.strip() for w in args.only.split(",")}
        cases = [c for c in cases if c["id"] in wanted or c["group"] in wanted]
    done = load_done() if args.resume else {}
    pending = [c for c in cases if c["id"] not in done]
    attempts = len(pending) * (1 + args.rerun_failed)
    say(
        f"將跑 {len(pending)} 組案例（失敗最多再跑 {args.rerun_failed} 次，最多 {attempts} 次查詢）：每次查詢最多花 "
        f"{JEV_CALL_LIMIT} 次 Jev 呼叫，合計上限約 {attempts * JEV_CALL_LIMIT} 次，並消耗邀請碼額度與真實網站流量。"
    )
    if not args.yes:
        say("沒有加 --yes，不執行。確認後加 --yes 再跑一次。")
        return 2
    main_invite = os.environ.get("JEV_INVITE", "").strip()
    if not main_invite:
        say("環境問題：請用環境變數 JEV_INVITE 提供額度夠大的邀請碼（J 類另需 JEV_TINY_INVITE：額度已用完的邀請碼）")
        return 2
    if not args.resume and (OUT / "results.jsonl").exists():
        (OUT / "results.jsonl").rename(OUT / f"results-{int(time.time())}.jsonl")
    invites = {"main": main_invite, "tiny": os.environ.get("JEV_TINY_INVITE", ""), "wrong": "inv-wrong0000000000000000"}
    chrome = None
    try:
        build_extension(args.api)
        free_profile()
        chrome = launch_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}），共 {len(cases)} 組")
        code = asyncio.run(drive(open_panel(ext_id), cases, invites, done, args.rerun_failed))
    except (Environment, subprocess.CalledProcessError) as error:
        return environment_failure(error)
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
