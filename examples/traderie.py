"""Live Traderie D2R item search with independent Trading/Recent Trades verification."""

import argparse
import json
from pathlib import Path

from jev_ultrafast import Agent
from jev_ultrafast.traderie import TRADERIE_D2R_URL, build_goal, collect_market_snapshot


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("item_name", help="Traderie D2R item name to look up.")
    parser.add_argument("--output", default="artifacts/traderie/latest")
    parser.add_argument("--keep-open", action="store_true")
    args = parser.parse_args()

    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)
    agent = Agent(TRADERIE_D2R_URL, build_goal(args.item_name))
    try:
        for state in agent.run():
            last = state["history"][-1] if state["history"] else {}
            print(state["elapsed_ms"], state["status"], last.get("action", ""), flush=True)
    finally:
        state = agent.snapshot()
        try:
            final_page = agent.browser.observe(screenshot=False)
            state["final_page"] = final_page
            state["verification"] = collect_market_snapshot(agent.browser, args.item_name, final_page)
        except Exception as exc:
            state["verification"] = {
                "passed": False,
                "item_name": args.item_name,
                "error": f"{type(exc).__name__}: {exc}",
            }
        (folder / "state.json").write_text(json.dumps(state, indent=2))
        (folder / "session.json").write_text(
            json.dumps({"target": agent.browser.target, "session": agent.browser.session})
        )
        if not args.keep_open:
            agent.close()
    print(json.dumps(state["verification"], indent=2))
    if not state["verification"]["passed"]:
        raise SystemExit("Final page did not satisfy the Traderie item checks")


if __name__ == "__main__":
    main()
