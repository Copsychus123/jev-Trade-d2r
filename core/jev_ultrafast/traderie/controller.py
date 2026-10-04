"""Controller steps around the Agent loop: read each view where the Agent stopped, verify, save."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jev_ultrafast.traderie.parsing import parse_recent_trades, parse_trading_txt
from jev_ultrafast.traderie.site import detect_guard, product_root_url
from jev_ultrafast.traderie.verification import matches_item, read_settled_page

TRADING_COLUMNS = ("賣家", "要價", "高符文價值", "刊登時間", "平台 / 模式 / 天梯", "防禦")
RECENT_COLUMNS = ("成交物品", "成交價格", "成交時間")
VIEW_LABELS = {"trading": "目前掛單", "recent_trades": "近期成交"}


def _is_recent_url(url: str) -> bool:
    return url.split("?", 1)[0].rstrip("/").endswith("/recent")


def _view(status: str, reason: str | None = None) -> dict[str, Any]:
    return {
        "status": status,
        "reason": reason,
        "url": None,
        "title": None,
        "observed_at": None,
        "rows": [],
        "has_more": False,
        "text": "",
    }


def new_market() -> dict[str, Any]:
    return {"trading": _view("NOT_RUN"), "recent_trades": _view("NOT_RUN"), "verification": None}


LOAD_MORE_PROBE = (
    "[...document.querySelectorAll('button,a,[role=button]')].some(e => /^\\s*load more\\s*$/i.test(e.innerText || ''))"
)


def _has_more(browser) -> bool:
    """Read-only: is a Load More button still on the page that was just read? (False if it cannot be told.)"""
    try:
        return bool(browser.evaluate(LOAD_MORE_PROBE))
    except Exception:
        return False


def read_view(browser, item_name: str, view: str) -> dict[str, Any]:
    """Read the page the Agent is on right now. One read, no navigation, never retried."""
    result = _view("FAILED")
    result["observed_at"] = datetime.now(timezone.utc).isoformat()
    trading = view == "trading"
    try:
        page = read_settled_page(browser)
    except TimeoutError:
        result["reason"] = "頁面一直沒有載入完成"
        return result
    text = page["text"]
    result.update(url=page["url"], title=page.get("title", ""), text=text)

    reason = detect_guard(page, browser)
    if reason:
        result.update(status="BLOCKED", reason=f"網站阻擋：{reason}")
        return result

    on_recent = _is_recent_url(page["url"])
    if not product_root_url(page["url"]) or on_recent == trading:
        result["reason"] = f"Agent 停在的不是{'掛單' if trading else '近期成交'}頁：{page['url']}"
        return result
    if not (matches_item(item_name, page.get("title", "")) or matches_item(item_name, text)):
        result["reason"] = f"頁面不是 {item_name} 的商品頁"
        return result

    lines = [line.strip() for line in text.splitlines()]
    if trading:
        rows = [card.to_dict() for card in parse_trading_txt(text, item_name=item_name)]
        expected = sum(1 for line in lines if line == "Trading For")
        if not rows:
            result["reason"] = "頁面上沒有讀到任何掛單"
            return result
        if len(rows) < expected:
            result["reason"] = f"表格 {len(rows)} 筆，少於網頁上的 {expected} 筆"
            return result
    else:
        parsed = parse_recent_trades(text)
        if parsed["blocked"]:
            result.update(status="BLOCKED" if "登入" in parsed["reason"] else "FAILED", reason=parsed["reason"])
            return result
        rows = parsed["trades"]
        expected = sum(1 for line in lines if line.lower() == "they give")
        if len(rows) != expected:
            result["reason"] = f"表格 {len(rows)} 筆，和網頁上的 {expected} 筆不一致"
            return result
    result.update(status="PASSED", rows=rows, has_more=_has_more(browser))
    return result


def verify_views(item_name: str, market: dict[str, Any]) -> dict[str, Any]:
    """Eight independent checks over what was read, plus the per-view read status."""
    trading, recent = market["trading"], market["recent_trades"]
    trading_url, recent_url = trading["url"] or "", recent["url"] or ""
    trading_root, recent_root = product_root_url(trading_url), product_root_url(recent_url)
    checks = {
        "product_page": recent_root is not None,
        "item_match": matches_item(item_name, recent["title"] or "") or matches_item(item_name, recent["text"]),
        "same_product": trading_root is not None and trading_root == recent_root,
        "trading_view": trading_root is not None and not _is_recent_url(trading_url),
        "recent_view": _is_recent_url(recent_url),
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
    """Call after every Agent command: read the Trading view at its DONE point, then Recent Trades."""
    state = agent.state
    if state["awaiting_handoff"]:
        market["trading"] = read_view(agent.browser, item_name, "trading")
        agent.browser.evaluate("window.scrollTo(0, 0)")  # viewport only, so the tabs are in view for Phase B
        agent.command("handoff")
    elif state["status"] == "done" and market["recent_trades"]["status"] == "NOT_RUN":
        market["recent_trades"] = read_view(agent.browser, item_name, "recent_trades")
        market["verification"] = verify_views(item_name, market)


def run_agent(agent, item_name: str, market: dict[str, Any]):
    """Agent loop plus per-view reads; yields each snapshot."""
    while agent.state["status"] not in {"done", "blocked"}:
        yield agent.command("tick")
        advance(agent, item_name, market)


def _cell(value: Any) -> str:
    text = "—" if value in (None, "") else str(value)
    return text.replace("|", "\\|").replace("\n", " ")


def _trading_cells(row: dict[str, Any]) -> list[Any]:
    env = " / ".join(str(row[k]) for k in ("platform", "mode", "ladder") if row.get(k))
    cells = [row.get("seller"), row.get("ask"), row.get("high_rune_value"), row.get("posted_time")]
    return [*cells, env, row.get("defense")]


def _recent_cells(row: dict[str, Any]) -> list[str]:
    return [row.get("buyer_or_seller"), row.get("price"), row.get("trade_time")]


def _table(columns: tuple[str, ...], rows: list[list[Any]]) -> list[str]:
    lines = ["| " + " | ".join(columns) + " |", "|" + "---|" * len(columns)]
    lines += ["| " + " | ".join(_cell(c) for c in row) + " |" for row in rows]
    return lines


def _markdown(item_name: str, market: dict[str, Any]) -> str:
    lines = [f"# {item_name} 市場資料", ""]
    for key, columns, cells in (
        ("trading", TRADING_COLUMNS, _trading_cells),
        ("recent_trades", RECENT_COLUMNS, _recent_cells),
    ):
        view = market[key]
        more = "網站上還有更多（已達載入次數上限）" if view["has_more"] else "已全部載入"
        lines += [f"## {VIEW_LABELS[key]}", "", f"- 網址：{view['url']}", f"- 讀取時間：{view['observed_at']}"]
        lines += [f"- 筆數：{len(view['rows'])}（{more}）", ""]
        lines += _table(columns, [cells(r) for r in view["rows"]])
        lines += ["", "<details><summary>網頁原文</summary>", "", "```text", view["text"], "```", "", "</details>", ""]
    return "\n".join(lines)


def save_report(item_name: str, market: dict[str, Any], output_dir: Path) -> str | None:
    """Write verification always; tables and report only when every check passed."""
    verification = market["verification"]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "verification.json").write_text(
        json.dumps(verification, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    paths = [output_dir / "market.json", output_dir / "market_report.md"]
    if not verification["passed"]:
        for path in paths:
            path.unlink(missing_ok=True)
        return None
    data = {
        key: {k: market[key][k] for k in ("status", "url", "title", "observed_at", "has_more", "rows")}
        for key in ("trading", "recent_trades")
    }
    paths[0].write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    report = _markdown(item_name, market)
    paths[1].write_text(report, encoding="utf-8")
    return report
