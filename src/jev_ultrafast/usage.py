"""Jev call usage: tokens, estimated cost and time, summed from the Agent's decisions."""

from __future__ import annotations

from typing import Any

from jev_ultrafast.config import Settings, get_settings


def _tokens(decision: dict[str, Any], key: str) -> int:
    value = (decision.get("usage") or {}).get(key)
    return value if isinstance(value, int) and value > 0 else 0


def usage_summary(
    decisions: list[dict[str, Any]], steps: list[Any], settings: Settings | None = None
) -> dict[str, Any]:
    """Totals for one run. `calls` counts every Jev answer, `steps` only the actions that were executed."""
    settings = settings or get_settings()
    input_tokens = sum(_tokens(d, "input_tokens") for d in decisions)
    output_tokens = sum(_tokens(d, "output_tokens") for d in decisions)
    latency_ms = sum(d.get("latency_ms") or 0 for d in decisions)
    calls = sum(d.get("model_calls", 1) for d in decisions)
    cost = (
        input_tokens / 1_000_000 * settings.jev_input_usd_per_million
        + output_tokens / 1_000_000 * settings.jev_output_usd_per_million
    )
    return {
        "calls": calls,
        "steps": len(steps),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost,
        "jev_seconds": round(latency_ms / 1000, 1),
        "avg_ms": round(latency_ms / calls) if calls else 0,
    }


def format_usd(value: float) -> str:
    """Small amounts are shown with 4 decimals and in US cents so they do not read as zero."""
    if value <= 0:
        return "$0"
    if value >= 0.01:
        return f"${value:.2f}"
    return f"${value:.4f}（約 {value * 100:.2f} 美分）"
