// Which screen the panel shows and how input gets into the forms: the screen ("scan" is home | "name" | "stats" | "listing"),
// where the coming query's input came from (`runSource`: a scan record or a picture), the query form's own rendering,
// the scan list's 精準搜尋 / 模糊搜尋 hand-offs, the screenshot reader's callbacks (a picked name, read text, a new
// picture), what the player's edits of the affix form teach the memories, and the affix form's warm-up. Starting a
// query, ending it and the page's own state stay in the panel: this module gets what it needs through the parameter
// object and never imports sidepanel.js.
import { Tab, loadPageScripts } from "./cdp.js";
import { $, element } from "./dom.js";
import { LEARNED_SURE } from "./ocr/match.js";
import { clock } from "./panel-dom.js";
import { ensureProperties } from "./traderie/properties.js";
import { RARITY_BY_QUALITY } from "./traderie/listing.js";
import { baseOptions, tableEntry } from "./traderie/lookup.js";
import { TRADERIE_D2R_URL } from "./traderie/site.js";

const MODE_TEXT = {
  name: { title: "精準搜尋", help: "輸入裝備名稱就能查（暗金、套裝等固定名稱）" },
  stats: { title: "模糊搜尋", help: "用底材、品質和詞綴條件找" },
};

/** The base a scan record is searched by: its own name for a base result, else the base candidate of the same read. */
const baseOf = (record) => (record.kind === "base" ? record.name : record.base);

/** The quality filter of the affix search, from the colour of the name line (Traderie's own words); else any. */
const recordQuality = (record) => RARITY_BY_QUALITY[record.quality] ?? "any";

/** Whether the record's base came from the reader or from the base memory (the form asks the player to confirm a remembered one). */
const baseSource = (record) => (record.kind !== "base" && record.baseLearned ? "learned" : "ocr");

/** The scan record a query came from, as the results screen and the affix hand-off need it. */
function scanSource(record) {
  return {
    kind: "scan",
    time: clock(record.at instanceof Date ? record.at.toISOString() : null),
    affixes: (record.conditions ?? []).map((condition) => condition.label).join("、"),
    record,
  };
}

/**
 * `isRunning()` / `isListingBusy()` lock the screen, `render()` redraws the panel, `blockReason()` is the invite's block,
 * `start()` starts the query of the current form, `forgetEndedQuery()` drops a finished query's result and banner,
 * `dismissResult()` drops them unconditionally, `backToForm()` returns to the form with the old results kept,
 * `getStatsForm()` / `getOcr()` / `getTables()` hand over the panel's late-built parts, `loadTables()` resolves with
 * the item tables and `valueCorrections` is the affix-number memory.
 */
export function createScreenFlow({
  isRunning,
  isListingBusy,
  render,
  blockReason,
  start,
  forgetEndedQuery,
  dismissResult,
  backToForm,
  getStatsForm,
  getOcr,
  getTables,
  loadTables,
  valueCorrections,
}) {
  let queryMode = "scan"; // the screen: "scan" is home | "name" | "stats" (the two forms) | "listing"
  let modeFromPicture = false; // the mode was set by a picture, not by the player: the reading may still switch it
  let runSource = null; // { kind: "scan"|"picture", time?, affixes?, record? } the input of the coming query came from
  let affixWarmed = false;

  /** The query form of the chosen search kind: name box or base box plus the affix part; locked while a query runs. */
  function renderModeForm() {
    const running = isRunning();
    const item = $("item");
    item.disabled = running;
    const statsMode = queryMode === "stats";
    document.body.dataset.mode = queryMode ?? "";
    const text = MODE_TEXT[queryMode];
    $("mode-title").textContent = text?.title ?? "";
    $("mode-help").textContent = text?.help ?? "";
    $("mode-change").disabled = running;
    $("item-label").textContent = statsMode ? "底材名稱" : "裝備名稱";
    $("item-label").htmlFor = statsMode ? "stats-base" : "item";
    item.hidden = statsMode;
    $("stats-base").hidden = !statsMode;
    $("item-help").textContent = statsMode ? "可輸入中文或英文裝備" : "中文或英文都可以，也可貼上截圖";
    $("part-stats").hidden = !statsMode;
    getStatsForm()?.setBusy(running);
  }

  /** Best effort, once: have Traderie's property list and the shipped item types ready before the first affix fill. A
   * failure is reported where the query needs it (judgeStats), never here. */
  function warmUpAffixForm() {
    if (affixWarmed) return;
    affixWarmed = true;
    loadTables()
      .then((loaded) => fillBaseOptions(baseOptions(loaded)))
      .catch(() => {});
    loadPageScripts()
      .then((scripts) => ensureProperties({ openTab: () => Tab.open(TRADERIE_D2R_URL, scripts), scripts }))
      .catch(() => {});
  }

  /** The base is still required, but the form offers the shipped item types: a unique item's tooltip never names its base,
   * so without this the player would have to know it from the game. A suggestion, never a restriction. */
  function fillBaseOptions(options) {
    const list = $("stats-base-options");
    if (!list || !options.length) return;
    list.replaceChildren(...options.map((name) => element("option", { value: name })));
  }

  /** Switches between the screens. Never persisted: the panel asks every time. */
  function setMode(mode) {
    queryMode = mode;
    if (mode === "stats") warmUpAffixForm(); // the first fill should not have to wait, and the base list should be there
    render();
  }

  /** Where typing starts on the current screen. */
  function focusEntry() {
    const id = { stats: "stats-base", scan: "scan-title", name: "item", listing: "listing-change" }[queryMode];
    $(id).focus();
  }

  /**
   * Shows a screen ("scan" is home); a finished query's result and its banner are left behind, typed text stays in the
   * forms. Refused while a query runs or a listing is being posted. It never touches the capture.
   */
  function chooseMode(mode) {
    if (isRunning() || isListingBusy()) return;
    modeFromPicture = false;
    forgetEndedQuery();
    runSource = null;
    setMode(mode);
    focusEntry();
  }

  /** The listing screen (the scan list's 「TR交易」 opens it). */
  function showListing() {
    modeFromPicture = false;
    setMode("listing");
  }

  /** Opens a search screen for a scan record: the last result and banner are dropped and the record is the run's source. */
  function openForRecord(mode, record) {
    modeFromPicture = false;
    dismissResult();
    setMode(mode);
    runSource = scanSource(record);
  }

  /** The scan list's 精準搜尋: the name query for the record's name starts at once. */
  function onSearchName(record) {
    if (isRunning() || blockReason() || !record.name) return; // the button is disabled without a name
    openForRecord("name", record);
    $("item").value = record.zh || record.name; // shown Chinese-first; resolveInput gives Traderie the English name
    return start();
  }

  /**
   * The scan list's 模糊搜尋: the affix query starts at once with the record's base and the quality of its name line, and
   * no affix condition. A record with no base cannot be searched this way: the form opens with the base box focused.
   */
  function onSearchStats(record) {
    if (isRunning() || blockReason()) return;
    openForRecord("stats", record);
    const statsForm = getStatsForm();
    statsForm.rememberScreenshot(record.text);
    const base = baseOf(record);
    if (!base) {
      focusEntry();
      return;
    }
    const from = baseSource(record);
    statsForm.setForRecord({ base, quality: recordQuality(record), from });
    // One correction asks (the form opens with the base marked for confirmation), the second identical one starts at once,
    // as the name memory does.
    if (from === "learned" && record.baseLearned < LEARNED_SURE) {
      focusEntry();
      return;
    }
    return start();
  }

  /** The affix form for a scan record, nothing started: the base and the affix lines the read found, ticked and marked as
   * coming from the capture for the player to confirm (the result screen's 用詞綴找同類 / 加詞綴條件縮小範圍). */
  function openAffixForm(record) {
    openForRecord("stats", record);
    const statsForm = getStatsForm();
    const base = baseOf(record);
    if (base) statsForm.setBaseFromScreenshot(base, { from: baseSource(record) });
    statsForm.fillFromText(record.text, { carryValues: true }); // the numbers come from the capture, marked for confirmation
    focusEntry();
  }

  /**
   * What the player changed in the affix form before this query starts is a correction of the read, and it is remembered
   * for the next read of the same text (ocr/value-corrections.js, the base memory): a number typed over one the reader
   * (or the memory) filled in, and a base typed over the record's own. A number or base the player left as it was is
   * never learned, a condition added from the menu has nothing it was read as, and nothing here is sent anywhere.
   */
  function noteStatsCorrections() {
    const ocr = getOcr();
    const form = getStatsForm().get();
    for (const c of form.conditions) {
      if (!c.on || c.kind === "bool" || !c.line || c.readMin == null || c.fromCapture || c.min === null || c.min === "") continue;
      if (Number(c.min) !== c.readMin) valueCorrections.learn(c.line, c.key, Number(c.min));
    }
    if (runSource?.kind === "picture") {
      ocr?.noteBaseQuery(form.base);
      return;
    }
    const record = runSource?.kind === "scan" ? runSource.record : null;
    if (!record || record.kind === "base") return; // a base record is searched by its own name: there is no base to correct
    const from = $("stats-base").dataset.from;
    const tables = getTables();
    const entry = (from === "" || from === "learned") && tables ? tableEntry(form.base.trim(), tables) : null; // the tables are loaded once the scan screen exists
    if (entry?.kind !== "base") return;
    // Typed over the record's base: a correction. Left as the remembered base after the form asked about it: one more
    // identical choice, which is what makes the next search start at once (LEARNED_SURE).
    const confirmed = from === "learned" && entry.name === record.base && record.baseLearned < LEARNED_SURE;
    if (entry.name === record.base && !confirmed) return;
    const hit = ocr?.learnBase(record.baseKey, entry.name);
    if (hit) Object.assign(record, { base: hit.name, baseLearned: hit.count });
  }

  /**
   * What the screenshot reader (ocr/panel.js) calls: a picked name goes into the name field, or into the affix form's
   * base when the picture was taken for that form; reading text ticks the affix form's conditions and fills in the
   * numbers it read, marked as coming from the capture. Either way the player confirms it: nothing here starts a query.
   */
  const readerHooks = {
    onPick: (name, kind, shown = name) => {
      if (isRunning()) return false; // never change the name under a query that is already running
      // A unique or set item has its own name search, so a picture of one leaves the affix form for it.
      if (queryMode === "stats" && kind === "item") setMode("name");
      if (modeFromPicture && kind === "base") setMode("stats");
      backToForm();
      if (queryMode === "stats") getStatsForm().setBaseFromScreenshot(name);
      else $("item").value = shown; // Chinese when the table has one; resolveInput turns it back into English before any query
      return true;
    },
    onText: (text) => {
      if (isRunning()) return;
      runSource = { kind: "picture" };
      // The reader ticks what it recognised and fills in the numbers it read, marked for confirmation; the player
      // still presses start.
      const statsForm = getStatsForm();
      statsForm?.rememberScreenshot(text);
      if (queryMode === "stats") {
        statsForm?.fillFromText(text, { carryValues: true });
        const learned = getOcr()?.learnedBase(text);
        if (learned) statsForm?.setBaseFromScreenshot(learned.name, { from: "learned" }); // a typed base is still never replaced
      }
    },
    onImage: () => {
      getStatsForm()?.forgetScreenshot();
      if (isRunning() || isListingBusy()) return;
      // From the home screen (or the listing screen) a picture opens the name form; a form already open stays.
      if (queryMode === "scan" || queryMode === "listing") {
        modeFromPicture = true;
        setMode("name");
      }
      backToForm();
    },
    // 「都不是，我自己輸入」: the player types the name (or the base, in the affix form); nothing is filled in for them.
    onNone: () => $(queryMode === "stats" ? "stats-base" : "item").focus(),
  };

  return {
    mode: () => queryMode,
    source: () => runSource,
    /** The player is starting over; whatever the last query used no longer describes the next one. */
    clearSource: () => {
      runSource = null;
    },
    readerHooks,
    renderModeForm,
    chooseMode,
    focusEntry,
    showListing,
    onSearchName,
    onSearchStats,
    openAffixForm,
    noteStatsCorrections,
  };
}
