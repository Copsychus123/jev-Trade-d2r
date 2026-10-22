// The panel hub: it exports nothing, it wires the screens together and runs init() as it is imported. It owns the query
// lifecycle (the running/after/banner state, beginQuery, runSession, start, the affix query, judge) and the page-level
// rendering; the invite code, the results and filters, the listing screen and the screen/hand-off state live in
// invite-state.js, results-view.js, listing-screen.js and screen-flow.js, which receive what they need from here.
import { chooseNext, pickBase } from "./api.js";
import { Agent, newCallBudget } from "./agent.js";
import { API_BASE } from "./config.js";
import { Tab, closeStaleWindows, loadPageScripts } from "./cdp.js";
import { $ } from "./dom.js";
import { priceSummaryLine, sourceLine } from "./labels.js";
import { describeRunError, guardProblem, judgeNameRun } from "./run-outcome.js";
import { SECTION_NAMES, affixHandoff, deriveView, visibleSections } from "./panel-state.js";
import { drawProgress, drawTrust } from "./panel-dom.js";
import { newMarket, verifyViews } from "./traderie/controller.js";
import { findAndRead } from "./traderie/finder.js";
import { indexTables, searchShowsItem } from "./traderie/lookup.js";
import { priceSummary } from "./traderie/price-summary.js";
import { INVITE_STORAGE_KEYS, createInviteState } from "./invite-state.js";
import { initLearningPanel } from "./learning-panel.js";
import { LISTING_DEFAULTS_KEY } from "./listing-defaults.js";
import { createListingScreen } from "./listing-screen.js";
import { initNameSuggest } from "./name-suggest.js";
import { BASE_STORE_KEY, chromeStorage, createCorrections } from "./ocr/corrections.js";
import { VALUE_STORE_KEY, createValueCorrections } from "./ocr/value-corrections.js";
import { initOcrPanel } from "./ocr/panel.js";
import { createResultsView } from "./results-view.js";
import { createScreenFlow } from "./screen-flow.js";
import { initScanPanel } from "./scan/scan-panel.js";
import { ensureProperties } from "./traderie/properties.js";
import { MAX_LOAD_MORE, TRADERIE_D2R_URL, detectGuard, phaseFinishRule } from "./traderie/site.js";
import { judgeStats, runStatsFlow } from "./stats-query.js";
import { initStatsForm } from "./stats-form.js";
import { newTimeline, timed } from "./timeline.js";

/** The stored 多讀幾批 count; anything that is not a whole number within the site's maximum falls back to 0. */
const normalizeLoadMore = (value) => (Number.isInteger(value) && value >= 0 && value <= MAX_LOAD_MORE ? value : 0);

// What the player chose for names the reader could not settle (ocr/corrections.js), on this computer only. Two more
// memories of the same kind: the base the player changed in the affix search (same module, its own key and only bases)
// and the affix numbers the player typed over a read one (ocr/value-corrections.js).
const corrections = createCorrections({ storage: chromeStorage() });
const baseCorrections = createCorrections({ storage: chromeStorage(BASE_STORE_KEY), only: "base" });
const valueCorrections = createValueCorrections({ storage: chromeStorage(VALUE_STORE_KEY) });
const memories = [corrections, baseCorrections, valueCorrections];

let running = false;
let stopRequested = false;
let market = newMarket();
let itemName = ""; // the name the query really used (English, from the run)
let queryText = ""; // what the player typed
let agent = null;
let current = null; // the session of the query that is running now: Stop and closing the panel act on its tab
let statusText = "";
let loadMore = 0;
let settingsOpen = false;
let after = null; // how the last query ended: "done" | "problem" | "stopped" | null
let banner = null; // { message, hint?, site?, settings?, retry? } shown for a problem
let starting = false; // the affix search has been pressed and has not reached `running` yet
let statsForm = null; // the second form (stats-form.js), made once the page is up
let ocr = null; // the screenshot reader's shared API (models, engine, matcher); the scan screen reads through it
let scanPanel = null; // the scan screen's handle ({ stop, refresh }), once it is up
let tables = null;
const tableStats = { jumps: 0, misses: 0 }; // table jumps and misses since the panel opened (shown in the miss note)

const invite = createInviteState({
  render,
  isRunning: () => running,
  onBlockChange: () => {
    scanPanel?.refresh?.();
    listing.update();
  },
  forgetBanner: () => {
    banner = null;
  },
  focusEntry: () => screen.focusEntry(),
});
const results = createResultsView({
  getMarket: () => market,
  getQueryText: () => queryText,
  getItemName: () => itemName,
  isRunning: () => running,
  render,
});
const listing = createListingScreen({
  invite,
  valueCorrections,
  loadTables,
  showScreen: () => screen.showListing(),
  isRunning: () => running,
  render,
});
const screen = createScreenFlow({
  isRunning: () => running,
  isListingBusy: () => listing.isBusy(),
  render,
  blockReason: invite.blockReason,
  start,
  forgetEndedQuery: () => {
    if (after != null) dismissResult();
  },
  dismissResult,
  backToForm,
  getStatsForm: () => statsForm,
  getOcr: () => ocr,
  getTables: () => tables,
  loadTables,
  valueCorrections,
});

const errorText = (error) => error?.message || String(error);
/** Forgets how the last query ended and its banner: the form (or the next query) starts clean. */
function dismissResult() {
  after = null;
  banner = null;
}

function setStatus(text) {
  statusText = text;
  renderProgress();
}

function renderProgress() {
  drawProgress({ market, phase: agent?.state.phase ?? null, running, statusText });
}

// ---- screens ---------------------------------------------------------------------------------------------------

/** The problem banner: shown for a problem, never over the settings or the running screen. */
function renderBanner(view) {
  const showBanner = Boolean(banner) && !["settings", "running"].includes(view);
  $("banner").hidden = !showBanner;
  if (!banner) return;
  $("banner-message").textContent = banner.message;
  $("banner-hint").textContent = banner.hint ?? "";
  $("banner-hint").hidden = !banner.hint;
  $("banner-open-site").hidden = !banner.site;
  $("banner-settings").hidden = !banner.settings;
  const retry = $("banner-retry");
  retry.hidden = !banner.retry;
  retry.textContent = banner.retry ?? "";
}

/**
 * The notes line: the affix search's own conclusion (what the listings it read ask, so the player does not have to work
 * it out from the table) leads it, and the base translation note follows.
 */
function notesText() {
  const price = market.mode === "stats" ? priceSummaryLine(priceSummary(market.trading?.rows ?? [])) : "";
  return [price, sourceLine(screen.source()), ...(market.lookup?.notes ?? [])].filter(Boolean).join("。");
}

function renderChrome() {
  const view = deriveView({
    settingsOpen,
    hasInvite: Boolean(invite.current()),
    running,
    after,
    mode: screen.mode(),
  });
  document.body.dataset.view = view;
  const shown = visibleSections(view, results.hasRows());
  for (const name of SECTION_NAMES) $(`part-${name}`).hidden = !shown.has(name);
  const notes = notesText();
  $("part-notes").textContent = notes;
  $("part-notes").hidden = !notes || !shown.has("notes");
  $("part-requery").hidden = !shown.has("requery") || Boolean(banner?.retry);
  // The affix search for the same item: after a failed name search it is the way out, after a finished affix search it
  // is how the read affix lines narrow the list (affixHandoff says which sentence, or none).
  const handoff = affixHandoff(shown, screen.source(), after, market.mode);
  $("fuzzy-handoff").hidden = !handoff;
  $("fuzzy-handoff").textContent = handoff;
  $("listing-change").disabled = listing.isBusy();
  $("summary-back").disabled = running || listing.isBusy();
  results.renderHeader(view);
  $("start").hidden = running;
  $("stop").hidden = !running;
  updateStart();
  renderBanner(view);
  invite.renderQuota();
  screen.renderModeForm();
  renderLoadMore();
  invite.renderInvite();
}

/** The "read more batches" count: how many extra batches the next query reads, within the site's maximum. */
function renderLoadMore() {
  $("more-value").textContent = loadMore;
  $("more-minus").disabled = running || loadMore <= 0;
  $("more-plus").disabled = running || loadMore >= MAX_LOAD_MORE;
}

function render() {
  invite.renderBlock();
  results.renderFilterFields();
  listing.renderDefaults();
  renderChrome();
  results.renderLists();
  drawTrust(market);
  renderProgress();
}

/** Back to the query form with the name kept (the old results stay until the next start). */
function backToForm() {
  dismissResult();
  screen.clearSource(); // the player is starting over; whatever the last query used no longer describes this one
  render();
}

/** The start button of the affix search needs something to search by (stats-form-state.js `startBlocker`). */
function updateStart() {
  const why = invite.blockReason() || (screen.mode() === "stats" && statsForm ? statsForm.startBlocker() : "");
  $("start").disabled = Boolean(why);
  $("start-why").textContent = why;
  $("start-why").hidden = !why || running;
}

function showSettings(open) {
  settingsOpen = open;
  invite.stopEditing();
  render();
  if (open) invite.refreshOnOpen(); // a code known to be refused is not asked again within the throttle window
}

// ---- running a query ---------------------------------------------------------------------------------------------

async function loadTables() {
  if (!tables) {
    const response = await fetch(chrome.runtime.getURL("traderie/data/items.json"));
    tables = indexTables(await response.json());
  }
  return tables;
}

/** The name flow's outcome: the decision tree lives in `run-outcome.js` (pure, tested); the panel supplies the facts and
 * stores the verification it hands back. */
async function judge(session) {
  const { after: ended, banner: problem, verification } = await judgeNameRun({
    stopped: stopRequested,
    outcome: session.outcome,
    status: agent.state.status,
    scopeBlockedReason: agent.state.scope_blocked_reason,
    page: agent.state.page,
    tab: session.tab,
    market,
    itemName,
    detectGuard,
    verify: verifyViews,
  });
  if (verification) market.verification = verification;
  return { after: ended, banner: problem };
}

/**
 * Clears the last query and shows the running screen; `text` is what the summary line says the query is about.
 * Resolves with the fresh market.
 */
function beginQuery(text) {
  queryText = text;
  stopRequested = false;
  market = newMarket();
  agent = null;
  dismissResult();
  statusText = "";
  results.reset();
  $("trust-more").open = false;
  running = true;
  render();
  return market;
}

/**
 * The shared frame of both searches: `work(session)` reads and resolves with how the query ended ({ after, banner? });
 * a failure is described, Stop is not a failure, and the query window is always closed.
 */
async function runSession(session, work) {
  current = session;
  try {
    ({ after, banner = null } = await work(session));
  } catch (error) {
    if (stopRequested) {
      after = "stopped"; // Stop closed the query window under a running command: that is the stop, not a problem
      banner = null;
    } else {
      const described = describeRunError(error, {
        hasRun: Boolean(session.run),
        hasStoredInvite: invite.hasSaved(),
        detached: session.tab?.detached,
        detachReason: session.tab?.detachReason,
      });
      if (described.clearPendingInvite) {
        // A refused or used-up code switches the three paid features off; a throttle ("try again in 15 minutes") does not.
        invite.blockIfRefused(error, described.banner.message);
        invite.clearPending();
      } else {
        invite.refreshOnOpen(); // a failed step may have been refunded: the shown count is read again
      }
      after = "problem";
      banner = described.banner;
    }
  } finally {
    current = null;
    if (session.tab) await timed(session, "close_tab", () => session.tab.close().catch(() => {}));
    publishRun(session);
    running = false;
    render();
  }
}

/** Measurement only: the last query's timings, for the Chrome checks (scripts/extension_e2e.py). No UI reads it. */
function publishRun(session) {
  const state = session.agent?.state ?? null;
  globalThis.__jevLastRun = {
    timeline: session.timeline?.entries ?? [],
    history: state?.history ?? [],
    decisions: (state?.decisions ?? []).map(({ request, ...decision }) => decision),
    rule_events: state?.rule_events ?? [],
    stale_events: state?.stale_events ?? {},
    visibility: session.tab?.openTiming?.settle?.visibility ?? null,
  };
}

const setAgent = (next) => {
  agent = next;
};

/**
 * The agent a run is read with: its choose / veto callbacks close over the run token the query resolved to and that
 * run's own item name, and the panel keeps the agent (the status line and the progress read it).
 */
function agentFactory({ session, callBudget, setAgent }) {
  return async (tab, run) => {
    const made = await Agent.create({
      callBudget,
      tab,
      phases: ["trading", "recent_trades"],
      text: run.item_name,
      finishPhaseAfter: phaseFinishRule(run.load_more),
      choose: (page, phase, history, options = {}) =>
        chooseNext(API_BASE, { runToken: session.run.run_token, phase, page, history, noBlock: options.noBlock }),
      vetoBlocked: (page) => searchShowsItem(page, run.item_name),
    });
    setAgent(made);
    return made;
  };
}

async function start() {
  if (running || starting || invite.blockReason()) return;
  if (screen.mode() === "stats") return runStatsQuery();
  const code = invite.current();
  const rawItem = $("item").value;
  beginQuery(rawItem.trim());
  ocr?.noteQueryName(rawItem); // a name typed over a read picture is a correction of that read
  const callBudget = newCallBudget(); // Jev calls of the whole query: every Agent it builds counts against it
  const session = { tab: null, agent: null, run: null, itemName: "", outcome: null, timeline: newTimeline() };
  await runSession(session, async (session) => {
    setStatus("正在準備…");
    const scripts = await loadPageScripts();
    session.outcome = await findAndRead({
      rawItem,
      tables: await loadTables(),
      tableStats,
      loadMore,
      startRun: invite.startRequest(code),
      pickBase: (args) => pickBase(API_BASE, args),
      openTab: (url) => Tab.open(url, scripts),
      makeAgent: agentFactory({ session, callBudget, setAgent }),
      market,
      session,
      shouldStop: () => stopRequested,
      onStatus: (text) => {
        setStatus(text);
        render();
      },
      onUpdate: () => {
        setStatus(`進行中，已操作 ${agent.state.history.length} 步`);
        render();
      },
    });
    itemName = session.itemName;
    return judge(session);
  });
}

/** The second search: yellow, blue and white items by their affixes (stats-query.js). */
async function runStatsQuery() {
  // `running` is only set once the flow has loaded the tables (an await), so a second press in that gap would charge a
  // second use and open a second window: this flag closes the gap.
  starting = true;
  try {
    await runStatsSession();
  } finally {
    starting = false;
  }
}

async function runStatsSession() {
  screen.noteStatsCorrections();
  await runSession({ tab: null, outcome: null, timeline: newTimeline() }, async (session) => {
    const countUse = (itemName) => invite.startRequest()({ itemName, loadMore: 0 });
    const hooks = { begin: beginQuery, setStatus, render, shouldStop: () => stopRequested, loadTables, countUse };
    itemName = await runStatsFlow(statsForm.get(), session, hooks);
    return judgeStats(session, { market, statsForm, stopped: stopRequested, guardProblem });
  });
}

// ---- start-up ----------------------------------------------------------------------------------------------------

const initProblemBanner = (message, error) => ({ message, hint: errorText(error), retry: "知道了" });

/** Showing a start-up problem in the banner: a dead panel with no explanation is worse than a half-working one. */
function showInitProblem(what, error) {
  banner = initProblemBanner(what, error);
  render();
}

/** True when this is the only open side panel, so a window left in session storage cannot belong to a live run. */
async function isOnlyPanel() {
  const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
  return panels.length <= 1;
}

function registerListeners() {
  const on = (id, handler) => $(id).addEventListener("click", handler);
  // A command Chrome is slow to answer must not hold Stop or the panel close back.
  const abortCurrent = () => {
    current?.tab?.abort().catch(() => {});
    listing.abort();
  };

  /** The settings screen: the invite area, the row filters and the "Load More" count. */
  function wireSettings() {
    on("settings-open", () => showSettings(!settingsOpen));
    on("settings-back", () => showSettings(false));
    results.wireFilters(on);
    on("filter-edit", () => {
      showSettings(true);
      $("settings-advanced").open = true; // the filters live under 進階: 改 must land on them
    });
    const setLoadMore = (next) => {
      loadMore = next;
      chrome.storage.local.set({ loadMore });
      render();
    };
    on("more-minus", () => setLoadMore(Math.max(0, loadMore - 1)));
    on("more-plus", () => setLoadMore(Math.min(MAX_LOAD_MORE, loadMore + 1)));
  }

  /** Starting and stopping, switching search kind, and the buttons of the problem banner. */
  function wireRun() {
    on("start", start);
    on("mode-change", () => screen.chooseMode("scan"));
    on("listing-change", () => screen.chooseMode("scan"));
    on("summary-back", () => screen.chooseMode("scan"));
    listing.wire(on);
    on("stop", () => {
      stopRequested = true;
      setStatus("正在停止…");
      abortCurrent();
    });
    on("part-requery", backToForm);
    on("fuzzy-handoff", () => {
      const source = screen.source();
      if (source?.kind === "scan") screen.openAffixForm(source.record);
    });
    on("banner-retry", backToForm);
    on("banner-open-site", () => chrome.tabs.create({ url: TRADERIE_D2R_URL }));
    on("banner-settings", () => showSettings(true));
  }

  function wireClose() {
    // Best effort: the panel is going away, so the query window must not stay open with the debugger attached.
    window.addEventListener("pagehide", () => {
      stopRequested = true;
      abortCurrent();
      for (const memory of memories) memory.flush().catch(() => {}); // what the player chose in the last seconds is still written
    });
  }

  function wireSubPanels() {
    statsForm = initStatsForm({
      // Best effort: a fresh cached list answers without touching a tab, an old one is read once (and that tab closed),
      // and a failed read returns null so filling carries on exactly as before - the query path still reports it.
      getProperties: async () => {
        try {
          const scripts = await loadPageScripts();
          const { properties } = await ensureProperties({ openTab: () => Tab.open(TRADERIE_D2R_URL, scripts), scripts });
          return properties;
        } catch {
          return null;
        }
      },
      onChange: updateStart,
      valueCorrections,
    });
    initNameSuggest({ input: $("item"), list: $("item-suggest"), getTables: () => tables });
    initLearningPanel({ corrections, baseCorrections, valueCorrections, getTables: () => tables });
  }

  invite.wire(on);
  wireSettings();
  wireRun();
  results.wireResults(on);
  wireClose();
  wireSubPanels();
}

/**
 * Start the screenshot reader (its table download included); what it does with a picked name or read text is
 * `screen.readerHooks`. Nothing here starts a query.
 */
async function startReader() {
  return initOcrPanel({
    tables: await loadTables(),
    corrections,
    baseCorrections,
    valueCorrections,
    isBusy: () => running,
    ...screen.readerHooks,
  });
}

async function init() {
  // test seam (scripts/ocr_e2e.py, extension_e2e.py, sidepanel.test.mjs): the name and affix forms are opened from here
  globalThis.__jevChooseMode = screen.chooseMode;
  // Every button works from here on, whatever fails below.
  try {
    registerListeners();
  } catch (error) {
    showInitProblem("側邊面板啟動時出了問題，部分按鈕可能沒有作用", error);
    return;
  }
  try {
    const saved = await chrome.storage.local.get([...INVITE_STORAGE_KEYS, "filters", "loadMore", LISTING_DEFAULTS_KEY]);
    invite.load(saved);
    results.loadFilters(saved.filters); // stale or damaged storage falls back to "no filter"
    loadMore = normalizeLoadMore(saved.loadMore);
    listing.loadDefaults(saved[LISTING_DEFAULTS_KEY]);
  } catch (error) {
    banner = initProblemBanner("讀不到已儲存的設定，請重新輸入邀請碼", error);
  }
  render();
  // Free (counts nothing) and tells a used-up code before the player presses anything. A code already known to be
  // refused is not asked again on every open (each ask counts as a wrong guess); the settings screen still asks.
  invite.refreshOnOpen();
  // A window left over from a panel that died mid-run (best effort; never while another panel might own one).
  isOnlyPanel()
    .then((only) => only && closeStaleWindows())
    .catch(() => {});
  // The screenshot reader loads last: its table download must not hold the rest of the panel back.
  try {
    await Promise.all(memories.map((memory) => memory.load())); // never rejects: a store that cannot be read is an empty memory
    ocr = await startReader();
  } catch (error) {
    showInitProblem("截圖辨識無法啟動，其他功能不受影響", error);
  }
  // The scan screen works through that reader's models, engine and matcher: without it there is nothing to scan with.
  if (ocr) {
    try {
      const loaded = await loadTables();
      listing.build(loaded);
      scanPanel = initScanPanel({
        ocr,
        tables: loaded,
        onSearchName: screen.onSearchName,
        onSearchStats: screen.onSearchStats,
        onList: listing.open,
        getBlock: invite.blockReason,
      });
    } catch (error) {
      showInitProblem("裝備掃描無法啟動，其他功能不受影響", error);
    }
  }
}

init();
