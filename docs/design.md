# Dynamic operation + target

The input is a natural-language goal. Every page observation builds an indexed table of accessible elements and their current values. One node receives one index, even when it supports both clicking and typing.

One TypeSafe request asks which operation to perform and which target would be appropriate for each available operation. The executor consumes only the target head corresponding to the selected operation. This avoids serial operation-then-target calls and rejects targets incompatible with the operation. Dropdown targets include a code-owned option index.

Operation and target questions receive the same next-step rules. Target criteria include current values and checked/selected state. The questions run independently: a target cannot read the operation answer, so its premise explicitly names the operation it assumes.

TYPE_TEXT types the text the caller gave to `Agent(text=...)`; no model writes field text.

## Runtime

One browser-side DOM snapshot supplies common HTML/ARIA roles, names, values, visible text, and executable targets. A WeakMap gives each actual node a code-owned identity; a Map keeps the live references used for execution. Replaced elements receive new identities, disconnected references are pruned, and navigation starts a new cache. These IDs are not CDP backend node IDs. Geometry is always read again immediately before input.

The model sees visible text. Background focus emulation keeps animation frames running in the owned tab. Screenshots are optional and disabled in library calls by default; `screenshots=True` enables them. The inspector (`demo.py`) passes `screenshots=True`.

Freshness compares semantic state instead of counting DOM mutations. Before a click/select, guards compare the document, full URL, viewport, safe form values/states, selected target, and nearby form/dialog/row context. Text generation, typing, scrolling, waiting, and completion use a full semantic comparison. The executor rechecks target visibility, enabled state, geometry, and click occlusion. Scoped guards intentionally permit unrelated visible content to change; this is a practical heuristic, not proof that arbitrary page changes are irrelevant to the goal.

Browser mutations are not retried by transport recovery. Completed execution is logged before the next observation, including when that observation encounters a navigation. An interrupted native-select evaluation stops because its change event may already have fired. Typing uses a browser select-all command followed by CDP text insertion, so existing input contents are replaced.

The next observation waits for up to two animation frames or 50 ms after an interaction. Editable ARIA comboboxes instead wait for visible options, capped at 200 ms. This avoids paying for a prediction before autocomplete suggestions arrive. An explicit WAIT remains 4.0 s; network loading is never fast-forwarded in the recording.

## What changed after the first demo

The initial prototype used five manually prepared steps and copied quoted strings. That proved finite-choice browser execution but did not demonstrate task decomposition or text generation. The current policy removes that shortcut and uses the original goal throughout. Operation/target distributions replace the old flat-choice/lookahead/Noul arrangement.

The audit also found that treating every INPUT as editable misclassified checkboxes. Editable roles now control TYPE_TEXT availability. Tests cover checkbox/radio/button distinction, invalid operation/target outputs, stale decisions, missing credentials, waits, and final-route verification.

## Finding the product (extension)

Three layers, one attempt each (`extension/src/traderie/finder.js`). (1) Table jump: a name found in `data/items.json` opens `/product/<slug>` directly; the page title must contain the item name as whole words, otherwise the run falls back to layer 2 on the home page. A name that two products share (`Crescent Moon`, `Ward`, `Wirt's Leg`) is never jumped to. (2) Search: Jev types the cleaned English name and picks the result. (3) Base list: only when the results page says "No results could be found" for a well-formed name. The program tries first: `stripToBase` (`lookup.js`) drops leading quality words one at a time ("Rare Ring" -> "Ring") and takes the first remainder that is an exact entry of the fixed base list. This is a program-side rule, sanctioned like the table jump: it chooses search text from a fixed list, never an element or a click, and never filters the page's element list. Only when it finds nothing, `pick_base` asks Jev for the plain item type from the fixed list (TypeSafe allows 255 choices per question, so a long list is split over several questions of one request and the most probable answer wins; below 0.8 it answers "none"). Then one more search; otherwise "not found". A base result is labelled as such because the quality word was not applied.

Model calls per lookup: the table jump costs none; the search layer costs the Jev calls of the Agent loop (a decision that re-asks sends two requests); the base layer costs none when `stripToBase` matched (the backend only checks the name against its own list and swaps the run token) and one request otherwise. All of them count toward the one budget of the run (see Budgets).

The tables are snapshots made by `scripts/build_item_tables.py`, which builds a candidate and replaces the committed table only after the audit (`scripts/audit_item_tables.py`) and a shrink check pass. A table jump that opens the wrong page leaves a note with the running miss count and table age (`tableAge`, stale after 90 days). A stale table only loses the shortcut: names fall back to search, and Chinese names that are not in it are refused before any quota is used.

## Second search: yellow, blue and white items by affixes (extension)

Items without a fixed name have no product page, so the name search cannot find them. The second search (`extension/src/traderie/stats_flow.js`) uses the filters of the D2R home page ("Search All Stats") instead. The player picks "模糊搜尋" on the "今天想搜尋什麼？" screen (contrasting with "精準搜尋" for name search), reads a screenshot (or enters a base and conditions by hand; Traditional Chinese base inputs like 「戒指」 or 「權冠」 are automatically resolved to canonical English bases like "Ring" or "Circlet", the base field is now required), switches on the conditions to use and edits their numbers, then presses start. The program opens the home page, takes Traderie's property list from inside that tab (`properties.js`: the same GET the site makes, kept in `chrome.storage.local` for a week; no property id is written in the code), maps each condition to exactly one property (`stats.js`; a condition with none, or more than one, ends the query before anything is searched), and opens the home page again with the query string.

What `scripts/probe_stats.py` measured on a logged-in dedicated Chrome (2026-10-05) and the code relies on:

- `GET /api/games?game=diablo2resurrected` lists `LISTINGS:STATS`; `GET /api/diablo2resurrected/properties?global=true` answers 200 with 742 properties (652 number, 65 string, 24 bool, 1 array). Both need the page's own cookies and `localStorage.jwt`, so they are read from inside the Traderie tab (`src/jev_ultrafast/traderie/fetch_json.js`); plain downloads get Cloudflare's 403.
- Number properties filter with `prop_<id>Min` / `prop_<id>Max`, yes/no ones with `prop_<name>=true`; the page keeps all of them in its address and shows them in the sidebar.
- Several conditions combine with "and". Measured with a pair that occurs together (FCR + Life): 50 listings on the first page; FCR + Cold Resist: 0 with the site's own "There are no listings"; FCR + an unreachable Life minimum: 0 with the same sentence. So `MAX_CONDITIONS = 8` and more conditions only narrow the list. Caveat: an unreachable minimum on its own (Life ≥ 99999 alone) came back as an ordinary list of 50, so a single absurd number can look unfiltered; the address and sidebar checks cannot tell, the player's own numbers are the only guard.
- Quality is the string property `Rarity` (rare, magic, superior, normal, low quality): yellow is `rare`, blue `magic`, white `normal,superior` (comma list). The first page of each is a plausible list of such items.
- `tags[]=<Item Type>` filters by the sidebar's "Item Type" entries (`tags[]=Ring` lists rings, unique ones included; with `Rarity=rare` only "Ring" items), so a base that is exactly one of those entries is sent as a type, and the list is then cut to the listings whose item has the base's name. Any other base ("Coronet") is only a display filter on the one page the site returns. `search=` (name text) gave 0 listings in every probe and is not used.
- The first page holds 50 listings. More pages are not read.
- A search nothing matches prints "There are no listings" (measured). A sidebar followed only by blank placeholder lines (U+200C) is a list that has not loaded: it is a failed read, never an empty result.
- The affix filter has **no Recent Trades view** (measured 2026-10-09): the filtered home page's 1037 links contain none that reaches one, and it carries only listing markers ("Make an Offer"); applying the product page's `/recent` suffix to the filter URL (`/diablo2resurrected/recent?prop_520Min=1`) lands on the HELP footer with 0 listings and no trade markers; realised prices exist only in a product page's `They Give` block. So the affix search cannot report realised prices — the only values on this path are the asking prices of its one page.

Re-measured 2026-10-13 on the same logged-in dedicated Chrome: every decision above held. The probe's own `TAG_PARAM_WORKS` flag was a false negative until then — it asked whether every listed *name* carries the word "ring", which no page listing uniques such as Angelic Halo or Nagelring can satisfy — and it now compares the listed set with the unfiltered page's instead.

The affix dictionary keeps 40 entries; `unmappedKeys` (tested against the saved real list in `extension/test/fixtures/properties.json`) shows there is a property for each. Number words in a screenshot are only hints (the reader often sees "20%" as "2006" or "20096"), so a captured value is never taken as truth: the reader ticks the attributes it recognised and fills the numbers it read into the form, each marked as coming from the capture so the player confirms or edits it, and the player still presses start. A ticked non-bool condition must carry at least one value (0 counts) before the search starts, while a bool condition needs none and ticking nothing at all stays legal.

## The side panel's screens and state (extension)

One module decides which screen is up: `extension/src/panel-state.js` (pure, no DOM, tested). Everything else renders what
it says. Its inputs are five facts about the panel, and nothing else may decide a screen:

| fact | meaning |
|---|---|
| `settingsOpen` | the settings screen replaces the main area |
| `hasInvite` | an invite code is stored (otherwise the welcome screen) |
| `running` | a query is in flight (the panel's own run, not the scan) |
| `after` | how the last query ended: `"done"`, `"problem"`, `"stopped"`, or `null` when the form is up |
| `mode` | `null`, `"name"`, `"stats"` or `"scan"` (which search the player chose) |

`deriveView` turns those into one of `VIEWS`; `visibleSections(view, hasRows)` turns a view into the sections of the
panel that may show (the results only once a table has rows). Two smaller decisions are pure functions beside it, because
one DOM line cannot be tested: `affixHandoff(shown, source, ended)` (offer the affix search for the item a failed,
scan-sourced query came from) and, in `labels.js`, the two lines the results screen writes above the tables —
`priceSummaryLine` (the asking prices of the rows it read, from `traderie/price-summary.js`) and `sourceLine` (which entry
the query's input came from).

The panel's own mutable state lives in `sidepanel.js` as one flat set of `let`s (`market`, `after`, `banner`, `runSource`,
`quota`, paging per tab…), and its rows are drawn from the same cell arrays CSV and TSV use, found **by column name**
(`rows.js` `reader`, which throws when a column is missing), so the screen, the copy button and the file cannot drift
apart. Modules that import the build product `config.js` cannot be unit-tested in node; today that is only
`sidepanel.js`, which is why the flow logic that can be extracted lives elsewhere (see the remark at the end of this
section).

## Screenshot reader accuracy (extension)

The reader's real accuracy only shows on pictures it was not tuned on. A 54-picture corpus measured 2026-10 with the same matcher (`artifacts/ocr-bench/compare.json`) shows the effect: on the 22 tuned pictures the reader reaches top-1 20 / top-3 21 against an off-the-shelf PP-OCR engine's 19 / 20, but on the other 30 scored pictures, which were never tuned on, it reaches only top-1 18 / top-3 20 against PP-OCR's 23 / 27 — the tuned set hides the gap. `scripts/ocr_e2e.py` therefore scores both groups in the same run: the tuned list `scripts/data/ocr_truth.json` and the held-out list `scripts/data/ocr_truth_holdout.json`, each against the same group of the last accepted `artifacts/ocr-e2e/report.json` (the held-out floor is set by its first accepted run; `--only` skips the held-out group).

The same 54-picture corpus, scored the same way with the repository's own matcher (`extension/src/ocr/match.js`) and the same truth entries, compared the Tesseract.js engine that shipped at the time (`best_int`, integer-quantised, wasm) with an off-the-shelf PP-OCRv6 small engine (PaddleOCR family, Apache-2.0, through `rapidocr`). Tesseract.js has since been removed (`extension/test/ocr-vendor.test.mjs` asserts `extension/src/vendor/` contains only `ort`); the engine that ships now is the PP-OCRv6 small one described at the end of this section:

| group | pictures | Tesseract top-1 / top-3 | PP-OCR top-1 / top-3 |
| --- | --- | --- | --- |
| tuned (`scripts/data/ocr_truth.json`) | 22 | 20 / 21 | 19 / 20 |
| held-out (`scripts/data/ocr_truth_holdout.json`) | 30 | 18 / 20 | 23 / 27 |
| all scored | 52 | 38 / 41 | 42 / 47 |
| screenshots | 36 | 29 / 32 | 31 / 34 |
| phone photos | 16 | 9 / 9 | 11 / 13 |

Tesseract produced no candidate at all on 7 of the 52 scored pictures, PP-OCR on none. Per picture PP-OCR fixed 8 and broke 2, and both regressions are matcher-side rather than reading errors: `image-1` (it read 「格里斯瓦德的榮耀」 correctly, but `item:Griswold's Honor` never became a candidate) and `image-34` (it read the jewel's random name 「防禦者的火焰」 correctly, and the matcher preferred that over the correct `base:Jewel`, the known random-name collision).

A browser spike (throwaway unpacked MV3 extension, everything under the git-ignored `artifacts/ocr-spike/`) then showed the same PP-OCRv6 small models run inside an extension page through onnxruntime-web 1.30.0, self-hosted — the MV3 CSP `script-src 'self' 'wasm-unsafe-eval'` forbids remote scripts — with no native helper and no server. On 10 corpus pictures, Chrome 154 headless, 12 logical CPUs and an Intel gen-12lp iGPU:

- text faithful to the Python run: 209 lines both, identical line count on 10/10 files, 196/209 lines identical after whitespace normalisation and 4/10 files byte-identical; the 13 differing lines are ±1 px crop-boundary effects (dictionary, resize policy and the cls stage were ruled out with a stage-by-stage oracle);
- cold start 6.0 s (wasm 1 thread) / 7.2 s (wasm 4 threads) / 12.0 s (WebGPU first);
- per picture: wasm 1 thread 7.1 s mean, wasm 4 threads 5.8 s, WebGPU 3.3 s mean and 2.6 s once the first picture had paid pipeline compilation; the Python native-ORT reference on the same machine was 6.2 s;
- WebGPU exists and is used in an extension page (per-node EP attribution is not exposed by onnxruntime-web); peak JS heap about 336 MB (wasm) to 460 MB (WebGPU);
- assets (spike measurement, now superseded): the spike measured models 31.7 MB plus onnxruntime-web wasm/jsep 42.6 MB, about 74 MB, and assumed all of it had to ship inside the package because the CSP only loads scripts and wasm from `'self'`. That is no longer how it ships: the models are **not** packed — they download once from modelscope into IndexedDB (~31.8 MB, `extension/src/ocr/models.js`, `PPOCR_BYTES = 31824456`) — and the vendored ORT is ≈28 MB, the jsep pair only (`ort.min.mjs` plus the `ort-wasm-simd-threaded.jsep.mjs`/`.wasm` pair; `extension/src/vendor/ort/VERSIONS.json` records each file's size and SHA-256), the plain wasm pair having been deleted so only the jsep pair ships.

Scored on the full 54-picture corpus with the repository's own matcher, the browser PP-OCRv6 small reaches top-1 20 / top-3 21 on the tuned pictures and 22 / 26 on the held-out ones — 42 / 47 across both (Tesseract.js 38 / 41) — plus 30 / 33 on screenshots and 12 / 14 on phone photos, with no scored picture coming back empty. The two regressions (`image-1`, `image-34`) are matcher-side, not reading errors, and are out of scope. Speed on the same 54 pictures (headless Chrome 154.0.8037.58, Windows 10.0.26200, 12 logical cores, Intel Gen-12LP iGPU): wasm 1 thread cold start 10.0 s, 4.87 s per picture mean, 263 s total; WebGPU cold start 12.8 s, 1.81 s per picture mean, 1.19 s median, 98 s total; peak JS heap 511–548 MB.

Two loader gotchas worth knowing for our own Chrome scripts: branded Google Chrome 137 and later ignores `--load-extension` (use `--enable-unsafe-extension-debugging` plus the experimental CDP command `Extensions.loadUnpacked`), and `/json/list` lists built-in component extensions, so an extension id must be pinned in the manifest (`key`).

Because `artifacts/` is git-ignored, this section carries the numbers themselves: the raw evidence (`artifacts/ocr-bench/`, `artifacts/ocr-spike/`) is not committed. The engine is now PP-OCRv6 small through onnxruntime-web, one engine only: WebGPU when available, otherwise wasm/1 thread.

## Budgets

| Where | Actions | Jev calls |
| --- | --- | --- |
| Core demo and CLI (`Agent`, `MAX_STEPS` in `config.py`) | 60 actions | 120 decisions (`MAX_STEPS * 2`; a decision that re-asks sends two requests) |
| Extension (`extension/src/agent.js`) | 60 actions (`MAX_STEPS`) | 30 Jev calls per run (`JEV_CALL_LIMIT`; a re-ask counts as two, and a step is only started when both fit) |
| Backend (`services/jevsvc/app.py`) | none (the client acts) | 30 model calls per run (`MAX_MODEL_CALLS`; `choose`, its re-ask and `pick_base` all count) |
| Extension, stats search (`extension/src/traderie/stats_flow.js`) | none (the program opens the address) | 0 (no Jev, no backend) |

The core demo allows more calls than the extension and backend. Whether the numbers should be unified is an open decision; they are kept as measured values until then.

## Search timing (extension): measurement and floors

The timeline recording is measurement only: recording changes no control flow, model call, fingerprint or backend request, and `mark`/`timed` never alter the work they wrap. The one deliberate wait change in this work is the `NAVIGATE_INTERACTIVE_GRACE_MS` value described below; nothing else in the timing work changes a duration. `extension/src/timeline.js` (`newTimeline`, `mark`, `timed`) records per-stage timings on the session; the panel publishes the last run at `globalThis.__jevLastRun` (`{timeline, history, decisions, rule_events, stale_events, visibility}`, `extension/src/sidepanel.js`). `scripts/extension_e2e.py` prints the stage table and writes the raw record to `artifacts/perf/run-<timestamp>.json`; `scripts/extension_batch.py` reads the same record through its `SNAPSHOT` into `results.jsonl`.

Floors (measured 2026-10 with real Chrome in a wide, visible window; per-run variance is large — a single run is ±1-2 s, so only medians are worth reading):

- Name search, table jump, `load_more = 0` (the extension's default, `sidepanel.js`): total ≈ 6.8 s — open_tab 2.8 s (navigate 0.62 s as `complete` + settle 2.1 s), check_landing 0.51 s, make_agent 0.03 s, agent loop 3.4 s (1 Jev step), view reads 0.52 s + 0.93 s, close 3 ms.
- Name search with `load_more = 2` (`scripts/extension_e2e.py` defaults to this): total ≈ 14.6 s median; the two extra Load More batches account for ≈ 7.8 s (~53%). The 載入更多 setting is the dominant knob, not the code.
- Stats search (no Jev, no quota): total ≈ 6.0-6.5 s — home load 2.7-3.1 s, home read 0.51 s, filtered navigate 0.37 s, settle 1.9 s, list read 0.53 s. `readStatsView` always passed on attempt 1 in every measured run. The 2.7-3.1 s home load is paid only when the Item Type list is not stored: a stored list (kept for a week like the property list, `extension/src/traderie/item-types.js`) skips that load entirely, so a query inside the week starts from the filtered address instead.

`NAVIGATE_INTERACTIVE_GRACE_MS = 500` (`extension/src/cdp.js`) is how long `readyState` may stay `interactive` before `navigate` stops waiting for `complete`. An interleaved A/B (500 vs 1500 ms, 3 runs each, alternating so profile cache and network drift cancel) showed the grace binding in 1 of 3 runs; a bound navigate returned in ~1.08 s at 500 ms against ~1.85 s at 1500 ms (~1 s), while the query total stayed within noise. The 1500 → 500 change is latency-only and must not be claimed as a whole-query win.

Measured and rejected, so future work does not repeat it: the minimized query window is not timer-throttled (`document.visibilityState` was `visible` in every run); the DONE/BLOCKED freshness gate is exercised but stayed cheap — in the default `load_more = 0` run the agent made 3 decisions (DONE in `trading`, CLICK `Recent Trades`, DONE in `recent_trades`) and `stale_events` stayed `{}`, so the gate did not fire; `phaseFinishRule(0)` is null (`site.js`), so the phase ends through Jev's DONE rather than a rule, and a DONE choice is not written to `history` (it returns before the push, which is why that run shows 1 history step). Its only fixed cost is one `tab.fresh()` evaluate per DONE, and a re-ask only happens when the page actually changed, which was not observed; two observed DONEs are evidence that the gate is cheap, not proof that it can never fire; `readStatsView`'s 1500 ms retry sleep never mattered (the first attempt passed every time); starting `startRun` concurrently with `Tab.open` would save only ~8 ms (`start_run` 6-300 ms across runs against open_tab 2.8-4.7 s); `tab.close` is 3 ms, so rendering the results before it is pointless.

Measured and rejected, so future work does not repeat it: blocking ad/tracker hosts in the extension's own query tab (AGENTS.md blocks them only in the dedicated Chrome). `scripts/probe_blocking.py` toggles the dedicated Chrome's own block list on the same filtered affix address and compares strictly alternating ON/OFF pairs, checking first that the blocked-host scripts really did land inside the settle window (its premise). Four runs: the first was inconclusive because its toggling did not take effect in every ON run (fixed); the second paired median (215 ms) sat inside the run-to-run spread (±262 ms); a 5-pair run looked encouraging (4 of 5 pairs faster, paired median 888 ms, about 33% of the OFF settle, navigate 437 against 766 ms); and a **12-pair run found no effect at all** - settle median **1695 ms ON against 1699 ms OFF (4 ms)**, only 4 of 12 pairs faster, the per-pair deltas scattered from -97 to +81 ms (median -10 ms), navigate 375 against 359 ms, no settle cap on either side. So the settles on this path are Traderie's own churn, not the ad hosts': the premise held (the ad scripts did land during the settle) yet removing them changed nothing measurable, and a permission in the extension would buy nothing - the earlier 5-pair result was that sample's luck. The raw per-run records, with what each run loaded and when, are under the git-ignored `artifacts/blocking/`, the way this file's other measurements are kept. (The other item here, caching the Item Type list, was decided on 2026-10-13 and is implemented: see the stats timing bullet above.)

## Fixed defects: stale retries, challenge detection, login, e2e evidence

Three real defects were found and fixed in one session (2026-10); the rules in `AGENTS.md` keep them from coming back. The measurements are recorded here because `artifacts/` is git-ignored.

- Stale retry bound (extension, `extension/src/agent.js`): `MAX_STEPS` reads `history.length`, and a stale click never executes, so nothing is pushed to `history`; `_finishPhaseByRule` counts only executed presses too. Before `STALE_RETRY_LIMIT = 3` the mechanical loading rule could therefore retry a covered element forever. Measured: 1379 `StalePage` events in 177 s (~7.8/s), the page's own click counter stayed 0, the panel froze at 「進行中，已操作 1 步」 and `__jevLastRun` was never published; the model-path face of the same defect asked Jev **29 times in ~9 s** before the 30-call cap stopped it. After the bound, the rule path ends in 8–24 s with **1** `/api/choose`, the model path in ~7 s with **3** chooses. `state.attempts` counts every action attempt (executed or stale) and `_prepareAction`'s bound is `history.length >= MAX_STEPS || attempts > MAX_STEPS`; both halves are needed or a covered element stops counting toward the step budget.
- Challenge guard (extension, `extension/src/traderie/site.js`): the extension's `page.text` comes from the snapshot, which covers only the visible viewport. A normal logged-in product page measured **1998 chars** and contained Traderie's own changelog line "Fixed captcha bugs when going between games", so the old bare-word test fired and `sidepanel.js`'s `judge()` showed 「Traderie 要求驗證或登入…防護頁/驗證碼」 instead of the run's real stop reason. `CHALLENGE_TEXT_MAX` (under it) plus `TRADING_MARKERS` ("Trading For" / "Make an Offer") make the bare word count only on a page that looks like a challenge; the explicit signals and the `CHALLENGE_FRAMES` probe are unchanged. The Python twin (`src/jev_ultrafast/traderie/site.py`) reads the whole-page `innerText` and needs no guard.
- Login wait (extension-side one-time login, `scripts/login.py`): a bare `input()` on a stdin that cannot wait (EOF, redirected) returned instantly and the `finally` closed the window before the human could log in (reproduced: `EOFError`, window gone in ~7.4 s). The wait now polls `LOGGED_IN_JS` (host `traderie.com` and `readyState === "complete"` and a non-empty body and no `Log In` link left) and the window stays open until a login is detected, Enter is pressed, or `JEV_LOGIN_WAIT_SECONDS` (default 600) is reached, which prints a clear Traditional-Chinese message and exits 1.
- e2e evidence (`scripts/extension_e2e.py`): a hung query used to leave no per-step record. The local backend's stdout is now mirrored to the git-ignored `artifacts/perf/backend-<timestamp>.log` (one `choose inv=… rid=… calls=… in=… out=…` line per answered Jev step; the path is printed at the end), each changed 3 s sample prints a progress line (including the panel's step counter and its last 4 decisions), a failed sample is counted and reported (`取樣：成功 N 次、失敗 M 次`), and `--timeout` (default 300) bounds the run.

Measured in the same session, about that stop: it was true but not actionable, because the element that could not be operated was under a modal. Traderie's Patch Notes pop-up is a `position: fixed; z-index: 100` box covering the whole viewport, so the target's centre point never resolves. A probe made **43 dismissal attempts** and only a **real mouse click** on the × dismissed it: the click listener sits on the inner `svg`, so a synthetic `element.click()` on the div does nothing, and the × is `#close-modal > svg` — a plain `div` wrapping one `svg`, with no role, no `aria-label`, no `title` and no text, so the generic observation path cannot name it. Dismissing it once sets `localStorage.whatsNewOpen`, and Traderie then keeps the pop-up away across reloads and Chrome restarts. The agent therefore gained **no** site-specific click for it: the stop instead *measures* the generic situation (`src/jev_ultrafast/covered_overlay.js` through `Tab.overlayCover`: the failed target's centre is covered and the covering element's nearest positioned ancestor is `position: fixed` and covers at least 90% of the viewport) and, only then, replaces the stop reason with an actionable Traditional-Chinese message telling the player to close the pop-up; when the measurement says nothing or fails, the message and the stop are exactly as before.

## Boundaries

Up to 250 action candidates are retained; truncated candidates cannot be selected. The service stays loopback-only, serializes inspector actions, and checks Host, Origin, and a local request token. Credentials remain server-side. Tabs run in the dedicated Chrome's profile (`src/.tmp-jev-chrome`, git-ignored; in `JEV_CHROME=existing` mode in the user's own Chrome profile, which is then the one being driven).

The policy is generic, but two websites do not establish broad reliability. Name resolution covers common labels, ARIA references, and text; it is not the browser's full accessibility algorithm. Shadow roots, frames, canvas, uploads, nested scrolling, pop-ups, and complex keyboard interactions can block progress. A valid action can still be wrong. Independent checks, rather than the model's DONE choice, determine whether the demonstrated task succeeded.
