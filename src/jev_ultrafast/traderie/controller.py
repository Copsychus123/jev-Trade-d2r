"""Controller steps around the Agent loop: read each view where the Agent stopped, verify, save.

Every view result carries a typed `reason_code` next to the human-readable `reason`:
`unsettled` (the page never stopped changing), `guard` (challenge/login/off-scope page), `wrong_view` (the Agent is not
on this view's page), `wrong_item`, `no_rows` (nothing read and the page does not say the list is empty), `no_anchor`
(rows were read but the page has no row markers to check them against), `row_mismatch` (fewer table rows than markers
on the page), `login_required` and `empty` (the page itself says there is nothing to list: a real answer, PASSED).

A confirmed-empty Recent Trades view (the page says "There are no offers") is PASSED with no rows, so a market without
trades still gets a report. An empty view the page does not confirm stays FAILED and the report is not written; the
rows that were read stay in the stored market for inspection.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jev_ultrafast import fs
from jev_ultrafast.errors import StalePage
from jev_ultrafast.traderie.parsing import is_trade_start, parse_recent_trades, parse_trading_txt
from jev_ultrafast.traderie.site import TRADING_MARKERS, detect_guard, product_root_url, product_section
from jev_ultrafast.traderie.verification import page_matches_item, read_settled_page

TRADING_COLUMNS = ("賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦")
RECENT_COLUMNS = ("成交物品", "成交價格", "成交時間")
VIEW_LABELS = {"trading": "目前掛單", "recent_trades": "近期成交"}
VIEW_SECTIONS = {"trading": None, "recent_trades": "recent"}
EMPTY_TRADING = "there are no listings"
EMPTY_RECENT = "there are no offers"


def _view(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "reason": None,
        "reason_code": None,
        "url": None,
        "title": None,
        "observed_at": None,
        "rows": [],
        "has_more": None,  # True / False once read; None = not read or the probe failed (unknown)
        "settled": None,
        "text": "",
    }


def new_market() -> dict[str, Any]:
    return {"trading": _view("NOT_RUN"), "recent_trades": _view("NOT_RUN"), "verification": None}


LOAD_MORE_PROBE = (
    "[...document.querySelectorAll('button,a,[role=button]')].some(e => /^\\s*load more\\s*$/i.test(e.innerText || ''))"
)


def _has_more(browser) -> bool | None:
    """Read-only: is a Load More button still on the page that was just read? None when it cannot be told."""
    try:
        return bool(browser.evaluate(LOAD_MORE_PROBE))
    except Exception:
        return None


def _fail(result: dict[str, Any], code: str, reason: str, status: str = "FAILED") -> dict[str, Any]:
    result.update(status=status, reason=reason, reason_code=code)
    return result


def _parse_view(view: str, text: str, item_name: str) -> dict[str, Any]:
    lines = [line.strip() for line in text.splitlines()]
    if view == "trading":
        rows = [card.to_dict() for card in parse_trading_txt(text, item_name=item_name)]
        markers = sum(1 for line in lines if line in TRADING_MARKERS)
        empty_text, empty_reason, fallback_reason = EMPTY_TRADING, "目前沒有掛單", "頁面上沒有讀到任何掛單"
    else:
        parsed = parse_recent_trades(text)
        if parsed["code"] in ("login_required", "login_or_no_data"):
            return {"blocked": (parsed["code"], parsed["reason"])}
        rows = parsed["trades"]
        markers = sum(1 for line in lines if is_trade_start(line))
        empty_text, empty_reason, fallback_reason = EMPTY_RECENT, "目前沒有成交紀錄", parsed["reason"]
    return {
        "trading": view == "trading",
        "rows": rows,
        "markers": markers,
        "lines": lines,
        "empty_text": empty_text,
        "empty_reason": empty_reason,
        "fallback_reason": fallback_reason,
        "blocked": None,
    }


def _cross_check_rows(parsed_view: dict[str, Any], result: dict[str, Any], browser) -> dict[str, Any]:
    rows = parsed_view["rows"]
    markers = parsed_view["markers"]
    lines = parsed_view["lines"]
    empty_text = parsed_view["empty_text"]
    empty_reason = parsed_view["empty_reason"]
    trading = parsed_view["trading"]

    if not rows:
        # "Nothing to list" is a real answer only when the page says so and has no row markers of its own.
        if markers == 0 and any(line.lower() == empty_text for line in lines):
            result.update(status="PASSED", reason=empty_reason, reason_code="empty", has_more=False)
            return result
        return _fail(result, "no_rows", parsed_view["fallback_reason"])
    if markers == 0:
        return _fail(result, "no_anchor", f"讀到 {len(rows)} 筆，但頁面上找不到可以核對的筆數標記")
    # The trading side only fails when there are *fewer* rows than markers, and that is deliberate: a line inside a
    # card that itself looks like a time line splits the card, so the rows can exceed the page's markers (measured:
    # one such line injected into a card -> 4 rows against 3 markers). Failing on that would fail a page that was read
    # in full. The recent-trades side compares with `!=` because its blocks are joined by the reader, so an extra row
    # there is a real disagreement; the asymmetry is intentional, not an oversight.
    if trading and len(rows) < markers:
        return _fail(result, "row_mismatch", f"表格 {len(rows)} 筆，少於網頁上的 {markers} 筆")
    if not trading and len(rows) != markers:
        return _fail(result, "row_mismatch", f"表格 {len(rows)} 筆，和網頁上的 {markers} 筆不一致")
    result.update(status="PASSED", rows=rows, has_more=_has_more(browser))
    return result


def read_view(browser, item_name: str, view: str) -> dict[str, Any]:
    """Read the page the Agent is on right now. One read, no navigation, never retried."""
    result = _view("FAILED")
    result["observed_at"] = datetime.now(timezone.utc).isoformat()
    trading = view == "trading"
    try:
        page = read_settled_page(browser)
    except (TimeoutError, StalePage):
        result["settled"] = False
        return _fail(result, "unsettled", "頁面一直沒有載入完成")
    text = page["text"]
    title = page.get("title", "")
    result.update(url=page["url"], title=title, text=text, settled=page.get("settled"))

    reason = detect_guard(page, browser)
    if reason:
        return _fail(result, "guard", f"網站阻擋：{reason}", "BLOCKED")

    if not product_root_url(page["url"]) or product_section(page["url"]) != VIEW_SECTIONS[view]:
        return _fail(result, "wrong_view", f"Agent 停在的不是{'掛單' if trading else '近期成交'}頁：{page['url']}")
    if not page_matches_item(item_name, title, text):
        return _fail(result, "wrong_item", f"頁面不是 {item_name} 的商品頁")
    if result["settled"] is False:
        return _fail(result, "unsettled", "頁面在時限內沒有穩定下來，讀到的筆數不可信")

    parsed_view = _parse_view(view, text, item_name)
    if parsed_view.get("blocked"):
        code, reason = parsed_view["blocked"]
        return _fail(result, "login_required", reason, "BLOCKED")
    return _cross_check_rows(parsed_view, result, browser)


def verify_views(item_name: str, market: dict[str, Any]) -> dict[str, Any]:
    """Eight independent checks over what was read, plus the per-view read status."""
    trading, recent = market["trading"], market["recent_trades"]
    trading_url, recent_url = trading["url"] or "", recent["url"] or ""
    trading_root, recent_root = product_root_url(trading_url), product_root_url(recent_url)
    checks = {
        "product_page": recent_root is not None,
        "item_match": page_matches_item(item_name, recent["title"] or "", recent["text"]),
        "same_product": trading_root is not None and trading_root == recent_root,
        "trading_view": trading_root is not None and product_section(trading_url) is None,
        "recent_view": recent_root is not None and product_section(recent_url) == "recent",
        "trading_rows_ok": trading["status"] == "PASSED",
        "recent_rows_ok": recent["status"] == "PASSED",
        "not_blocked": "BLOCKED" not in (trading["status"], recent["status"]),
    }
    failed = [name for name, ok in checks.items() if not ok]
    return {
        "passed": not failed,
        "item_name": item_name,
        "product_url": recent_root,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "failed_checks": failed,
        "view_reasons": {key: market[key]["reason"] for key in ("trading", "recent_trades") if market[key]["reason"]},
    }


def advance(agent, item_name: str, market: dict[str, Any]) -> None:
    """Controller work that is due for the Agent's current state: read the Trading view at its handoff point, then
    Recent Trades once the run is done. A blocked run gets a verdict too, so the report says which checks failed.
    Idempotent: when the state has nothing due it does nothing, so it is safe to call before and after any command."""
    state = agent.state
    if state["awaiting_handoff"]:
        market["trading"] = read_view(agent.browser, item_name, "trading")
        try:
            agent.browser.evaluate("window.scrollTo(0, 0)")  # viewport only, so the tabs are in view for Phase B
        except StalePage:
            pass  # cosmetic; the handoff must not be lost to it
        agent.command("handoff")
    elif state["status"] == "done" and market["recent_trades"]["status"] == "NOT_RUN":
        market["recent_trades"] = read_view(agent.browser, item_name, "recent_trades")
        market["verification"] = verify_views(item_name, market)
    elif state["status"] == "blocked" and market["verification"] is None:
        market["verification"] = verify_views(item_name, market)


def step(agent, item_name: str, market: dict[str, Any]) -> dict[str, Any]:
    """One loop step shared by the CLI and `run_agent`: finish controller work left over from an earlier step,
    tick the Agent, then do the controller work that tick made due. The controller work also runs when the tick
    raised (the Agent may have reached DONE or a handoff before the error), and the tick's error is the one raised.
    Returns the Agent snapshot taken after the controller work."""
    advance(agent, item_name, market)
    try:
        agent.command("tick")
    except Exception:
        try:
            advance(agent, item_name, market)
        except Exception:
            pass  # the next step runs it again before anything else; the tick's error is the one to report
        raise
    advance(agent, item_name, market)
    return agent.snapshot()


def run_agent(agent, item_name: str, market: dict[str, Any]):
    """Agent loop plus per-view reads; yields each snapshot. The controller work of a step is done before its snapshot
    is yielded, so a consumer that stops at status 'done' already has the Recent Trades read and the verification."""
    advance(agent, item_name, market)
    while agent.state["status"] not in {"done", "blocked"}:
        yield step(agent, item_name, market)


def _cell(value: Any) -> str:
    text = "—" if value in (None, "") else str(value)
    return text.replace("|", "\\|").replace("\n", " ")


def _trading_cells(row: dict[str, Any]) -> list[Any]:
    env = " / ".join(str(row[k]) for k in ("platform", "mode", "ladder") if row.get(k))
    cells = [row.get("seller"), row.get("ask"), row.get("high_rune_value"), row.get("posted_time")]
    return [*cells, env, row.get("defense")]


def _recent_cells(row: dict[str, Any]) -> list[str]:
    return [row.get("buyer_or_seller"), row.get("price"), row.get("trade_time")]


def _row(cells) -> str:
    return "| " + " | ".join(cells) + " |"


def _table(columns: tuple[str, ...], rows: list[list[Any]]) -> list[str]:
    lines = [_row(columns), "|" + "---|" * len(columns)]
    lines += [_row(_cell(c) for c in row) for row in rows]
    return lines


MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]<>#|~])")
BACKTICK_RUN = re.compile(r"`+")


def _more_text(has_more: bool | None) -> str:
    if has_more is None:
        return "是否還有更多：未知"
    return "網站上還有更多（已達載入次數上限）" if has_more else "已全部載入"


def _fenced(text: str) -> list[str]:
    """A code block whose fence is longer than any backtick run inside the page text, so the text cannot close it."""
    fence = "`" * max(3, max((len(run) for run in BACKTICK_RUN.findall(text)), default=0) + 1)
    return [f"{fence}text", text, fence]


def _md_escape(text: str) -> str:
    """Markdown-safe text for a heading: the item name comes from the user."""
    return MARKDOWN_SPECIAL.sub(lambda m: "\\" + m.group(1), " ".join(text.split()))


def _markdown(item_name: str, market: dict[str, Any]) -> str:
    lines = [f"# {_md_escape(item_name)} 市場資料", ""]
    for key, columns, cells in (
        ("trading", TRADING_COLUMNS, _trading_cells),
        ("recent_trades", RECENT_COLUMNS, _recent_cells),
    ):
        view = market[key]
        lines += [f"## {VIEW_LABELS[key]}", "", f"- 網址：{view['url']}", f"- 讀取時間：{view['observed_at']}"]
        lines += [f"- 筆數：{len(view['rows'])}（{_more_text(view['has_more'])}）", ""]
        lines += _table(columns, [cells(r) for r in view["rows"]])
        lines += ["", "<details><summary>網頁原文</summary>", "", *_fenced(view["text"]), "", "</details>", ""]
    return "\n".join(lines)


def save_report(item_name: str, market: dict[str, Any], output_dir: Path) -> str | None:
    """Write verification always; tables and report only when every check passed."""
    verification = market["verification"]
    fs.write_text(output_dir / "verification.json", json.dumps(verification, indent=2, ensure_ascii=False))
    market_path = output_dir / "market.json"
    report_path = output_dir / "market_report.md"
    if not verification["passed"]:
        for path in (market_path, report_path):
            path.unlink(missing_ok=True)
        return None
    fields = ("status", "reason_code", "url", "title", "observed_at", "has_more", "settled", "rows")
    data = {key: {k: market[key][k] for k in fields} for key in ("trading", "recent_trades")}
    fs.write_text(market_path, json.dumps(data, indent=2, ensure_ascii=False))
    report = _markdown(item_name, market)
    fs.write_text(report_path, report)
    return report
