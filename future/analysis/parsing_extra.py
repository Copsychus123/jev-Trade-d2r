"""Parsing helpers moved out of jev_ultrafast/traderie/parsing.py (not used by the current flow).

Needs ListingCard, TIME_REGEX and the noise constants from jev_ultrafast.traderie.parsing when revived.
"""

from __future__ import annotations

import re

from jev_ultrafast.traderie.parsing import LISTING_NOISE_LINES, TIME_REGEX, ListingCard
from jev_ultrafast.traderie.site import TRADERIE_D2R_URL


def parse_relative_time_to_hours(time_str: str) -> float | None:
    """Parse relative time string to approximate hours; None if unparseable."""
    if not time_str:
        return None
    s = time_str.strip()
    m = TIME_REGEX.match(s)
    if not m:
        if "just now" in s.lower() or "剛剛" in s:
            return 0.0
        return None

    val = float(m.group(1))
    unit = m.group(2).lower()
    if unit in ("s", "sec", "second", "seconds", "秒"):
        return val / 3600.0
    if unit in ("m", "min", "minute", "minutes", "分鐘"):
        return val / 60.0
    if unit in ("h", "hr", "hour", "hours", "小时", "小時"):
        return val
    if unit in ("d", "day", "days", "天"):
        return val * 24.0
    if unit in ("week", "weeks"):
        return val * 24.0 * 7.0
    if unit in ("month", "months"):
        return val * 24.0 * 30.0
    if unit in ("year", "years"):
        return val * 24.0 * 365.0
    return None


def is_within_time_window(time_str: str, max_hours: float = 72.0) -> bool:
    """Check if relative time falls within max_hours."""
    hours = parse_relative_time_to_hours(time_str)
    if hours is None:
        return True
    return hours <= max_hours


def parse_trading_html(html_content: str, *, item_name: str = "Harlequin Crest") -> list[ListingCard]:
    """Parse listing cards from Traderie trading page HTML."""
    if not html_content:
        return []
    fallback_name = item_name

    parts = html_content.split('class="col-xs-12 col-sm-6 col-md-6 fade listing-row"')
    listings: list[ListingCard] = []

    for p in parts[1:]:
        id_m = re.search(r'href="/diablo2resurrected/listing/([^"]+)"', p)
        listing_id = id_m.group(1).strip() if id_m else None

        seller_m = re.search(r"text-overflow:\s*ellipsis[^>]*>([^<]+)</div>", p)
        seller = seller_m.group(1).strip() if seller_m else "Unknown"

        rating_m = re.search(r"mb-1\">(?:&nbsp;)?\(([^)]+)\)</div>", p)
        rating = f"({rating_m.group(1).strip()})" if rating_m else None

        time_m = re.search(r'class="listing-date-compact-slider">([^<]+)</span>', p)
        if not time_m:
            time_m = re.search(
                r"(\d+\s*(?:second|minute|hour|day|week|month|year|s|m|h|d|秒|分鐘|小時|小时|天)s?\s*(?:ago|前))",
                p,
                re.I,
            )
        posted_time = time_m.group(1).strip() if time_m else ""

        item_m = re.search(r'class="[^"]*selling-listing[^"]*"[^>]*>(.*?)</a>', p, re.DOTALL)
        item_raw = re.sub(r"<[^>]+>", " ", item_m.group(1)) if item_m else ""
        item_clean = " ".join(item_raw.split())
        item_name_m = re.search(
            r"(?:\d+\s*x\s+)?([A-Za-z0-9'\s]+?)(?=\s*reign|\s*lord|\s*\&nbsp;|\s*•|$)",
            item_clean,
            re.I,
        )
        parsed_name = item_name_m.group(1).strip() if item_name_m and item_name_m.group(1).strip() else fallback_name

        text_clean = " ".join(re.sub(r"<[^>]+>", " ", p).split())
        tags = re.findall(r'<span class="align-middle"[^>]*>([^<]+)</span>', p)
        tags_lower = [t.lower() for t in tags]

        is_pc = "pc" in tags_lower or bool(re.search(r"\bPC\b", text_clean, re.I))
        is_ps = any("playstation" in t for t in tags_lower) or "playstation" in text_clean.lower()
        is_xbox = any("xbox" in t for t in tags_lower) or "xbox" in text_clean.lower()
        is_switch = any("switch" in t for t in tags_lower) or "switch" in text_clean.lower()

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

        is_hardcore = "hardcore" in tags_lower or bool(re.search(r"\bhardcore\b", text_clean, re.I))
        is_softcore = "softcore" in tags_lower or bool(re.search(r"\bsoftcore\b", text_clean, re.I))
        mode = "Hardcore" if is_hardcore else ("Softcore" if is_softcore else None)

        is_non_ladder = "non ladder" in tags_lower or bool(re.search(r"\bnon[\s-]*ladder\b", text_clean, re.I))
        is_ladder = ("ladder" in tags_lower or bool(re.search(r"\bladder\b", text_clean, re.I))) and not is_non_ladder
        ladder = "Non Ladder" if is_non_ladder else ("Ladder" if is_ladder else None)

        is_rotw = any("reign of the warlock" in t for t in tags_lower) or bool(
            re.search(r"reign\s+of\s+the\s+warlock", text_clean, re.I)
        )
        is_lod = any("lord of destruction" in t for t in tags_lower) or bool(
            re.search(r"lord\s+of\s+destruction", text_clean, re.I)
        )
        game_version = "Reign of the Warlock" if is_rotw else ("Lord of Destruction" if is_lod else None)

        is_ethereal = "ethereal" in tags_lower or bool(re.search(r"\bethereal\b", text_clean, re.I))
        is_unidentified = "unidentified" in tags_lower or bool(re.search(r"\bunidentified\b", text_clean, re.I))

        props_m = re.search(r'class="listing-num-properties">(.*?)</div>', p, re.DOTALL)
        props_clean = " ".join(re.sub(r"<[^>]+>", " ", props_m.group(1)).split()) if props_m else ""

        def_m = re.search(r"(\d+)\s*Defense", props_clean or text_clean)
        defense = int(def_m.group(1)) if def_m else None

        env_tag_set = {
            "reign of the warlock", "lord of destruction", "softcore", "hardcore", "pc",
            "playstation", "xbox", "switch", "ladder", "non ladder", "ethereal", "unidentified",
        }
        extra_tags = [t for t in tags if t.lower() not in env_tag_set]

        stats_list: list[str] = []
        if defense is not None:
            stats_list.append(f"{defense} Defense")
        if extra_tags:
            stats_list.extend(extra_tags)
        if props_clean:
            stat_matches = re.findall(
                r"(\+\s*\d+[^0-9]+|\d+\s*%\s*[^0-9]+|Damage Reduced by\s*\d+|Required Level\s*\d+)",
                props_clean,
                re.I,
            )
            for prop in stat_matches:
                prop_str = " ".join(prop.split())
                if "defense" not in prop_str.lower() and prop_str not in stats_list:
                    stats_list.append(prop_str)

        if "Make an Offer" in p:
            ask = "Make an Offer"
        elif "Trading For" in p:
            tf_idx = p.find("Trading For")
            end_tf = p.find("listing-value", tf_idx)
            if end_tf == -1:
                end_tf = p.find("listing-date", tf_idx)
            block = p[tf_idx:end_tf]
            block = re.sub(r"&\s*nbsp;\s*OR", " __OR__ ", block, flags=re.I)
            block = re.sub(r">\s*OR\s*<", "> __OR__ <", block, flags=re.I)
            clean_b = " ".join(re.sub(r"<[^>]+>", " ", block).replace("&nbsp;", " ").split())
            if clean_b.startswith("Trading For"):
                clean_b = clean_b[len("Trading For"):].strip()
            if "<div" in clean_b:
                clean_b = clean_b[:clean_b.find("<div")].strip()
            clean_b = clean_b.replace("__OR__", "OR")
            ask = " ".join(clean_b.split())
        else:
            ask = "Unknown"

        hrv_m = re.search(r'class="listing-value"><span>([^<]+)</span>', p)
        high_rune_value = hrv_m.group(1).strip() if hrv_m else None

        listings.append(
            ListingCard(
                listing_id=listing_id,
                seller=seller,
                rating=rating,
                posted_time=posted_time,
                item_name=parsed_name,
                platform=platform,
                mode=mode,
                ladder=ladder,
                game_version=game_version,
                is_ethereal=is_ethereal,
                is_unidentified=is_unidentified,
                defense=defense,
                stats=stats_list,
                ask=ask,
                high_rune_value=high_rune_value,
                raw_text=text_clean,
            )
        )

    return listings
