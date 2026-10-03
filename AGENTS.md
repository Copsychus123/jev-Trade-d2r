# Repository Guidelines

## Project Overview
Jev Ultrafast is a small browser Agent. It takes one natural-language goal, observes the page as indexed elements, asks TypeSafe (a remote chooser) for an operation plus a target, and executes it through Chrome DevTools Protocol. The shipped use case is Traderie Diablo II: Resurrected: search an item, open its product page, read the Trading (目前掛單) listings, click the Recent Trades (近期成交) tab, read the trades, and show both as tables in a local web demo.

Read `README.md` (Traditional Chinese) and `docs/design.md` before editing. The user is non-technical and writes in Traditional Chinese: explain results in plain Traditional Chinese, without jargon.

## Hard Rules
- Keep the loop small: page -> indexed elements -> operation + target -> execution.
- The input is one natural-language goal. No site-specific plans and no hardcoded field values or click targets. The model never emits selectors or executable code.
- TypeSafe chooses an operation and operation-specific target heads in one request. Consume only the selected operation's target. Targets must map to observed elements and supported operations.
- `TYPE_TEXT` types the text the caller supplied to `Agent(text=...)`; no model generates field text.
- Current stage scope: search -> product page -> read all Trading listings -> click Recent Trades -> read all trades -> show both as tables. Data analysis modules are a future extension (`future/`). The only model that may choose browser actions is Jev (TypeSafe), with one mechanical exception: `Agent(finish_phase_after=(label, n))` (`site.phase_finish_rule`) ends a phase without asking Jev once the action named `label` (Load More) ran `n` times in that phase; it is logged in `state["rule_events"]` and shown in the decision log. The same rule also runs the loading cycle inside a phase (`Agent._next_by_rule`): after Load More it scrolls to the bottom, after scrolling to the bottom it presses Load More if that button is on the page; otherwise (first step of a phase, no button) Jev chooses. Rule steps have `model_calls = 0` and appear in `rule_events` with `press: True`. Rules never choose search, product or tab targets; do not add any other LLM call, in particular no LLM-based data analysis and no model that generates field text.
- Never retry a browser mutation. Log execution before observing its result.
- Keep credentials server-side and `.env` ignored. Tests must not call paid APIs.
- Verify actual final outcomes independently. A `DONE` choice is not proof of success.
- Keep examples, README claims, raw evidence and model-call counts consistent.
- Do not commit or push unless the user asks. Many files in the working tree are modified or deleted by earlier tools; leave them alone.
- Untracked analysis files left by earlier tools were moved to `archive/` and are not authoritative (for example `SMOKE_TEST_UPGRADE_REPORT.md` falsely claimed "13/13 通過").

## Architecture & Data Flow
```
goal -> demo.py (HTTP, loopback) -> Agent.command(tick = predict + act)
          predict: Browser.observe -> model.choose (TypeSafe) -> decision
          act:     Browser.act (CDP input) -> Browser.observe -> history
        traderie/controller.advance() reads each view when the Agent finishes it
```
- `jev_ultrafast/agent.py`: `Agent` is the only owner of `agent.state`. Commands: `predict`, `act`, `tick`, `handoff`. Status values: `ready`, `predicted`, `handoff`, `done`, `blocked`. A single-string goal on a Traderie D2R URL becomes a 2-phase plan (`trading`, `recent_trades`); finishing phase A sets `awaiting_handoff` and the controller must call `handoff`.
- `jev_ultrafast/browser.py`: one CDP session through `browser_harness`. `observe`, `fresh`, `act`, `evaluate`, `navigate`, `settle`, `close`. `fingerprint()` hashes url, text, actions and scroll. After a click, `observe` waits until the visible text has changed once (or 1.0 s passed) and then stayed unchanged for 0.4 s (cap 6 s; measured: 0.7/1.5 s gave a median loop of 26 s, 0.4/1.0 s about 16 s); `wait` sleeps 4 s so slow XHR content can arrive (a shorter wait made Jev answer `blocked` on half-loaded search results).
- `jev_ultrafast/snapshot.js`: runs inside the page. Garbage accessible names (`[object Object]`, `undefined`, `null`, `NaN`) are ignored and the visible text is used instead (Traderie ships `aria-label="[object Object]"` on listing links). Lists up to 250 visible safe elements as `e1..eN`, plus controls `scroll_down`, `scroll_up`, `scroll_bottom`, `scroll_top`, `wait`. Page text is capped at 6000 chars and only covers the visible viewport.
- Phases: `Agent.state["phase_start"]` is where the current phase began in `history`; `choose` receives only that part, so `recent_actions` and `action_counts` (how often each action ran in this phase) restart at the handoff. The goal tells Jev to choose DONE when `action_counts` shows Load More at `LOAD_MORE_LIMIT` (counting from a list of actions was unreliable). Views carry `has_more` (a Load More button still on the page when it was read).
- `model.choose` asks Jev again, once, without the chosen operation when its target probability is below `MIN_TARGET_PROBABILITY = 0.5` (four same-name links once sent the Agent to another product page at 26%); the decision then has `reasked` and `model_calls = 2` and the usage sums both requests. `action_space` keeps at most `MAX_SAME_NAME_ELEMENTS = 2` elements with the same name and role (26 Min/Max boxes cost about 8% of the tokens). The Load More count (0-5, `site.validate_load_more`) comes from the demo selector (`reset` body `load_more`) or `--load-more`.
- `jev_ultrafast/model.py`: `post_json` (retries only network errors and HTTP 429/503/529), `action_space`, `choose`, `validate_choice` (checks probabilities only; there is no confidence anywhere), `validate_choice`. `questions.py` holds the prompt strings.
- `jev_ultrafast/config.py`: constants (`MAX_STEPS = 60`, viewport size), frozen `Settings` from `get_settings()`, `load_dotenv` (uses `setdefault`: the real environment wins over `.env`).
- `jev_ultrafast/demo.py`: loopback inspector on `127.0.0.1:8766`. POST checks Host, `X-Demo-Token` and Origin (403), single busy lock (409), `ValueError/RuntimeError/TimeoutError` -> 400. Commands: `reset`, `tick`, `report`; the page has one start button (「開始查詢」, runs `tick` until done), a stop button and the report button. `GET /api/report` returns the markdown; `GET /api/raw?view=trading|recent_trades` returns the stored page text (state carries only `text_length`; decisions other than the last are trimmed to a summary). Demo-owned fields live in `RUN` (`item_name`, `market`, `report_md`); never mutate `AGENT.state` from the demo.
- `jev_ultrafast/traderie/`: the Traderie domain.
  - `site.py`: URLs, `build_goal`, `LOAD_MORE_LIMIT = 2`, `product_root_url`, `traderie_scope_reason`, `detect_guard`.
  - `controller.py`: `new_market`, `read_view`, `verify_views`, `advance`, `run_agent`, `save_report`. Each view is read once, from the page the Agent is on (no navigation, no retry), into rows via `parsing.parse_trading_txt` / `parse_recent_trades`, and cross-checked against the page text ("Trading For" / "They Give" counts). Status per view: `NOT_RUN`, `PASSED`, `FAILED`, `BLOCKED`.
  - `verification.py`: `read_settled_page`, `matches_item`. The 8 independent checks live in `controller.verify_views`: `product_page`, `item_match`, `same_product`, `trading_view`, `recent_view`, `trading_rows_ok`, `recent_rows_ok`, `not_blocked`.
  - `parsing.py`: rule-based readers, no AI.
  - Future extension, not part of the current stage (do not wire in, extend or test): everything under `future/` (`analysis/`, `scripts/`, `tests/`).
- `jev_ultrafast/static/`: `index.html` (token placeholder `__TOKEN__`), `app.js`, `style.css`, `csv.js` (CSV export, no DOM access, tested through node). Results are two columns (listings 3fr, trades 2fr) at >= 1000px, stacked below; `marketViews.trading.mergeInto` shows the high-rune column as small text under the price only in the wide layout (CSS `.col-merge`/`.inline-extra`), CSV still exports all columns. Three tab panels: `tab-run`, `tab-results`, `tab-usage` (all element ids must stay in `index.html`; `tests/test_ui_static.py` checks this). The page switches to the results tab once when `market.verification` appears, unless the user picked a tab. Page text is untrusted: write table cells with `textContent`, never `innerHTML`; CSV cells starting with `= + - @` get a leading apostrophe.

## Key Directories
- `jev_ultrafast/`: package. `traderie/`: domain code. `static/`: demo UI.
- `examples/`: `traderie.py` (CLI, same flow as the demo).
- `scripts/`: `login_traderie.py` (visible dedicated Chrome for the one-time Traderie login), `check_guards.py`. `future/` holds the retired analysis code and helper scripts (`run.py`, `export_traderie_session.py`; not maintained, not tested, not packaged); `archive/` holds leftovers of earlier tools (git-ignored).
- `tests/`: pytest suite. `artifacts/traderie/latest/`: run output (`market.json`, `market_report.md`, `verification.json`; ignored by git). `.agents/skills/`: assistant skills, not product code.

## Development Commands
Run from the repo root, in bash (not PowerShell). Use `env VAR=... cmd` to set variables.
```bash
uv sync
uv run ruff check .
uv run pytest                      # live tests are deselected
node --check jev_ultrafast/static/app.js
node --check jev_ultrafast/static/csv.js
uv build
uv run python jev_ultrafast/demo.py                      # demo at http://127.0.0.1:8766
uv run python examples/traderie.py "Harlequin Crest"     # CLI, writes artifacts/traderie/latest
uv run pytest -m live -v                                 # real Chrome, TypeSafe, Traderie
```

## Code Conventions & Common Patterns
- Python >= 3.12, ruff line length 120, rules `E,F,I`. Clean cutover: when removing a behavior, migrate every caller and delete dead code; no shims or aliases.
- Safety patterns to keep:
  - `Agent` consumes a decision once, before any mutation or model call.
  - `StalePage` triggers a re-observe and a new decision, never a replay of the action.
  - `Browser.fresh(page, action)` guards element actions (including `fill`); page-level `MARKER` is used for page-level actions.
  - Scope guard (`traderie_scope_reason`) blocks anything outside Traderie D2R.
  - Verification results always carry a human-readable reason (`view_reasons`, `failed_checks`).
- Errors: raise `ValueError` for caller mistakes, `RuntimeError`/`TimeoutError` for browser or network problems; the demo maps them to HTTP 400.
- Config: read through `get_settings()`; never read secrets in the frontend.
- Naming: snake_case modules and functions; test functions are full sentences (`test_stale_decision_is_consumed_before_any_mutation`); status strings are upper-case constants (`PASSED`, `BLOCKED`).
- Do not add keyword lists that filter the element list by site vocabulary; that hid the real search-result link once. Improve generic observation or prompts instead.

## Important Files
- Entry points: `jev_ultrafast/demo.py:main` (`jev` script), `examples/traderie.py`.
- Config: `pyproject.toml` (hatchling, pytest `addopts = ["-m", "not live"]`, ruff), `.env` (ignored) and `.env.example`.
- Env keys (never print values): `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `TYPESAFE_DEMO_PORT`, `TRADERIE_COOKIE`, `TRADERIE_SESSION_TOKEN`, `TRADERIE_SESSION_COOKIE_NAME`.
- `jev_ultrafast/fs.py`: atomic writes and utf-8 reads; use it instead of ad-hoc writes in library code.

## Runtime/Tooling Preferences
- Python with `uv` (lock file `uv.lock`); `node` only for `node --check` on JS. No CI directory.
- By default `jev_ultrafast/chrome.py` starts a dedicated headless Chrome (port 9355, profile `.tmp-jev-chrome`, git-ignored) and points `browser_harness` at it with a per-process daemon name (`BU_NAME=jev-<pid>`). `JEV_CHROME` selects the mode: `headless` (default), `window` (visible dedicated Chrome), `existing` (the user's own Chrome; needs remote debugging on port 9222, and if Chrome asks "Allow remote debugging?", only the user can click Allow).
- Only in the dedicated Chrome: advertising/tracker hosts are blocked (`BLOCKED_HOSTS`, halves memory), picture URLs are blocked when screenshots are off (`Browser(images=False)`; the demo keeps pictures for its screenshot panel), the page cache is capped at 50 MB, small caches are removed on close (the login stays), and renderer processes are limited. In headless Chrome the tab must be a foreground tab or screenshots hang.
- TypeSafe requires `TYPESAFE_API_KEY`. No local text model is needed.
- Without a login, Traderie hides Load More and may block Recent Trades. Tell the user to run `uv run python scripts/login_traderie.py`, log in once in the window, press Enter, then continue. In `existing` mode, log in in the user's Chrome instead.

## Testing & QA
- Framework: pytest. Default lane is offline and fast (`uv run pytest`, about 5 s). Marker: `live` (starts a real Chrome and/or uses the network; excluded by default).
- `tests/test_agent.py` (loop, stale pages, phases, scope guard), `test_model.py` (HTTP/JSON retry), `test_config.py`, `test_traderie.py` (domain, `read_view`, `verify_views`), script tests, and `test_live_traderie.py`.
- Offline tests stub `browser_harness` before importing the package (see the head of `tests/test_traderie.py`: fake `browser_harness`, `.admin`, `.helpers` in `sys.modules`, then `# noqa: E402` imports). Mock with `monkeypatch`; use fake browser classes with `evaluate`/`observe`.
- `tests/test_live_traderie.py` starts the real demo server on port 0, drives it over HTTP with `httpx`, and checks that the Agent clicked Recent Trades, that both views are `PASSED`, and that `market_report.md` matches the download. The Agent is non-deterministic: a single failed run (for example wrong search text or a blocked results page) is not proof of a code bug; rerun before changing code.
- Never weaken a verification check to make a test pass; fix the cause. Do not pin wording or incidental behavior in permanent tests.
- Before finishing non-trivial work, run the real path (demo or CLI) and observe the result; tests alone are not proof.
