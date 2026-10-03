"""Tests for missing value handling in trading reports."""

import sys
import types

import pytest  # noqa: F401

# Mock browser harness
browser_harness = types.ModuleType("browser_harness")
admin = types.ModuleType("browser_harness.admin")
helpers = types.ModuleType("browser_harness.helpers")
admin.ensure_daemon = lambda: None
helpers.cdp = lambda *args, **kwargs: {}  # noqa: F841
helpers.drain_events = lambda: []  # noqa: F841
browser_harness.admin = admin  # noqa: F841
browser_harness.helpers = helpers  # noqa: F841
sys.modules["browser_harness"] = browser_harness  # noqa: F841
sys.modules["browser_harness.admin"] = admin  # noqa: F841
sys.modules["browser_harness.helpers"] = helpers  # noqa: F841

from jev_ultrafast.traderie.report import (  # noqa: E402
    MIN_LISTINGS_FOR_STATS,
    UNKNOWN_PLACEHOLDER,
    build_json_report,
    calculate_statistics,
    extract_numeric_price,
    filter_valid_listings,
    filter_valid_trades,
    is_valid_listing,
    is_valid_price_format,
    is_valid_trade,
)


class TestPriceValidation:
    """Tests for price format validation."""

    def test_is_valid_price_format_with_valid_price(self):
        """Valid price strings should return True."""
        assert is_valid_price_format("3 Ber")
        assert is_valid_price_format("2.5 Ber")
        assert is_valid_price_format("1000 Runes")
        assert is_valid_price_format("Make an Offer (serious buyers)")

    def test_is_valid_price_format_with_empty_string(self):
        """Empty string should return False."""
        assert not is_valid_price_format("")
        assert not is_valid_price_format("   ")

    def test_is_valid_price_format_with_none(self):
        """None should return False."""
        assert not is_valid_price_format(None)

    def test_is_valid_price_format_with_invalid_placeholders(self):
        """Placeholder prices without value should return False."""
        assert not is_valid_price_format("unknown")
        assert not is_valid_price_format("pending")
        assert not is_valid_price_format("ask for price")

    def test_is_valid_price_format_with_non_string(self):
        """Non-string types should return False."""
        assert not is_valid_price_format(123)
        assert not is_valid_price_format([])
        assert not is_valid_price_format({})


class TestListingValidation:
    """Tests for listing validation."""

    def test_is_valid_listing_with_valid_data(self):
        """Listing with valid ask price should return True."""
        listing = {
            "seller": "PlayerA",
            "ask": "3 Ber",
            "defense": 150,
        }
        assert is_valid_listing(listing)

    def test_is_valid_listing_missing_price(self):
        """Listing without ask price should return False."""
        listing = {
            "seller": "PlayerA",
        }
        assert not is_valid_listing(listing)

    def test_is_valid_listing_with_invalid_price(self):
        """Listing with invalid price format should return False."""
        listing = {
            "seller": "PlayerA",
            "ask": "unknown",
        }
        assert not is_valid_listing(listing)

    def test_is_valid_listing_missing_seller_is_ok(self):
        """Listing can be missing seller (will use Unknown placeholder)."""
        listing = {
            "ask": "3 Ber",
        }
        assert is_valid_listing(listing)


class TestTradeValidation:
    """Tests for trade validation."""

    def test_is_valid_trade_with_valid_data(self):
        """Trade with valid price should return True."""
        trade = {
            "buyer_or_seller": "PlayerA",
            "price": "2 Ber",
            "trade_time": "2 hours ago",
        }
        assert is_valid_trade(trade)

    def test_is_valid_trade_missing_price(self):
        """Trade without price should return False."""
        trade = {
            "buyer_or_seller": "PlayerA",
            "trade_time": "2 hours ago",
        }
        assert not is_valid_trade(trade)

    def test_is_valid_trade_missing_buyer_seller_is_ok(self):
        """Trade can be missing buyer/seller (will use Unknown)."""
        trade = {
            "price": "2 Ber",
            "trade_time": "2 hours ago",
        }
        assert is_valid_trade(trade)


class TestListingFiltering:
    """Tests for filtering valid vs invalid listings."""

    def test_filter_valid_listings_all_valid(self):
        """All valid listings should be returned."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "2.5 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        valid, reasons = filter_valid_listings(listings)
        assert len(valid) == 3
        assert len(reasons) == 0

    def test_filter_valid_listings_mixed_valid_invalid(self):
        """Invalid listings should be excluded."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB"},  # Missing price
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        valid, reasons = filter_valid_listings(listings)
        assert len(valid) == 2
        assert "missing_price" in reasons

    def test_filter_valid_listings_all_invalid(self):
        """All invalid listings should be excluded."""
        listings = [
            {"seller": "PlayerA"},  # Missing price
            {"seller": "PlayerB"},  # Missing price
        ]
        valid, reasons = filter_valid_listings(listings)
        assert len(valid) == 0
        assert "missing_price" in reasons

    def test_filter_valid_listings_empty_list(self):
        """Empty list should return empty valid list."""
        valid, reasons = filter_valid_listings([])
        assert len(valid) == 0


class TestTradeFiltering:
    """Tests for filtering valid vs invalid trades."""

    def test_filter_valid_trades_all_valid(self):
        """All valid trades should be returned."""
        trades = [
            {"buyer_or_seller": "PlayerA", "price": "2 Ber"},
            {"buyer_or_seller": "PlayerB", "price": "2.5 Ber"},
        ]
        valid, reasons = filter_valid_trades(trades)
        assert len(valid) == 2
        assert len(reasons) == 0

    def test_filter_valid_trades_mixed(self):
        """Invalid trades should be excluded."""
        trades = [
            {"buyer_or_seller": "PlayerA", "price": "2 Ber"},
            {"buyer_or_seller": "PlayerB"},  # Missing price
            {"buyer_or_seller": "PlayerC", "price": "2.5 Ber"},
        ]
        valid, reasons = filter_valid_trades(trades)
        assert len(valid) == 2
        assert "missing_price" in reasons

    def test_filter_valid_trades_all_invalid(self):
        """All invalid trades should be excluded."""
        trades = [
            {"buyer_or_seller": "PlayerA"},  # Missing price
            {"buyer_or_seller": "PlayerB"},  # Missing price
        ]
        valid, reasons = filter_valid_trades(trades)
        assert len(valid) == 0


class TestNumericPriceExtraction:
    """Tests for extracting numeric values from prices."""

    def test_extract_numeric_price_with_rune_prices(self):
        """Should extract numeric value from rune prices."""
        assert extract_numeric_price("3 Ber") == 3.0
        assert extract_numeric_price("2.5 Ber") == 2.5
        assert extract_numeric_price("1000 Runes") == 1000.0

    def test_extract_numeric_price_with_decimal(self):
        """Should handle decimal prices."""
        assert extract_numeric_price("2.75 Ber") == 2.75
        assert extract_numeric_price("1.5 Lo") == 1.5

    def test_extract_numeric_price_with_none(self):
        """Should return None for None input."""
        assert extract_numeric_price(None) is None

    def test_extract_numeric_price_with_invalid_format(self):
        """Should return None if no numeric value found."""
        assert extract_numeric_price("unknown") is None
        assert extract_numeric_price("Make an Offer") is None

    def test_extract_numeric_price_with_complex_format(self):
        """Should extract first numeric value from complex formats."""
        assert extract_numeric_price("OR 3 Ber + 2 Ist") == 3.0


class TestStatisticsCalculation:
    """Tests for price statistics calculation."""

    def test_calculate_statistics_sufficient_data(self):
        """Should calculate stats with sufficient listings."""
        listings = [
            {"seller": "PlayerA", "ask": "2 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3.5 Ber"},
            {"seller": "PlayerD", "ask": "4 Ber"},
        ]
        stats = calculate_statistics(listings)
        assert stats is not None
        assert stats["count"] == 4
        assert stats["min_numeric"] == 2.0
        assert stats["max_numeric"] == 4.0
        assert stats["price_variance"] in ["low", "medium", "high"]

    def test_calculate_statistics_insufficient_data(self):
        """Should return None with fewer than MIN_LISTINGS_FOR_STATS listings."""
        listings = [
            {"seller": "PlayerA", "ask": "2 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
        ]
        stats = calculate_statistics(listings)
        assert stats is None

    def test_calculate_statistics_empty_list(self):
        """Should return None for empty list."""
        stats = calculate_statistics([])
        assert stats is None

    def test_calculate_statistics_high_variance(self):
        """Should flag high variance when price range > 50%."""
        listings = [
            {"seller": "PlayerA", "ask": "1 Ber"},
            {"seller": "PlayerB", "ask": "1 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        stats = calculate_statistics(listings)
        assert stats is not None
        assert stats["price_variance"] == "high"

    def test_calculate_statistics_low_variance(self):
        """Should flag low variance when price range < 20%."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3.1 Ber"},
            {"seller": "PlayerC", "ask": "3.2 Ber"},
        ]
        stats = calculate_statistics(listings)
        assert stats is not None
        assert stats["price_variance"] == "low"

    def test_calculate_statistics_median_calculation(self):
        """Should calculate median correctly."""
        listings = [
            {"seller": "PlayerA", "ask": "1 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "5 Ber"},
        ]
        stats = calculate_statistics(listings)
        assert stats is not None
        assert stats["median_numeric"] == 3.0


class TestJsonReport:
    """Tests for complete JSON report generation."""

    def test_build_json_report_with_valid_listings_only(self):
        """Should generate report with valid listings and partial status."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber", "defense": 150},
            {"seller": "PlayerB", "ask": "2.5 Ber", "defense": 155},
            {"seller": "PlayerC", "ask": "3 Ber", "defense": 145},
        ]
        report = build_json_report("Harlequin Crest", listings)
        
        assert report["item_name"] == "Harlequin Crest"
        assert report["data_completeness"]["trading_listings_found"] is True
        assert report["data_completeness"]["recent_trades_found"] is False
        assert report["trading"]["status"] == "SUCCESS"
        assert report["trading"]["listings_valid_count"] == 3
        assert report["recent_trades"]["status"] == "PARTIAL"
        assert report["summary"]["status"] == "PARTIAL"

    def test_build_json_report_no_listings(self):
        """Should return PARTIAL status when no valid listings."""
        listings = []
        report = build_json_report("Test Item", listings)
        
        assert report["trading"]["listings_valid_count"] == 0
        assert report["trading"]["status"] == "PARTIAL"
        assert report["summary"]["status"] == "FAILED"

    def test_build_json_report_mixed_valid_invalid_listings(self):
        """Should exclude invalid listings and report counts."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB"},  # Missing price
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings)
        
        assert report["trading"]["listings_count"] == 3
        assert report["trading"]["listings_valid_count"] == 2
        assert report["trading"]["listings_excluded_count"] == 1
        assert "missing_price" in report["trading"]["exclusion_reasons"]

    def test_build_json_report_missing_seller_uses_unknown(self):
        """Should use Unknown placeholder for missing sellers."""
        listings = [
            {"seller": "", "ask": "3 Ber"},
            {"ask": "2.5 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings)
        
        valid = report["trading"]["listings"]
        assert all(listing["seller"] == UNKNOWN_PLACEHOLDER for listing in valid)

    def test_build_json_report_statistics_included(self):
        """Should include statistics when sufficient data."""
        listings = [
            {"seller": "PlayerA", "ask": "2 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "4 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings)
        
        assert report["statistics"] is not None
        assert report["statistics"]["count"] == 3
        assert "min_numeric" in report["statistics"]
        assert "max_numeric" in report["statistics"]

    def test_build_json_report_insufficient_data_for_stats(self):
        """Should not calculate stats with fewer than 3 listings."""
        listings = [
            {"seller": "PlayerA", "ask": "2 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings)
        
        assert report["statistics"] is not None
        assert report["statistics"]["status"] == "INSUFFICIENT_DATA"
        assert report["statistics"]["current_count"] == 2

    def test_build_json_report_with_trades(self):
        """Should include trades data when provided."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        trades = [
            {"buyer_or_seller": "Trader1", "price": "2.5 Ber", "trade_time": "1 day ago"},
            {"buyer_or_seller": "Trader2", "price": "3 Ber", "trade_time": "2 days ago"},
        ]
        report = build_json_report("Harlequin Crest", listings, trades)
        
        assert report["data_completeness"]["recent_trades_found"] is True
        assert report["recent_trades"]["trades_valid_count"] == 2
        assert report["summary"]["status"] == "SUCCESS"

    def test_build_json_report_with_invalid_trades(self):
        """Should exclude invalid trades."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        trades = [
            {"buyer_or_seller": "Trader1", "price": "2.5 Ber"},
            {"buyer_or_seller": "Trader2"},  # Missing price
            {"buyer_or_seller": "Trader3", "price": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings, trades)
        
        assert report["recent_trades"]["trades_count"] == 3
        assert report["recent_trades"]["trades_valid_count"] == 2
        assert report["recent_trades"]["trades_excluded_count"] == 1

    def test_build_json_report_missing_buyer_seller_in_trades(self):
        """Should use Unknown for missing buyer/seller in trades."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        trades = [
            {"price": "2.5 Ber"},
            {"buyer_or_seller": "", "price": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings, trades)
        
        valid_trades = report["recent_trades"]["trades"]
        assert all(t["buyer_or_seller"] == UNKNOWN_PLACEHOLDER for t in valid_trades)

    def test_build_json_report_empty_recent_trades(self):
        """Should handle empty recent trades list."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings, [])
        
        assert report["recent_trades"]["trades_count"] == 0
        assert report["recent_trades"]["trades_valid_count"] == 0

    def test_build_json_report_no_data_fails(self):
        """Should return FAILED status when no listings or trades."""
        report = build_json_report("Nonexistent Item", [], [])
        
        assert report["summary"]["status"] == "FAILED"
        assert "Insufficient data" in report["summary"]["note"]

    def test_build_json_report_status_only_trades(self):
        """Should return PARTIAL when only trades, no listings."""
        listings = []
        trades = [
            {"buyer_or_seller": "Trader1", "price": "2.5 Ber"},
            {"buyer_or_seller": "Trader2", "price": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings, trades)
        
        assert report["summary"]["status"] == "PARTIAL"
        assert "trades" in report["summary"]["note"].lower()

    def test_build_json_report_complete_success(self):
        """Should return SUCCESS status with both listings and trades."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        trades = [
            {"buyer_or_seller": "Trader1", "price": "2.5 Ber"},
            {"buyer_or_seller": "Trader2", "price": "3 Ber"},
        ]
        report = build_json_report("Harlequin Crest", listings, trades)
        
        assert report["summary"]["status"] == "SUCCESS"
        assert "complete" in report["summary"]["note"].lower()


class TestDataCompletenessNotes:
    """Tests for data completeness notes."""

    def test_data_completeness_no_listings(self):
        """Should include note when no listings found."""
        report = build_json_report("Test Item", [])
        
        assert "note" in report["data_completeness"]
        assert "No active listings" in report["data_completeness"]["note"]

    def test_data_completeness_no_trades(self):
        """Should include note when no trades found."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        report = build_json_report("Test Item", listings, [])
        
        assert "note" in report["data_completeness"]
        assert "Recent trade history not available" in report["data_completeness"]["note"]


class TestExclusionReasons:
    """Tests for exclusion reason tracking."""

    def test_exclusion_reasons_no_duplicates(self):
        """Should not include duplicate exclusion reasons."""
        listings = [
            {"seller": "PlayerA"},  # Missing price
            {"seller": "PlayerB"},  # Missing price
            {"seller": "PlayerC"},  # Missing price
        ]
        report = build_json_report("Test Item", listings)
        
        reasons = report["trading"]["exclusion_reasons"]
        assert len(reasons) == len(set(reasons))  # No duplicates

    def test_exclusion_reasons_for_trades(self):
        """Should track exclusion reasons for trades."""
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        trades = [
            {"buyer_or_seller": "Trader1"},  # Missing price
            {"buyer_or_seller": "Trader2"},  # Missing price
        ]
        report = build_json_report("Test Item", listings, trades)
        
        reasons = report["recent_trades"]["exclusion_reasons"]
        assert "missing_price" in reasons


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    def test_exact_minimum_listings_for_stats(self):
        """Should calculate stats with exactly MIN_LISTINGS_FOR_STATS listings."""
        listings = [
            {"seller": "PlayerA", "ask": f"{i} Ber"}
            for i in range(1, MIN_LISTINGS_FOR_STATS + 1)
        ]
        stats = calculate_statistics(listings)
        assert stats is not None

    def test_one_less_than_minimum_listings_for_stats(self):
        """Should not calculate stats with one less than minimum."""
        listings = [
            {"seller": "PlayerA", "ask": f"{i} Ber"}
            for i in range(1, MIN_LISTINGS_FOR_STATS)
        ]
        stats = calculate_statistics(listings)
        assert stats is None

    def test_special_characters_in_seller_name(self):
        """Should handle special characters in seller names."""
        listings = [
            {"seller": "Player™©", "ask": "3 Ber"},
            {"seller": "Player™®", "ask": "3 Ber"},
            {"seller": "Player_123", "ask": "3 Ber"},
        ]
        report = build_json_report("Test Item", listings)
        
        sellers = [listing["seller"] for listing in report["trading"]["listings"]]
        assert len(sellers) == 3

    def test_unicode_in_item_name(self):
        """Should handle Unicode characters in item names."""
        item_name = "嚴格審判之杖 (Harlequin Crest)"
        listings = [
            {"seller": "PlayerA", "ask": "3 Ber"},
            {"seller": "PlayerB", "ask": "3 Ber"},
            {"seller": "PlayerC", "ask": "3 Ber"},
        ]
        report = build_json_report(item_name, listings)
        
        assert report["item_name"] == item_name

    def test_whitespace_only_seller_treated_as_missing(self):
        """Should treat whitespace-only seller as missing."""
        listings = [
            {"seller": "   ", "ask": "3 Ber"},
        ]
        report = build_json_report("Test Item", listings)
        
        sellers = [listing["seller"] for listing in report["trading"]["listings"]]
        assert sellers[0] == UNKNOWN_PLACEHOLDER
