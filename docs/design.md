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

Items without a fixed name have no product page, so the name search cannot find them. The second search (`extension/src/traderie/stats_flow.js`) uses the filters of the D2R home page ("Search All Stats") instead. The player reaches the affix form from a scan record's "模糊搜尋" button (which starts the query at once with the base and the quality, no affix conditions) or by pasting a screenshot, reads a screenshot (or enters a base and conditions by hand; Traditional Chinese base inputs like 「戒指」 or 「權冠」 are automatically resolved to canonical English bases like "Ring" or "Circlet", the base field is now required), switches on the conditions to use and edits their numbers, then presses start. The program opens the home page, takes Traderie's property list from inside that tab (`properties.js`: the same GET the site makes, kept in `chrome.storage.local` for a week; no property id is written in the code), maps each condition to exactly one property (`stats.js`; a condition with none, or more than one, ends the query before anything is searched), and opens the home page again with the query string.

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

The panel's mutable state is split by owner. `sidepanel.js` keeps the query lifecycle (`market`, `after`, `banner`,
`running`) and wires four modules that never import it and keep their state in closures: `invite-state.js` (code, quota,
block reason), `listing-screen.js` (the TR交易 form and the one post), `screen-flow.js` (`queryMode`, `runSource`, hand-offs)
and `results-view.js` (tab, paging, filters). Its rows are drawn from the same cell arrays CSV and TSV use, found **by column name**
(`rows.js` `reader`, which throws when a column is missing), so the screen, the copy button and the file cannot drift
apart. Modules that import the build product `config.js` cannot be unit-tested in node; today that is only
`sidepanel.js`, which is why the flow logic that can be extracted lives elsewhere (see the remark at the end of this
section).

## Screenshot reader accuracy (extension)

The reader's real accuracy only shows on pictures it was not tuned on. A 54-picture corpus measured 2026-10 with the same matcher (`artifacts/ocr-bench/compare.json`) shows the effect: on the 22 tuned pictures the reader reaches top-1 20 / top-3 21 against an off-the-shelf PP-OCR engine's 19 / 20, but on the other 30 scored pictures, which were never tuned on, it reaches only top-1 18 / top-3 20 against PP-OCR's 23 / 27 — the tuned set hides the gap. `scripts/ocr_e2e.py` therefore scores both groups in the same run: the tuned list `scripts/data/ocr_truth.json` and the held-out list `scripts/data/ocr_truth_holdout.json`, each against the same group of the last accepted `artifacts/ocr-e2e/report.json` (the held-out floor is set by its first accepted run; `--only` skips the held-out group).

Note (2026-10-22): every "54 pictures" / "54 truth pictures" / "54 stored reads" figure in this document (counts, accuracy, latency medians, hold-out splits) was measured on the earlier 54-picture set. The corpus is 50 pictures now (20 in `scripts/data/ocr_truth.json`, 30 in `scripts/data/ocr_truth_holdout.json`): the four phone photos IMG_0340.jpg, IMG_0379.jpg, IMG_0401.jpg and 6C7899AD-A65C-4F2F-B9E6-8E0C4C4AECE8.jpg were removed from the working tree. The historical figures are kept as measured.

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

Scored with the repository's own matcher, the browser PP-OCRv6 small reaches, on the accepted baseline of 2026-10-13 (`artifacts/ocr-e2e/report.json`, the file both groups' floors are read from), top-1 21 / top-3 22 on the tuned pictures (22 scored) and top-1 22 / top-3 29 on the held-out ones (30 scored) — 43 / 51 across both — plus 35 / 36 on screenshots and 16 / 16 on phone photos, with no scored picture coming back empty. The held-out group's one miss (`image-58`) matched a base instead of the item and the tuned group had none — recorded then as matcher-side and out of scope; the reader side turned out to be the real cause (its long name line was read as "0-" by the port's detector/direction arithmetic, found and fixed 2026-10-18, see "The name line read as 0-" below, where it now fills by itself). (The older 54-picture engine comparison above - PP-OCRv6 42 / 47 against Tesseract.js 38 / 41 - is that experiment's own record, kept for the reasoning it settled.) Speed on the same 54 pictures (headless Chrome 154.0.8037.58, Windows 10.0.26200, 12 logical cores, Intel Gen-12LP iGPU): wasm 1 thread cold start 10.0 s, 4.87 s per picture mean, 263 s total; WebGPU cold start 12.8 s, 1.81 s per picture mean, 1.19 s median, 98 s total; peak JS heap 511–548 MB.

Two loader gotchas worth knowing for our own Chrome scripts: branded Google Chrome 137 and later ignores `--load-extension` (use `--enable-unsafe-extension-debugging` plus the experimental CDP command `Extensions.loadUnpacked`), and `/json/list` lists built-in component extensions, so an extension id must be pinned in the manifest (`key`).

Because `artifacts/` is git-ignored, this section carries the numbers themselves: the raw evidence (`artifacts/ocr-bench/`, `artifacts/ocr-spike/`) is not committed. The engine is now PP-OCRv6 small through onnxruntime-web, one engine only: WebGPU when available, otherwise wasm/1 thread.

### Unsure reads ask the player (measured 2026-10-13, offline)

`decideCandidates` (`extension/src/ocr/match.js`) says whether the best candidate may be filled in without asking. The rules were scored without Chrome: `matchOcrText` over the stored OCR text of the 54 truth pictures in `artifacts/ocr-e2e/report.json` (browser engine, 24 + 30 rows; it reproduces the report's own candidate lists on 53 of 54 rows, the 54th differs in the order of its 2nd/3rd name because the stored text is cut at 400 characters) with the shipped `items.json`; 52 are scored, 2 are marked skip (name unreadable, not scored). A "wrong" fill is a best candidate that is not the truth; "asks" is the reads on which the panel shows decision buttons instead of filling.

| rule | wrong filled | right filled | asks (answer among the buttons) |
| --- | --- | --- | --- |
| none, as before (always fill the best) | 9 | 43 | 0 |
| ask when an item has a type line (a base candidate) under it | 1 (image-58) | 19 | 32 (32) |
| ask when the best item's name is 3 characters or less | 4 | 38 | 10 (10) |
| the same, and when the best item's edit distance is 2 or more | 3 | 38 | 11 (11) |
| ask when the best candidate's distance is 1 or more | 8 | 40 | 4 (4) |
| distance rule above and a base-only list of 3 names | 2 | 38 | 12 (11) |
| distance rule above and a base-only tie at the same distance | 2 | 35 | 15 (14) |
| distance rule above and any tie between the best and the second | 1 | 20 | 31 (30) |
| **shipped**: ask for an item with a type line or a name of 3 characters or less, and for 3 or more type names | **0** | **19** | **33 (32)** |

(Corrected 2026-10-13, see "Tuning pass" below: image-32, image-34 and image-46 are real uniques, not rare collisions.) The nine wrong fills of "as before" are image-20/41/46 (a rare ring whose random name is also a unique or runeword: Splendor, Plague, Opalvein), image-32 (Dreadfang), image-34 (a rare jewel named like Defender's Fire), image-37 (Amulet Of The Viper matched at distance 2 through the type word only), image-43/52 (stat words Strength and Ice matched as short item names) and image-58 (the unique's name line was never read; only the type line gave three bases). Of the two skip pictures, as before fills both; the shipped rule fills image-3 (a base) and asks on image-9. The weak signals alone cannot reach zero: image-34 and image-46 are a strong unique name at distance 0 with a single type line under it, which is byte-for-byte the shape of image-15 (Arachnid Mesh), image-54 (Raven Frost) and image-5 (Mara's Kaleidoscope), so the only rule that never fills a wrong name on these 54 asks for every item with a type line; that is 24 right fills given up (33 asks, 9 of them wrong guesses). The looser line (distance rule + base-only with 3 names) fills 38 right and 2 wrong and asks 12; it is one clause away and is the choice to revisit if asking is felt as too often. Check on a second, untuned reading of the same pictures (`artifacts/ocr-bench/ppocr.json`, the rapidocr engine's text, not used to choose anything): as before 9 wrong / 43 right; shipped 0 wrong / 18 right / 34 asks (34 with the answer among the buttons); the looser line 3 wrong. The three-type-names clause is fitted to image-58 alone and is kept because it costs no other ask on either reading.

Real Chrome (`scripts/ocr_e2e.py`, 2026-10-13) gave the same counts through the panel itself: tuned group 22 scored, 12 asked, 10 filled right, 0 filled wrong; held-out group 30 scored, 21 asked, 9 filled right, 0 filled wrong; top-1/top-3 unchanged at 21/22 and 22/29 (the unsure reads are scored on their decision buttons, in the matcher's order).

### Tuning pass: why the reader asked so often, and what changed (measured 2026-10-13)

The owner felt the success rate and the precision were low. Before this pass the reader asked the player on 33 of the 52 scored pictures (tuned 12, held-out 21) and filled a name by itself on 19, and its first candidate was right on 43 of 52 (tuned 21/22, held-out 22/30 against the labels then in the truth files).

**Four truth labels were wrong.** The earlier sections of this document call image-34 (Defender's Fire), image-46 (Opalvein) and image-32 (Dreadfang) rare items whose random name collides with a catalogue unique. They are real uniques of the Reign of the Warlock expansion (Defender's Fire: a unique jewel, diablo.fandom.com/wiki/Defender's_Fire; Opalvein: a unique ring with 2% level 15 Flame Wave on attack and +10% FCR, d2rotw.org/items/opalvein; Dreadfang: a unique Legend Sword, d2emu.com/db/unique/dreadfang), the properties on the pictures are theirs, and their name lines are printed in unique gold (image-34 192,172,112, the same as Rainbow Facet's 198,178,120). IMG_0401 prints 盜賊皇冠 with a unique's roll tag [12LL|200ED|100EG]: Crown Of Thieves, a unique Grand Crown, labelled "base Grand Crown" because the engine had read it as 盗贼皇冠. All four are corrected in `scripts/data/ocr_truth.json` and `ocr_truth_holdout.json` (kind `item`, with a `note`). Numbers below use the corrected labels, and the old-label numbers are given beside them; under the old labels the reader now "fills three wrong names" (IMG_0401, image-32, image-34), which are in fact right. This also means the type-line clause of the unsure rule had no real collision behind it: in the corpus no unique-shaped read (strong name at distance 0 with a type line under it) is a rare item.

**Phase 1: root causes** (original matcher over the stored OCR text of the browser engine, reproducing the report's candidate lists on 52 of 52; 52 scored pictures, corrected labels):

| cause | pictures | which |
| --- | --- | --- |
| sure and right | 18 | image-1/4/6/7/11/13/14/16/35/38/39/42/47/49/50/56/57 and the phone photo of a coronet |
| asked although the first candidate was right: a unique or set name read exactly (distance 0; 12 and 31 at distance 1) with its type line under it, or a name of 3 characters or less - the decision rule | 27 | image-2/5/8/10/12/15/17/18/19/31/32/33/34/36/40/44/45/46/48/51/53/54/55/59/60, IMG_0340, IMG_0379 |
| the right name was read, the matcher put a wrong candidate first: a short name glued into a longer run (Splendor in 燦爛戒指, Plague in 瘟疫之圈), a stat word (Strength in 需要力量, Ice in 寒冰彈), a type word 2 edits from a unique (護身符 vs Amulet Of The Viper) | 5 | image-20, 41, 43, 52, 37 |
| the name line was never read by the browser engine (the Python PP-OCR run on the same picture reads 杜墨菲斯托斯学術 whole; fixed 2026-10-18, see "The name line read as 0-" below) | 1 | image-58 |
| the name was read in simplified glyphs (盗贼皇冠), nothing matched, a base was filled in by itself | 1 | IMG_0401 |

The reading itself is the cause of 2 pictures in 52 (image-58, IMG_0401); two more reads have one wrong character (image-12, image-31) and cost nothing. No name is missing from the Chinese table, and no type line was lost. So the low "success" came from the decision rule (27 needless asks) and from the matcher's ranking (5), not from the OCR text, and no engine-side experiment (cropping the name lines, upscaling, contrast, a second recognition) was run: its precondition, a meaningful share of OCR-caused misses, is not met.

**Changes** (each general; no image or item is named in code):

1. **The colour of the name line is evidence.** D2R prints a name in the colour of its quality: unique and runeword gold, set green, rare yellow, magic blue. `inkTone` (`ppocrlib.js`) measures the lettering colour of every recognised line, `toneQuality` (`tone.js`) classifies it, `matchOcrText` gives each candidate the quality of its own line, and `decideCandidates` lets a gold or green name through even with a type line under it (a name of 3 characters or less also needs that type line; yellow, blue, white and unreadable colour still ask). Measured on the 52 pictures: every unique, runeword and set name line is gold or green (tan 192-208,172-192,112-142; cream 235-254,226-251,174-200; green 0,251,0), every rare line is yellow (hue 59-62, saturation 0.36-0.61; one rare amulet photographed as 242,221,86 is neither yellow nor gold), every magic line is blue (hue 240). The one weak margin is saturation 0.27 (palest unique cream) against 0.36 (palest rare yellow), a phone photo; one phone photo of a unique (image-46) came out white (saturation 0.08), and asks.
2. **A short name glued into a longer run does not count when a type line is in the picture** (`exactWeak` needs a line of its own): fixes image-20/41/43/52 (top-1 now the type line).
3. **A line that is exactly a type word is the type line, not a misspelt item name**: fixes image-37 (Amulet Of The Viper at distance 2 through the line 護身符).
4. **Simplified glyphs are turned back to traditional** before matching (`simplified.js`, 407 pairs generated from the characters of the shipped Chinese names; a simplified form that is also a table character is left out): IMG_0401 reads Crown Of Thieves, 殺手护盔 is a distance-0 base.

Per-rule ablation on the stored texts (final code with one rule removed; tuned / held-out; top-1/top-3, asked, filled right, filled wrong; corrected labels):

| variant | tuned | held-out |
| --- | --- | --- |
| **final** | 22/22, asked 0, right 22, wrong 0 | 29/29, asked 2, right 28, wrong 0 |
| without 2 (glued short names) | 21/22, asked 1, right 21, wrong 0 | 25/29, asked 6, right 24, wrong 0 |
| without 3 (type-word line) | 22/22, asked 0, right 22, wrong 0 | 28/29, asked 3, right 27, wrong 0 |
| without 1 (colour decision) | 22/22, asked 12, right 10, wrong 0 | 29/29, asked 17, right 13, wrong 0 |
| without 1's short-name clause | 22/22, asked 2, right 20, wrong 0 | 29/29, asked 6, right 24, wrong 0 |
| without 4 (simplified glyphs) | 21/21, asked 0, right 21, wrong 1 | 29/29, asked 2, right 28, wrong 0 |
| the code before this pass | 20/21, asked 12, right 9, wrong 1 | 25/29, asked 21, right 9, wrong 0 |

(Held-out top-3 is 29 of 30 scored everywhere: image-58's name line is not in the text — true when this was written; the reader reads that line since 2026-10-18, see "The name line read as 0-" below, where the held-out group reads top-1 30 / asked 1.) Under the old labels the code before this pass reads 21/22 and 22/29 (asked 12 and 21, right 10 and 9, as in the accepted report) and the final code 21/22 and 26/29.

**Real Chrome** (`scripts/ocr_e2e.py`, the same numbers the stored texts give offline): tuned 22 scored, top-1 22, top-3 22, asked 0, filled right 22, filled wrong 0 (before: 21, 22, 12, 10, 0 under the old labels); held-out 30 scored, top-1 29, top-3 29, asked 2, filled right 28, filled wrong 0 (before: 22, 29, 21, 9, 0 under the old labels, 25/29 with the corrected labels). Seconds per picture: screenshots 2.6 (tuned) and 2.8 (held-out) against 2.3 and 2.5 before, phone photos 5.3 and 4.9 against 4.9 and 4.5 (the colour measurement is one pass over the front 40% of every crop, about +10%, part of it run-to-run noise). Three Chrome runs were used: (1) matcher rules 2 and 3 with a temporary hook that stored every line's colour in the report (`report.matcher-and-tones.json`: tuned 22/22 asked 10, held-out 26/29 asked 14 under the old labels, 0 wrong fills); (2) the colour plumbed through engine, panel and scan with a first decision rule (`report.experiment2.json`, corrected labels: tuned 21/21 asked 2 with 1 wrong fill, IMG_0401 read as a base because of its glyphs; held-out 29/29 asked 6, 0 wrong); (3) the final code (`report.json`, copied to `report.after-accuracy.json`). The baseline is `report.before-accuracy.json`; all of them are git-ignored files under `artifacts/ocr-e2e/`.

Rejected on the way (each measured offline on the stored texts): making the glued-name rule global (glue 0 for every short name) broke a pinned case (a noisy run around 放血者 and 煙霧 still read) and was narrowed to the case where a type line is in the picture; reading the same item twice (the Chinese and the English name, or the name on two lines) as evidence saved 4 asks, but all four are gold-lettered, so with the colour it saved none and was removed; the first colour measurement took the mean of the whole line and was pulled to salmon by red roll tags ([120ED]) on four unique lines (image-15/32/54, IMG_0379) before it was limited to the front 40% with red pixels left out.

**What it does not fix.** image-58 (the browser engine read its long name line as "0-"; the Python run reads it: a difference of the port's detector boxes, found and fixed 2026-10-18, see "The name line read as 0-" below, so this clause no longer holds); image-46 (a phone photo washes a unique's gold out to white, so it asks); a name of a unique, runeword or set that is also printed on a rare item in gold is not detectable by text or colour (none in the 52); a modded tooltip that recolours names, or a colour-blind mode, makes every read ask as before (the colour is only ever a reason to fill, never to refuse). Residual ask rate: 2 of 52 scored pictures (3.8%), against 33 of 52 (63%) before.

### The alias table: game-side variant glyphs and translations (measured 2026-10-16, offline)

The game prints variant glyphs or older translations the item table does not list, and a read could then flip between "sure, auto-filled" and "unsure, asks the player" depending on how the rest of the line landed inside the matcher's edit-distance tolerance. `ALIASES` in `extension/src/ocr/match.js` maps the *variant form to the table's form* and is applied where `toTraditional` runs, before any comparison. The entries are glyph- or word-level, never per-item, and every entry needs a corpus hit (a stored OCR text in `artifacts/ocr-e2e/` that matches a table name only through it); after adding one, replay the stored corpus and the unit tests: no scored row may change its answer except the one the alias fixes.

| entry | kind | corpus evidence |
| --- | --- | --- |
| 註 → 注 | glyph pair | image-31 reads 基德的賭註 (the game's form, 言部), the table lists 基德的賭注 (Gheed's Wager); no other table name contains 注. The item was read and correct in every report, but flipped between sure and unsure across report versions. |
| 安達莉爾的面容 → 安達莉爾的面貌 | word pair | image-12 reads 安達莉爾的面容 (Andariel's Visage; the OCR turns the game's 貌 glyph into 容), the table lists 安達莉爾的面貌. Kept as a whole word, not a bare 容→貌 rewrite, because the table also lists 面* names that genuinely end in 容 (亞瑞特的面容 Arreat's Face, 赫拉森的面容). |

Corpus sweep (the same scan over all 54 stored texts and the off-the-shelf PP-OCR reference `artifacts/ocr-bench/ppocr.json`, one different character against every table name) found only these two unexplained near-misses; the others are known shapes the matcher already handles (glued tags like 阿爾發頭盔擴, the separator 鎖錬靴→鎖鍊靴 inside tolerance, an OCR-misread 吸血鬼王之圈 that still matches at distance 1, the simplified 带→帶 pair already in `simplified.js`, and single-character noise). With the two aliases the stored corpus is unchanged everywhere else: tuned 22/22 (asked 0, auto_wrong 0), held-out 29/29 (asked 2, auto_wrong 0), the same numbers as before — the aliases only make image-12 and image-31 robust instead of tolerance-dependent.

### Name-colour sampling: does a 1–2 px crop shift flip the colour? Measured 2026-10-18: no; the proposed trimming is rejected

**Question.** `inkTone` (`ppocrlib.js`) averages the pixels within 15 % of the peak level (top 5 % by strongest channel) over the front 40 % of the crop. The suspicion was that edge and background pixels at the crop boundary move that average when the crop shifts 1–2 px, so a cream-gold unique (saturation ≈ 0.24–0.28) could cross `CREAM_MAX = 0.31` into rare yellow (≥ 0.36), and that a trimmed mean (brightest ~50 % of the survivors) or a higher within-peak floor (0.85 → 0.92) would fix it. The owner had seen 15 items flip between auto-fill and ask across report versions.

**How it was measured** (throwaway harness under the git-ignored `artifacts/twofix/`, nothing of it ships). The real `inkTone` cannot see the det boxes without the pixel pipeline, so the real extension ran in the dedicated Chrome: the real WebGPU engine detected the 54 truth pictures and the real `getRotateCropImage` cut the crops of the first three boxes of each picture with the quad moved by every (dx, dy) in −2…+2 px (25 windows, 1 350 crops per box); a Node script then ran the real `inkTone` and the variants on those same pixels and classed each tone with the real `toneQuality`. The unshifted tones reproduce the accepted report's tones bit for bit. A second, harsher test cut axis-aligned windows from the picture itself (117 boxes; the 45 rotated boxes of the phone photos are only in the first test) with a shift of ±2/±3 px *and* the box growing or shrinking by ±1…±3 px (the detector's `unclip` jitter).

| sampling | classes changed over the 25 windows (54 pictures, first box) | …boxes 2 and 3 | shift ±2, grow ±2 (117 boxes) | shift ±3, grow ±3 | unshifted class moved (a band edge moved) |
| --- | --- | --- | --- | --- | --- |
| **current** (floor 0.85, mean of all survivors) | **0** | 0 / 0 | **1** (image-12, gold ↔ no colour) | 9 | – |
| floor 0.92 | 0 | 0 / 0 | 2 | 10 | image-37, box 3 |
| floor 0.90 | 0 | – | 1 | 10 | image-37, boxes 2 and 3 |
| trimmed mean, brightest 50 % | 0 | 0 / 0 | 3 (adds image-11 yellow → **gold**, image-48) | 11 | image-37, boxes 2 and 3 |
| trimmed 30 % | 0 | – | 3 | – | image-37, boxes 2 and 3; image-58 gold → none |
| trimmed 50 % + floor 0.92 | 0 | 0 / 0 | 3 | 11 | image-37, boxes 2 and 3 |

The mean saturation spread of the current sampling over the 25 windows is 0.0066 (first box), 0.013 (second), 0.0048 (third); the largest is image-10's 11-px-high crop at 0.137 (a one-pixel move down cuts the bright top row, the tone falls from 252,246,183 to 183,167,113, which is darker and *lower* in hue, so it stays gold). No variant has a smaller worst case.

**Verdict: `inkTone` is unchanged.** On the real crops no picture changes class under a ±2 px shift, before or after, so there is no flip to remove; every proposed variant is equal or worse on the harsher test, and each one moves a band (image-37's unshifted class) or turns a yellow line gold under box growth (image-11), which is the one direction the rule must not move. The flips the owner saw were not crop jitter: of the eight stored reports with tones, the one from before the front-40 %/red rule (`report.matcher-and-tones.json`, whole-line mean) is the only one whose first lines change class (image-15, 42, 49, 54, 58, IMG_0379, IMG_0401: the whole-line mean of that version); in the other six the first-line tone is identical in 45 of 54 pictures and within 1–5 channel units in the rest (det/crop revisions), never a class change; the "flips" a line-by-line diff of the later lines shows are a changed *line count* shifting the index. At ±3 px growth the box starts to include the line below, and three yellow lines (image-11, 38, 43) read gold under every variant including the current one; that needs a box 3 px too large, 2 px growth never does it.

What stays: the three permanent tests in `extension/test/ocr-ppocrlib.test.mjs` pin the guarantee on synthetic lines (the stability of gold, rare yellow and white under every one of 25 windows, the 0.27/0.36 pair on its own sides of the edge, red and crafted orange refused), and `extension/test/ocr-tone.test.mjs` pins the band edge (0.30 gold, 0.32 yellow). Mutation: letting the blended edge pixels into the average (`floor = level * 0.3` instead of `0.85`) turns the first two red; raising `CREAM_MAX` from 0.31 to 0.40 turns the edge test and the shifted-line test red; widening the orange band turns the refusal test red.

### The name line read as "0-": the port's detector boxes were 1–3 px off the reference (root cause found and fixed 2026-10-18)

**Symptom.** `scripts/data/image-58.png` (735 × 647, truth `Ars Dul'Mephistos`, one very long name line `杜墨菲斯托斯学術[30FCR|115ED|70AR|-20MR|170EDef|25MF]`, 692 × 29 px, then the base line 神秘秘典【精英】) came out of the browser engine as the two characters `0-` (score 0.56093), so only the base was left and the read asked. The Python reference reads the line whole, so this was a difference between the port and the reference, not a model limit.

**Where the two first diverge** (rapidocr 3.9.2 with the same three pinned models run through onnxruntime CPU in a throwaway venv under `artifacts/twofix/`, against the real extension in the dedicated Chrome; the suspects were tried in the order the task listed them):

| step | reference | browser port | verdict |
| --- | --- | --- | --- |
| (a) recogniser input width | dynamic: `trunc(48 × widest ratio)` | the same: the 692 × 29 crop is fed as 1 × 3 × 48 × 1145, a normal box as 320 | not the cause (pinned by two new tests anyway) |
| (b) detector box of the first line | `[[33,32],[724,35],[724,64],[33,62]]`, crop 691 × 30 | `[[33,33],[725,36],[724,65],[33,62]]`, crop 692 × 29 | **first difference**; 14 of the picture's 21 boxes are 1–2 px off, and the same 14 are off when the port's post-processing is fed the reference's own probability map (7 of 21 identical), so it is the port's DB post-processing, not engine numerics |
| (c) detector input size / aspect | probability map 736 × 832 | 736 × 832 | identical |
| classifier on that crop | upright, P(180°) = 0.215 | **turned**, P(180°) = 0.9276 (threshold 0.9; the same on WebGPU and wasm) | the 1 px box difference is amplified here |
| recogniser | – | the turned crop reads `0-` at 0.56093; the upright crop reads the whole line at 0.997 | the turn is what destroyed the text |
| (d) CTC / score filter | – | `0-` at 0.56 passes the 0.5 filter, nothing is dropped | not the cause |

The classifier squashes every crop to 192 × 48, so on a 23.9 : 1 line its P(180°) is not a stable number: the same box moved ±2 px and grown or shrunk ±2 px gives 0.4991 … 0.9753, and 14 of the 25 windows are over 0.9. The reference's 0.215 is the lucky side of that, and a port that is a pixel off lands on the other. Across the 54 pictures (914 crops) the classifier turns only 5 crops, none of them really upside down: image-38 (a digit 9 read as 6, 0.737 against 0.998 upright), image-39 (two single glyphs, a tie), image-46 (junk, 0.29 against 0.39) and image-58.

**Why the port's boxes were off.** pyclipper (`unclip`) works on integers: the min-area rectangle's float32 corners are cut to whole pixels, offset with the round-join arc rule of Clipper 6.4.2, and every offset vertex is rounded to a pixel. The port inflated the exact float rectangle by the distance instead. On the 38 screenshots with a reference map the port's boxes equalled the reference's in 187 of 522 cases (35.8 %, none of the 38 pictures fully identical).

**Changes** (both general, no picture is named in code; `extension/src/ocr/ppocrlib.js`):

1. `clipperRoundOffset` + `detCandidateBox`: the rectangle's corners go through `fround`, are cut to integers, offset with Clipper's own `DoOffset` arithmetic and the min-area rectangle of the rounded outline is taken. Boxes equal to the reference's: 187/522 → **505/522 (96.7 %)**, pictures with every box identical 0 → **22 of 38**; on 400 synthetic bars run through the reference's `DBPostProcess` the mismatches fall from 282 to 42. The reads follow: lines identical to the Python reference (`artifacts/ocr-bench/ppocr.json`, aligned by line order) 654/890 → 730/891, pictures wholly identical 9/54 → 23/54.
2. `recognizeChecked`: a crop the classifier turned is also read upright and the higher recogniser score wins (a tie keeps the turn, so truly upside-down text still reads). It is the guard for the classifier instability above, which an exact box does not remove (a slightly different capture could move the box by a pixel again); it costs one extra recogniser call only for a turned crop, 5 crops of 914 here. Alone, change 1 already reads image-58 (score 0.99381 against the reference's 0.99392); change 2 additionally turns image-38's digit line back to `9` and keeps image-46's recogniser time at 268 ms instead of the 406 ms change 1 alone costs there.

**Results.**

| | before | after |
| --- | --- | --- |
| tuned (22 scored) | top-1 22, top-3 22, asked 0, auto_right 22, auto_wrong 0 | the same |
| held-out (30 scored) | top-1 29, top-3 29, asked 2, auto_right 28, auto_wrong 0 | top-1 **30**, top-3 **30**, asked **1**, auto_right **29**, auto_wrong 0 |
| image-58 row | asked; buttons `base:Occult Tome`, `base:Tome`, `base:Occult Codex` | filled by itself: `item:Ars Dul'Mephistos` (its `want` unchanged) |
| the other 53 rows | – | `top`, `ok`, `top1`, `unsure` and `possible` identical in every one (compared row by row; the first-line tone vector moves by a few units on 20 pictures; the only first-line class that changes is image-46's, because a junk line "2" now precedes its name line, and its row is unchanged) |

Speed (one page-side pass per picture, median of 3 repeats, summed over the 54 pictures; `old` was run twice to show the run-to-run spread): det 12399 / 12748 ms (old / old again) against 12405 (new), cls 6146 / 6431 against 6272, rec 16082 / 16442 against 16063, total 36326 / 37483 against 36551; median per-picture total for screenshots 636.5 / 666 against 631 ms, for phone photos 921 / 1010.5 against 925 ms. The recogniser only does extra work on the pictures with a turned crop: image-38 rec 314 → 336 ms, image-39 384 → 422 ms, image-46 258 → 268 ms, image-58 415 → 410 ms. The `ocr_e2e.py` seconds per picture (median screenshots 1.8 → 1.6 s tuned and 2.0 → 1.7 s held-out, phones 2.3 → 2.35 s tuned and 2.0 → 1.75 s held-out) are inside the run-to-run noise and are not claimed as a gain. Scan: `scripts/scan_e2e.py` normal page 4 of 4, `--page scripts/data/scan_sim_failures.html` 8 records (image-58's name is now one of them), no query started.

**What it does not fix.** 17 of 522 boxes (3.3 %) are still one pixel off: `cv2.minAreaRect` does its rotating-calipers arithmetic in float32 and returns corners such as 314.99994, which pyclipper cuts to 314, where the port's doubles say 315; reproducing it needs the calipers code bit for bit. Four screenshots (image-2, 3, 38, 49) get one extra low-score box (0.52–0.55 against the 0.5 threshold) that the reference drops, most likely because `cv2.fillPoly` counts boundary pixels in the box score and the port counts pixel centres (not proved; the four extra boxes are not in any row that changes). The phone photos are not compared against the reference box for box (the reader deliberately detects them on a 736-capped copy, "The reader's phone photos"). The classifier can still turn a long line wrongly; the guard only repairs a turn that reads worse, it cannot find a turn that was missed. Tests (`extension/test/ocr-ppocrlib.test.mjs`): the reference boxes of three bars (red when the corners are not cut or the vertices not rounded, or with the old float inflation); the 1145-wide input of the 692 × 29 box and the 320 of a normal box (red when the width is clamped to 320); a turned crop that reads worse keeps its upright reading, a truly upside-down one keeps the turn, an untouched crop costs no second read, and a whole picture reads its first line upright in both reading modes (red when either call site skips the check, or when the better reading is always or never taken).

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

Measured and rejected, so future work does not repeat it: the recent-trades marker fallback (`Sold For`/`Traded For`/`Closed For` in `parsing.py`/`parsing.js`) has no page to fire on here - a logged-out product `/recent` view (probed 2026-10-13) answers with a sign-in prompt and no trade markers at all, the logged-in view the panel reads carries `They Give` blocks, and its records could not pass the controller's marker count in any case; that is why the field it fills is documented rather than renamed. The minimized query window is not timer-throttled (`document.visibilityState` was `visible` in every run); the DONE/BLOCKED freshness gate is exercised but stayed cheap — in the default `load_more = 0` run the agent made 3 decisions (DONE in `trading`, CLICK `Recent Trades`, DONE in `recent_trades`) and `stale_events` stayed `{}`, so the gate did not fire; `phaseFinishRule(0)` is null (`site.js`), so the phase ends through Jev's DONE rather than a rule, and a DONE choice is not written to `history` (it returns before the push, which is why that run shows 1 history step). Its only fixed cost is one `tab.fresh()` evaluate per DONE, and a re-ask only happens when the page actually changed, which was not observed; two observed DONEs are evidence that the gate is cheap, not proof that it can never fire; `readStatsView`'s 1500 ms retry sleep never mattered (the first attempt passed every time); starting `startRun` concurrently with `Tab.open` would save only ~8 ms (`start_run` 6-300 ms across runs against open_tab 2.8-4.7 s); `tab.close` is 3 ms, so rendering the results before it is pointless.

Measured and rejected, so future work does not repeat it: blocking ad/tracker hosts in the extension's own query tab (AGENTS.md blocks them only in the dedicated Chrome). `scripts/probe_blocking.py` toggles the dedicated Chrome's own block list on the same filtered affix address and compares strictly alternating ON/OFF pairs, checking first that the blocked-host scripts really did land inside the settle window (its premise). Four runs: the first was inconclusive because its toggling did not take effect in every ON run (fixed); the second paired median (215 ms) sat inside the run-to-run spread (±262 ms); a 5-pair run looked encouraging (4 of 5 pairs faster, paired median 888 ms, about 33% of the OFF settle, navigate 437 against 766 ms); and a **12-pair run found no effect at all** - settle median **1695 ms ON against 1699 ms OFF (4 ms)**, only 4 of 12 pairs faster, the per-pair deltas scattered from -97 to +81 ms (median -10 ms), navigate 375 against 359 ms, no settle cap on either side. So the settles on this path are Traderie's own churn, not the ad hosts': the premise held (the ad scripts did land during the settle) yet removing them changed nothing measurable, and a permission in the extension would buy nothing - the earlier 5-pair result was that sample's luck. The raw per-run records, with what each run loaded and when, are under the git-ignored `artifacts/blocking/`, the way this file's other measurements are kept. (The other item here, caching the Item Type list, was decided on 2026-10-13 and is implemented: see the stats timing bullet above.)

## Settle window: measured and rejected at 150 ms (extension and Python)

`traderie/controller.js` (and the Python twin) read each view through `readSettledPage(500, …)`: 500 ms is how long
the view's text must hold still before it is read. A review asked whether that window is worth shortening, so it was
measured on the shipped e2e path (`scripts/extension_e2e.py --stub-chooser --item <name>`, 0 Jev calls, so the
measurement cost no quota) on three table-jump items, comparing the two read stages against the script's own
independent check (the 掛單/成交 row counts, not the panel's status):

| window | runs | read_trading | read_recent_trades | outcome |
|---|---|---|---|---|
| 500 ms (shipped) | 6 | 564–847 ms (median ≈ 630) | 522–820 ms (median ≈ 525) | 6 of 6 read 150/20 |
| 150 ms | 10 | 233–753 ms | 165–213 ms | 7 of 10 read 150/20; **3 aborted** |

The aborts are the same failure, and the script names it:

    失敗：
      - 載入更多 2 批，掛單只有 50 筆

With the shorter window the trading read lands before the page's first Load More batch and its button are there, so
the loading rule sees no button, ends the phase (its decisions stop after `Scroll` → `完成`, 2 steps against 5) and
the panel shows 50 rows instead of 150. The e2e caught it because its check does not read the panel's own status.

Not worth it: the two reads are ≈1.2 s of a ≈17 s run, and 150 ms removes ≈0.6 s of that (≈3.5 %), while making
about one run in three end early. **The window stays 500 ms.** The per-run evidence is the git-ignored
`artifacts/perf/run-20261013-*.json` (`timeline[].ms`, `history`, `decisions`) with the backend logs beside them.

## Fixed defects: stale retries, challenge detection, login, e2e evidence

Three real defects were found and fixed in one session (2026-10); the rules in `AGENTS.md` keep them from coming back. The measurements are recorded here because `artifacts/` is git-ignored.

- Stale retry bound (extension, `extension/src/agent.js`): `MAX_STEPS` reads `history.length`, and a stale click never executes, so nothing is pushed to `history`; `_finishPhaseByRule` counts only executed presses too. Before `STALE_RETRY_LIMIT = 3` the mechanical loading rule could therefore retry a covered element forever. Measured: 1379 `StalePage` events in 177 s (~7.8/s), the page's own click counter stayed 0, the panel froze at 「進行中，已操作 1 步」 and `__jevLastRun` was never published; the model-path face of the same defect asked Jev **29 times in ~9 s** before the 30-call cap stopped it. After the bound, the rule path ends in 8–24 s with **1** `/api/choose`, the model path in ~7 s with **3** chooses. `state.attempts` counts every action attempt (executed or stale) and `_prepareAction`'s bound is `history.length >= MAX_STEPS || attempts > MAX_STEPS`; both halves are needed or a covered element stops counting toward the step budget.
- Challenge guard (extension, `extension/src/traderie/site.js`): the extension's `page.text` comes from the snapshot, which covers only the visible viewport. A normal logged-in product page measured **1998 chars** and contained Traderie's own changelog line "Fixed captcha bugs when going between games", so the old bare-word test fired and `sidepanel.js`'s `judge()` showed 「Traderie 要求驗證或登入…防護頁/驗證碼」 instead of the run's real stop reason. `CHALLENGE_TEXT_MAX` (under it) plus `TRADING_MARKERS` ("Trading For" / "Make an Offer") make the bare word count only on a page that looks like a challenge; the explicit signals and the `CHALLENGE_FRAMES` probe are unchanged. The Python twin (`src/jev_ultrafast/traderie/site.py`) reads the whole-page `innerText` and needs no guard.
- Login wait (extension-side one-time login, `scripts/login.py`): a bare `input()` on a stdin that cannot wait (EOF, redirected) returned instantly and the `finally` closed the window before the human could log in (reproduced: `EOFError`, window gone in ~7.4 s). The wait now polls `LOGGED_IN_JS` (host `traderie.com` and `readyState === "complete"` and a non-empty body and no `Log In` link left) and the window stays open until a login is detected, Enter is pressed, or `JEV_LOGIN_WAIT_SECONDS` (default 600) is reached, which prints a clear Traditional-Chinese message and exits 1.
- e2e evidence (`scripts/extension_e2e.py`): a hung query used to leave no per-step record. The local backend's stdout is now mirrored to the git-ignored `artifacts/perf/backend-<timestamp>.log` (one `choose inv=… rid=… calls=… in=… out=…` line per answered Jev step; the path is printed at the end), each changed 3 s sample prints a progress line (including the panel's step counter and its last 4 decisions), a failed sample is counted and reported (`取樣：成功 N 次、失敗 M 次`), and `--timeout` (default 300) bounds the run.

Measured in the same session, about that stop: it was true but not actionable, because the element that could not be operated was under a modal. Traderie's Patch Notes pop-up is a `position: fixed; z-index: 100` box covering the whole viewport, so the target's centre point never resolves. A probe made **43 dismissal attempts** and only a **real mouse click** on the × dismissed it: the click listener sits on the inner `svg`, so a synthetic `element.click()` on the div does nothing, and the × is `#close-modal > svg` — a plain `div` wrapping one `svg`, with no role, no `aria-label`, no `title` and no text, so the generic observation path cannot name it. Dismissing it once sets `localStorage.whatsNewOpen`, and Traderie then keeps the pop-up away across reloads of that profile. Re-measured 2026-10-13: the same "only a real click works" holds, and a real click can be made from a script — `Input.dispatchMouseEvent` (`mousePressed` then `mouseReleased`, left button) at the centre of `#close-modal`'s box dismissed it and set `whatsNewOpen=15422`, after which `scripts/extension_e2e.py --stub-chooser` ran the whole query (150 listings, 20 trades, both views `PASSED`, zero Jev calls). So the pop-up is a **profile** state, not a code defect: once cleared, every Chrome run of this family starts past it — a fresh profile sees it again. The agent therefore gained **no** site-specific click for it: the stop instead *measures* the generic situation (`src/jev_ultrafast/covered_overlay.js` through `Tab.overlayCover`: the failed target's centre is covered and the covering element's nearest positioned ancestor is `position: fixed` and covers at least 90% of the viewport) and, only then, replaces the stop reason with an actionable Traditional-Chinese message telling the player to close the pop-up; when the measurement says nothing or fails, the message and the stop are exactly as before.

## Gear scan: what the continuous scan can and cannot see (measured 2026-10-14, stand-in pages and the truth pictures, not the real game)

**Detection width 480 -> 720/960: tried, rejected, `DETECT_WIDTH` stays 480.** Frames are shrunk to `DETECT_WIDTH` before `findTooltip`. A diagnosis found that about 17 % of tooltips are never detected (35 truth pictures drawn at native size on a 1920-wide frame: 6 never found in three real-Chrome runs; offline 1080p misses 8/35, 1440p 15 plus 3 half-found, 4K 31). The one-constant fix was measured offline (no Chrome): the 35 pictures of `scripts/data` (those <= 760x1000; 34 fit a 720p stage), each drawn at native size twice on a stage frame of 1280x720 / 1920x1080 / 2560x1440 over the two informative backdrops (the sim page's grey noise, and the same noise inside black pillar bars), box-downscaled to each width, the shipped `findTooltip` + `boxKey` unchanged (its thresholds are fractions of the frame, so the width only changes how many pixels there are). "Half" = a box that covers under 90 % of the real tooltip; "false crop" = a box that touches no tooltip, or a box on a frame with no tooltip (counted over all four backdrops, dark and bright floors included); the key columns compare keys of DIFFERENT pictures (the merge risk: `KEY_TOLERANCE` merges keys within 8 of 64 cells).

| stage | width | frames | missed | half | missed+half | false crops | min key distance, different pictures | key pairs <= 8 | node ms/frame |
|---|---|---|---|---|---|---|---|---|---|
| 1280x720 | 480 (shipped) | 136 | 12 | 19 | 31 | 0 | 8 | 1 / 3720 | 1.8 |
| 1280x720 | 720 | 136 | 4 | 32 | 36 | 1 | 9 | 0 / 4224 | 4.3 |
| 1280x720 | 960 | 136 | 8 | 32 | 40 | 1 | 9 | 0 / 3968 | 7.8 |
| 1920x1080 | 480 (shipped) | 140 | 32 | 5 | 37 | 0 | 6 | 12 / 2812 | 1.7 |
| 1920x1080 | 720 | 140 | 22 | 16 | 38 | 0 | 5 | 4 / 3366 | 3.8 |
| 1920x1080 | 960 | 140 | 16 | 22 | 38 | 1 | 6 | 8 / 3722 | 6.5 |
| 2560x1440 | 480 (shipped) | 140 | 52 | 10 | 62 | 0 | 8 | 5 / 1868 | 1.3 |
| 2560x1440 | 720 | 140 | 31 | 6 | 37 | 0 | 7 | 4 / 2863 | 3.2 |
| 2560x1440 | 960 | 140 | 30 | 10 | 40 | 1 | 6 | 20 / 2917 | 6.0 |

Missed+half over the three stages: 130 at 480, 111 at 720 (-15 %), 118 at 960 (-9 %) - the rule was "at least a third fewer" (87 or less), so neither width wins. Where it helps (1440p: 62 -> 40) it is mostly misses turning into cut boxes (1080p: missed 32 -> 16 but half 5 -> 22), and 720p gets slightly worse. Side effects at 960 against 480: three false crops where 480 has none (on the stand-in dark floor, noise 0..40 with 3 % bright specks: the specks are averaged away at 480 but count as a "bright 2..35 %" tooltip at 960, so every one of 208 dark frames returns a loose box that swallows the floor, where 480 returns one on 72 and misses the rest); no different-pictures key pair closer than at 480 (min 6 vs 6..8), but the pairs within the tolerance are not fewer (1080p 12 -> 8, 1440p 5 -> 20, because more tooltips are found and more pairs exist); and the cost is about 4x (1.3-1.8 ms -> 5.3-7.8 ms per frame for detection and key alone, before the extra `drawImage`/`getImageData` at 960). The box drift tolerance `within2` in `session.js` is in pixels, so a 960 detector would need 4 there. Re-deriving thresholds did not change the verdict: a 27-variant grid at 960 (`DARK_RATIO` 0.30/0.38/0.45 x `MIN_DENSITY` 0.35/0.42/0.50 x `BRIGHT_RANGE` lower bound 0.02/0.05 and upper 0.35/0.5, one placement per picture) best reached 57 against 70 at the shipped 480 on the same frames (-19 %); a `BRIGHT_RANGE` lower bound of 0.05 removes the dark-floor false crops at 960 and costs nothing elsewhere, and still does not reach a third. The same pictures (image-11, 13, 16, 20, 41, 43, 49) fail at 480 and 960 alike, so what is left is the detector's own logic (their panels are not dense in dark-or-bright pixels), not resolution. No Chrome run at 960 was made: it lost offline. The real phone photos (17, translucent tooltip on the real UI) give the same three detections at both widths and no extra box. Raw material: the git-ignored `artifacts/diag-scan/offline/` (`widths.py`, `widths.mjs`, `sweep.mjs`, `photos_w.*`) and `artifacts/scanfixes-runs/`.

**Text-structure detector (`textbox.js` fallback): tried, rejected, dark-panel detector stays.** A pure alternative detector was implemented and measured offline over the 35 native-size screenshots on 1280x720, 1920x1080, and 2560x1440 stages (200 tuned frames for image-1..20 and 216 held-out frames for image-31..60, plus the 4 phone photos). The algorithm builds a text mask using a 5x5 neighbourhood mean local background ($G \ge 120$ and $G - \text{mean5} \ge 25$), projects rows into alternating text groups separated by blank row gaps within regular spacing (factor 2.5 of median line and gap height), derives the column extent via the 10th percentile of line start positions, and runs first with fallback to the shipped dark-panel detector when null or covering. Decision rule required sum of misses+half-detections $\le 65$ (half of 130), false crops not exceeding 0-3, key distance not degrading, and cost under 10 ms at 480.

| stage | detector | frames | tuned bad (m/h) | held bad (m/h) | total bad | false crops | min key dist | key pairs <= 8 | node ms/frame |
|---|---|---|---|---|---|---|---|---|---|
| 1280x720 | dark-panel (baseline) | 136 | 19 (8/11) | 12 (4/8) | 31 | 0 | 8 | 1 / 3720 | 1.8 |
| 1280x720 | text-structure | 136 | 20 (0/20) | 15 (0/15) | 35 | 1 | 8 | 1 / 8976 | 4.3 |
| 1920x1080 | dark-panel (baseline) | 140 | 20 (17/3) | 17 (15/2) | 37 | 0 | 6 | 12 / 2812 | 1.7 |
| 1920x1080 | text-structure | 140 | 21 (0/21) | 26 (2/23) | 47 | 2 | 0 | 19 / 9114 | 4.3 |
| 2560x1440 | dark-panel (baseline) | 140 | 32 (30/2) | 30 (22/8) | 62 | 0 | 8 | 5 / 1868 | 1.3 |
| 2560x1440 | text-structure | 140 | 35 (6/22) | 43 (5/33) | 78 | 13 | 0 | 21 / 6622 | 4.3 |

Sum of misses+half-detections (including wrong boxes) over the three stages increased from 130 to 160 (tuned bad 71 -> 76, held bad 59 -> 84; misses alone dropped from 96 to 13, but half-detections increased from 34 to 134 because the text bounding box tightly bounds glyph strokes without the translucent outer panel padding, leaving coverage between 0.50 and 0.85). In addition, false crops increased from 0 to 16 (noise along black pillar bars and texture edges), minimum key distance degraded from 6 to 0, and per-frame cost rose to 4.3 ms. Because it failed the adoption threshold (160 > 65), the source change was reverted and the shipped detector remains unchanged.

**Locate-by-text, grow-to-panel detector (Experiment E2): tried, rejected, dark-panel detector stays.** A second iteration located the tooltip via the text-structure detector, then grew the tight box into the surrounding panel using relaxed dark-or-bright cues (`m <= 65` or `m >= 120` or text mask) with bounded directional expansion up to 20 % of width and 15 % of height, validated with relaxed `looksLikePanel` (dark ratio $\ge 0.20$ or bright ratio in $[0.02, 0.40]$, bright $\ge 0.015$, containing the tight box), falling back to the shipped dark-panel detector when null or not covering. Measured offline on the same 416 stage frames:

| stage | detector | frames | tuned bad (m/h) | held bad (m/h) | total bad | false crops | min key dist | key pairs <= 8 | node ms/frame |
|---|---|---|---|---|---|---|---|---|---|
| 1280x720 | dark-panel (baseline) | 136 | 19 (8/11) | 12 (4/8) | 31 | 0 | 8 | 1 / 3720 | 1.8 |
| 1280x720 | E2 text+grow | 136 | 17 (2/15) | 12 (1/11) | 29 | 1 | 8 | 1 / 8583 | 5.7 |
| 1920x1080 | dark-panel (baseline) | 140 | 20 (17/3) | 17 (15/2) | 37 | 0 | 6 | 12 / 2812 | 1.7 |
| 1920x1080 | E2 text+grow | 140 | 15 (9/6) | 16 (5/11) | 31 | 0 | 6 | 29 / 7702 | 5.7 |
| 2560x1440 | dark-panel (baseline) | 140 | 32 (30/2) | 30 (22/8) | 62 | 0 | 8 | 5 / 1868 | 1.3 |
| 2560x1440 | E2 text+grow | 140 | 17 (10/7) | 28 (8/20) | 45 | 0 | 6 | 15 / 5521 | 5.7 |

While E2 recovered outright misses (dropped from 96 to 49 across the three stages) and avoided the false crops and key degradation of E1 (false crops 1, min key distance 6), sum of misses+half-detections only reached 105 (down from 130, -19 %), failing the non-negotiable adoption gate of $\le 65$. The fundamental barrier at 480 wide is that translucent panels lack dark borders to guide density-based growth, leaving coverage clustered at 0.60..0.88 (counted as half-detections), while small tooltips (e.g. image-20, native 235x109) downscale to $< 48$ px at 1440p where 2 px text lines cannot be separated from noise. The source changes remain reverted and the shipped detector is unchanged.


**Rate-limited PP-OCR detection (`det`) fallback (shipped):** To rescue tooltips missed by the dark-panel detector (translucent backgrounds and small panels at 1440p) without slowing down live frame processing, a rate-limited fallback runs PP-OCR detection (`PP-OCRv6_det_small.onnx`, limit side length 736) on the frame downscaled to 720 wide (`extension/src/scan/fallback.js`). The fallback triggers only when `findTooltip` returns null on a stable frame (`STABLE_FRAMES = 2`), the OCR recognition queue is empty, and at least 3 s have elapsed since the last fallback. Detected text line boxes are clustered by vertical/horizontal proximity ($\le 1.5$ line heights) and padded by median line height to cover outer borders.

Measured offline: 6 of the 7 previously-missed tooltips reach coverage $\ge 0.90$ (image-11: 100 %, image-13: 100 %, image-16: 100 %, image-20: 99.0 %, image-41: 97.5 %, image-43: 100 %, image-49: 89.3 %), and all 4 phone photos produce boxes with coverage $\ge 0.97$. False crops on empty frames: 0 of 6. Cost per fallback call is ~750 ms on CPU; because it fires only on still frames with an empty queue, the live scanner frame rate is unaffected (measured 13–16 fps in Chrome). Session stats record fallback runs and hits (「備援偵測 N 次、救回 M 件」).
**The `*_slow` sim pages do not exercise native size.** `scripts/data/scan_sim_1080p_slow.html` and `scan_sim_1440p_slow.html` draw the four tooltips at native size on a 1920x1080 / 2560x1440 canvas, but the headless Chrome captures that tab at 800x396 / 800x360 (measured), so the 480-wide detector sees a scaled-down picture and "four records" says nothing about a real 1080p/1440p capture. What the game window really delivers is unmeasured here.

**A covered game window slows the scan, and the e2e cannot see it.** When the game covers Chrome, `document.visibilityState` of the side panel is `"hidden"`: frames per second fall from about 10.7 to 3-4.8 and a crop's `convertToBlob` takes about 1.0-1.3 s, so a half-second hover was read 5 of 12 times (7 of 12 with a 0.3 s gap) against 12 of 12 with the panel visible; windowed with Chrome side by side was 12 of 12. Skipping the PNG and a software canvas did not help. The e2e's anti-throttle flags (`EXTRA_ARGS` in `scripts/scan_e2e.py`) make a covered page still count as visible, so the e2e never reproduces the slowdown; `--minimize-after` only shows that the records still land on a hidden page. What the panel does about it (`scan-panel.js`): while scanning and `document.visibilityState === "hidden"` it says so (「遊戲視窗蓋住了這個面板…」); the old "three low seconds in a row" slow notice never fired (the rate bounces 7,2,1,6,4,3,8) and fired falsely once the picture stood still, so it now judges the last 6 seconds on the seconds that carried frames only (at least 3 of them, mean under 5 per second); a second with no frame is a still picture. The status line says 「待辨識 N 件，約 M 秒」 (N x the average read, once a read has landed); the stats line's 略過 counts every tooltip that gave no new record (the same panel again by crop key, the same text again, nothing readable) and 丟棄 every tooltip lost because the 300-crop queue was full (a sweep of 35 that recorded 28 used to say 0 and 0).

Measured about that e2e blind spot (2026-10-14): with the anti-throttle flags on and the game window really covering Chrome (headed) the side panel reports `visibilityState` `"visible"` on all 74 samples, so no covered-window slowdown can be produced; in the normal headless `scan_e2e.py` run the panel tab sits behind the sim tab, reports `"hidden"` and still runs at about 14 frames per second (stats line 「每秒畫面 14…」), so the covered notice appears in a run that is not slow. The script records the visibility and only checks that the notice and the hidden state agree.
## Recognition performance breakdown (P0) and P1/P2/P3 implementation (measured 2026-10-14)

### Table 1: Per-stage OCR recognition latency

| path & engine | sample count | total ms (median, range) | det ms (median, range) | cls ms (median, range) | rec ms (median, range) | resize/decode ms | command / source |
|---|---|---|---|---|---|---|---|
| reader-WebGPU | 52 | 2100 (1500 - 4800) | 480 (320 - 1200) | 90 (40 - 250) | 1480 (1050 - 3300) | 50 (25 - 110) | `uv run --group e2e python scripts/ocr_e2e.py` |
| reader-wasm (1 thread) | 54 | 6800 (4200 - 12800) | 1750 (950 - 4500) | 115 (50 - 320) | 4500 (2800 - 8100) | 110 (50 - 240) | Historical evidence: `artifacts/ocr-spike/run-full-wasm.log` (2026-10-06) |
| scan-WebGPU | 11 | 700 (500 - 1400) | 180 (110 - 420) | 35 (15 - 90) | 450 (280 - 950) | 25 (10 - 45) | `uv run --group e2e python scripts/scan_e2e.py` |
| scan-wasm (1 thread) | 15 | 2400 (1800 - 3900) | 650 (420 - 1200) | 60 (30 - 120) | 1600 (1100 - 2600) | 45 (20 - 80) | Historical evidence: `artifacts/ocr-spike/threads.json` (2026-10-06) |

*Note on scan costs outside recognition:* Per-frame tooltip detection: 1.5–3 ms (480px) on CPU. Tooltip crop and PNG encode: 6–12 ms. Queue wait time: 0–15 ms. Fallback PP-OCR detection (`detectBoxes` on 720px): 280–360 ms.

### P3 offline pre-check (text truncation accuracy)

| dataset / line cutoff | scored | top1 | top3 | asked | auto_right | auto_wrong |
|---|---|---|---|---|---|---|
| **Tuned (22)**: N = 2 | 22 | 15 (68.2%) | 15 (68.2%) | 6 | 14 | 2 |
| Tuned (22): N = 3 | 22 | 20 (90.9%) | 20 (90.9%) | 2 | 18 | 2 |
| Tuned (22): N = 4 | 22 | 21 (95.5%) | 21 (95.5%) | 0 | 21 | 1 |
| Tuned (22): N = 6 | 22 | 22 (100%) | 22 (100%) | 0 | 22 | 0 |
| **Tuned (22): name region** | 22 | 22 (100%) | 22 (100%) | 1 | 21 | 0 |
| Tuned (22): full text | 22 | 22 (100%) | 22 (100%) | 0 | 22 | 0 |
| **Held-out (30)**: N = 2 | 30 | 19 (63.3%) | 19 (63.3%) | 13 | 16 | 1 |
| Held-out (30): N = 3 | 30 | 26 (86.7%) | 27 (90.0%) | 6 | 24 | 0 |
| Held-out (30): N = 4 | 30 | 29 (96.7%) | 29 (96.7%) | 3 | 27 | 0 |
| Held-out (30): N = 6 | 30 | 29 (96.7%) | 29 (96.7%) | 2 | 28 | 0 |
| **Held-out (30): name region** | 30 | 29 (96.7%) | 29 (96.7%) | 2 | 28 | 0 |
| Held-out (30): full text | 30 | 29 (96.7%) | 29 (96.7%) | 2 | 28 | 0 |
| **All scored (52): name region** | 52 | 51 (98.1%) | 51 (98.1%) | 3 | 49 | 0 |
| All scored (52): full text | 52 | 51 (98.1%) | 51 (98.1%) | 2 | 50 | 0 |

*Caveat:* The original tuning used all 52 pictures, so the held-out set is not strictly independent.
*Verdict:* Reading dynamically up to the first stat line (`nameRegionOnly`) achieves 51/52 accuracy with 0 auto-wrongs, identical to full text reading.

### P1, P2, P3 implementation & perceived latency

1. **P1 (Keep warm):** `createEngineCache.keepWarm()` prevents idle termination during scans and while a picture is loaded in the reader, avoiding the 10.7–12.0 s cold start penalty during active user sessions.
2. **P2 (Deduplicate crop queue):** `session.accept()` checks `boxKey` against active records and pending keys. Normal sweeps skip 1–3 duplicates per cycle, saving ~700 ms per hover.; a repeat the key cannot tell apart (a held tooltip whose frame changed, or the same panel at a second place whose key drifted past the tolerance) is refused by the held-picture rule and the record rule instead — see "The same item read again" below.
3. **P3 (Name region read):** designed as `nameRegionOnly` (recognize line by line until the first stat line). No caller ever passed it, so it never shipped and its numbers were never a shipped result; it is replaced by the head-first read (`HEAD_LINES = 6`, see "Head first" below), which the offline table above supports (the first 6 lines decide exactly as the whole text).

## The same item read again: the held picture and the record rule (measured 2026-10-15)

The owner's report: 「同一件裝備被重複掃到的次數很高」 and 「同一件裝備不要持續識別」 — while playing, the same item is scanned again very often, and one item should be recognised exactly once. Measured, the repeats had three separate causes:

1. **A held tooltip was cropped more than once.** `session.feed` only handed a crop out on the frame that satisfied `STABLE_FRAMES`, but *any* change of the detector's box or of `boxHash` called `startStreak`, which cleared the "already handed out" flag. A game keeps re-rendering behind the panel, so during one hover the streak kept restarting and a second, third crop was handed out for the same held item. `accept`'s crop key usually refused those, which is why the cost showed up as 略過 rather than as extra records.
2. **The same panel reappearing read as a new one.** `boxKey` is anchored on the panel's own dark structure, so the same tooltip at a second place usually gives the same key (0..4 of 64 cells), but not always: in `artifacts/diag-scan/results/t1-sanity.json` the same picture (image-18, Verdungo's Hearty Cord) appeared twice in one sweep and its second key drifted past `KEY_TOLERANCE` (8), so `accept` let it through: a second crop, a second ~1 s read and a second record — the duplicate the owner sees. The two stored reads are only 0.689 alike (and earlier measurement of the same tooltip re-read found it identical in only 7 of 28 pairs), so the old exact-text check could not collapse them either.
3. **The fallback hunted an unreadable item every 3 s.** When `findTooltip` returns null on a stable frame the panel runs PP-OCR det (280-360 ms a call, rate limited to one call every 3 s). A tooltip det could not read was hunted again and again for as long as it was held.

What changed (all in `extension/src/scan/session.js` and `scan-panel.js`, numbers chosen from the measurements below):

| rule | what it does | the numbers behind it |
|---|---|---|
| held picture | a picture whose crop was handed out stays held while the detector's box is within `HELD_BOX_PX = 6` px and the crop key is within `HELD_KEY_TOLERANCE` (16 of 64 cells): no second crop, no second read, no second record | one panel differs in 0..4 of 64 cells across the sweep's eight positions and 0..10 with its glyphs slid and the frame re-encoded, two different pictures in 23..38; 16 is twice `accept`'s own tolerance (8), which must not swallow a different item |
| release | the hold ends when the tooltip closes, and `removeRecord` releases it too, so ✕ then the same hover records the item again | the existing ✕-then-re-hover guarantee, now independent of whether the tooltip closed in between |
| same-item record | a read whose whitespace-stripped OCR text is at least `TEXT_SAME = 0.6` alike an existing record's (character bigrams) is the same item read again: counted as 略過, not a second record | different items in the 54 stored reads: max 0.449 (image-35 vs image-41), the sim's own items max 0.234; the same tooltip read again from a second place: 0.689 (t1-sanity) |
| short texts | both texts must be at least `TEXT_SAME_MIN = 40` characters for that; below it the texts must be equal | every stored corpus read is 55+ characters (median 157) and every sweep record but one (43) |
| fallback per picture | the fallback remembers the picture it ran on (that box's own content key, same tolerance): one det call per held tooltip, not one every 3 s; a run that rescued nothing (no box, or a crop that made no record) waits 20 s (`FALLBACK_UNREAD_BACKOFF_US`) before it may run again on the same held picture | det is 280-360 ms a call and cannot read an item it just failed to read; on the shipped fallback page the calls fell from 6 to 3 for the same 6 records |

**The duplicate-record table.** One sweep of a variant stand-in page (`artifacts/repeatfix/scan_sim_hold.html`, git-ignored) that holds each tooltip far longer than the shipped page does (4 s for the four detector-visible pictures, 12 s for the seven the fallback has to find), re-renders the game under it, shows the four pictures twice (the second time with a dark neighbour in the key's window, which is the drift the real sweep produced for Verdungo's), and moves something far away from the seven fallback pictures so the whole frame keeps changing: 15 appearances of 11 distinct items.

| | before | after |
|---|---|---|
| records on the list | 14 | 9 |
| duplicates (same name, same 中文名稱, text ≥ 0.9 alike) | 3 | 0 |
| records beyond one per item (same item read again) | 6 | 1 |
| engine reads (crops handed to OCR) | 14 | 13 |
| fallback det calls | 7 | 4 (6 in an earlier run of the same page: the gate is timing-dependent) |
| 略過 (no new record) | 63 | 12 |
| distinct items with a record | 8 of 11 | 8 of 11 |
| sweep wall time | 125.5 s | 125.4 s |

Read against the owner's complaint: the three duplicates are gone and 5 of the 6 extra records with them; the crop work behind them is nearly gone as well (略過 63 → 12; each of those was a crop the panel cut and `accept` threw away). The wall time does not move because the sweep is paced by the page's own hold schedule, not by the scan's work. The one record that remains beyond one per item is a *garbled* re-read of an already recorded item: the sweep re-read Verdungo's Hearty Cord as 「戈的心結 … Belt」 (0.453 alike), under the threshold, so it looks like another item to the rule and to the eye. Two limits the sweep also shows, unchanged by this work: the same 8 of 11 items are read in both runs (the three fallback-only pictures whose crops `accept` refuses because their key is within 8 cells of one already seen — the fallback found a box for all seven, `救回 7 件`, while only four of them reached OCR), and the fix changes which *records* appear, not which items get read.

The shipped stand-in pages are unchanged in their verdicts: `scripts/data/scan_sim.html` records 4/4, and `scripts/data/scan_sim_failures.html` records 6 distinct items — its earlier "7 records" was one of the three rings recorded twice (`備援偵測 7 次` then, `3` now, for the same 6 items).


## Possible names and the correction memory (measured 2026-10-16)

A read `decideCandidates` (`extension/src/ocr/match.js`) cannot name by itself shows the player up to five names instead of guessing: `extendCandidates` keeps the matcher's own candidates first, unchanged (`matchOcrText` and its `top1`/`top3` keep their meaning, so `scripts/ocr_e2e.py` scores an unsure read on its first three buttons and reports `asked_top3`/`asked_top5`), then adds the next best table names under the `wide` tolerance and a third `loose` one; an item name of one to three characters is never offered from a near miss. Nothing is ever filled by itself while the read is unsure.

Every choice between those candidates, and every table name typed for a record (typed-name box in `scan-panel.js` `nameBox`, table names only: `traderie/lookup.js` `tableEntry`), is remembered in the correction memory (`extension/src/ocr/corrections.js`). One `chrome.storage.local` key, `jevCorrections` (`STORE_KEY`, `{ v: 1, e: [[key, { n, k, c, u }]] }`, `STORE_VERSION`): the normalised name-line text the chosen candidate matched (`MAX_KEY = 40` characters at most — a longer piece is a glued paragraph, never a name; never a picture, never the full OCR text, never page data) mapped to the English table name (`n`, at most 100 characters), its kind (`k`, `item` or `base`), the count of identical choices in a row (`c`, capped at 99) and the last-use time (`u`). At most `MAX_ENTRIES = 500` entries, the least recently used one going when a new one would make it more; writes are batched, `SAVE_DELAY_MS = 1500` ms after the change, and the panel also flushes on `pagehide` (a player who closes the side panel inside that second and a half does not lose the choice). The store is loaded once at panel start; a store that cannot be read is an empty in-memory one that is never written over (`writable = false`), so a broken storage can never erase what is in it.

It helps only for the exact same normalised text — no fuzzy learning: `applyLearned` looks the key up in a Map, so it can never recover a tooltip the detector never found, never generalise to a similar name, and never leave this computer. The rule (`LEARNED_SURE = 2` in `match.js`, `decideCandidates`): the first time the same text is read again, the remembered name goes to the top of the asked list with the hint 「你上次選過這個」 (`LEARNED_HINT`); a name the memory had to move up (`promoted` in `applyLearned`) still asks, while a name the matcher already put first keeps the matcher's own decision; after two identical choices in a row it is sure and the field fills by itself whatever the matcher said; a different choice for the same text replaces the name and starts the count again at one, so one mis-click can never auto-fill anything. Only names the item tables list are stored (a Chinese or an English input goes in as its English name), so a typo or a stranger's name never enters. The settings screen's 「學習紀錄」 block (`extension/src/learning-panel.js`) counts the pairs, lists the newest 30 with a ✕ each and clears all after a one-step confirmation; the Chrome e2e scripts empty `jevCorrections` at their start and end, so runs never depend on state left behind.

Two more corrections are remembered the same way (2026-10-22), each in its own store so the name memory's behaviour is untouched: the **base** of the affix search (`jevBaseCorrections`: the same `createCorrections` with `only: "base"`) and the **affix numbers** (`jevValueCorrections`, `extension/src/ocr/value-corrections.js`: `{ v: 1, e: [[lineKey, { k, m, c, u }]] }`, the normalised affix line and the dictionary key it was read as -> the corrected `min`, how many identical corrections in a row, last used; at most 500, least recently used evicted). The base follows the name rule (one correction asks, `LEARNED_SURE` identical ones start the query at once) because it is a pick from a list the reader proposed; a number is the player's own typed entry, so one correction fills the next read of the same line and the box is marked 「照你上次改的數字」 (dotted, never 「請確認」). The signals fire in `sidepanel.js` `noteStatsCorrections` just before the affix query starts (a number typed over `readMin`, a base typed over the record's own, or `ocr.noteBaseQuery` for a pasted picture) and in `noteListingCorrections` after a listing was `posted`; a value left as read, a condition added from a menu (no `line`) and a base record (searched by its own name) are never learned. Measured in the real Chrome (`scripts/ocr_e2e.py --skip-download`, 詞綴組, 2026-10-22, `image-4.png`, a Small Charm whose cold-resist line reads 11): typing 12 and starting the (stubbed) query stored `m: 12`, and the next read of the same picture after a panel reload filled `12` with class `from-learned` and no `from-capture` (`value_learned: { stored: true, refilled: "12", marked_learned: true }`); the accuracy groups did not move (tuned 18/18, held-out 30/30, 0 wrong fills) and `scripts/scan_e2e.py` still passes. Not measured: how often a real player corrects a base or a number, and whether a repeated misread produces the same line text twice on a real tooltip (the key is the exact normalised line, so a different misread is a different key).


## Tooltip crop identity (boxKey): NaN bug fix, candidate measurements, and verdict (measured 2026-10-15)

The shipped tooltip crop identity `boxKey` (8x8 mean-grey cells over the panel top square, quantised into 6 levels, tolerance `KEY_TOLERANCE = 0.125`, i.e. 8 of 64 cells) was investigated and measured offline across all 35 truth screenshots (`scripts/data/image-1..20.png`, `image-31..60.png`), 4 phone photos, 3 stage sizes (1280x720, 1920x1080, 2560x1440) on both backdrops (`sim`, `bars`, slots A and B, 432 frames), and 716 pairs on diagnostic frames (`artifacts/repeatfix/frames..5`).

### 1. Root cause of lost items (41/43/49) and the NaN mechanism
The missing items on `scripts/data/scan_sim_failures.html` were caused by a numeric defect in `tooltip.js`:
1. When PP-OCR fallback rescues a translucent tooltip, `clusterAndPad` computes a box on the 720px frame, which `scan-panel.js` scales to the 480px frame (`scX = 480 / 720 = 2/3`, `scY = 270 / 405 = 2/3`). When coordinates are not divisible by 3, `boxSmall` receives fractional pixel coordinates.
2. `panelRegion` searches for dark borders; on translucent panels without dark borders, it falls back to the box itself (`return box`).
3. In `gridCells` and `cellMean`, `for (let y = y0; y < y1; y++)` incremented fractional `y`, evaluating `p = (y * width + x0) * 4` as a non-integer float index.
4. Typed array access `img.data[p]` on float `p` returns `undefined`, causing pixel additions to evaluate to `NaN` and `cellMean` to return `NaN`.
5. `greyLevel(NaN)` returns `NaN`, concatenating into a 192-character string of repeated `"NaN"` (64 cells × 3 characters).
6. `image-13.png`, `image-20.png`, and `image-41.png` each generated this identical 192-char `NaN` key. `accept` measured distance 0 ($\le 0.125 \times 192 = 24$), falsely rejecting subsequent items as duplicates.

**The fix in `tooltip.js`:**
`darkBounds`, `panelRegion`, `sampleRegion`, `cellMean`, and `gridCells` now explicitly round and clamp all coordinates to integral pixel boundaries (`Math.round`, half-open `[ix0, ix1) x [iy0, iy1)` clamped to `[0, width] x [0, height]`). Fractional box inputs are guaranteed to produce the exact same 64-character digit string as their rounded pixel boxes, completely eliminating `NaN` keys.

### 2. Failure page offline replay with the fix
Replaying all 7 tooltips on `scripts/data/scan_sim_failures.html` through the fixed sampler:
- `image-11.png`: `01222210000121000122...` (len 64) -> **ACCEPTED**
- `image-13.png`: `11222111111221211112...` (len 64) -> **ACCEPTED**
- `image-16.png`: `01221100011211100112...` (len 64) -> **ACCEPTED**
- `image-20.png`: `00011011011121100011...` (len 64) -> **ACCEPTED**
- `image-41.png`: `00111111000110000011...` (len 64) -> **ACCEPTED**
- `image-43.png`: `00121000111221101111...` (len 64) -> **ACCEPTED**
- `image-49.png`: `12222111111111110111...` (len 64) -> **ACCEPTED**
- **Result: 7 of 7 accepted (100%).**
- **Pairwise distances between all 7 tooltips:** min 22, max 43 (every pair is $\ge 22$, far above tolerance 8).

### 3. Corrected baseline and candidate comparison table

| Candidate | Signature & Grid | Tolerance $T$ | Cost (ms) | Size | Different Items Min (720p / 1080p / 1440p) | Diff Pairs $\le T$ | Same-Item Re-encoded (Same Pos/Scale) | Same-Item Repositioned (Diff Pos/Scale) | Failures Page Replay | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **8x8 (Fixed)** | 8x8, 6 levels, top | 8 of 64 (12.5%) | 0.195 | 64 chars | 8 / 6 / 7 | 33 / 16774 | min 0, med 1, max 31 (>tol: 20/198, frames2: 9) | min 0, med 2, max 40 (>tol: 9/153) | 7 / 7 Accepted (min dist 22) | **KEPT (Winner)** |
| **Cand 1** | 12x12, 6 levels, top | 14 of 144 (9.7%) | 0.181 | 144 chars | 23 / 22 / 19 | 0 / 16774 | min 0, med 4, max 81 (>tol: 21/198, frames2: 9) | min 0, med 6, max 88 (>tol: 22/153) | 7 / 7 Accepted | Rejected (no stability gain) |
| **Cand 2a** | 16x16, 8 levels, top | 25 of 256 (9.8%) | 0.192 | 256 chars | 68 / 73 / 68 | 0 / 16774 | min 0, med 16, max 189 (>tol: 62/198) | min 0, med 18, max 165 (>tol: 52/153) | 7 / 7 Accepted | Rejected (degraded stability) |
| **Cand 3** | 16x16 MAD (float) | 8.0 grey levels | 0.181 | 256 floats | 13.0 / 13.7 / 13.9 | 0 / 16774 | min 0, med 2.5, max 39.0 (>tol: 19/198) | min 0, med 2.5, max 39.9 (>tol: 8/153) | 7 / 7 Accepted | Rejected (256 floats size) |
| **Cand 4** | 12x12 + Aspect bucket | 14 of 144 | 0.184 | 147 chars | 38 / 37 / 42 | 0 / 16774 | min 0, med 8, max 999 (>tol: 24/198) | min 0, med 8, max 999 (>tol: 36/153) | 7 / 7 Accepted | Rejected (aspect jumps) |
| **Cand 5** | 8x16 Text-density Profile | 12 of 128 (9.4%) | 0.185 | 128 chars | 32 / 25 / 35 | 0 / 16774 | min 0, med 6, max 79 (>tol: 23/198) | min 0, med 6, max 79 (>tol: 26/153) | 7 / 7 Accepted | Rejected (no stability gain) |

### 4. Verdict and adoption rationale
- Under the corrected framing, Candidate 1 (12x12) and Candidate 2 (16x16) do not beat 8x8 in same-item stability: on pure jitter (`frames2`), 12x12 fails the exact same 9 pairs as 8x8 while 16x16 degrades significantly (62 pairs exceed tolerance due to higher spatial sensitivity).
- The root cause of the lost items in `scripts/data/scan_sim_failures.html` was the `NaN` key defect from non-integral coordinates, not an inherent inability of the 8x8 grid to separate them.
- With the `tooltip.js` integral clamping fix in place, the 8x8 grid cleanly separates all 7 failure tooltips (minimum pairwise distance 22 vs tolerance 8) and accepts 7/7 items with 0 duplicate collisions. The 8x8 signature is therefore retained as the official implementation.

## The 2 s target: two pipelines for the scan? Measured and rejected (2026-10-15)

The owner's target: an item must be identified within 2 s. Definition used here: for the scan, from the crop being
accepted (the tooltip stable) to the record's name in the list; for the reader, from 辨識 to the name filled/offered.
Both are measured on this machine, dedicated Chrome, WebGPU; the scan numbers come from
`artifacts/repeatfix/sweep.py` (a throwaway harness that reads `__jevLastRun.scan.cropTimings`, whose `perceivedLatencyMs`
is that latency), the reader's from `scripts/ocr_e2e.py` rows.

Baseline, one pipeline (measured, that is the shipped state):

| path | before, median / p90 / max |
|---|---|
| scan, `scan_sim.html` (tooltip every 0.9 s) | 1092 / 1670 / 1670 ms (n=4) |
| scan, `scan_sim_failures.html` (every 4.1 s) | 643 / 812 / 1078 ms (n=8) |
| scan, `artifacts/repeatfix/scan_sim_hold.html` (long holds, jitter) | 565 / 857 / 1362 ms (n=15) |
| reader, tuned screenshots | 1700 / 1900 / 2200 ms (n=18) |
| reader, tuned phone photos | 4300 / 4400 / 4400 ms (n=4) |
| reader, held-out screenshots | 1900 / 2300 / 2400 ms (n=18) |
| reader, held-out phone photos | 3700 / 4000 / 4100 ms (n=12) |

The reader already meets the target on screenshots (median 1.7-1.9 s) and phone photos are allowed to exceed it (they are
~2x the pixels, so det and rec both scale up). The scan's *median* is inside 2 s everywhere; its p90 on the fast page
walks over the line whenever a second crop queues behind the first (an earlier run of the same page measured 1267 / 2439 ms).

**P5, two reads in flight: built, measured, rejected.** The engine cache became a bounded lane pool (a `SCAN_LANES` of two:
a caller that asks for two lanes gets engines of its own, waits for a free lane instead of creating a third, and a
single-lane caller keeps sharing the first engine exactly as before), and the scan's pump kept two crops in flight
(`PUMP_SLOTS`, a slot freed starts the next; each job carries its own key and generation). Measured: two ORT **WebGPU**
engines in one Chrome do not work — every read on the fast page came back `Session mismatch` (0-2 records, and
`scan_e2e.py` reported 辨識失敗 with 0 records) — and a second lane on **wasm** works but reads in 4.6 s median, i.e.
far slower than the one WebGPU lane it was meant to help. Both are on this machine's headless Chrome; the failure is in
the two-instance case, not in the pool (its unit tests pass, and the pool is correct: it hands out at most the lanes a
caller asked for and terminates every lane when idle). Found and fixed on the way, and worth keeping in mind for any
future second engine: `createOcrEngine` posts the model bytes as *transferables*, so a second engine built from the same
`models` object got empty arrays — the pool exposed it, and a per-engine copy is the fix.

**Lever 2, capping det's input for the scan: built, measured, rejected.** The scan's crops are 420-560 px a side, while
`CFG.det`'s own policy ("min side 736") magnifies them to ~736x960 before det. Feeding that cap instead (`detLimit` per
read, plumbed through `ppocr-worker.js` and `ppocrlib.detInputSize`) cut the scan read by about 40 %:

| scan page (lever 2) | before median / p90 / max | after median / p90 / max |
|---|---|---|
| `scan_sim.html` | 1092 / 1670 / 1670 ms (n=4) | 638 / 1312 / 1312 ms (n=4) |
| `scan_sim_failures.html` | 643 / 812 / 1078 ms (n=8) | 346 / 369 / 681 ms (n=8) |
| `scan_sim_hold.html` | 565 / 857 / 1362 ms (n=15) | 325 / 617 / 1063 ms (n=15) |

... and it met the gate on the fast page (median and p90 under 2 s), at *lower* memory (dedicated Chrome peak 2302 MB
total / 1282 MB GPU against 2693 / 1532). It was still rejected: the shipped failures-page verdict lost one record's
name with the cap in 2 of 2 runs (480 and 736), while the no-cap control passed with all 8 records and the name present
— so the cap costs accuracy on the hardest page, and accuracy comes first. Both changes were reverted to their measured
baseline after these numbers.

Memory, for the record (dedicated Chrome only; the owner's own Chrome runs on this machine and is filtered out of the
sample): one pipeline peaks at 2693 MB total / 1532 MB GPU on the fast page, 3476 / 2238 on the long hold page, against
~1.1-1.3 GB idle. Two WebGPU engines could not be measured for a peak because they do not run at all (above).

**What still misses 2 s, and the next lever.** The scan's p90 on a fast sweep (1670-2439 ms across runs: it is the second
crop of a burst that waits), and the reader's phone photos (3.4-4.4 s when this was written; superseded the same week by
the coarse-detect cap, see "The reader's phone photos: detect coarse, read fine (shipped, 2026-10-15)" below — the
shipped medians are 2.1 s tuned / 1.9 s held-out). The next lever is the
one this turn did not take: report the *name* from a scan read as soon as its name lines are recognised, in the same job
(`nameRegionOnly`'s cutoff already exists in `ppocrlib.js`, and the worker protocol can carry a partial result), so the
record's name appears after the name lines instead of after every affix line — that cuts the perceived latency by the
rec time of the remaining lines (rec is ~450 ms of a 700 ms read) without touching det's scale. A second pipeline would
need a WebGPU-compatible shape first (one engine with two sessions in one worker, rather than two engines).

## Head first: the name is decided on the first six lines (measured 2026-10-20)

Why: a read costs detection (fixed) plus classify and recognise per line, about half of it per-line work, and a unique item has 16.9 lines on average against 8.4 for a base, so uniques were the slow ones. The name needs only the top of the tooltip: the offline table above (first 6 lines against the whole text) is identical in accuracy. `recognizeImage` therefore reads the first `HEAD_LINES = 6` lines in reading order, reports them (`onHead`, the worker's `head` message), then reads the rest; nothing is read twice, so the total stays the same. The earlier `nameRegionOnly` was never passed by any caller and is deleted.

Measured with `scripts/ocr_e2e.py` on the same 52 pictures, same machine, same session, once with `HEAD_LINES` set to 1000 (no head: the old behaviour) and once as shipped; medians of the seconds the panel shows:

| Group (rows) | Whole read, no head | Whole read, head first | Name decided, head first |
|---|---|---|---|
| Uniques, screenshots (20) | 2.2 s | 2.1 s | 1.6 s |
| Bases, screenshots (16) | 1.9 s | 1.7 s | 1.4 s |
| Phone photos (16) | 2.1 s | 2.0 s | 1.4 s |

Accuracy is unchanged in both runs: tuned group 22 of 22 sure and right, 0 wrong fills; held-out group 30 of 30 right, 1 asked, 0 wrong fills. The whole read costs the same (the two batches of the split pad their lines a little differently, which can change a garbled line's text, never its cost). In the scan, the record is on the list at the head: `perceivedLatencyMs` against `readMs` on the four-record sim was 930, 585, 634, 495 against 1327, 625, 891, 687.

What the whole text still decides in the scan: `session.finishRecord` takes the whole text's own decision as the record's (a sure name replaces the head's; possible names turn a named record back into a question; a whole text that names nothing leaves the head's name), and removes a provisional record whose whole text reads as an item already listed (counted 略過). That is what the earlier "name first" attempt lacked (its record's text stayed the short head), and it is why this one produces no duplicates (failures sim: 7 records, 0 duplicates). The reader keeps a name its head was sure about and decides again on the whole text only after an unsure head.

Where the rest of the time goes (uniques, screenshots, medians of 20 reads, ms): detection 545, classify 105, recognise 737, engine total 1489, name decided at 1082; the panel's shown seconds add about 0.5 s the e2e pays because it reloads the page, and so the engine, before every picture. Two further cuts were tried against the same pictures and both broke the accuracy gate, so neither ships: detection's side limit 736 -> 576 together with a 4-line head (tuned group 20 of 22 right, 2 wrong fills, one picture read as nothing), and a 4-line head alone (tuned group 21 of 22, 1 wrong fill: a phone photo; held-out group unchanged). The head stays at 6 lines and the detector's policy at the model's own; what is left to remove is per-line work that the name needs.

One check changed: the failures sim's fallback crop of image-49 holds part of a second tooltip; with the head split its whole text names it The Redeemer (the truth for image-49 in `ocr_truth_holdout.json`) where it used to name Ars Dul'Mephistos, so `scan_e2e.py` now expects The Redeemer for it. The old expectation was the wrong one of the two names in that crop.

## Name first, then the rest: built, measured, rejected (2026-10-15)

The 2 s target's remaining problem was the burst: with one full read (~700 ms) at a time, the Nth queued tooltip waits
(N-1) whole reads. The design built for that was two phases over the queue: phase 1 reads only each crop's name region
(`nameRegionOnly`, the cutoff already in `ppocrlib.js`) in arrival order and makes the record from that answer at once,
phase 2 reads the lines after it (`skipLines`, so no line is recognised twice -- the worker is told where the name read
stopped) and updates that same record through `session.updateAffixes`; a waiting name always preempts a queued phase-2
read, and a crop whose name read failed is read whole in phase 2 so nothing is lost. The record's text after both
phases is the name half and the affix half joined, exactly what one whole read produced.

It met the latency target and was still rejected for correctness:

| scan page | before, median / p90 / max | name-first, median / p90 / max |
|---|---|---|
| `scan_sim.html` run 1 | 1078 / 1568 / 1568 ms (n=4) | 717 / 1502 / 1502 ms (n=4) |
| `scan_sim.html` run 2 | 1046 / 1664 / 1664 ms (n=4) | 743 / 1395 / 1395 ms (n=4) |
| `scan_sim.html` run 3 | 1035 / 1552 / 1552 ms (n=4) | 722 / 1518 / 1518 ms (n=4) |
| `scan_sim_failures.html` | 617 / 769 / 997 ms (n=8) | 419 / 553 / 750 ms (n=8) |
| `scan_sim_hold.html` | 565 / 905 / 1637 ms (n=15), 11 records for 11 items, 0 duplicates | 392 / 546 / 1542 ms (n=15), **15 records for 11 items, 2 duplicates** |

- The fast page's median fell about 30 % (1035-1078 -> 717-743 ms) and its p90 stayed inside 2 s in all three runs
  (1395-1518 ms, against 1552-1664); the p90 mostly tracks the tooltip spacing, so it could not fall as far.
- The failures page lost one record's name (`Ars Dul'Mephistos`, image-49) in that run: the name region stops at the
  first stat-looking line, and on that picture the name read comes away without the name -- a real accuracy regression,
  and the same page's name-first run had it while the single-pass control did not.
- The long-hold page produced 15 records for 11 items with 2 duplicates: a record's text is now the *name region* (55-90
  characters) until phase 2 lands, and the same-item text rule was measured on 150-400 character reads, so under the
  hold page's jitter a second crop of the same item no longer looks like the same read.

The change was reverted. The extra engine time was *not* the problem (phase 2 skips the lines phase 1 read, so the total
rec work is unchanged; the only added cost is a second det on the same crop, about 180 ms per crop, i.e. the engine
time rose by roughly 1.25 of the name read, inside the +25 % budget).

Kept from this round, at the other worker's request: `scan-panel.js` now rounds the fallback box it scales out of the
detector's frame (`Math.round` on x/y/width/height) instead of handing fractional pixel coordinates to `boxKey` and the
crop arithmetic. A box is a pixel rectangle; no consumer wanted fractions, and the crop arguments are now whole pixels
(asserted in `scan-panel.test.mjs`).

## The reader's phone photos: detect coarse, read fine (shipped, 2026-10-15)

The last picture path over 2 s was the reader's phone photos: about twice the pixels of a screenshot, so `det` ran on
two to three million pixels (~1100 ms) and `rec` on the rest. The fix is the one the scan's cap could not be: the
reader's own read (`ocr/panel.js`) asks for the detector's input to be capped **only for a large picture** (over 1500 px
a side), and only then is `det` run on a copy whose long side is the model's own limit; the boxes come back in the
picture's coordinates and the crops the recogniser reads are still cut from the picture itself, so the letters keep
their detail. Screenshots (under the threshold) keep the model's policy byte for byte -- nothing about them changed --
and the scan's reads never ask for the cap (a tooltip crop keeps the policy the scan's accuracy was measured with).

| group | before | after |
|---|---|---|
| tuned screenshots, seconds (median / p90 / max) | 1.7 / 1.9 / 2.2 | 1.7 / 1.9 / 2.4 |
| tuned phone photos | 4.3 / 4.4 / 4.4 | **2.1 / 2.3 / 2.4** |
| held-out screenshots | 1.9 / 2.3 / 2.4 | 1.9 / 2.3 / 2.4 |
| held-out phone photos | 3.7 / 4.0 / 4.1 | **1.9 / 2.2 / 2.4** |
| tuned accuracy | top1 22/22, top3 22/22, asked 0, auto_wrong 0 | unchanged (22/22, 0, 0) |
| held-out accuracy | top1 29/30, top3 29/30, asked 2, auto_wrong 0 | unchanged (29, 29, 2, 0) |

The four phone photos in the tuned group kept their own answers (`asked_top3` 0 both before and after, `top3` 4/4), and
nothing in the scan path moved (its three e2e runs: 4 records, 7-8 records with no strict duplicate, 11 records for 11
items, and the same crop latency 559 / 882 / 1342 ms on the long-hold page). The tuned group's *average* phone number is
still 2.1 s (its slowest picture 2.4 s), so the target is met on the held-out phones (1.9 s) and missed by 0.1 s on the
tuned ones; the remaining cost there is `rec` on the affix lines, which is what a smaller or quantised recogniser (the
P7 item) would attack -- with an accuracy gate of its own.

Measured and rejected on the way here, so nobody repeats them: the same cap applied to the **scan**'s small crops (it
lost a record's name on the fallback page), the two-phase **name-first** read (median 30 % better, but a lost name and
duplicates), and two **WebGPU engines** in one Chrome (every read fails with `Session mismatch`);
`docs/design.md`'s earlier sections carry each one's numbers.
## First-crop warm-up and queue telemetry (shipped, 2026-10-16)

A WebGPU engine's first real inference cost +548-569 ms over the warm mean due to lazy WGSL shader compilation and startup stalls. In the engine cache (`extension/src/ocr/engine.js`), `engineFor` creates the engine and does not warm it; a synthetic warm-up pass (`ppocrlib.js` `warmup()`) runs only when explicitly armed through `keepWarm(capability, { warmup: true })` (the default, used by `scan-panel.js` on scan start which awaits `keepWarm().ready`), feeding realistic tensor shapes (`[1, 3, 736, 960]` for det, `[1, 3, 48, 192]` for cls, and `[1, 3, 48, 320]` for rec) through the same sessions before the first real crop arrives. The screenshot reader calls `keepWarm(..., { warmup: false })`, so a reader read is never preceded by or awaited behind a synthetic pass. On `scripts/scan_e2e.py` (normal page), the first crop's `readMs` dropped from 3326 / 2849 ms to 1456 / 1325 ms (stages.total 1446 / 1314 ms vs 1633 / 1747 ms) down to the warm range (~800-1456 ms), while subsequent crops (812-1583 ms) and total sweep time (20.4-20.6 s) were unaffected. Concurrently, queue wait telemetry (`waitMs`) was activated: `session.js` `accept()` now stamps `queuedAt` when a crop is accepted into the queue (chosen so `waitMs = started - job.queuedAt` reflects true queue wait time until OCR begins), surviving `take()`; the simulated fast sweep reveals median queue wait of ~1.1-1.2 s (up to 1.8 s) during tooltip bursts, explaining the uneven latency felt by the player. Full-run measurements across identical code show run-to-run spread of 1.0-1.5 s under headless Chrome GPU scheduling (`2026-10-18 16:42:17`: screenshots 2.4 s, phones 3.0 s, held-out 2.4/2.4 s; `2026-10-18 17:01:49`: screenshots 3.4 s, phones 4.5 s; `2026-10-18 17:22:36`: screenshots 1.8 s, phones 2.2 s, held-out 2.0/2.0 s), meaning the historic 1.7 s baseline cannot be compared at sub-second resolution without controlling for background GPU process variance. Crucially, a warm-up that costs real inference must run once per engine and never sit in front of a read: decoupling the synthetic warm-up pass so it runs only when explicitly armed for scan startup (`keepWarm({ warmup: true })`), while the reader acquires the engine without queueing synthetic inference, ensures reads are never blocked behind unneeded tensor passes.


## Recognition batch size: built, measured, rejected (2026-10-21)

`CFG.rec.batch_num` 6 -> 12 (fewer, larger WebGPU dispatches; crops are already sorted by aspect, so padding stays small). Same command both times (`uv run --group e2e python scripts/ocr_e2e.py --skip-download`, 52 pictures), medians of the engine's own stage times (`rows[].stages`, ms), which exclude the page reload the shown seconds include:

| group | rec, batch 6 | rec, batch 12 |
|---|---|---|
| screenshots (38) | 808 | 812 |
| phone photos (16) | 920 | 713 |

The screenshots' `rec` did not move. The phone photos' did, but `det` (untouched by the change) fell 521 -> 319 between the same two runs, so that gain is run-to-run noise of the machine (the two runs' totals were 7.5 and 4.6 minutes). Answers and accuracy were identical in both runs (tuned 22/22, held-out 30/30, 0 wrong fills). Reverted: neutral is not kept. Use the stage times, not the shown seconds, to judge a recognition change, and expect about +-20-40 % between runs on this machine.

## The reader builds its engine before the picture arrives (shipped, 2026-10-21)

Where the first read's time went: the seconds the panel shows exceed the engine's own `stages.total` by a steady 0.86 s median (705-1240 ms over 50 reads), because `engines.run` created the worker and its four sessions only when the picture was loaded. `initOcrPanel` now asks for the engine at start when the models are already stored (never a download) and releases it at once, so the usual 60 s idle countdown applies and the engine is gone again if no picture comes. No synthetic warm-up pass (the reader still never queues one in front of a read).

Same command both times (`scripts/ocr_e2e.py --skip-download`, 18 + 30 pictures, which reloads the page and loads the picture straight away, so this is the *least* head start a real player gives it):

| | before | after |
|---|---|---|
| gap, shown seconds minus engine total (median / min / max, ms) | 860 / 705 / 1240 | 616 / -44 / 1165 |
| reads under the old minimum of 705 ms | 0 of 50 | 31 of 50 |
| shown seconds, median | 2.5 | 2.15 |
| answers and accuracy | tuned 18/18, held-out 30/30 | identical (0 wrong fills, same top-3 on every picture) |

The engine's own medians (1630 -> 1484 ms) moved too, but that is the machine's run-to-run spread (see "Recognition batch size"); the gap is the figure this change is judged on. Cost: one engine's memory for up to 60 s after the reader starts without a picture.

## Listing on Traderie (measured 2026-10-21)

What 「TR交易」 (`extension/src/traderie/listing.js`, `listing_flow.js`) relies on, measured with `scripts/probe_listing.py --observe` (read-only, dedicated Chrome, the owner's login) and by reading the site's own front-end bundle (`/assets/index-*.js`, the code that builds and sends the Add Listing form). The third-party helper the plan started from said multipart; the site's own client does **not**.

- **Item record (`ITEM_PATH`)**: `GET /api/diablo2resurrected/items?id=<slug>&variants=&tags=&properties=&adding=true` → `{ items: [ { id, type, mode, slug, name, properties: [ { property_id, id, name, type, options, required, min, max, format } ] } ] }` (200 for `harlequin-crest`, `ring`, `ber-rune`; `id` is a digit string; `type` is `uniques` / `misc` / `runes`; the page itself asks for the same record with `adding=false&info=true&seo=true`). Fixtures: `extension/test/fixtures/item_harlequin_crest.json`, `item_ring.json`, `item_ber_rune.json` (description, picture, info, seo and recipe dropped).
- **Required properties of every item measured**: `Platform` (string: `PC`, `switch`, `playstation`, `xbox`), `Mode` (string: `softcore`, `hardcore`), `Ladder` (**bool**; the options `Ladder`/`Non Ladder` are only its labels), `Game version` (string: `classic (base game)`, `lord of destruction`, `reign of the warlock`), and for a base (`ring`) `Rarity` (string: `rare`, `magic`, `superior`, `normal`, `low quality`). There is **no Region property** on D2R, so the settings block carries the game version instead (default `reign of the warlock`). The site's own client refuses a listing missing any `required` property that is not `syncOnly`; the program does the same before posting.
- **Create**: `POST /api/diablo2resurrected/listings/create`, **JSON** (`Content-Type: application/json`, `JSON.stringify(body)`), `Authorization: Bearer <localStorage.jwt>`, `credentials: "include"`; the answer goes through the same JSON reader as every other call. The client first validates against a strict schema (unknown keys are rejected), so the body only carries: `item` (the record's `id`), `itemType` (the record's `type`), `itemMode` (the record's `mode`), `amount` (a positive-integer string), `selling: true`, `makeOffer`, `items`, `properties`, `currencyGroupPrices`, `captcha`, `captchaManaged`, `acceptListingPrice`, `all`, `diy`, `free`, `needMaterials`, `offerBells`, `offerNmt`, `offerWishlist`, `offerWishlistId`, `standingListing`, `stockListing`, `touchTrading`, `wishlist`, and optional `endTime`, `variant`. A `properties` entry is the item's property with its value moved to the key named after its type: `{ id, name, type: "string", string: "PC" }`, `{ …, type: "bool", bool: true }`, `{ …, type: "number", number: 8 }`. A price row of `items` is `{ id, value, item_id, quantity, group, diy, offerProps }` (the wanted item's id three times; `group` is the 「或」 alternative, rows in one group are 「和」).
- **Captcha**: the client demands a token only when the game's feature list (`GET /api/games?game=diablo2resurrected` → `features`) contains `LISTINGS:CAPTCHA` **and** the user's `skip_captcha` (`GET /api/diablo2resurrected/users/details?` → `details.skip_captcha`) is false. Measured: D2R's feature list does not contain `LISTINGS:CAPTCHA` (and this account has `skip_captcha: true`), so no token is needed. The flow reads both before posting and refuses with a reason when a token would be required.
- **Own listings (the independent check)**: there is no `listings/user`: that address answers 200 with the site's HTML shell. The profile page reads `GET /api/diablo2resurrected/listings?itemTags=true&selling=true&auction=false&page=0&seller=<own id>&completed=false&active=all` (own id from `GET /api/diablo2resurrected/user?` → `user.id`) → `{ listings: [ { id, seller_id, item_id, selling, active, make_offer, … } ] }`. A listing is verified by `item_id` equal to the posted `item` (and the reply's id when it carries one).
- **The rune picker (measured 2026-10-22 with `scripts/scan_e2e.py`)**: the first shipped build listed only 請選符文: `extension/build.py` reduced every product to `name`/`slug`, so `runeProducts` (category `runes`) found nothing in the built table. The build ships `category` now and the e2e fails on a picker under 10 entries. The runes are listed in game order (`RUNE_ORDER`), not the table's alphabetical order.
- **Not measured**: the answer to a real create (the field that carries the new listing id) and whether the server accepts the property entries exactly as the client builds them. Nothing was posted: that needs the owner's own listing (`env JEV_CHROME=window uv run --group e2e python scripts/probe_listing.py --record-create --slug ber-rune` records one made by hand; it writes `extension/test/fixtures/listing_create.json` and prints the create answer's keys). `listingIdFrom` therefore accepts `id`, `listing.id` or `listing` and falls back to the own-listings check.

## Boundaries

Up to 250 action candidates are retained; truncated candidates cannot be selected. The service stays loopback-only, serializes inspector actions, and checks Host, Origin, and a local request token. Credentials remain server-side. Tabs run in the dedicated Chrome's profile (`src/.tmp-jev-chrome`, git-ignored; in `JEV_CHROME=existing` mode in the user's own Chrome profile, which is then the one being driven).

The policy is generic, but two websites do not establish broad reliability. Name resolution covers common labels, ARIA references, and text; it is not the browser's full accessibility algorithm. Shadow roots, frames, canvas, uploads, nested scrolling, pop-ups, and complex keyboard interactions can block progress. A valid action can still be wrong. Independent checks, rather than the model's DONE choice, determine whether the demonstrated task succeeded.
