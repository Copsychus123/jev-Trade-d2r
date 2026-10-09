import { chooseNext, pickBase, startRun } from "./api.js";
import { Agent, newCallBudget } from "./agent.js";
import { API_BASE } from "./config.js";
import { Tab, closeStaleWindows, loadPageScripts } from "./cdp.js";
import { ApiError } from "./errors.js";
import { priceSummaryLine, sourceLine, statusLabel } from "./labels.js";
import { describeRunError, guardProblem, judgeNameRun } from "./run-outcome.js";
import { SECTION_NAMES, affixHandoff, deriveView, visibleSections } from "./panel-state.js";
import { PAGE_SIZE, clampPage, pageCount, pageRows } from "./paginate.js";
import { clock, drawProgress, drawTrust } from "./panel-dom.js";
import {
  COMMON_PRESET,
  EMPTY_FILTERS,
  FILTER_FIELDS,
  FILTER_OPTION_LABELS,
  applyFilters,
  describeFilters,
  filtersActive,
  normalizeFilters,
} from "./filters.js";
import { filterLine, filteredAway, tabCount, viewNote } from "./rows.js";
import { nextTab } from "./tabs.js";
import { newMarket, verifyViews } from "./traderie/controller.js";
import { findAndRead } from "./traderie/finder.js";
import { baseOptions, indexTables, searchShowsItem } from "./traderie/lookup.js";
import { priceSummary } from "./traderie/price-summary.js";
import { initNameSuggest } from "./name-suggest.js";
import { initOcrPanel } from "./ocr/panel.js";
import { initScanPanel } from "./scan/scan-panel.js";
import { ensureProperties } from "./traderie/properties.js";
import { MAX_LOAD_MORE, TRADERIE_D2R_URL, detectGuard, phaseFinishRule } from "./traderie/site.js";
import { marketViews, openable, tabKeysFor, viewConfigFor } from "./result-views.js";
import { createResultActions } from "./result-actions.js";
import { judgeStats, runStatsFlow } from "./stats-query.js";
import { initStatsForm } from "./stats-form.js";
import { newTimeline, timed } from "./timeline.js";

const $ = (id) => document.getElementById(id);

const MODE_TEXT = {
  name: { title: "精準搜尋", help: "輸入裝備名稱就能查（暗金、套裝等固定名稱）" },
  stats: { title: "模糊搜尋", help: "用底材、品質和詞綴條件找" },
};

const pages = { trading: 1, recent_trades: 1 };
let running = false;
let stopRequested = false;
let market = newMarket();
let itemName = ""; // the name the query really used (English, from the run)
let queryText = ""; // what the player typed
let agent = null;
let current = null; // the session of the query that is running now: Stop and closing the panel act on its tab
let statusText = "";
let activeTab = "trading";
let loadMore = 0;
let settingsOpen = false;
let after = null; // how the last query ended: "done" | "problem" | "stopped" | null
let banner = null; // { message, hint?, site?, settings?, retry? } shown for a problem
let quota = null; // { used, limit } from the last accepted start
let runSource = null; // { kind: "scan"|"picture", time?, affixes?, record? } the input of the coming query came from
let savedInvite = ""; // in chrome.storage.local
let pendingInvite = ""; // typed but not accepted by the backend yet: kept in memory only
let editingInvite = false;
let filters = EMPTY_FILTERS; // display-time row filters, saved in chrome.storage.local
let queryMode = null; // null: not chosen yet (the panel asks) | "name" | "stats" | "scan"
let modeFromPicture = false; // the mode was set by a picture, not by the player: the reading may still switch it
let statsForm = null; // the second form (stats-form.js), made once the page is up
let ocr = null; // the screenshot reader's shared API (models, engine, matcher); the scan screen reads through it

const currentInvite = () => pendingInvite || savedInvite;
const hasRows = () => [market.trading, market.recent_trades].some((view) => view.rows.length);
/** What the screen, the copy button and the CSV file use: the rows the filter keeps (all rows without a filter). */
const filteredRows = (key) => applyFilters(market[key].rows, filters);

function setStatus(text) {
  statusText = text;
  renderProgress();
}

// ---- results: every cell is written with textContent (page text is untrusted), never innerHTML --------------------

function renderMarket(key) {
  const config = viewConfigFor(market, key);
  const view = market[key];
  const prefix = config.prefix;
  const { rows } = filteredRows(key);
  const total = rows.length;
  $(`${prefix}-tab`).dataset.status = view.status;
  $(`${prefix}-count`).textContent = tabCount(view, total, filtersActive(filters));
  $(`${prefix}-mark`).textContent = view.status === "PASSED" ? "" : statusLabel(view.status);
  const note = viewNote(view, total);
  $(`${prefix}-meta`).textContent = note;
  $(`${prefix}-meta`).hidden = !note;
  $(`${prefix}-clear`).hidden = !filteredAway(view, total);
  const page = clampPage(pages[key], total);
  pages[key] = page;
  $(`${prefix}-pager`).hidden = total <= PAGE_SIZE;
  $(`${prefix}-page`).textContent = `第 ${page} / ${pageCount(total)} 頁`;
  $(`${prefix}-prev`).disabled = page <= 1;
  $(`${prefix}-next`).disabled = page >= pageCount(total);
  const body = $(`${prefix}-list`);
  const stamp = `${view.status}|${view.observed_at}|${view.rows.length}|${JSON.stringify(filters)}|${page}`;
  if (body.dataset.stamp === stamp) return;
  body.dataset.stamp = stamp;
  body.replaceChildren();
  body.hidden = !total;
  if (total) config.draw(body, pageRows(rows, page));
}

function selectTab(key, focus = false) {
  activeTab = key;
  for (const [k, config] of Object.entries(marketViews)) {
    const tab = $(`${config.prefix}-tab`);
    const selected = k === key;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`${config.prefix}-panel`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  resultActions.resetCopyLabel();
  renderActions();
  renderFilterLine();
}

/** The three buttons under the tabs act on the selected tab: enabled by its (filtered) rows and its page address. */
function renderActions() {
  const view = market[activeTab];
  const kept = filteredRows(activeTab).rows.length;
  $("result-csv").disabled = !kept;
  $("result-copy").disabled = !kept;
  $("result-open").disabled = !openable(view.url);
}

/** Shown only while a filter is active and something was read; follows the selected tab. */
function renderFilterLine() {
  const line = $("filter-line");
  line.hidden = !filtersActive(filters) || !hasRows();
  if (line.hidden) return;
  const view = market[activeTab];
  const result = filteredRows(activeTab);
  $("filter-text").textContent = filterLine({
    description: describeFilters(filters),
    hidden: result.hidden,
    unknown: result.unknown,
    kept: result.rows.length,
    hasMore: market.mode === "stats" ? false : view.has_more, // "read more batches" does not exist in the stats search
  });
  $("filter-edit").disabled = running;
}

function renderProgress() {
  drawProgress({ market, phase: agent?.state.phase ?? null, running, statusText });
}

// ---- screens ---------------------------------------------------------------------------------------------------

const mask = (code) => (code ? `${"•".repeat(8)}${code.length > 8 ? code.slice(-4) : ""}` : "（還沒有邀請碼）");

/** Caption, summary line and tab labels of the results: the two search kinds name their list differently. */
function renderResultsHeader(view) {
  const stats = market.mode === "stats";
  const description = market.lookup?.description ?? "";
  $("results-caption").hidden = stats ? view !== "done" || !description : view !== "ready" || !queryText;
  $("results-caption").textContent = stats ? `條件：${description}` : `上一次查詢的結果：${queryText}`;
  $("summary-text").textContent = `查詢：${stats && description ? description : queryText}`;
  $("recent-trades-tab").hidden = stats; // the stats search has no recent-trades list
  $("trading-label").textContent = stats ? "符合條件的掛單" : "目前掛單";
}

/** The query form of the chosen search kind: name box or base box plus the affix part; locked while a query runs. */
function renderModeForm() {
  $("item").disabled = running;
  const statsMode = queryMode === "stats";
  document.body.dataset.mode = queryMode ?? "";
  const text = MODE_TEXT[queryMode];
  $("mode-title").textContent = text?.title ?? "";
  $("mode-help").textContent = text?.help ?? "";
  $("mode-change").disabled = running;
  $("item-label").textContent = statsMode ? "底材名稱" : "裝備名稱";
  $("item-label").htmlFor = statsMode ? "stats-base" : "item";
  $("item").hidden = statsMode;
  $("stats-base").hidden = !statsMode;
  $("item-help").textContent = statsMode ? "可輸入中文或英文裝備" : "中文或英文都可以，也可貼上截圖";
  $("part-stats").hidden = !statsMode;
  $("more-box").hidden = statsMode;
  statsForm?.setBusy(running);
}

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
  $("banner-retry").hidden = !banner.retry;
  $("banner-retry").textContent = banner.retry ?? "";
}

/** The quota line under the name field: used up while a query runs or has just ended, remaining before that. */
function renderQuota(view) {
  const used = quota && ["running", "done", "problem", "stopped"].includes(view);
  $("quota").textContent = !currentInvite()
    ? ""
    : used
      ? `已用 ${quota.used}/${quota.limit}`
      : quota
        ? `剩 ${Math.max(0, quota.limit - quota.used)} 次`
        : "已用 —";
}

/** The invite area of the settings screen, and every settings control that a running query locks. */
function renderInvite() {
  for (const id of ["settings-open", "invite-change", "invite-new", "invite-new-ok", "welcome-invite", "welcome-go"]) {
    $(id).disabled = running;
  }
  $("invite-masked").textContent = mask(currentInvite());
  $("invite-edit").hidden = !editingInvite;
  $("invite-change").hidden = editingInvite;
  $("invite-note").textContent = "新的邀請碼要等下一次查詢成功，才會儲存。";
  $("invite-note").hidden = !pendingInvite;
  $("invite-quota").textContent = quota ? `已用 ${quota.used} / ${quota.limit} 次（剩 ${Math.max(0, quota.limit - quota.used)} 次）` : "";
  $("invite-quota").hidden = !quota;
}

function renderChrome() {
  const view = deriveView({ settingsOpen, hasInvite: Boolean(currentInvite()), running, after, mode: queryMode });
  document.body.dataset.view = view;
  // The affix search's own conclusion: what the listings it read are asking, so the player does not have to work it
  // out from the table. It leads the notes line (the base translation note follows).
  const priceLine = market.mode === "stats" ? priceSummaryLine(priceSummary(market.trading?.rows ?? [])) : "";
  const notes = [priceLine, sourceLine(runSource), ...(market.lookup?.notes ?? [])].filter(Boolean).join("。");
  const shown = visibleSections(view, hasRows());
  for (const name of SECTION_NAMES) $(`part-${name}`).hidden = !shown.has(name);
  $("part-notes").textContent = notes;
  $("part-notes").hidden = !notes || !shown.has("notes");
  $("part-requery").hidden = !shown.has("requery") || Boolean(banner?.retry);
  // When a query that came in from a scan record ends in a problem, the player still has that record's affixes: offer
  // the affix search for the same item instead of leaving them with a failure and a name.
  $("fuzzy-handoff").hidden = !affixHandoff(shown, runSource, after);
  renderResultsHeader(view);
  $("start").hidden = running;
  $("stop").hidden = !running;
  updateStart();
  renderBanner(view);
  renderQuota(view);
  renderModeForm();
  $("more-value").textContent = loadMore;
  $("more-minus").disabled = running || loadMore <= 0;
  $("more-plus").disabled = running || loadMore >= MAX_LOAD_MORE;
  renderInvite();
}

/** The settings selects mirror `filters`; they are locked like every other setting while a query runs. */
function renderFilterFields() {
  for (const { key } of FILTER_FIELDS) {
    $(`filter-${key}`).value = filters[key];
    $(`filter-${key}`).disabled = running;
  }
  $("filter-preset").disabled = running;
  $("filter-clear").disabled = running || !filtersActive(filters);
}

/** Applies new filters: saved, shown at once, both lists back on page 1. Never starts a query. */
function setFilters(next) {
  filters = normalizeFilters(next);
  chrome.storage.local.set({ filters });
  pages.trading = 1;
  pages.recent_trades = 1;
  render();
}

function render() {
  renderFilterFields();
  renderChrome();
  renderMarket("trading");
  renderMarket("recent_trades");
  selectTab(activeTab);
  drawTrust(market);
  renderProgress();
}

/** Back to the query form with the name kept (the old results stay until the next start). */
function backToForm() {
  after = null;
  banner = null;
  runSource = null; // the player is starting over; whatever the last query used no longer describes this one
  render();
}

// ---- running a query ---------------------------------------------------------------------------------------------

let tables = null;
const tableStats = { jumps: 0, misses: 0 }; // table jumps and misses since the panel opened (shown in the miss note)

export async function loadTables() {
  if (!tables) {
    const response = await fetch(chrome.runtime.getURL("traderie/data/items.json"));
    tables = indexTables(await response.json());
  }
  return tables;
}

// The backend has accepted the code (the run started): only now is it worth keeping.
async function rememberInvite(invite) {
  if (invite !== savedInvite) {
    await chrome.storage.local.set({ invite });
    savedInvite = invite;
  }
  pendingInvite = "";
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
  after = null;
  banner = null;
  statusText = "";
  activeTab = "trading";
  pages.trading = 1;
  pages.recent_trades = 1;
  $("trust-more").open = false;
  document.querySelectorAll("[data-stamp]").forEach((el) => delete el.dataset.stamp);
  running = true;
  render();
  return market;
}

const resultActions = createResultActions({
  getMarket: () => market,
  rowsOf: (key) => filteredRows(key).rows,
  getItemName: () => itemName,
  getActiveTab: () => activeTab,
});

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
        hasStoredInvite: Boolean(savedInvite),
        detached: session.tab?.detached,
        detachReason: session.tab?.detachReason,
      });
      if (described.clearPendingInvite) pendingInvite = ""; // the backend refused it: never stored
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

async function start() {
  if (running) return;
  if (!queryMode) return;
  if (queryMode === "stats") return runStatsQuery();
  const invite = currentInvite();
  const rawItem = $("item").value;
  beginQuery(rawItem.trim());
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
      startRun: async (args) => {
        const run = await startRun(API_BASE, { invite, ...args });
        quota = { used: run.used, limit: run.limit };
        await rememberInvite(invite);
        return run;
      },
      pickBase: (args) => pickBase(API_BASE, args),
      openTab: (url) => Tab.open(url, scripts),
      makeAgent: async (tab, run) => {
        agent = await Agent.create({
          callBudget,
          tab,
          phases: ["trading", "recent_trades"],
          text: run.item_name,
          finishPhaseAfter: phaseFinishRule(run.load_more),
          choose: (page, phase, history, options = {}) =>
            chooseNext(API_BASE, { runToken: session.run.run_token, phase, page, history, noBlock: options.noBlock }),
          vetoBlocked: (page) => searchShowsItem(page, run.item_name),
        });
        return agent;
      },
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
  await runSession({ tab: null, outcome: null, timeline: newTimeline() }, async (session) => {
    const hooks = { begin: beginQuery, setStatus, render, shouldStop: () => stopRequested };
    itemName = await runStatsFlow(statsForm.get(), session, hooks);
    return judgeStats(session, { market, statsForm, stopped: stopRequested, guardProblem });
  });
}

function showSettings(open) {
  settingsOpen = open;
  editingInvite = false;
  render();
}

/** Switches between the name search and the affix search. Never persisted: the panel asks every time. */
function setMode(mode) {
  queryMode = mode;
  if (mode === "stats") warmUpAffixForm(); // the first fill should not have to wait, and the base list should be there
  render();
}

/** Best effort, once: have Traderie's property list and the shipped item types ready before the first affix fill. A
 * failure is reported where the query needs it (judgeStats), never here. */
let affixWarmed = false;
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
  list.replaceChildren(...options.map((name) => Object.assign(document.createElement("option"), { value: name })));
}

/** Where typing starts on the current screen. */
function focusEntry() {
  $(!queryMode ? "choose-name" : queryMode === "stats" ? "stats-base" : queryMode === "scan" ? "scan-start" : "item").focus();
}

/** The player picks (or changes back to the question with null); a later picture no longer switches the mode. */
function chooseMode(mode) {
  modeFromPicture = false;
  setMode(mode);
  focusEntry();
}

/** The scan list's 精準搜尋: fills the name form in, it never starts a query. */
function onSearchName(record) {
  if (!record.name) return; // the button is disabled without a name
  modeFromPicture = false;
  setMode("name");
  runSource = scanSource(record);
  $("item").value = record.name;
  focusEntry();
}

/** The scan list's 模糊搜尋: ticks the affixes the OCR text shows; the base is the record's own name for a base result,
 * otherwise the base candidate of the same read, so a unique item does not need the player to know its base. */
function onSearchStats(record) {
  modeFromPicture = false;
  setMode("stats");
  runSource = scanSource(record);
  const base = record.kind === "base" ? record.name : record.base;
  if (base) statsForm.setBaseFromScreenshot(base);
  statsForm.fillFromText(record.text, { carryValues: true }); // the numbers come from the capture, marked for confirmation
  focusEntry();
}

/** The scan record a query came from, as the results screen and the affix hand-off need it. */
function scanSource(record) {
  return {
    kind: "scan",
    time: clock(record.at instanceof Date ? record.at.toISOString() : null),
    affixes: (record.conditions ?? []).map((condition) => condition.label).join("、"),
    record,
  };
}

/** The start button of the affix search needs something to search by (stats-form-state.js `startBlocker`). */
function updateStart() {
  const why = queryMode === "stats" && statsForm ? statsForm.startBlocker() : "";
  $("start").disabled = Boolean(why);
  $("start-why").textContent = why;
  $("start-why").hidden = !why || running;
}

/** One labelled select per filter field, first option 「不限」; they are built from the same list the filter uses. */
function buildFilterFields() {
  const box = $("filter-fields");
  for (const field of FILTER_FIELDS) {
    const id = `filter-${field.key}`;
    const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: field.label });
    const select = Object.assign(document.createElement("select"), { id });
    select.append(new Option("不限", ""));
    for (const value of field.options) select.append(new Option(FILTER_OPTION_LABELS[value] ?? value, value));
    select.addEventListener("change", () => setFilters({ ...filters, [field.key]: select.value }));
    box.append(label, select);
  }
}

/** Showing a start-up problem in the banner: a dead panel with no explanation is worse than a half-working one. */
function showInitProblem(what, error) {
  banner = { message: what, hint: error?.message || String(error), retry: "知道了" };
  render();
}

/** True when this is the only open side panel, so a window left in session storage cannot belong to a live run. */
async function isOnlyPanel() {
  const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
  return panels.length <= 1;
}

function registerListeners() {
  const on = (id, handler) => $(id).addEventListener("click", handler);

  // The code is only held in memory here; it is stored once the backend accepts it (see rememberInvite).
  function wireInvite() {
    $("part-welcome").addEventListener("submit", (event) => {
      event.preventDefault();
      const code = $("welcome-invite").value.trim();
      if (!code) {
        $("welcome-invite").focus();
        return;
      }
      pendingInvite = code;
      banner = null;
      $("welcome-invite").value = "";
      render();
      focusEntry();
    });
    $("invite-edit").addEventListener("submit", (event) => {
      event.preventDefault();
      const code = $("invite-new").value.trim();
      if (code) pendingInvite = code;
      $("invite-new").value = "";
      editingInvite = false;
      render();
    });
    on("invite-change", () => {
      editingInvite = true;
      render();
      $("invite-new").focus();
    });
  }

  /** The settings screen: the invite area, the row filters and the "Load More" count. */
  function wireSettings() {
    on("settings-open", () => showSettings(!settingsOpen));
    on("settings-back", () => showSettings(false));
    buildFilterFields();
    on("filter-preset", () => setFilters(COMMON_PRESET));
    on("filter-clear", () => setFilters(EMPTY_FILTERS));
    on("filter-edit", () => showSettings(true));
    for (const { prefix } of Object.values(marketViews)) on(`${prefix}-clear`, () => setFilters(EMPTY_FILTERS));
    on("more-minus", () => {
      loadMore = Math.max(0, loadMore - 1);
      render();
    });
    on("more-plus", () => {
      loadMore = Math.min(MAX_LOAD_MORE, loadMore + 1);
      render();
    });
  }

  /** Starting and stopping, switching search kind, and the buttons of the problem banner. */
  function wireRun() {
    on("start", start);
    on("choose-name", () => chooseMode("name"));
    on("choose-stats", () => chooseMode("stats"));
    on("choose-scan", () => chooseMode("scan"));
    on("mode-change", () => chooseMode(queryMode === "name" ? "stats" : "name"));
    on("scan-change", () => chooseMode(null));
    on("stop", () => {
      stopRequested = true;
      setStatus("正在停止…");
      current?.tab?.abort().catch(() => {}); // a command Chrome is slow to answer must not hold Stop back
    });
    on("part-requery", backToForm);
    on("fuzzy-handoff", () => {
      if (runSource?.kind === "scan") onSearchStats(runSource.record);
    });
    on("banner-retry", backToForm);
    on("banner-open-site", () => chrome.tabs.create({ url: TRADERIE_D2R_URL }));
    on("banner-settings", () => showSettings(true));
  }

  /** The results screen: its tabs (keyboard and click), paging, and copy / CSV / open-site. */
  function wireResults() {
    $("results-tabs").addEventListener("keydown", (event) => {
      const next = nextTab(tabKeysFor(market), activeTab, event.key);
      if (!next) return;
      event.preventDefault();
      selectTab(next, true);
    });
    on("result-csv", () => resultActions.download(activeTab));
    on("result-copy", () => resultActions.copy(activeTab));
    on("result-open", () => resultActions.openSite(activeTab));
    for (const [key, config] of Object.entries(marketViews)) {
      on(`${config.prefix}-tab`, () => selectTab(key));
      // Paging only changes what the list shows; copy and CSV always take every row.
      on(`${config.prefix}-prev`, () => {
        pages[key] -= 1;
        renderMarket(key);
      });
      on(`${config.prefix}-next`, () => {
        pages[key] += 1;
        renderMarket(key);
      });
    }
  }

  function wireClose() {
    // Best effort: the panel is going away, so the query window must not stay open with the debugger attached.
    window.addEventListener("pagehide", () => {
      stopRequested = true;
      current?.tab?.abort().catch(() => {});
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
    });
    initNameSuggest({ input: $("item"), list: $("item-suggest"), getTables: () => tables });
  }

  wireInvite();
  wireSettings();
  wireRun();
  wireResults();
  wireClose();
  wireSubPanels();
}

async function init() {
  loadMore = 0; // the browser may restore an old form value; always start at the default
  // Every button works from here on, whatever fails below.
  try {
    registerListeners();
  } catch (error) {
    showInitProblem("側邊面板啟動時出了問題，部分按鈕可能沒有作用", error);
    return;
  }
  try {
    const saved = await chrome.storage.local.get(["invite", "filters"]);
    savedInvite = saved.invite || "";
    filters = normalizeFilters(saved.filters); // stale or damaged storage falls back to "no filter"
  } catch (error) {
    banner = { message: "讀不到已儲存的設定，請重新輸入邀請碼", hint: error?.message || String(error), retry: "知道了" };
  }
  render();
  // A window left over from a panel that died mid-run (best effort; never while another panel might own one).
  isOnlyPanel()
    .then((only) => only && closeStaleWindows())
    .catch(() => {});
  // The screenshot reader loads last: its table download must not hold the rest of the panel back.
  try {
    ocr = initOcrPanel({
      tables: await loadTables(),
      isBusy: () => running,
      onPick: (name, kind) => {
        if (running) return false; // never change the name under a query that is already running
        // A unique or set item has its own name search, so a picture of one leaves the affix form for it.
        if (queryMode === "stats" && kind === "item") setMode("name");
        if (modeFromPicture && kind === "base") setMode("stats");
        backToForm();
        if (queryMode === "stats") statsForm.setBaseFromScreenshot(name);
        else $("item").value = name; // the player reads it, then decides to press 開始查詢
        return true;
      },
      onText: (text) => {
        if (running) return;
        runSource = { kind: "picture" };
        // The reader ticks what it recognised and fills in the numbers it read, marked for confirmation; the player
        // still presses start.
        if (queryMode === "stats") statsForm.fillFromText(text, { carryValues: true });
        else statsForm.rememberScreenshot(text);
      },
      onImage: () => {
        statsForm.forgetScreenshot();
        if (!running && !queryMode) {
          modeFromPicture = true;
          setMode("name");
        }
        if (!running) backToForm();
      },
    });
  } catch (error) {
    showInitProblem("截圖辨識無法啟動，其他功能不受影響", error);
  }
  // The scan screen works through that reader's models, engine and matcher: without it there is nothing to scan with.
  if (ocr) {
    try {
      initScanPanel({ ocr, tables: await loadTables(), onSearchName, onSearchStats });
    } catch (error) {
      showInitProblem("裝備掃描無法啟動，其他功能不受影響", error);
    }
  }
}

init();
