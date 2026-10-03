"""Markdown report generation for Traderie D2R market analysis."""

from __future__ import annotations

import re
from statistics import median
from typing import Any

from jev_ultrafast.traderie.analysis import analyze_market_data
from jev_ultrafast.traderie.parsing import parse_recent_trades, parse_trading_txt

# Constants for missing value handling
MIN_LISTINGS_FOR_STATS = 3
DEFAULT_CURRENCY = "Runes"
UNKNOWN_PLACEHOLDER = "Unknown"


def is_valid_price_format(price: str | None) -> bool:
    """Check if price string is in a valid format."""
    if not price or not isinstance(price, str):
        return False
    price_stripped = price.strip()
    if not price_stripped:
        return False
    # Price should not be just "Make an Offer" or similar placeholders without value
    if price_stripped.lower() in ("unknown", "pending", "ask for price"):
        return False
    return True


def is_valid_listing(listing: dict[str, Any]) -> bool:
    """Return True if listing has minimum required fields."""
    # Must have a seller (or will use Unknown placeholder)
    # Must have a valid ask price
    return (
        is_valid_price_format(listing.get("ask"))
    )


def filter_valid_listings(all_listings: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Return valid listings and exclusion reasons.
    
    Returns:
        Tuple of (valid_listings, exclusion_reasons)
    """
    valid = []
    exclusion_reasons = []
    
    for listing in all_listings:
        if not is_valid_listing(listing):
            if not is_valid_price_format(listing.get("ask")):
                exclusion_reasons.append("missing_price")
    
    valid = [listing for listing in all_listings if is_valid_listing(listing)]
    return valid, exclusion_reasons


def is_valid_trade(trade: dict[str, Any]) -> bool:
    """Check if a trade record has minimum required fields."""
    return (
        is_valid_price_format(trade.get("price"))
    )


def filter_valid_trades(all_trades: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Return valid trades and exclusion reasons."""
    valid = [t for t in all_trades if is_valid_trade(t)]
    exclusion_reasons = []
    if len(all_trades) - len(valid) > 0:
        exclusion_reasons.append("missing_price")
    return valid, exclusion_reasons


def extract_numeric_price(price_str: str | None) -> float | None:
    """Extract numeric value from price string for statistical calculations.
    
    Handles formats like "3 Ber", "2.5 Ber", "1000 Runes", etc.
    Returns the numeric value or None if unable to parse.
    """
    if not price_str or not isinstance(price_str, str):
        return None
    
    # Extract first number (integer or float)
    match = re.search(r"(\d+(?:\.\d+)?)", price_str)
    if match:
        try:
            return float(match.group(1))
        except (ValueError, AttributeError):
            return None
    return None


def calculate_statistics(listings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Calculate price statistics or return None if insufficient data.
    
    Requires at least MIN_LISTINGS_FOR_STATS valid listings with prices.
    """
    if len(listings) < MIN_LISTINGS_FOR_STATS:
        return None
    
    prices = []
    price_to_listing = {}  # Map price to listing for reverse lookup
    
    for listing in listings:
        numeric = extract_numeric_price(listing.get("ask"))
        if numeric is not None:
            prices.append(numeric)
            if numeric not in price_to_listing:
                price_to_listing[numeric] = listing
    
    if len(prices) < MIN_LISTINGS_FOR_STATS:
        return None
    
    min_price = min(prices)
    max_price = max(prices)
    avg_price = sum(prices) / len(prices)
    median_price = median(prices)
    
    # Detect variance
    variance = max_price - min_price
    range_pct = (variance / avg_price * 100) if avg_price > 0 else 0
    
    if range_pct > 50:
        variance_level = "high"
    elif range_pct > 20:
        variance_level = "medium"
    else:
        variance_level = "low"
    
    # Find closest price to min and max for display
    min_listing = price_to_listing[min_price]
    max_listing = price_to_listing[max_price]
    
    # For median, find the listing closest to the median value
    median_listing = min(
        (listing for listing in listings if is_valid_price_format(listing.get("ask"))),
        key=lambda listing: abs(extract_numeric_price(listing.get("ask")) - median_price)
    )
    
    return {
        "count": len(prices),
        "min_numeric": min_price,
        "max_numeric": max_price,
        "avg_numeric": avg_price,
        "median_numeric": median_price,
        "min_price": min_listing["ask"],
        "max_price": max_listing["ask"],
        "avg_price": f"{avg_price:.2f}",
        "median_price": median_listing["ask"],
        "price_variance": variance_level,
    }


def build_json_report(
    item_name: str,
    trading_listings: list[dict[str, Any]],
    recent_trades: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a JSON report with comprehensive missing value handling.
    
    Args:
        item_name: Name of the item being reported
        trading_listings: List of trading listings
        recent_trades: Optional list of recent trade records
    
    Returns:
        Report dict with status, data completeness, and sections for trading/trades/stats
    """
    # Filter valid data
    valid_listings, listing_exclusions = filter_valid_listings(trading_listings)
    valid_trades = []
    trade_exclusions = []
    
    if recent_trades is None:
        recent_trades = []
    
    if recent_trades:
        valid_trades, trade_exclusions = filter_valid_trades(recent_trades)
    
    # Ensure sellers have values (use "Unknown" if missing)
    for listing in valid_listings:
        if not listing.get("seller") or listing.get("seller", "").strip() == "":
            listing["seller"] = UNKNOWN_PLACEHOLDER
    
    for trade in valid_trades:
        if not trade.get("buyer_or_seller") or trade.get("buyer_or_seller", "").strip() == "":
            trade["buyer_or_seller"] = UNKNOWN_PLACEHOLDER
    
    # Calculate statistics
    stats = calculate_statistics(valid_listings) if valid_listings else None
    
    # Determine overall status
    if not valid_listings and not valid_trades:
        report_status = "FAILED"
        summary_note = "Insufficient data to generate report (no valid listings or trades found)"
    elif not valid_listings:
        report_status = "PARTIAL"
        summary_note = "Report contains historical trades but no current listings"
    elif not valid_trades:
        report_status = "PARTIAL"
        summary_note = "Report contains current listings but incomplete historical data"
    else:
        report_status = "SUCCESS"
        summary_note = "Report complete with listings and historical trades"
    
    # Build report structure
    report = {
        "item_name": item_name,
        "data_completeness": {
            "trading_listings_found": len(valid_listings) > 0,
            "recent_trades_found": len(valid_trades) > 0,
        },
        "trading": {
            "status": "SUCCESS" if valid_listings else "PARTIAL",
            "listings_count": len(trading_listings),
            "listings_valid_count": len(valid_listings),
            "listings_excluded_count": len(trading_listings) - len(valid_listings),
            "exclusion_reasons": list(set(listing_exclusions)) if listing_exclusions else [],
            "listings": valid_listings,
        },
        "recent_trades": {
            "status": "SUCCESS" if valid_trades else "PARTIAL",
            "trades_count": len(recent_trades),
            "trades_valid_count": len(valid_trades),
            "trades_excluded_count": len(recent_trades) - len(valid_trades),
            "exclusion_reasons": list(set(trade_exclusions)) if trade_exclusions else [],
            "trades": valid_trades,
        },
        "statistics": stats,
        "summary": {
            "status": report_status,
            "note": summary_note,
        },
    }
    
    # Add data completeness notes
    if not valid_listings:
        report["data_completeness"]["note"] = "No active listings found"
    elif not valid_trades:
        report["data_completeness"]["note"] = "Recent trade history not available for this item"
    
    if stats is None and valid_listings and len(valid_listings) < MIN_LISTINGS_FOR_STATS:
        report["statistics"] = {
            "status": "INSUFFICIENT_DATA",
            "reason": f"Need at least {MIN_LISTINGS_FOR_STATS} valid listings for statistics calculation",
            "current_count": len(valid_listings),
        }
    
    return report

def generate_markdown_report(analysis_data: dict[str, Any]) -> str:
    """Generate professional Traditional Chinese market report markdown."""
    env = analysis_data["environment"]
    summary = analysis_data["summary"]
    recent = analysis_data["recent_trades_status"]
    links = analysis_data["links"]
    valid_listings = analysis_data["valid_listings"]
    excluded_listings = analysis_data["excluded_listings"]

    lines = [
        f"# {analysis_data['item_name']} 市場行情分析報告",
        "",
        f"**報告模式**：{analysis_data['report_mode']}  ",
        f"**分析環境規範**：`{env['platform']}` · `{env['mode']}` · `{env['ladder']}` · `{env['game_version']}`  ",
        f"**時間窗口**：{env['time_window']}  ",
        "**數據保證**：零幻覺標準（賣家 ID、刊登時間、要價、裝備規格均來自實際抓取網頁資料，保留原文）  ",
        "",
        "---",
        "",
        "## 1. 市場概況與在架掛單 (Trading) 統計",
        "",
        f"- **總擷取掛單數**：{summary['total_captured']} 筆",
        f"- **符合規範有效掛單**：{summary['valid_count']} 筆",
        (
            f"- **排除掛單**：{summary['excluded_count']} 筆"
            "（排除原因包含：Non Ladder、Hardcore、非 PC 平台、非 Reign of the Warlock）"
        ),
        f"- **防禦值 (Defense) 範圍**：{summary['defense_range']['min']} ~ {summary['defense_range']['max']}",
        f"- **未辨識 (Unidentified)**：{summary['unidentified_count']} 筆",
        (
            f"- **無形 (Ethereal)**：{summary['ethereal_count']} 筆（"
            + (
                "有效掛單中無無形，全數為 Non-Eth"
                if summary["ethereal_count"] == 0
                else f"包含 {summary['ethereal_count']} 筆無形掛單"
            )
            + "）"
        ),
        "",
        "### 主流行情要價 (Ask) 分佈",
        "",
        "| 要價 (Ask / Pricing) | 掛單數量 | 佔有效比率 | 行情解讀 |",
        "| :--- | :---: | :---: | :--- |",
    ]

    price_dist = summary["price_distribution"]
    total_valid = max(summary["valid_count"], 1)
    for ask, count in sorted(price_dist.items(), key=lambda x: x[1], reverse=True):
        ratio = (count / total_valid) * 100
        desc = ""
        if "Mal Rune" in ask and "OR" not in ask:
            desc = "主流入門均價（普通防禦或快速出清）"
        elif "Ist Rune" in ask and "OR" not in ask and "Mal" not in ask:
            desc = "標準均價（中高防禦或標準定價）"
        elif "Make an Offer" in ask:
            desc = "賣家開放議價"
        elif "Ohm" in ask or "Vex" in ask:
            desc = "高頂防/鑲頂寶石溢價要價"
        else:
            desc = "複合要價 / 多幣種彈性選擇"
        lines.append(f"| `{ask}` | {count} | {ratio:.1f}% | {desc} |")

    lines.extend([
        "",
        "---",
        "",
        "## 2. 歷史成交紀錄 (Recent Trades) 狀態與防偽判定",
        "",
    ])

    if recent.get("mode") == "B" or recent.get("blocked"):
        lines.extend([
            "### 【模式 B：防偽直達/指引報告】",
            "",
            "> **防護/登入牆觸發說明**：  ",
            f"> 系統在檢視 Recent Trades 頁面時，偵測到防護或登入限制提示（`{recent.get('reason', '需要登入')}`）。  ",
            "> 根據**零幻覺最高原則**，系統禁止捏造或推估虛構的成交記錄與成交價。",
            "",
            "#### 關鍵物品屬性與直達鏈接：",
            f"- **物品英文全名**：`{analysis_data['item_name']}`",
            f"- **Traderie 物品頁面 (Trading)**：[{links['trading_url']}]({links['trading_url']})",
            f"- **Traderie 成交紀錄頁 (Recent Trades)**：[{links['recent_trades_url']}]({links['recent_trades_url']})",
            "",
            "#### 用戶登入與查看指引：",
            "1. 點擊上方直達連結前往 Traderie Recent Trades 頁面。",
            "2. 若未登入，請使用 Traderie 帳號登入（可透過 Discord 或 Google 授權）。",
            "3. 如需透過本自動化工具抓取 Recent Trades，請於環境變數配置 `TRADERIE_COOKIE` 或 "
            "`TRADERIE_SESSION_TOKEN`，系統將自動注入 Session 讀取歷史成交資訊。",
            "",
        ])
    else:
        lines.extend([
            "### 【模式 A：真實成交資料】",
            "",
            "| 成交玩家 | 成交對價 | 成交時間 |",
            "| :--- | :--- | :--- |",
        ])
        for t in recent.get("trades", []):
            lines.append(f"| `{t['buyer_or_seller']}` | `{t['price']}` | {t['trade_time']} |")
        lines.append("")

    lines.extend([
        "---",
        "",
        "## 3. 在架有效掛單明細（PC · Softcore · Ladder · Reign of the Warlock）",
        "",
        "| # | 賣家 ID | 刊登時間 | 防禦 (Def) | 規格/鑲嵌/未辨識 | 原始要價 (Ask) | 高符價值 (HRV) |",
        "| :---: | :--- | :--- | :---: | :--- | :--- | :--- |",
    ])

    for i, c in enumerate(valid_listings, 1):
        def_str = str(c["defense"]) if c["defense"] is not None else "-"
        specs = []
        if c["is_unidentified"]:
            specs.append("Unidentified")
        if c["is_ethereal"]:
            specs.append("Ethereal")
        else:
            specs.append("Non-Eth")
        for s in c["stats"]:
            if "defense" not in s.lower() and s not in specs:
                specs.append(s)
        spec_str = ", ".join(specs)
        hrv_str = c["high_rune_value"] or "-"
        lines.append(
            f"| {i} | `{c['seller']}` | {c['posted_time']} | {def_str} | {spec_str} | `{c['ask']}` | {hrv_str} |"
        )

    lines.extend([
        "",
        "---",
        "",
        "## 4. 排除掛單抽樣明細（環境/條件不符）",
        "",
        "| # | 賣家 ID | 原始標籤 / 環境 | 排除原因 |",
        "| :---: | :--- | :--- | :--- |",
    ])

    for i, ex in enumerate(excluded_listings[:12], 1):
        c = ex["listing"]
        p = c["platform"] or "Unknown"
        m = c["mode"] or "Unknown"
        lad = c["ladder"] or "Unknown"
        gv = c["game_version"] or "Unknown"
        env_summary = f"{p} · {m} · {lad} · {gv}"
        reasons_str = "、".join(ex["reasons"])
        lines.append(f"| {i} | `{c['seller']}` | {env_summary} | {reasons_str} |")

    if len(excluded_listings) > 12:
        rem = len(excluded_listings) - 12
        lines.append(f"| ... | *(其餘 {rem} 筆已略，皆因 Non Ladder / 家機平台 / Hardcore 等排除)* | | |")

    lines.append("")
    return "\n".join(lines)


def build_market_report(
    item_name: str,
    item_slug: str,
    trading_text: str,
    recent_text: str,
    *,
    observed_at: str,
    sources: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Parse trading and recent texts, analyze market data, and generate markdown report."""
    cards = parse_trading_txt(trading_text, item_name=item_name)
    recent = parse_recent_trades(recent_text)
    data = analyze_market_data(
        trading_cards=cards,
        recent_result=recent,
        item_name=item_name,
        item_slug=item_slug,
        include_raw=False,
        observed_at=observed_at,
        sources=sources,
    )
    return data, generate_markdown_report(data)
