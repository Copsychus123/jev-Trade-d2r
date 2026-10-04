"""Data parsing for Traderie listing rows, innerText cards, and trade records."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

from jev_ultrafast.traderie.site import TRADERIE_D2R_URL

SIGN_IN_PROMPT = "Please sign in to view offers"

LISTING_NOISE_LINES = {
    "join akrew pro for an ad free experience!",
    "pro",
    "marketplace",
    "community",
    "add listing",
    "log in",
    "sign up",
}

# Older entries show a date instead of "N days ago". The Chinese form is what Traderie shows to a Chinese browser;
# the others are the usual numeric and English forms.
ABSOLUTE_DATE = (
    r"\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}/\d{1,2}/\d{4}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}"
)

TIME_REGEX = re.compile(
    r"^(?:(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|s|m|h|d|秒|分鐘|小时|小時|天)s?\s*(?:ago|前)|"
    + ABSOLUTE_DATE
    + ")$",
    re.I,
)


@dataclass
class ListingCard:
    listing_id: str | None
    seller: str
    rating: str | None
    posted_time: str
    item_name: str
    platform: str | None
    mode: str | None
    ladder: str | None
    game_version: str | None
    is_ethereal: bool
    is_unidentified: bool
    defense: int | None
    stats: list[str]
    ask: str
    high_rune_value: str | None
    raw_text: str | None = None

    def to_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        data = asdict(self)
        if not include_raw:
            data.pop("raw_text", None)
        return data


@dataclass
class TradeRecord:
    buyer_or_seller: str | None
    price: str
    trade_time: str
    item_name: str | None = None
    specs: dict[str, Any] | None = None

    def to_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        return asdict(self)


def parse_trading_txt(txt_content: str, *, item_name: str = "Harlequin Crest") -> list[ListingCard]:
    """Parse listing cards from Traderie trading page innerText."""
    if not txt_content:
        return []

    lines = [line.strip().replace("\xa0", " ") for line in txt_content.splitlines() if line.strip()]

    start = 0
    for i, line in enumerate(lines):
        if "Apply this search for all" in line:
            start = i + 1

    end = len(lines)
    for i in range(start, len(lines)):
        if "Log in to Load More" in lines[i] or lines[i].startswith("HELP"):
            end = i
            break

    listing_lines = lines[start:end]
    cards_raw: list[list[str]] = []
    current: list[str] = []

    for line in listing_lines:
        current.append(line)
        if TIME_REGEX.match(line):
            cards_raw.append(current)
            current = []

    listings: list[ListingCard] = []

    for card in cards_raw:
        clean_prefix = [entry for entry in card if entry.lower() not in LISTING_NOISE_LINES]
        if not clean_prefix:
            continue
        seller = clean_prefix[0]
        rating = None
        if len(clean_prefix) > 1 and clean_prefix[1].startswith("(") and clean_prefix[1].endswith(")"):
            rating = clean_prefix[1]

        posted_time = card[-1]

        item_line = item_name
        item_idx = -1
        for i, entry in enumerate(clean_prefix):
            if item_name.lower() in entry.lower():
                item_line = entry
                item_idx = i
                break

        trade_idx = -1
        for i, entry in enumerate(clean_prefix):
            if entry in ("Trading For", "Make an Offer"):
                trade_idx = i
                break
        mid_lines = clean_prefix[item_idx + 1:trade_idx] if (item_idx != -1 and trade_idx != -1) else []
        mid_text = " ".join(mid_lines)

        is_pc = (
            any("pc" in entry.lower().split("•") or entry.strip().lower() == "pc" for entry in mid_lines)
            or "pc" in mid_text.lower()
        )
        is_ps = "playstation" in mid_text.lower()
        is_xbox = "xbox" in mid_text.lower()
        is_switch = "switch" in mid_text.lower()
        if is_pc:
            platform = "PC"
        elif is_ps:
            platform = "Playstation"
        elif is_xbox:
            platform = "Xbox"
        elif is_switch:
            platform = "Switch"
        else:
            platform = None

        is_hardcore = "hardcore" in mid_text.lower()
        is_softcore = "softcore" in mid_text.lower()
        mode = "Hardcore" if is_hardcore else ("Softcore" if is_softcore else None)

        is_non_ladder = "non ladder" in mid_text.lower()
        is_ladder = "ladder" in mid_text.lower() and not is_non_ladder
        ladder = "Non Ladder" if is_non_ladder else ("Ladder" if is_ladder else None)

        is_rotw = "reign of the warlock" in mid_text.lower()
        is_lod = "lord of destruction" in mid_text.lower()
        game_version = "Reign of the Warlock" if is_rotw else ("Lord of Destruction" if is_lod else None)

        is_ethereal = "ethereal" in mid_text.lower()
        is_unidentified = "unidentified" in mid_text.lower()

        def_m = re.search(r"(\+?\d+)\s*Defense", mid_text, re.I)
        defense = int(def_m.group(1).lstrip("+")) if def_m else None

        stats_list = []
        if defense is not None:
            stats_list.append(f"{defense} Defense")
        for entry in mid_lines:
            if any(
                term in entry.lower()
                for term in [
                    "better chance",
                    "all skills",
                    "to life",
                    "to mana",
                    "damage reduced",
                    "required level",
                ]
            ):
                stats_list.append(entry)

        ask_lines = clean_prefix[trade_idx:-1] if trade_idx != -1 else []
        hrv = None
        cleaned_ask_lines = []
        for entry in ask_lines:
            if entry.startswith("High Rune Value:"):
                hrv = entry
            elif entry != "Trading For":
                cleaned_ask_lines.append(entry)
        ask = " ".join(cleaned_ask_lines).strip()
        if not ask:
            ask = "Make an Offer" if "Make an Offer" in card else "Unknown"

        listings.append(
            ListingCard(
                listing_id=None,
                seller=seller,
                rating=rating,
                posted_time=posted_time,
                item_name=item_line,
                platform=platform,
                mode=mode,
                ladder=ladder,
                game_version=game_version,
                is_ethereal=is_ethereal,
                is_unidentified=is_unidentified,
                defense=defense,
                stats=stats_list,
                ask=ask,
                high_rune_value=hrv,
                raw_text=" ".join(card),
            )
        )

    return listings


def parse_recent_trades(
    text_content: str,
    observe_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse Recent Trades view. Detects whether blocked by sign-in prompt or guard."""
    text = (text_content or "") + " " + (observe_json.get("text", "") if observe_json else "")
    url = (observe_json.get("url") if observe_json else "") or f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent"

    if SIGN_IN_PROMPT.lower() in text.lower() or "please sign in" in text.lower():
        return {
            "mode": "B",
            "blocked": True,
            "reason": "需要登入 (Please sign in to view offers)",
            "trades": [],
            "direct_url": url,
            "notice": "Traderie 成交紀錄頁面需要登入帳號方可查看。",
        }

    trades: list[TradeRecord] = []
    lines = [entry.strip() for entry in text.splitlines() if entry.strip()]
    env_tags = {
        "pc", "softcore", "hardcore", "ladder", "non ladder", "xbox", "playstation",
        "nintendo switch", "reign of the warlock", "resurrected",
    }

    def clean_tag(line: str) -> str | None:
        content = line.rstrip("•").strip()
        if not content or content.lower() in env_tags or content == "Additional Item(s)":
            return None
        return content

    trade_time_re = re.compile(
        r"^(?:\d+\s*(?:秒|分鐘|小時|天|週|週|個月|年)前|[a-z ]*\d+ ?(?:second|minute|hour|day|week|month|year)s? ago|"
        + ABSOLUTE_DATE
        + ")$",
        re.IGNORECASE,
    )
    i = 0
    while i < len(lines):
        if lines[i].lower() == "they give":
            stage = "gave"
            gave: list[str] = []
            received: list[str] = []
            trade_time = ""
            j = i + 1
            while j < len(lines) and lines[j].lower() not in ("they give",):
                line = lines[j]
                low = line.lower()
                if low == "i give":
                    stage = "received"
                elif trade_time_re.match(line):
                    trade_time = line
                    break
                elif low.startswith("high rune value"):
                    pass
                elif stage == "gave":
                    cleaned = clean_tag(line)
                    if cleaned:
                        gave.append(cleaned)
                else:
                    cleaned = clean_tag(line)
                    if cleaned:
                        received.append(cleaned)
                j += 1
            if trade_time and (gave or received):
                item = ", ".join(gave) if gave else "Unknown"
                parts: list[str] = []
                for entry in received:
                    if entry == "OR":
                        if parts:
                            parts[-1] += " OR "
                        continue
                    if parts and parts[-1].endswith(" OR "):
                        parts[-1] += entry
                    else:
                        parts.append(entry)
                price = ", ".join(parts) if parts else "Unknown"
                trades.append(TradeRecord(
                    buyer_or_seller=item,
                    price=price,
                    trade_time=trade_time,
                ))
                i = j + 1
                continue
            i += 1
            continue
        i += 1

    if not trades:
        for i, line in enumerate(lines):
            if any(marker.lower() == line.lower() for marker in ("Sold For", "Traded For", "Closed For")):
                price = lines[i + 1] if i + 1 < len(lines) else ""
                trade_time = lines[i + 2] if i + 2 < len(lines) else ""
                buyer_or_seller = lines[i - 1] if i > 0 else "Unknown"
                trades.append(TradeRecord(
                    buyer_or_seller=buyer_or_seller,
                    price=price,
                    trade_time=trade_time,
                ))

    if not trades:
        if "sign in" in text.lower() or "login" in text.lower():
            return {
                "mode": "B",
                "blocked": True,
                "reason": "未偵測到成交數據或需要登入",
                "trades": [],
                "direct_url": url,
            }

    return {
        "mode": "A" if trades else "B",
        "blocked": False if trades else True,
        "reason": None if trades else "無成交紀錄",
        "trades": [t.to_dict() for t in trades],
        "direct_url": url,
    }
