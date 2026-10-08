import pytest

from jev_ultrafast.config import get_settings
from jev_ultrafast.usage import format_usd, usage_summary

DECISIONS = [
    {"usage": {"input_tokens": 5599, "output_tokens": 423}, "latency_ms": 400},
    {"usage": {"input_tokens": 5000, "output_tokens": 400}, "latency_ms": 200},
    {"latency_ms": 300},  # a call without usage counts as zero tokens but is still a call
]


def test_usage_summary_sums_tokens_cost_and_time_from_every_call():
    summary = usage_summary(DECISIONS, ["s1", "s2"], get_settings({}))
    assert summary["calls"] == 3
    assert summary["steps"] == 2
    assert summary["input_tokens"] == 10599
    assert summary["output_tokens"] == 823
    assert summary["cost_usd"] == pytest.approx(10599 / 1e6 * 0.042)
    assert summary["jev_seconds"] == 0.9
    assert summary["avg_ms"] == 300


def test_usage_summary_uses_the_configured_prices():
    settings = get_settings({"JEV_INPUT_USD_PER_MILLION": "0.08", "JEV_OUTPUT_USD_PER_MILLION": "0.5"})
    summary = usage_summary(DECISIONS, [], settings)
    assert summary["cost_usd"] == pytest.approx(10599 / 1e6 * 0.08 + 823 / 1e6 * 0.5)


def test_usage_summary_without_calls_is_all_zero():
    summary = usage_summary([], [], get_settings({}))
    assert summary == {
        "calls": 0,
        "steps": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "jev_seconds": 0.0,
        "avg_ms": 0,
    }


def test_format_usd_shows_small_amounts_in_cents_so_they_do_not_read_as_zero():
    assert format_usd(0.0025) == "$0.0025（約 0.25 美分）"
    assert format_usd(0.05) == "$0.05"
    assert format_usd(0) == "$0"


def test_a_reasked_decision_counts_as_two_calls_and_the_average_follows_the_calls():
    decisions = [
        {"usage": {"input_tokens": 100, "output_tokens": 5}, "latency_ms": 300},
        {"usage": {"input_tokens": 200, "output_tokens": 10}, "latency_ms": 600, "model_calls": 2},
    ]
    summary = usage_summary(decisions, [1, 2], get_settings({}))
    assert summary["calls"] == 3 and summary["avg_ms"] == 300
