"""Live Traderie D2R item search with independent Trading/Recent Trades verification."""

import argparse
import json
from pathlib import Path

from jev_ultrafast import Agent
from jev_ultrafast.chrome import close_chrome
from jev_ultrafast.traderie import TRADERIE_D2R_URL, build_goal, new_market, run_agent, save_report
from jev_ultrafast.traderie.site import LOAD_MORE_LIMIT, phase_finish_rule
from jev_ultrafast.usage import format_usd, usage_summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("item_name", help="Traderie D2R item name to look up.")
    parser.add_argument("--output", default="artifacts/traderie/latest")
    parser.add_argument("--load-more", type=int, default=LOAD_MORE_LIMIT, help="Load More presses per view (0-5).")
    parser.add_argument("--keep-open", action="store_true")
    args = parser.parse_args()

    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)
    agent = Agent(
        TRADERIE_D2R_URL,
        build_goal(args.item_name, args.load_more),
        text=args.item_name,
        finish_phase_after=phase_finish_rule(args.load_more),
    )
    market = new_market()
    error = "run stopped before both views were read"
    try:
        for state in run_agent(agent, args.item_name, market):
            last = state["history"][-1] if state["history"] else {}
            print(state["elapsed_ms"], state["status"], last.get("action", ""), flush=True)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        state = agent.snapshot()
        if market["verification"] is None:
            market["verification"] = {
                "passed": False,
                "item_name": args.item_name,
                "error": error,
                "failed_checks": ["run_incomplete"],
            }
        save_report(args.item_name, market, folder)
        state["market"] = market
        state["usage"] = usage_summary(state["decisions"], state["history"])
        (folder / "state.json").write_text(json.dumps(state, indent=2))
        (folder / "session.json").write_text(
            json.dumps({"target": agent.browser.target, "session": agent.browser.session})
        )
        if not args.keep_open:
            agent.close()
            close_chrome()
    blocked = state.get("scope_blocked_reason") or ""
    if "需要登入" in blocked:
        print(blocked)
    verification = market["verification"]
    print(json.dumps({k: v for k, v in verification.items() if k != "final_page"}, indent=2, ensure_ascii=False))
    usage = state["usage"]
    print(
        f"Jev 用量：{usage['calls']} 次呼叫、{usage['steps']} 步、"
        f"輸入 {usage['input_tokens']:,} / 輸出 {usage['output_tokens']:,} token、"
        f"預估 {format_usd(usage['cost_usd'])}"
    )
    if not verification["passed"]:
        raise SystemExit("Final page did not satisfy the Traderie item checks")


if __name__ == "__main__":
    main()
