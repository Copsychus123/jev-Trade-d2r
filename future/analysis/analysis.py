"""Market filtering and analysis aggregation logic for Traderie D2R."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from jev_ultrafast.traderie.parsing import is_within_time_window
from jev_ultrafast.traderie.site import TRADERIE_D2R_URL

if TYPE_CHECKING:
    from jev_ultrafast.traderie.parsing import ListingCard

MARKET_PLATFORM = "PC"
MARKET_MODE = "Softcore"
MARKET_LADDER = "Ladder"
MARKET_GAME_VERSION = "Reign of the Warlock"
MARKET_MAX_HOURS = 72.0


def filter_listings(
    listings: list[ListingCard],
    *,
    platform: str = MARKET_PLATFORM,
    mode: str = MARKET_MODE,
    ladder: str = MARKET_LADDER,
    game_version: str = MARKET_GAME_VERSION,
    max_hours: float = MARKET_MAX_HOURS,
    include_raw: bool = False,
) -> tuple[list[ListingCard], list[dict[str, Any]]]:
    """Filter listings matching environment criteria and time window."""
    valid: list[ListingCard] = []
    excluded: list[dict[str, Any]] = []

    for item in listings:
        reasons: list[str] = []
        if item.platform != platform:
            reasons.append(f"非 {platform} ({item.platform})")
        if item.mode != mode:
            reasons.append(f"非 {mode} ({item.mode})")
        if item.ladder != ladder:
            reasons.append(f"非 {ladder} ({item.ladder})")
        if item.game_version != game_version:
            reasons.append(f"非 {game_version} ({item.game_version})")
        if not is_within_time_window(item.posted_time, max_hours=max_hours):
            reasons.append(f"超過 {max_hours} 小時 ({item.posted_time})")

        if not reasons:
            valid.append(item)
        else:
            excluded.append({
                "listing": item.to_dict(include_raw=include_raw),
                "reasons": reasons,
            })

    return valid, excluded


def analyze_market_data(
    trading_cards: list[ListingCard],
    recent_result: dict[str, Any],
    item_name: str = "Harlequin Crest",
    item_slug: str = "harlequin-crest",
    *,
    include_raw: bool = False,
    observed_at: str | None = None,
    sources: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Synthesize market analysis report data."""
    valid_listings, excluded_listings = filter_listings(trading_cards, include_raw=include_raw)

    ask_counts: dict[str, int] = {}
    for card in valid_listings:
        ask_counts[card.ask] = ask_counts.get(card.ask, 0) + 1

    defense_values = [c.defense for c in valid_listings if c.defense is not None]
    defense_min = min(defense_values) if defense_values else None
    defense_max = max(defense_values) if defense_values else None

    eth_count = sum(1 for c in valid_listings if c.is_ethereal)
    unid_count = sum(1 for c in valid_listings if c.is_unidentified)

    direct_url = f"{TRADERIE_D2R_URL}/product/{item_slug}"
    recent_url = f"{TRADERIE_D2R_URL}/product/{item_slug}/recent"

    report_mode = "【模式 A】" if valid_listings else "【模式 B：防偽直達/指引報告】"

    out = {
        "report_mode": report_mode,
        "item_name": item_name,
        "environment": {
            "platform": MARKET_PLATFORM,
            "mode": MARKET_MODE,
            "ladder": MARKET_LADDER,
            "game_version": MARKET_GAME_VERSION,
            "time_window": f"{int(MARKET_MAX_HOURS)} 小時內",
        },
        "links": {
            "trading_url": direct_url,
            "recent_trades_url": recent_url,
        },
        "summary": {
            "total_captured": len(trading_cards),
            "valid_count": len(valid_listings),
            "excluded_count": len(excluded_listings),
            "defense_range": {
                "min": defense_min,
                "max": defense_max,
            },
            "ethereal_count": eth_count,
            "unidentified_count": unid_count,
            "price_distribution": ask_counts,
        },
        "recent_trades_status": recent_result,
        "valid_listings": [c.to_dict(include_raw=include_raw) for c in valid_listings],
        "excluded_listings": excluded_listings,
    }
    if observed_at is not None:
        out["observed_at"] = observed_at
    if sources is not None:
        out["sources"] = sources
    return out
