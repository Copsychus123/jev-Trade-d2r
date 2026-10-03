"""Unit tests for Traderie data parsing and market analysis module."""


from jev_ultrafast.traderie import (
    ListingCard,
    analyze_market_data,
    build_market_report,
    filter_listings,
    generate_markdown_report,
    is_within_time_window,
    parse_recent_trades,
    parse_relative_time_to_hours,
    parse_trading_html,
    parse_trading_txt,
)


def test_parse_relative_time_to_hours():
    assert parse_relative_time_to_hours("10 seconds ago") == 10 / 3600.0
    assert parse_relative_time_to_hours("30 秒前") == 30 / 3600.0
    assert parse_relative_time_to_hours("5 分鐘前") == 5 / 60.0
    assert parse_relative_time_to_hours("15 minutes ago") == 15 / 60.0
    assert parse_relative_time_to_hours("2 hours ago") == 2.0
    assert parse_relative_time_to_hours("3 小時前") == 3.0
    assert parse_relative_time_to_hours("1 day ago") == 24.0
    assert parse_relative_time_to_hours("3 days ago") == 72.0
    assert parse_relative_time_to_hours("4 days ago") == 96.0
    assert parse_relative_time_to_hours("1 week ago") == 168.0
    assert parse_relative_time_to_hours("just now") == 0.0
    assert parse_relative_time_to_hours("剛剛") == 0.0


def test_filter_listings_time_window_72h():
    card_recent = ListingCard(
        listing_id="1",
        seller="seller1",
        rating="(100)",
        posted_time="2 hours ago",
        item_name="Harlequin Crest",
        platform="PC",
        mode="Softcore",
        ladder="Ladder",
        game_version="Reign of the Warlock",
        is_ethereal=False,
        is_unidentified=False,
        defense=120,
        stats=["120 Defense"],
        ask="1 X Ist Rune",
        high_rune_value="0.16",
    )
    card_old = ListingCard(
        listing_id="2",
        seller="seller2",
        rating="(50)",
        posted_time="4 days ago",
        item_name="Harlequin Crest",
        platform="PC",
        mode="Softcore",
        ladder="Ladder",
        game_version="Reign of the Warlock",
        is_ethereal=False,
        is_unidentified=False,
        defense=120,
        stats=["120 Defense"],
        ask="1 X Mal Rune",
        high_rune_value="0.1",
    )
    assert is_within_time_window("2 hours ago", max_hours=72.0) is True
    assert is_within_time_window("4 days ago", max_hours=72.0) is False

    valid, excluded = filter_listings([card_recent, card_old], max_hours=72.0)
    assert len(valid) == 1
    assert valid[0].seller == "seller1"
    assert len(excluded) == 1
    assert excluded[0]["listing"]["seller"] == "seller2"
    assert any("72" in r for r in excluded[0]["reasons"])


def test_filter_listings_environment_exclusions():
    base_card = {
        "listing_id": "test",
        "seller": "test_user",
        "rating": "(10)",
        "posted_time": "1 hour ago",
        "item_name": "Harlequin Crest",
        "platform": "PC",
        "mode": "Softcore",
        "ladder": "Ladder",
        "game_version": "Reign of the Warlock",
        "is_ethereal": False,
        "is_unidentified": False,
        "defense": 130,
        "stats": ["130 Defense"],
        "ask": "1 X Ist Rune",
        "high_rune_value": "0.16",
    }

    c_valid = ListingCard(**base_card)
    c_non_ladder = ListingCard(**{**base_card, "seller": "nl_user", "ladder": "Non Ladder"})
    c_hardcore = ListingCard(**{**base_card, "seller": "hc_user", "mode": "Hardcore"})
    c_playstation = ListingCard(**{**base_card, "seller": "ps_user", "platform": "Playstation"})
    c_lod = ListingCard(**{**base_card, "seller": "lod_user", "game_version": "Lord of Destruction"})

    cards = [c_valid, c_non_ladder, c_hardcore, c_playstation, c_lod]
    valid, excluded = filter_listings(cards)

    assert len(valid) == 1
    assert valid[0].seller == "test_user"

    excluded_sellers = {e["listing"]["seller"]: e["reasons"] for e in excluded}
    assert "nl_user" in excluded_sellers
    assert any("Non Ladder" in r for r in excluded_sellers["nl_user"])
    assert "hc_user" in excluded_sellers
    assert any("Hardcore" in r for r in excluded_sellers["hc_user"])
    assert "ps_user" in excluded_sellers
    assert any("Playstation" in r for r in excluded_sellers["ps_user"])
    assert "lod_user" in excluded_sellers
    assert any("Lord of Destruction" in r for r in excluded_sellers["lod_user"])


def test_parse_recent_trades_mode_b_sign_in_detection():
    # When sign in prompt is present
    text = "Recent Trades\nPlease sign in to view offers\nSign in with Discord"
    result = parse_recent_trades(text)
    assert result["mode"] == "B"
    assert result["blocked"] is True
    assert "Please sign in" in result["reason"] or "登入" in result["reason"]
    assert "product/harlequin-crest/recent" in result["direct_url"]

    # When observe json has sign in prompt
    observe_json = {
        "url": "https://www.traderie.com/diablo2resurrected/product/harlequin-crest/recent",
        "text": "Please sign in to view offers",
    }
    result_observe = parse_recent_trades("", observe_json)
    assert result_observe["mode"] == "B"
    assert result_observe["blocked"] is True


def test_parse_recent_trades_mode_a_with_actual_trades():
    text = (
        "Buyer1\n"
        "Sold For\n"
        "2 X Ber Rune\n"
        "10 minutes ago\n"
    )
    result = parse_recent_trades(text)
    assert result["mode"] == "A"
    assert result["blocked"] is False
    assert len(result["trades"]) >= 1
    assert result["trades"][0]["buyer_or_seller"] == "Buyer1"
    assert result["trades"][0]["price"] == "2 X Ber Rune"
    assert result["trades"][0]["trade_time"] == "10 minutes ago"

TRADING_HTML_SAMPLE = """
<div class="col-xs-12 col-sm-6 col-md-6 fade listing-row">
  <a href="/diablo2resurrected/listing/listing-1"></a>
  <div style="text-overflow: ellipsis">SellerOne</div>
  <div class="mb-1">(100)</div>
  <span class="listing-date-compact-slider">2 hours ago</span>
  <a class="selling-listing">1 X Harlequin Crest</a>
  <span class="align-middle">PC</span>
  <span class="align-middle">Softcore</span>
  <span class="align-middle">Ladder</span>
  <span class="align-middle">Reign of the Warlock</span>
  <div class="listing-num-properties">120 Defense</div>
  Trading For
  <div>1 X Ist Rune</div>
  <div class="listing-value"><span>0.16</span></div>
</div>
<div class="col-xs-12 col-sm-6 col-md-6 fade listing-row">
  <a href="/diablo2resurrected/listing/listing-2"></a>
  <div style="text-overflow: ellipsis">SellerTwo</div>
  <div class="mb-1">(40)</div>
  <span class="listing-date-compact-slider">4 days ago</span>
  <a class="selling-listing">1 X Harlequin Crest</a>
  <span class="align-middle">PC</span>
  <span class="align-middle">Hardcore</span>
  <span class="align-middle">Ladder</span>
  <span class="align-middle">Reign of the Warlock</span>
  <div class="listing-num-properties">110 Defense</div>
  Trading For
  <div>1 X Mal Rune</div>
  <div class="listing-value"><span>0.10</span></div>
</div>
"""

TRADING_HTML_SINGLE_SAMPLE = """
<div class="col-xs-12 col-sm-6 col-md-6 fade listing-row">
  <a href="/diablo2resurrected/listing/listing-1"></a>
  <div style="text-overflow: ellipsis">SellerOne</div>
  <div class="mb-1">(100)</div>
  <span class="listing-date-compact-slider">2 hours ago</span>
  <a class="selling-listing">1 X Harlequin Crest</a>
  <span class="align-middle">PC</span>
  <span class="align-middle">Softcore</span>
  <span class="align-middle">Ladder</span>
  <span class="align-middle">Reign of the Warlock</span>
  <div class="listing-num-properties">120 Defense</div>
  Trading For
  <div>1 X Ist Rune</div>
  <div class="listing-value"><span>0.16</span></div>
</div>
"""


TRADING_TXT_SAMPLE = """
Apply this search for all
SellerOne
(100)
1 X Harlequin Crest
PC • Softcore • Ladder • Reign Of The Warlock
120 Defense
Trading For
1 X Ist Rune
High Rune Value: 0.16
2 hours ago
"""


def test_parse_harlequin_crest_actual_capture():
    """Golden fixture signal: deterministic parser regression catch."""
    cards = parse_trading_html(TRADING_HTML_SAMPLE)
    assert len(cards) == 2

    valid, excluded = filter_listings(cards)
    # Partition invariant: every card is either valid or excluded with a reason.
    assert len(valid) + len(excluded) == len(cards)
    assert all(e["reasons"] for e in excluded)
    assert all("seller" in e["listing"] for e in excluded)

    # Business invariant: valid listings satisfy the published market criteria.
    assert len(valid) == 1
    only = valid[0]
    assert only.platform == "PC"
    assert only.mode == "Softcore"
    assert only.ladder == "Ladder"
    assert only.game_version == "Reign of the Warlock"
    assert is_within_time_window(only.posted_time, max_hours=72.0) is True
    assert only.listing_id and only.seller and only.item_name and only.posted_time


def test_parse_trading_txt_matches_count():
    cards = parse_trading_txt(TRADING_TXT_SAMPLE)
    html_cards = parse_trading_html(TRADING_HTML_SINGLE_SAMPLE)
    # Same listing captured as txt and html: both parsers agree on population.
    assert len(cards) == len(html_cards) == 1

    valid, excluded = filter_listings(cards)
    assert len(valid) + len(excluded) == len(cards)

RECENT_TWO_TRADES_SAMPLE = """
They Give
1 X Harlequin Crest
PC •
Softcore •
Ladder •
Reign Of The Warlock
+126 Defense

I Give

1 X Mal Rune
High Rune Value: 0
17 分鐘前
They Give
1 X Harlequin Crest
Ethereal •
PC •
Ladder •
147 Defense

I Give

1 X Um Rune
OR
3 X Random Minor Key
33 minutes ago
"""


def test_parse_recent_trades_current_they_give_block_format():
    result = parse_recent_trades(RECENT_TWO_TRADES_SAMPLE)
    assert result["mode"] == "A"
    assert result["blocked"] is False
    assert len(result["trades"]) == 2
    t1, t2 = result["trades"]
    assert t1["buyer_or_seller"] == "1 X Harlequin Crest, +126 Defense"
    assert t1["price"] == "1 X Mal Rune"
    assert t1["trade_time"] == "17 分鐘前"
    assert t2["buyer_or_seller"] == "1 X Harlequin Crest, Ethereal, 147 Defense"
    assert t2["price"] == "1 X Um Rune OR 3 X Random Minor Key"
    assert t2["trade_time"] == "33 minutes ago"


def test_listing_card_serialization_respects_include_raw():
    card = ListingCard(
        listing_id="abc",
        seller="seller",
        rating="(10)",
        posted_time="1 hour ago",
        item_name="Harlequin Crest",
        platform="PC",
        mode="Softcore",
        ladder="Ladder",
        game_version="Reign of the Warlock",
        is_ethereal=False,
        is_unidentified=False,
        defense=120,
        stats=["120 Defense"],
        ask="1 X Ist Rune",
        high_rune_value="0.16",
        raw_text="full card text here",
    )
    compact = card.to_dict()
    assert "raw_text" not in compact
    assert compact["seller"] == "seller"

    full = card.to_dict(include_raw=True)
    assert full["raw_text"] == "full card text here"


def test_generate_analysis_and_report_structure():
    cards = parse_trading_html(TRADING_HTML_SAMPLE)
    recent_result = parse_recent_trades("Please sign in to view offers")
    analysis_data = analyze_market_data(
        cards,
        recent_result,
        observed_at="2026-10-01T12:00:00Z",
        sources={"trading": {"url": "u1", "title": "t1"}},
    )

    # Schema: required top-level keys with expected types.
    for key in (
        "report_mode", "item_name", "environment", "links", "summary",
        "recent_trades_status", "valid_listings", "excluded_listings",
    ):
        assert key in analysis_data
    assert isinstance(analysis_data["report_mode"], str) and analysis_data["report_mode"]
    assert analysis_data["observed_at"] == "2026-10-01T12:00:00Z"
    assert analysis_data["sources"] == {"trading": {"url": "u1", "title": "t1"}}

    summary = analysis_data["summary"]
    valid_listings = analysis_data["valid_listings"]
    excluded_listings = analysis_data["excluded_listings"]

    # Summary counts are internally consistent.
    assert summary["total_captured"] == len(cards)
    assert summary["valid_count"] == len(valid_listings)
    assert summary["excluded_count"] == len(excluded_listings)
    assert summary["valid_count"] + summary["excluded_count"] == summary["total_captured"]
    assert sum(summary["price_distribution"].values()) == summary["valid_count"]

    # Aggregate stats agree with the listings they summarize.
    defenses = [c["defense"] for c in valid_listings if c["defense"] is not None]
    assert summary["defense_range"] == {
        "min": min(defenses) if defenses else None,
        "max": max(defenses) if defenses else None,
    }
    assert summary["ethereal_count"] == sum(1 for c in valid_listings if c["is_ethereal"])
    assert summary["unidentified_count"] == sum(1 for c in valid_listings if c["is_unidentified"])

    # Report mode is coherent with listing availability (mode A iff valid listings exist).
    assert ("【模式 A】" in analysis_data["report_mode"]) == (summary["valid_count"] > 0)

    env = analysis_data["environment"]
    for c in valid_listings:
        # Valid listing entries carry required fields with sane types, no raw payload.
        assert isinstance(c["seller"], str) and c["seller"]
        assert isinstance(c["item_name"], str) and c["item_name"]
        assert isinstance(c["ask"], str) and c["ask"]
        assert isinstance(c["posted_time"], str) and c["posted_time"]
        assert c["defense"] is None or isinstance(c["defense"], int)
        assert "raw_text" not in c
        # Stated environment matches the listings deemed valid.
        assert c["platform"] == env["platform"]
        assert c["mode"] == env["mode"]
        assert c["ladder"] == env["ladder"]
        assert c["game_version"] == env["game_version"]

    # Excluded listings always expose at least one reason.
    for e in excluded_listings:
        assert e["reasons"]

    # Report renders the analysis it was given (data-driven, not hardcoded text).
    report = generate_markdown_report(analysis_data)
    assert analysis_data["item_name"] in report
    assert analysis_data["report_mode"] in report
    for c in valid_listings:
        assert c["seller"] in report
    for e in excluded_listings[:12]:  # report truncates exclusion rows at 12
        assert e["listing"]["seller"] in report
    assert recent_result["reason"] in report


def test_build_market_report_uses_inputs():
    data, report = build_market_report(
        "Harlequin Crest",
        "harlequin-crest",
        "",
        RECENT_TWO_TRADES_SAMPLE,
        observed_at="2026-10-01T12:00:00Z",
        sources={},
    )
    assert data["recent_trades_status"]["mode"] == "A"
    assert len(data["recent_trades_status"]["trades"]) == 2
    assert data["observed_at"] == "2026-10-01T12:00:00Z"
    assert "Harlequin Crest" in report
