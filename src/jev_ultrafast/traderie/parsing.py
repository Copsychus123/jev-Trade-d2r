"""Data parsing for Traderie listing rows, innerText cards, and trade records."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

from jev_ultrafast.traderie.site import TRADERIE_D2R_URL, TRADING_MARKERS

SIGN_IN_PROMPT = "Please sign in to view offers"

# The trade vocabulary: a finished trade's block starts at TRADE_START, and a view without blocks shows the trade as
# one of TRADE_DONE_MARKERS. The trade parsers here and the controller's line-counting cross-check read it from this
# one place; TRADE_MARKERS is every line that marks a trade (the probe's vocabulary).
TRADE_START = "They Give"
TRADE_DONE_MARKERS = ("Sold For", "Traded For", "Closed For")
TRADE_MARKERS = (TRADE_START, *TRADE_DONE_MARKERS)

LISTING_NOISE_LINES = {
    "join akrew pro for an ad free experience!",
    "pro",
    "marketplace",
    "community",
    "add listing",
    "log in",
    "sign up",
}

# Environment/quality words that are not affixes on a listing card (mirrors the JS logic). Built once: every card
# is parsed against the same set.
CARD_ENV_TAGS = {
    "pc", "softcore", "hardcore", "ladder", "non ladder", "playstation", "xbox",
    "nintendo switch", "reign of the warlock", "resurrected", "lord of destruction", "classic (base game)",
    "rare", "classic", "penta", "magic", "monarch", "sun", "dot", "orange",
}
# Card lines that are item stats, not environment tags.
STAT_TERMS = ("better chance", "all skills", "to life", "to mana", "damage reduced", "required level")

# Environment words skipped on the Recent Trades side (a narrower list than CARD_ENV_TAGS: a trade's item name may
# itself be a quality word such as "Monarch").
RECENT_ENV_TAGS = {
    "pc", "softcore", "hardcore", "ladder", "non ladder", "xbox", "playstation",
    "nintendo switch", "reign of the warlock", "lord of destruction", "classic (base game)", "resurrected",
}

# Older entries show a date instead of "N days ago". The Chinese form is what Traderie shows to a Chinese browser;
# the others are the usual numeric and English forms.
ABSOLUTE_DATE = (
    r"\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}/\d{1,2}/\d{4}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}"
)

# The tail both time patterns share: "just now", its Chinese form, then an absolute date.
TIME_TAIL = r"just now|剛剛|" + ABSOLUTE_DATE

TIME_REGEX = re.compile(
    r"^(?:[a-z ]*(?:\d+|a|an)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"s|m|h|d|秒|分鐘|小时|小時|天|週|周|個月|月|年)s?\s*(?:ago|前)|"
    + TIME_TAIL
    + ")$",
    re.I,
)

# The Recent Trades view writes relative times in a slightly different shape than a card does, so it needs its own
# pattern (kept beside TIME_REGEX and compiled once).
TRADE_TIME_REGEX = re.compile(
    r"^(?:\d+\s*(?:秒|分鐘|小时|小時|天|週|周|個月|月|年)前|"
    r"(?:[a-z ]*)?(?:\d+|a|an) ?(?:second|minute|hour|day|week|month|year|s|m|h|d)s? ago|"
    + TIME_TAIL
    + ")$",
    re.IGNORECASE,
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
    affixes: list[str]
    ask: str
    high_rune_value: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TradeRecord:
    # The item line of a "They Give" block. The marker fallback below puts the line above its marker here instead,
    # and nothing in this repo samples that page shape - so the name describes the main path and the ambiguity stays.
    buyer_or_seller: str | None
    price: str
    trade_time: str
    item_name: str | None = None
    specs: dict[str, Any] | None = None
    platform: str | None = None
    mode: str | None = None
    ladder: str | None = None
    game_version: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _env_labels(low: str) -> tuple[str | None, str | None, str | None]:
    """The mode, ladder and game version words found in `low` (lower-cased text)."""
    mode = "Hardcore" if "hardcore" in low else "Softcore" if "softcore" in low else None
    ladder = "Non Ladder" if "non ladder" in low else "Ladder" if "ladder" in low else None
    game_version = (
        "Classic (Base Game)" if "classic (base game)" in low
        else "Reign of the Warlock" if "reign of the warlock" in low
        else "Lord of Destruction" if "lord of destruction" in low
        else None
    )
    return mode, ladder, game_version


def _card_platform(mid_lower: str) -> str | None:
    """The platform of a card: the first of PC, Playstation, Xbox, Switch mentioned in its middle lines.
    Recent Trades reads a different rule (see `_trade_block`), so the two do not share this helper."""
    for needle, label in (("pc", "PC"), ("playstation", "Playstation"), ("xbox", "Xbox"), ("switch", "Switch")):
        if needle in mid_lower:
            return label
    return None


def _item_line(clean_prefix: list[str], item_name: str | None) -> tuple[str | None, int]:
    """The card line naming the item and its index in `clean_prefix` (the given name and -1 when not found)."""
    item_line = item_name
    item_idx = -1
    if item_name is not None:
        name_lower = item_name.lower()
        for i, entry in enumerate(clean_prefix):
            if name_lower in entry.lower():
                item_line = entry
                item_idx = i
                break
    else:
        # Home page (no known item name): find item by "N X Name" pattern
        for i, entry in enumerate(clean_prefix):
            item_match = re.match(r"^(\d+)\s*[xX]\s+(.+)$", entry)
            if item_match:
                item_line = item_match.group(2)
                item_idx = i
                break
    return item_line, item_idx


def _home_seller(clean_prefix: list[str], item_idx: int) -> tuple[str | None, str | None]:
    """The seller and rating of a home-page card, scanned backwards from the item line."""
    seller = None
    rating = None
    for i in range(item_idx - 1, -1, -1):
        entry = clean_prefix[i]
        if entry.startswith("(") and entry.endswith(")"):
            rating = entry
            seller = clean_prefix[i - 1] if i > 0 else None
            break
    return seller, rating


def _card_stats(mid_lines: list[str], defense: int | None) -> list[str]:
    """The stat lines of a card: its defense line when it has one, then the middle lines that are item stats."""
    stats_list = [f"{defense} Defense"] if defense is not None else []
    for entry in mid_lines:
        low = entry.lower()
        if any(term in low for term in STAT_TERMS):
            stats_list.append(entry)
    return stats_list


def _ask_fields(clean_prefix: list[str], trade_idx: int, card: list[str]) -> tuple[str, str | None]:
    """What a listing asks for (its text and its High Rune Value line, when it has one)."""
    ask_lines = clean_prefix[trade_idx:-1] if trade_idx != -1 else []
    high_rune_value = None
    cleaned_ask_lines = []
    for entry in ask_lines:
        if entry.startswith("High Rune Value:"):
            high_rune_value = entry
        elif entry != "Trading For":
            cleaned_ask_lines.append(entry)
    ask = " ".join(cleaned_ask_lines).strip()
    if not ask:
        ask = "Make an Offer" if "Make an Offer" in card else "Unknown"
    return ask, high_rune_value


def _tag_text(line: str) -> str:
    """A tag line with its trailing bullet glyphs and surrounding whitespace removed."""
    return line.rstrip("•").strip()


def _card_affixes(mid_lines: list[str]) -> list[str]:
    """affixes: mid_lines excluding env/tag/quality words (mirrors the JS logic)"""
    affixes_list: list[str] = []
    for entry in mid_lines:
        cleaned = _tag_text(entry)
        if cleaned and cleaned.lower() not in CARD_ENV_TAGS:
            affixes_list.append(cleaned)
    return affixes_list


def _trade_idx(clean_prefix: list[str]) -> int:
    """The index of the card line ("Trading For" or "Make an Offer") that ends its item section; -1 when absent."""
    for i, entry in enumerate(clean_prefix):
        if entry in TRADING_MARKERS:
            return i
    return -1


def _card_seller_rating(
    clean_prefix: list[str], item_name: str | None, item_idx: int
) -> tuple[str | None, str | None] | None:
    """The seller and rating of a card, or None when a home-page row has neither (so it is not a listing).

    A card with a known `item_name` names its seller and rating on its first two lines. The home page has no known
    name, so both are scanned backwards from the item line instead; a home row without either is not a listing."""
    if item_name is None and item_idx != -1:
        seller, rating = _home_seller(clean_prefix, item_idx)
        if seller is None or rating is None:
            return None
        return seller, rating
    seller = clean_prefix[0]
    rating = None
    if len(clean_prefix) > 1 and clean_prefix[1].startswith("(") and clean_prefix[1].endswith(")"):
        rating = clean_prefix[1]
    return seller, rating


def _card_data(card: list[str], item_name: str) -> dict | None:
    """Parse one card's raw lines into ListingCard keyword fields, or None when this card is not a listing."""
    clean_prefix = [entry for entry in card if entry.lower() not in LISTING_NOISE_LINES]
    if not clean_prefix:
        return None

    posted_time = card[-1]

    item_line, item_idx = _item_line(clean_prefix, item_name)

    seller_rating = _card_seller_rating(clean_prefix, item_name, item_idx)
    if seller_rating is None:
        return None
    seller, rating = seller_rating

    trade_idx = _trade_idx(clean_prefix)
    mid_lines = clean_prefix[item_idx + 1:trade_idx] if (item_idx != -1 and trade_idx != -1) else []
    mid_text = " ".join(mid_lines)
    mid_lower = mid_text.lower()

    platform = _card_platform(mid_lower)
    mode, ladder, game_version = _env_labels(mid_lower)

    is_ethereal = "ethereal" in mid_lower
    is_unidentified = "unidentified" in mid_lower

    defense_match = re.search(r"(\+?\d+)\s*Defense", mid_text, re.I)
    defense = int(defense_match.group(1).lstrip("+")) if defense_match else None

    stats_list = _card_stats(mid_lines, defense)
    ask, high_rune_value = _ask_fields(clean_prefix, trade_idx, card)
    affixes_list = _card_affixes(mid_lines)

    return {
        "listing_id": None,
        "seller": seller,
        "rating": rating,
        "posted_time": posted_time,
        "item_name": item_line,
        "platform": platform,
        "mode": mode,
        "ladder": ladder,
        "game_version": game_version,
        "is_ethereal": is_ethereal,
        "is_unidentified": is_unidentified,
        "defense": defense,
        "stats": stats_list,
        "affixes": affixes_list,
        "ask": ask,
        "high_rune_value": high_rune_value,
    }


def _text_lines(text: str) -> list[str]:
    """The non-empty, whitespace-trimmed lines of a page's text."""
    return [line.strip() for line in text.splitlines() if line.strip()]


def _listing_bounds(lines: list[str]) -> tuple[int, int]:
    """The half-open range of `lines` holding the listings: after the search banner, before the load-more prompt."""
    start = 0
    for i, line in enumerate(lines):
        if "Apply this search for all" in line:
            start = i + 1

    end = len(lines)
    for i in range(start, len(lines)):
        # The footer's own line is exactly "HELP" (measured on a product page: one line, between "Load More" and
        # "Getting Started"). An exact match, because a seller name may start with those four letters, and cutting the
        # list there made the rows disagree with the page's markers.
        if "Log in to Load More" in lines[i] or lines[i] == "HELP":
            end = i
            break

    return start, end


def _split_cards(listing_lines: list[str]) -> list[list[str]]:
    """Group the listing area's lines into cards: each card ends at its own time line."""
    cards_raw: list[list[str]] = []
    current: list[str] = []

    for line in listing_lines:
        current.append(line)
        if TIME_REGEX.match(line):
            cards_raw.append(current)
            current = []

    return cards_raw


def parse_trading_txt(text_content: str, *, item_name: str = "Harlequin Crest") -> list[ListingCard]:
    """Parse listing cards from Traderie trading page innerText."""
    if not text_content:
        return []

    lines = [line.replace("\xa0", " ") for line in _text_lines(text_content)]

    start, end = _listing_bounds(lines)
    cards_raw = _split_cards(lines[start:end])

    listings: list[ListingCard] = []

    for card in cards_raw:
        data = _card_data(card, item_name)
        if data is not None:
            listings.append(ListingCard(**data))

    return listings


def _answer_token(line: str) -> str | None:
    """One wanted-tag line, cleaned; None for the environment words and the "Additional Item(s)" filler."""
    content = _tag_text(line)
    if not content or content.lower() in RECENT_ENV_TAGS or content == "Additional Item(s)":
        return None
    return content


def _or_price(received: list[str]) -> str:
    """The wanted tags joined into one price; an "OR" line joins the tags on either side of it."""
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
    return ", ".join(parts) if parts else "Unknown"


def _trade_env(gave_raw: list[str]) -> tuple[str | None, str | None, str | None, str | None]:
    """Platform, mode, ladder and game version read from a trade's raw "They Give" lines. Recent Trades reads
    platform as a whole token (PC) and then Switch, Playstation, Xbox: its own rule, not a card's."""
    platform = None
    for entry in gave_raw:
        low = entry.lower()
        tokens = [t.strip() for t in low.split("•")]
        if any(t == "pc" for t in tokens):
            platform = "PC"
            break
        if "nintendo switch" in low:
            platform = "Switch"
            break
        if "playstation" in low:
            platform = "Playstation"
            break
        if "xbox" in low:
            platform = "Xbox"
            break
    mode = ladder = game_version = None
    for entry in gave_raw:
        found_mode, found_ladder, found_version = _env_labels(entry.lower())
        if found_mode:
            mode = found_mode
        if found_ladder:
            ladder = found_ladder
        if found_version:
            game_version = found_version
    return platform, mode, ladder, game_version


def _trade_block(lines: list[str], start: int) -> tuple[TradeRecord | None, int]:
    """Read the "They Give" block that starts at `start` (the index of its "They Give" line). Returns its trade
    record, or None when the block is not a finished trade, and the line index the scan continues from."""
    stage = "gave"
    gave: list[str] = []
    gave_raw: list[str] = []
    received: list[str] = []
    trade_time = ""
    j = start + 1
    while j < len(lines) and lines[j].lower() != TRADE_START.lower():
        line = lines[j]
        low = line.lower()
        if low == "i give":
            stage = "received"
        elif TRADE_TIME_REGEX.match(line):
            trade_time = line
            break
        elif low.startswith("high rune value"):
            pass
        elif stage == "gave":
            gave_raw.append(line)
            cleaned = _answer_token(line)
            if cleaned:
                gave.append(cleaned)
        else:
            cleaned = _answer_token(line)
            if cleaned:
                received.append(cleaned)
        j += 1
    if not trade_time or not (gave or received):
        return None, start + 1
    platform, mode, ladder, game_version = _trade_env(gave_raw)

    item = ", ".join(gave) if gave else "Unknown"
    return TradeRecord(
        buyer_or_seller=item,
        price=_or_price(received),
        trade_time=trade_time,
        platform=platform,
        mode=mode,
        ladder=ladder,
        game_version=game_version,
    ), j + 1


def _marker_trades(lines: list[str]) -> list[TradeRecord]:
    """Fallback for a view without "They Give" blocks: one record per "Sold For"/"Traded For"/"Closed For" line."""
    trades: list[TradeRecord] = []
    for i, line in enumerate(lines):
        if any(marker.lower() == line.lower() for marker in TRADE_DONE_MARKERS):
            price = lines[i + 1] if i + 1 < len(lines) else ""
            trade_time = lines[i + 2] if i + 2 < len(lines) else ""
            # What the page prints above the marker; no sample in this repo pins down what that is (this path has no
            # fixture and no test), so it is recorded as it stands rather than given a name it might not deserve.
            buyer_or_seller = lines[i - 1] if i > 0 else "Unknown"
            trades.append(TradeRecord(
                buyer_or_seller=buyer_or_seller,
                price=price,
                trade_time=trade_time,
            ))
    return trades


def _they_give_trades(lines: list[str]) -> list[TradeRecord]:
    """Every finished trade in `lines`, read from its "They Give" block."""
    trades: list[TradeRecord] = []
    i = 0
    while i < len(lines):
        if lines[i].lower() == TRADE_START.lower():
            record, i = _trade_block(lines, i)
            if record:
                trades.append(record)
            continue
        i += 1
    return trades


def parse_recent_trades(text_content: str) -> dict[str, Any]:
    """Parse Recent Trades view. Detects whether blocked by sign-in prompt or guard."""
    text = text_content or ""
    low = text.lower()
    url = f"{TRADERIE_D2R_URL}/product/harlequin-crest/recent"

    if SIGN_IN_PROMPT.lower() in low or "please sign in" in low:
        return {
            "code": "login_required",
            "mode": "B",
            "blocked": True,
            "reason": "需要登入 (Please sign in to view offers)",
            "trades": [],
            "direct_url": url,
            "notice": "Traderie 成交紀錄頁面需要登入帳號方可查看。",
        }

    lines = _text_lines(text)

    trades = _they_give_trades(lines)

    if not trades:
        trades = _marker_trades(lines)

    if not trades:
        if "sign in" in low or "login" in low:
            return {
                "code": "login_required",
                "mode": "B",
                "blocked": True,
                "reason": "未偵測到成交數據或需要登入",
                "trades": [],
                "direct_url": url,
            }

    return {
        "code": None,
        "mode": "A" if trades else "B",
        "blocked": False if trades else True,
        "reason": None if trades else "無成交紀錄",
        "trades": [t.to_dict() for t in trades],
        "direct_url": url,
    }
