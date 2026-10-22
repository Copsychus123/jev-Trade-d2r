"""Read-only A/B probe: what blocking the ad/tracker hosts does to the affix-search page's settle.

The extension's own query tab blocks nothing; only the dedicated Chrome installs `BLOCKED_HOSTS`
(`src/jev_ultrafast/chrome.py`) with `Network.setBlockedURLs`. `docs/design.md` records the claim that the settles
that dominate both searches wait on the page churn those hosts cause, as an opportunity that still needs a decision.
This probe opens the same filtered affix address with the block list ON and OFF, strictly alternating so the profile
cache and network drift cancel in adjacent pairs, and records per run the navigate time (the product's own
`complete`/interactive-grace rule), the settle time (the product's own `settle.js` quiet gate) and the total, plus
which blocked-host scripts the page actually loaded and when.

Read-only: it transports nothing, writes only its own record under the git-ignored `artifacts/blocking/`, spends no
Jev quota (the affix path never calls Jev) and changes no product behaviour.
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _probe  # noqa: E402
from _cdp import open_dedicated_tab  # noqa: E402

from jev_ultrafast.chrome import BLOCKED_HOSTS, blocked_url_patterns, close_chrome  # noqa: E402

HOME = "https://www.traderie.com/diablo2resurrected"
OUT = ROOT / "artifacts" / "blocking"
# The settle the product ships: `extension/src/cdp.js` calls settle.js with these defaults.
QUIET_MS, SETTLE_CAP_MS, MIN_CHARS = 600, 15000, 100
GRACE_MS = 500  # NAVIGATE_INTERACTIVE_GRACE_MS (extension/src/cdp.js): how long "interactive" may last
SETTLE_JS = (ROOT / "src" / "jev_ultrafast" / "settle.js").read_text(encoding="utf-8").strip()
# Every resource the document loaded, with its start and duration relative to navigation start (page clock).
RESOURCE_JS = (
    "JSON.stringify(performance.getEntriesByType('resource').map(e => "
    "({n: e.name, s: Math.round(e.startTime), d: Math.round(e.duration)})))"
)
PAGE_JS = "JSON.stringify({u: location.href, n: (document.body ? document.body.innerText : '').length})"


class Tab(_probe.Tab):
    async def navigate(self, url: str, grace_ms: int = GRACE_MS, timeout_s: float = 30.0) -> dict:
        """`Page.navigate` then poll `readyState`; returns {"how", "ms"} like the product's `navigate`."""
        started = time.monotonic()
        await self.send("Page.navigate", {"url": url})
        interactive_since = None
        while time.monotonic() - started < timeout_s:
            try:
                state = await self.evaluate("document.readyState")
            except Exception:
                state = None  # the old document may go away mid-poll; keep polling the new one
            if state == "complete":
                return {"how": "complete", "ms": round((time.monotonic() - started) * 1000)}
            if state == "interactive":
                interactive_since = interactive_since or time.monotonic()
                if (time.monotonic() - interactive_since) * 1000 >= grace_ms:
                    return {"how": "interactive_grace", "ms": round((time.monotonic() - started) * 1000)}
            await asyncio.sleep(0.02)
        raise TimeoutError(f"navigation to {url} did not finish in {timeout_s} s")

    async def settle(self) -> dict:
        """The product's own settle gate: {capped, ms, visibility}."""
        return await self.evaluate(f"({SETTLE_JS})({QUIET_MS}, {SETTLE_CAP_MS}, {MIN_CHARS})")

    async def resources(self) -> list[dict]:
        return json.loads(await self.evaluate(RESOURCE_JS))

    async def page(self) -> dict:
        return json.loads(await self.evaluate(PAGE_JS))


def host_of(url: str) -> str:
    return urlparse(url).hostname or ""


def is_blocked_host(host: str) -> bool:
    return any(host == blocked or host.endswith(f".{blocked}") for blocked in BLOCKED_HOSTS)


async def run_once(tab: Tab, url: str, blocked: bool) -> dict:
    """One navigation with the block list ON (the product's patterns) or OFF (the extension's own tab today)."""
    await tab.send("Network.setBlockedURLs", {"urls": blocked_url_patterns() if blocked else []})
    tab.events.clear()
    started = time.monotonic()
    nav = await tab.navigate(url)
    settle = await tab.settle()
    total_ms = round((time.monotonic() - started) * 1000)
    # One extra second of observation: were the hosts still loading after the settle had already given up?
    await asyncio.sleep(1.0)
    try:
        await tab.send("Runtime.evaluate", {"expression": "1", "returnByValue": True})  # drain the event buffer
    except Exception:
        pass
    events = list(tab.events)
    resources = await tab.resources()
    page = await tab.page()
    blocked_events = [
        event
        for event in events
        if event.get("method") == "Network.loadingFailed"
        and event.get("params", {}).get("blockedReason") == "inspector"
    ]
    ad = [r for r in resources if is_blocked_host(host_of(r["n"]))]
    ad_served = [r for r in ad if r["d"] > 0]  # a blocked request still shows up, with ~0 duration
    own = [r for r in resources if not is_blocked_host(host_of(r["n"]))]
    return {
        "blocked": blocked,
        "navigate_ms": nav["ms"],
        "navigate_how": nav["how"],
        "settle_ms": settle["ms"],
        "settle_capped": settle["capped"],
        "settle_visibility": settle["visibility"],
        "total_ms": total_ms,
        "chars": page["n"],
        "url_kept": page["u"] == url,
        "resources": len(resources),
        "ad_blocked": len(blocked_events),
        "ad_served": len(ad_served),
        "ad_any": len(ad),
        "ad_hosts": sorted({host_of(r["n"]) for r in ad}),
        "ad_last_ms": max((r["s"] + r["d"] for r in ad_served), default=None),
        # When the page's own last resource lands: circles the settle gate independently of the blocked hosts.
        "own_last_ms": max((r["s"] + r["d"] for r in own), default=None),
    }


async def measure(tab: Tab, url: str, pairs: int) -> list[dict]:
    """`pairs` alternating ON/OFF runs: an odd run's neighbour is the opposite condition, so drift cancels."""
    rows: list[dict] = []
    for blocked in [flag for _ in range(pairs) for flag in (True, False)]:
        row = await run_once(tab, url, blocked)
        rows.append(row)
        print(
            f"  {'ON ' if blocked else 'OFF'} navigate {row['navigate_ms']:>5} ms"
            f"  settle {row['settle_ms']:>5} ms{' (cap)' if row['settle_capped'] else ''}"
            f"  total {row['total_ms']:>5} ms  ad_blocked {row['ad_blocked']:>2}  ad_served {row['ad_served']:>2}"
            f"  ad_last {row['ad_last_ms']}  own_last {row['own_last_ms']}"
        )
    return rows


def summarize(rows: list[dict], blocked: bool) -> dict:
    cond = [row for row in rows if row["blocked"] is blocked]
    return {
        "runs": len(cond),
        **{
            key: {
                "median": median([row[key] for row in cond]),
                "min": min(row[key] for row in cond),
                "max": max(row[key] for row in cond),
            }
            for key in ("navigate_ms", "settle_ms", "total_ms")
        },
        "capped_runs": sum(1 for row in cond if row["settle_capped"]),
    }


def pairs_of(rows: list[dict]) -> list[tuple[dict, dict]]:
    """Adjacent ON/OFF runs as pairs: each pair is one drift-cancelling comparison, so pair them, never pool."""
    return list(zip(rows[0::2], rows[1::2]))


def paired_settle_deltas(rows: list[dict]) -> list[int]:
    """The per-pair settle difference (OFF - ON): one drift-cancelling number per adjacent ON/OFF pair."""
    return [off_row["settle_ms"] - on_row["settle_ms"] for on_row, off_row in pairs_of(rows)]


MIN_TRUSTWORTHY_PAIRS = 8  # below this a run's own verdict is a sample's luck, not a finding


def _decide(rows: list[dict]) -> tuple[str, str]:
    """Whether the measured record supports "the settles wait on the page churn the blocked hosts cause"."""
    on = [row for row in rows if row["blocked"]]
    off = [row for row in rows if not row["blocked"]]
    if not on or not off:
        return "inconclusive", "both conditions must have runs"
    if not (all(row["ad_blocked"] > 0 for row in on) and all(row["ad_served"] == 0 for row in on)):
        return "inconclusive", "the block list did not take effect in every ON run (check Network.setBlockedURLs)"
    overlap = [
        row
        for row in off
        if row["ad_served"] > 0 and row["ad_last_ms"] is not None and row["ad_last_ms"] >= row["navigate_ms"]
    ]
    if len(overlap) != len(off):
        return (
            "not supported",
            f"blocked-host scripts did not land during the settle window in {len(off) - len(overlap)}/{len(off)}"
            " OFF runs, so the claim's premise (the settles wait on their churn) is not visible here",
        )
    deltas = paired_settle_deltas(rows)
    shorter = [delta for delta in deltas if delta > 0]
    median_delta = median(deltas)
    if len(shorter) == len(deltas):
        return "supported", f"every one of {len(deltas)} adjacent pairs settled {round(median_delta)} ms faster blocked"
    if len(shorter) >= len(deltas) - 1 and median_delta > 0:
        return (
            "supported",
            f"{len(shorter)} of {len(deltas)} adjacent pairs settled faster blocked (median {round(median_delta)} ms,"
            f" {round(100 * median_delta / median([row['settle_ms'] for row in off]))}% of the OFF settle)",
        )
    if len(shorter) <= len(deltas) // 4 and median_delta <= 0:
        return (
            "not supported",
            f"blocking did not shorten the settle: {len(shorter)} of {len(deltas)} adjacent pairs were faster"
            f" blocked (median paired delta {round(median_delta)} ms)",
        )
    return (
        "inconclusive",
        f"the pairs disagree: {len(shorter)} of {len(deltas)} settled faster blocked (median {round(median_delta)} ms)",
    )


def verdict(rows: list[dict]) -> tuple[str, str]:
    """`_decide`'s answer, with a loud note while the sample is too small to carry it: the first 5-pair run here
    looked like 4 of 5 pairs settling 33% faster and was pure luck against a 12-pair run that found nothing."""
    result, why = _decide(rows)
    pairs = len(pairs_of(rows))
    if pairs < MIN_TRUSTWORTHY_PAIRS:
        why += (
            f" - but only {pairs} pairs: that is a sample, not a finding, so re-run with"
            f" --pairs {MIN_TRUSTWORTHY_PAIRS} or more before trusting it"
        )
    return result, why


def print_report(rows: list[dict], url: str, verdict_line: tuple[str, str]) -> None:
    on, off = summarize(rows, True), summarize(rows, False)
    print(f"\naddress: {url}")
    print(f"blocked hosts ({len(BLOCKED_HOSTS)}): {', '.join(BLOCKED_HOSTS)}")
    print(f"\n{'condition':<10} {'navigate ms (median)':>21} {'settle ms (median)':>19} {'total ms (median)':>18}")
    for name, side in (("blocked ON", on), ("blocked OFF", off)):
        print(
            f"{name:<10} {side['navigate_ms']['median']:>8} [{side['navigate_ms']['min']}-{side['navigate_ms']['max']}]"
            f" {side['settle_ms']['median']:>6} [{side['settle_ms']['min']}-{side['settle_ms']['max']}]"
            f" {side['total_ms']['median']:>6} [{side['total_ms']['min']}-{side['total_ms']['max']}]"
        )
    print(f"\nsettle delta (OFF - ON): {round(off['settle_ms']['median'] - on['settle_ms']['median'])} ms")
    print(f"navigate delta (OFF - ON): {round(off['navigate_ms']['median'] - on['navigate_ms']['median'])} ms")
    print(f"capped settles: ON {on['capped_runs']}/{on['runs']}, OFF {off['capped_runs']}/{off['runs']}")
    deltas = paired_settle_deltas(rows)
    print(f"\nadjacent pairs, settle delta (OFF - ON) ms: {deltas}  median {round(median(deltas))}")
    verdict_name, why = verdict_line
    print(f"\nverdict: {verdict_name} — {why}")


async def probe(pairs: int) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        async with open_dedicated_tab(Tab, collect_events=True) as tab:
            await tab.send("Network.enable")
            await tab.send("Network.setBlockedURLs", {"urls": []})
            await tab.navigate(HOME)
            await tab.settle()
            reply = await tab.fetch_json(_probe.PROPERTIES_PATH)
            props = _probe.property_list(reply)
            numbers = [p for p in props if p.get("type") == "number"]
            if reply["status"] != 200 or not numbers:
                print(f"沒有讀到數值屬性清單（status {reply['status']}）；先跑 scripts/login.py？")
                return 1
            prop = next((p for p in numbers if "faster cast" in p["name"].lower()), numbers[0])
            url = f"{HOME}?prop_{prop['id']}Min=1"  # the address scripts/probe_stats.py builds for the stats search
            await tab.navigate(url)  # one discarded warm-up: the first load of a session is the cold one
            await tab.settle()
            print(f"measuring {pairs} alternating pairs against {url}")
            rows = await measure(tab, url, pairs)
            verdict_line = verdict(rows)
            print_report(rows, url, verdict_line)
            record = {
                "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "url": url,
                "property": {"id": prop["id"], "name": prop["name"]},
                "blocked_hosts": list(BLOCKED_HOSTS),
                "settle": {"quiet_ms": QUIET_MS, "cap_ms": SETTLE_CAP_MS, "min_chars": MIN_CHARS},
                "navigate_grace_ms": GRACE_MS,
                "runs": rows,
                "summary": {"blocked_ON": summarize(rows, True), "blocked_OFF": summarize(rows, False)},
                "paired_settle_delta_ms": paired_settle_deltas(rows),
                "verdict": {"result": verdict_line[0], "why": verdict_line[1]},
            }
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            _probe.write_json(OUT / f"ab-{stamp}.json", record)
            print(f"\nraw record: artifacts/blocking/ab-{stamp}.json")
            return 0
    finally:
        close_chrome()  # stops only a Chrome this run started; a Chrome that was already running is left alone


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pairs", type=int, default=5, help="ON/OFF run pairs (default 5: ten navigations)")
    args = parser.parse_args()
    return asyncio.run(probe(args.pairs))


if __name__ == "__main__":
    sys.exit(main())
