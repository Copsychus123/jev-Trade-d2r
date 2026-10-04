"""Real-Chrome end-to-end check of the screenshot reader: uv run python scripts/ocr_e2e.py [--headed]

Loads extension/dist into the dedicated Chrome, then in the side panel:
  C  download group: first use asks before downloading, checks and stores the models, a second run and a
     reload do not download again, a blocked download is reported (not retried), a hand-picked model file is
     checked (a tampered one is refused);
  A/B accuracy and speed group: every picture in scripts/data goes through the real panel and is compared with
     scripts/data/ocr_truth.json.
Writes artifacts/ocr-e2e/report.json. Exit 0 all good, 1 something failed, 2 environment problem.
"""

import argparse
import asyncio
import gzip
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extension_e2e import (  # noqa: E402
    LOCAL_API,
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
DATA = ROOT / "scripts" / "data"
OUT = ROOT / "artifacts" / "ocr-e2e"
TRUTH_FILE = "ocr_truth.json"  # replaced by --truth
_BEST_INT = "https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_best_int"
MODELS = {code: f"{_BEST_INT}/{code}.traineddata.gz" for code in ("chi_tra",)}  # the languages the extension reads
STATE = """JSON.stringify({
  status: document.getElementById('ocr-status').textContent,
  kind: document.getElementById('ocr-status').dataset.kind || '',
  time: document.getElementById('ocr-time').textContent,
  text: document.getElementById('ocr-text').textContent,
  consent: !document.getElementById('ocr-consent').hidden,
  consentText: document.getElementById('ocr-consent-text').textContent,
  item: document.getElementById('item').value,
  go: !document.getElementById('ocr-go').disabled,
  candidates: [...document.querySelectorAll('#ocr-candidates button')].map((b) => b.textContent),
  external: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !n.startsWith('chrome-extension://'))
})"""


class Panel:
    def __init__(self, ws):
        self.ws, self.counter, self.events = ws, 0, []

    async def send(self, method, params=None):
        self.counter += 1
        mine = self.counter
        await self.ws.send(json.dumps({"id": mine, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") == mine:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message.get("result", {})
            self.events.append(message)

    async def evaluate(self, expression):
        result = await self.send(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}
        )
        return result.get("result", {}).get("value")

    async def state(self):
        return json.loads(await self.evaluate(STATE))

    async def wait(self, predicate, seconds=120, step=0.5):
        end = time.time() + seconds
        while time.time() < end:
            state = await self.state()
            if predicate(state):
                return state
            await asyncio.sleep(step)
        raise Environment(f"等不到預期的畫面狀態（{seconds} 秒）：{await self.state()}")

    async def reload(self):
        await self.evaluate("location.reload()")
        await asyncio.sleep(1)
        for _ in range(60):
            try:
                if await self.evaluate("document.readyState === 'complete' && !!document.getElementById('ocr-go')"):
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise Environment("側邊欄沒有重新載入")

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
    return [u for u in state["external"] if "raw.githubusercontent.com" in u]


async def download_group(panel: Panel, report: dict, first_image: Path, work: Path) -> None:
    checks = report.setdefault("download", {})
    await panel.reload()
    await panel.wipe_models()
    await panel.reload()
    await panel.load_picture(first_image)

    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await panel.wait(lambda s: s["consent"], 30)
    checks["asks_before_download"] = True
    checks["consent_text"] = state["consentText"]
    checks["no_request_before_consent"] = not model_requests(state)
    await panel.evaluate(
        "window.__progress = new Set(); new MutationObserver(() => {"
        " const t = document.getElementById('ocr-status').textContent;"
        " if (t.includes('下載辨識模型')) window.__progress.add(t.split('：')[0]); })"
        ".observe(document.getElementById('ocr-status'), { childList: true, characterData: true, subtree: true })"
    )
    await panel.evaluate("document.getElementById('ocr-agree').click()")
    state = await panel.wait(lambda s: s["time"] or s["kind"] == "error", 180)
    progress = json.loads(await panel.evaluate("JSON.stringify([...window.__progress])"))
    checks["progress_seen"] = sorted(progress)
    checks["first_run_status"] = state["status"]
    checks["download_urls"] = sorted(set(model_requests(state)))
    checks["only_fixed_urls"] = set(checks["download_urls"]) <= set(MODELS.values())

    # Second picture, same page: no question, no new download.
    await panel.load_picture(first_image)
    before = len(model_requests(await panel.state()))
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await panel.wait(lambda s: s["time"] or s["kind"] == "error" or s["consent"], 180)
    checks["second_run_no_question"] = not state["consent"]
    checks["second_run_no_download"] = len(model_requests(state)) == before

    # Reload the panel (the models must survive in IndexedDB).
    await panel.reload()
    await panel.load_picture(first_image)
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await panel.wait(lambda s: s["time"] or s["kind"] == "error" or s["consent"], 180)
    checks["after_reload_no_question"] = not state["consent"]
    checks["after_reload_no_download"] = not model_requests(state)

    # Blocked download: one attempt per model, a clear message, no automatic retry.
    await panel.wipe_models()
    await panel.reload()
    await panel.send(
        "Fetch.enable", {"patterns": [{"urlPattern": "*raw.githubusercontent.com*", "requestStage": "Request"}]}
    )
    await panel.load_picture(first_image)
    await panel.evaluate("document.getElementById('ocr-go').click()")
    await panel.wait(lambda s: s["consent"], 30)
    await panel.evaluate("document.getElementById('ocr-agree').click()")
    blocked = 0
    end = time.time() + 20
    while time.time() < end:
        for event in list(panel.events):
            if event.get("method") == "Fetch.requestPaused":
                blocked += 1
                await panel.send(
                    "Fetch.failRequest", {"requestId": event["params"]["requestId"], "errorReason": "ConnectionRefused"}
                )
                panel.events.remove(event)
        state = await panel.state()
        if state["kind"] == "error":
            break
        await asyncio.sleep(0.3)
    await asyncio.sleep(3)  # a silent retry would show up as another paused request
    for event in list(panel.events):
        if event.get("method") == "Fetch.requestPaused":
            blocked += 1
            await panel.send(
                "Fetch.failRequest", {"requestId": event["params"]["requestId"], "errorReason": "ConnectionRefused"}
            )
    state = await panel.state()
    checks["blocked_message"] = state["status"]
    checks["blocked_is_clear"] = state["kind"] == "error" and "下載" in state["status"] or "連不到" in state["status"]
    checks["blocked_requests"] = blocked
    checks["blocked_not_retried"] = blocked <= 1
    await panel.send("Fetch.disable")

    # Manual import: a tampered file is refused, the real files are accepted, and then no network is needed.
    tampered = work / "chi_tra.traineddata.gz"
    data = bytearray(gzip.compress(b"not a model"))
    tampered.write_bytes(bytes(data))
    await panel.reload()
    await panel.set_files("#ocr-model-file", [tampered])
    state = await panel.wait(lambda s: "匯入" in s["status"], 30)
    checks["tampered_refused"] = state["kind"] == "error" and "檢查碼" in state["status"] or "大小" in state["status"]
    checks["tampered_message"] = state["status"]
    good = []
    for code, url in MODELS.items():
        target = work / f"{code}.traineddata.gz"
        subprocess.run(["curl", "-sL", "-o", str(target), url], check=True)
        good.append(target)
    await panel.set_files("#ocr-model-file", good)
    await asyncio.sleep(4)
    await panel.load_picture(first_image)
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await panel.wait(lambda s: s["time"] or s["kind"] == "error" or s["consent"], 180)
    checks["manual_import_works_without_question"] = not state["consent"] and bool(state["time"])


async def accuracy_speed_group(panel: Panel, report: dict, files: list[dict]) -> None:
    rows = []
    await panel.reload()
    for item in files:
        await panel.reload()
        await panel.evaluate("document.getElementById('item').value = ''")
        await panel.load_picture(DATA / item["file"])
        await panel.evaluate("document.getElementById('ocr-go').click()")
        state = await panel.wait(lambda s: s["time"] or s["kind"] == "error" or s["consent"], 240)
        seconds = float(state["time"].split()[1]) if state["time"] else None
        # The best result is written into the name field (status says whether it is only a type); the buttons are the
        # other candidates.
        filled = "填入裝備名稱" in state["status"]
        first = state["item"] if filled else None
        first_kind = "base" if "只認出底材" in state["status"] else "item"
        others = [
            ("base" if "（底材）" in c else "item", c.replace("（底材）", ""))
            for c in state["candidates"]
            if c.replace("（底材）", "") != first
        ]
        top = ([f"{first_kind}:{first}"] if first else []) + [f"{k}:{n}" for k, n in others]
        want = f"{item['kind']}:{item['expect']}"
        rows.append(
            {
                "file": item["file"],
                "want": want,
                "top": top,
                "seconds": seconds,
                "ok": item["kind"] != "skip" and want in top,
                "top1": bool(top) and top[0] == want,
                "phone": item["phone_photo"],
                "skip": item["kind"] == "skip",
                "status": state["status"],
                "text": state["text"][:400],
            }
        )
        say(f"  {item['file'][:14]:14s} {want:32s} -> {top} {seconds}s")
    scored = [r for r in rows if not r["skip"]]
    small = [r["seconds"] for r in rows if not r["phone"] and r["seconds"]]
    phone = [r["seconds"] for r in rows if r["phone"] and r["seconds"]]
    report["accuracy"] = {
        "scored": len(scored),
        "top1": sum(r["top1"] for r in scored),
        "top3": sum(r["ok"] for r in scored),
        "screenshots_top3": sum(r["ok"] for r in scored if not r["phone"]),
        "screenshots_scored": sum(1 for r in scored if not r["phone"]),
        "phone_top3": sum(r["ok"] for r in scored if r["phone"]),
        "phone_scored": sum(1 for r in scored if r["phone"]),
        "avg_seconds_screenshot": round(sum(small) / len(small), 1) if small else None,
        "avg_seconds_phone_photo": round(sum(phone) / len(phone), 1) if phone else None,
        "max_seconds": max((r["seconds"] for r in rows if r["seconds"]), default=None),
    }
    report["rows"] = rows


SAMPLES = {  # code: (text, font file, share of the characters that must be read back)
    "eng": ("Harlequin Crest Shako", "arial.ttf", 0.8),
    "chi_sim": ("哈勒昆之冠 护身符 需要等级", "msyh.ttc", 0.7),
    "jpn": ("ハーレクイン クレスト", "YuGothR.ttc", 0.6),
    "kor": ("하를레킨 크레스트 반지", "malgun.ttf", 0.6),
    "deu": ("Größe Äpfel Schwerer Helm", "arial.ttf", 0.8),
    "fra": ("Épée légendaire élite", "arial.ttf", 0.8),
    "spa": ("Espada única niño casco", "arial.ttf", 0.8),
}


def sample_picture(path: Path, text: str, font_file: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype(rf"C:\Windows\Fonts\{font_file}", 44)
    image = Image.new("RGB", (900, 120), (20, 20, 20))
    ImageDraw.Draw(image).text((20, 30), text, font=font, fill=(235, 235, 235))
    image.save(path)


def share_read(expected: str, got: str) -> float:
    import difflib

    a, b = "".join(expected.split()).lower(), "".join(got.split()).lower()
    return difflib.SequenceMatcher(None, a, b).ratio()


async def language_group(panel: Panel, report: dict, work: Path) -> None:
    """Each language: asked first, downloaded once, reads a picture of its own text, marked offline in the list, and
    still reads it after every request to the download host is refused (that is the offline case)."""
    rows = report.setdefault("languages", {})
    await panel.reload()
    await panel.wipe_models()
    for code, (text, font_file, need) in SAMPLES.items():
        picture = work / f"sample-{code}.png"
        sample_picture(picture, text, font_file)
        row = rows.setdefault(code, {})
        await panel.reload()
        await panel.evaluate(
            f"(() => {{ const s = document.getElementById('ocr-lang'); s.value = '{code}'; "
            "s.dispatchEvent(new Event('change')); })()"
        )
        await panel.load_picture(picture)
        await panel.evaluate("document.getElementById('ocr-go').click()")
        state = await panel.wait(lambda s: s["consent"] or s["time"] or s["kind"] == "error", 120)
        row["asked_first"] = state["consent"]
        row["consent_text"] = state["consentText"] if state["consent"] else ""
        if state["consent"]:
            await panel.evaluate("document.getElementById('ocr-agree').click()")
        state = await panel.wait(lambda s: s["time"] or s["kind"] == "error", 180)
        row["text"] = state["text"].strip()[:80]
        row["share"] = round(share_read(text, state["text"]), 2)
        row["recognised"] = row["share"] >= need
        # Offline: refuse the download host, reload, read again without any question.
        await panel.reload()
        await panel.send(
            "Fetch.enable", {"patterns": [{"urlPattern": "*raw.githubusercontent.com*", "requestStage": "Request"}]}
        )
        await panel.evaluate(
            f"(() => {{ const s = document.getElementById('ocr-lang'); s.value = '{code}'; "
            "s.dispatchEvent(new Event('change')); })()"
        )
        await asyncio.sleep(1.5)
        option = await panel.evaluate(f"document.querySelector('#ocr-lang option[value={code}]').textContent")
        row["marked_offline"] = "離線" in option
        await panel.load_picture(picture)
        await panel.evaluate("document.getElementById('ocr-time').textContent = ''")
        await panel.evaluate("document.getElementById('ocr-go').click()")
        await asyncio.sleep(1)
        state = await panel.wait(lambda s: s["consent"] or s["time"] or s["kind"] == "error", 120)
        paused = [e for e in panel.events if e.get("method") == "Fetch.requestPaused"]
        row["works_offline"] = (not state["consent"]) and not paused and share_read(text, state["text"]) >= need
        await panel.send("Fetch.disable")
        say(f"  {code}: 讀回 {row['share']}，離線可用 {row['works_offline']}，{row['text']!r}")


async def drive(
    ws_url: str, only: list[str], skip_download: bool, skip_accuracy: bool, languages: bool = False
) -> dict:
    report: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S")}
    truth = json.loads((DATA / TRUTH_FILE).read_text(encoding="utf-8"))
    if only:
        truth = [t for t in truth if t["file"] in only]
    work = OUT / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    async with websockets.connect(ws_url, max_size=None) as ws:
        panel = Panel(ws)
        await panel.send("Page.enable")
        await panel.send("DOM.enable")
        await panel.send("Runtime.enable")
        for _ in range(40):
            if await panel.evaluate("document.readyState === 'complete' && !!document.getElementById('ocr-go')"):
                break
            await asyncio.sleep(0.5)
        else:
            raise Environment("側邊欄頁面沒有載入")
        # Choices remembered by the panel (language, auto-recognise) must not leak between runs. The picture groups
        # drive the buttons themselves, so auto-recognise is off for them; auto_group turns it on.
        await panel.evaluate("chrome.storage.local.remove('ocrLanguage')")
        await panel.evaluate("chrome.storage.local.set({ ocrAuto: false })")
        await panel.reload()
        if not skip_download:
            say("C 組：下載、驗證、儲存、載入…")
            await download_group(panel, report, DATA / "image-5.png", work)
        if not skip_accuracy:
            say("A/B 組：24 張圖逐張辨識…")
            await accuracy_speed_group(panel, report, truth)
        if not skip_download and not skip_accuracy:
            say("自動辨識組：有模型時自動讀，沒模型時不自動下載…")
            await auto_group(panel, report)
        if languages:
            say("語言組：每個語言各下載一次，再斷網確認離線可用…")
            await language_group(panel, report, work)
        await panel.evaluate("chrome.storage.local.remove(['ocrLanguage', 'ocrAuto'])")  # leave nothing chosen behind
    shutil.rmtree(work, ignore_errors=True)
    return report


async def auto_group(panel: Panel, report: dict) -> None:
    """With auto-recognise on: a picture is read by itself when the language pack is already stored (and nothing is
    searched); with no pack stored it neither reads nor downloads nor asks."""
    row = report.setdefault("auto", {})
    await panel.evaluate("chrome.storage.local.set({ ocrAuto: true })")
    await panel.reload()
    await panel.evaluate("document.getElementById('item').value = ''")
    await panel.set_files("#ocr-file", [DATA / "image-4.png"])
    state = await panel.wait(lambda s: s["time"] or s["kind"] == "error" or s["consent"], 120)
    row["reads_by_itself_with_model"] = bool(state["time"]) and state["item"] == "Small Charm"
    row["did_not_start_a_query"] = (await panel.evaluate("document.getElementById('status').textContent")) == ""
    await panel.wipe_models()
    await panel.reload()
    await panel.set_files("#ocr-file", [DATA / "image-4.png"])
    await asyncio.sleep(3)
    state = await panel.state()
    row["no_model_no_auto_read"] = not state["time"]
    row["no_model_no_question_or_download"] = not state["consent"] and not model_requests(state)
    say(f"  自動辨識：{row}")
    # Leave the profile usable for the next run: read once by hand, which asks and then downloads the default pack.
    await panel.evaluate("document.getElementById('ocr-go').click()")
    state = await panel.wait(lambda s: s["consent"] or s["time"], 60)
    if state["consent"]:
        await panel.evaluate("document.getElementById('ocr-agree').click()")
        await panel.wait(lambda s: s["time"] or s["kind"] == "error", 120)


def verdict(report: dict) -> list[str]:
    failures = []
    d = report.get("download")
    if d:
        for key in (
            "asks_before_download",
            "no_request_before_consent",
            "only_fixed_urls",
            "second_run_no_question",
            "second_run_no_download",
            "after_reload_no_question",
            "after_reload_no_download",
            "blocked_is_clear",
            "blocked_not_retried",
            "tampered_refused",
            "manual_import_works_without_question",
        ):
            if not d.get(key):
                failures.append(f"C 組：{key} 沒通過（{d.get(key)!r}）")
        if not d.get("progress_seen"):
            failures.append("C 組：沒看到下載進度")
    for code, row in (report.get("languages") or {}).items():
        for key in ("asked_first", "recognised", "works_offline", "marked_offline"):
            if not row.get(key):
                failures.append(f"語言 {code}：{key} 沒通過（{row}）")
    for key, value in (report.get("auto") or {}).items():
        if isinstance(value, bool) and not value:
            failures.append(f"自動辨識：{key} 沒通過（{report['auto']}）")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="截圖辨識真實 Chrome 端對端測試")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--only", help="只跑這些圖片檔（逗號分隔）")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--skip-accuracy", action="store_true")
    parser.add_argument("--languages", action="store_true", help="另外測每個語言：下載、辨識、斷網後離線可用")
    parser.add_argument("--truth", default="ocr_truth.json", help="答案清單（在 scripts/data/ 裡）")
    args = parser.parse_args()
    global TRUTH_FILE
    TRUTH_FILE = args.truth
    chrome = None
    try:
        build_extension(LOCAL_API)
        free_profile()
        chrome = launch_chrome(args.headed)
        ext_id = load_extension()
        say(f"擴充功能已載入（{ext_id}）")
        report = asyncio.run(
            drive(
                open_panel(ext_id),
                [o for o in (args.only or "").split(",") if o],
                args.skip_download,
                args.skip_accuracy,
                args.languages,
            )
        )
    except Environment as error:
        say(f"環境問題：{error}")
        return 2
    except subprocess.CalledProcessError:
        say("環境問題：擴充功能打包失敗")
        return 2
    finally:
        cleanup(chrome, None)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    failures = verdict(report)
    if "accuracy" in report:
        say("準確度與速度：" + json.dumps(report["accuracy"], ensure_ascii=False))
    if "download" in report:
        say(
            "下載組："
            + json.dumps({k: v for k, v in report["download"].items() if isinstance(v, bool)}, ensure_ascii=False)
        )
    for failure in failures:
        say(f"失敗：{failure}")
    say(f"報告：{OUT / 'report.json'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
