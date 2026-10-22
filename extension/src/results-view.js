// The results screen and the row filters that shape it: which tab is selected and which page each list shows, the
// display-time filters (state, storage, the settings screen's selects, the filter line), both result lists, the three
// buttons under the tabs and the caption/summary header. Every cell is written with textContent (page text is
// untrusted), never innerHTML. It reads the market through `getMarket()` and never imports sidepanel.js.
import { $, element } from "./dom.js";
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
import { statusLabel } from "./labels.js";
import { PAGE_SIZE, clampPage, pageCount, pageRows } from "./paginate.js";
import { createResultActions } from "./result-actions.js";
import { marketViews, openable, tabKeysFor, viewConfigFor } from "./result-views.js";
import { filterLine, filteredAway, tabCount, viewNote } from "./rows.js";
import { nextTab } from "./tabs.js";

/**
 * `getMarket()` is the market of the query on screen, `getQueryText()` what the player typed, `getItemName()` the name
 * the query really used, `isRunning()` says a query runs (the filter settings are locked) and `render()` redraws the
 * whole panel.
 */
export function createResultsView({ getMarket, getQueryText, getItemName, isRunning, render }) {
  const pages = { trading: 1, recent_trades: 1 };
  let activeTab = "trading";
  let filters = EMPTY_FILTERS; // display-time row filters, saved in chrome.storage.local

  const hasRows = () => [getMarket().trading, getMarket().recent_trades].some((view) => view.rows.length);
  /** What the screen, the copy button and the CSV file use: the rows the filter keeps (all rows without a filter). */
  const filteredRows = (key) => applyFilters(getMarket()[key].rows, filters);
  const resultActions = createResultActions({
    getMarket,
    rowsOf: (key) => filteredRows(key).rows,
    getItemName,
    getActiveTab: () => activeTab,
  });

  function resetPages() {
    pages.trading = 1;
    pages.recent_trades = 1;
  }

  /** A new query starts on the trading tab, page 1, and every list is redrawn from scratch. */
  function reset() {
    activeTab = "trading";
    resetPages();
    document.querySelectorAll("[data-stamp]").forEach((node) => delete node.dataset.stamp);
  }

  function renderMarket(key) {
    const market = getMarket();
    const config = viewConfigFor(market, key);
    const view = market[key];
    // Every node of one list shares its prefix (`trading-`, `recent-trades-`).
    const at = (suffix) => $(`${config.prefix}-${suffix}`);
    const { rows } = filteredRows(key);
    const total = rows.length;
    at("tab").dataset.status = view.status;
    at("count").textContent = tabCount(view, total, filtersActive(filters));
    at("mark").textContent = view.status === "PASSED" ? "" : statusLabel(view.status);
    const note = viewNote(view, total);
    const meta = at("meta");
    meta.textContent = note;
    meta.hidden = !note;
    at("clear").hidden = !filteredAway(view, total);
    const page = clampPage(pages[key], total);
    pages[key] = page;
    const count = pageCount(total);
    at("pager").hidden = total <= PAGE_SIZE;
    at("page").textContent = `第 ${page} / ${count} 頁`;
    at("prev").disabled = page <= 1;
    at("next").disabled = page >= count;
    const body = at("list");
    const stamp = `${view.status}|${view.observed_at}|${view.rows.length}|${JSON.stringify(filters)}|${page}`;
    if (body.dataset.stamp === stamp) return;
    body.dataset.stamp = stamp;
    body.replaceChildren();
    body.hidden = !total;
    if (total) config.draw(body, pageRows(rows, page));
  }

  function selectTab(key, { focus = false } = {}) {
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
    const view = getMarket()[activeTab];
    const kept = filteredRows(activeTab).rows.length;
    $("result-csv").disabled = !kept;
    $("result-copy").disabled = !kept;
    $("result-open").disabled = !openable(view.url);
  }

  /** Shown only while a filter is active and something was read; follows the selected tab. */
  function renderFilterLine() {
    const market = getMarket();
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
    $("filter-edit").disabled = isRunning();
  }

  /** Caption, summary line and tab labels of the results: the two search kinds name their list differently. */
  function renderHeader(view) {
    const market = getMarket();
    const queryText = getQueryText();
    const statsMode = market.mode === "stats";
    const description = market.lookup?.description ?? "";
    const caption = $("results-caption");
    caption.textContent = statsMode ? `條件：${description}` : `上一次查詢的結果：${queryText}`;
    caption.hidden = statsMode ? view !== "done" || !description : view !== "ready" || !queryText;
    $("summary-text").textContent = `查詢：${statsMode && description ? description : queryText}`;
    $("recent-trades-tab").hidden = statsMode; // the stats search has no recent-trades list
    $("trading-label").textContent = viewConfigFor(market, "trading").label; // the affix search renames the one list it shows
  }

  /** The settings selects mirror `filters`; they are locked like every other setting while a query runs. */
  function renderFilterFields() {
    for (const { key } of FILTER_FIELDS) {
      const select = $(`filter-${key}`);
      select.value = filters[key];
      select.disabled = isRunning();
    }
    $("filter-preset").disabled = isRunning();
    $("filter-clear").disabled = isRunning() || !filtersActive(filters);
  }

  /** Both lists and the selected tab (the stamp keeps an unchanged list from being redrawn). */
  function renderLists() {
    renderMarket("trading");
    renderMarket("recent_trades");
    selectTab(activeTab);
  }

  /** Applies new filters: saved, shown at once, both lists back on page 1. Never starts a query. */
  function setFilters(next) {
    filters = normalizeFilters(next);
    chrome.storage.local.set({ filters });
    resetPages();
    render();
  }

  /** One labelled select per filter field, first option 「不限」; they are built from the same list the filter uses. */
  function buildFilterFields() {
    const box = $("filter-fields");
    for (const field of FILTER_FIELDS) {
      const id = `filter-${field.key}`;
      const label = element("label", { htmlFor: id, textContent: field.label });
      const select = element("select", { id });
      select.append(new Option("不限", ""));
      for (const value of field.options) select.append(new Option(FILTER_OPTION_LABELS[value] ?? value, value));
      select.addEventListener("change", () => setFilters({ ...filters, [field.key]: select.value }));
      box.append(label, select);
    }
  }

  /** The filter selects and their buttons (the 改 button opens the settings screen, so the panel wires it itself). */
  function wireFilters(on) {
    buildFilterFields();
    on("filter-preset", () => setFilters(COMMON_PRESET));
    on("filter-clear", () => setFilters(EMPTY_FILTERS));
    for (const { prefix } of Object.values(marketViews)) on(`${prefix}-clear`, () => setFilters(EMPTY_FILTERS));
  }

  /** The results screen: its tabs (keyboard and click), paging, and copy / CSV / open-site. */
  function wireResults(on) {
    $("results-tabs").addEventListener("keydown", (event) => {
      const next = nextTab(tabKeysFor(getMarket()), activeTab, event.key);
      if (!next) return;
      event.preventDefault();
      selectTab(next, { focus: true });
    });
    on("result-csv", () => resultActions.download(activeTab));
    on("result-copy", () => resultActions.copy(activeTab));
    on("result-open", () => resultActions.openSite(activeTab));
    for (const [key, config] of Object.entries(marketViews)) {
      const turnPage = (delta) => {
        pages[key] += delta;
        renderMarket(key);
      };
      on(`${config.prefix}-tab`, () => selectTab(key));
      // Paging only changes what the list shows; copy and CSV always take every row.
      on(`${config.prefix}-prev`, () => turnPage(-1));
      on(`${config.prefix}-next`, () => turnPage(1));
    }
  }

  return {
    hasRows,
    reset,
    renderLists,
    renderHeader,
    renderFilterFields,
    wireFilters,
    wireResults,
    /** The stored filters; stale or damaged storage falls back to "no filter". */
    loadFilters: (saved) => {
      filters = normalizeFilters(saved);
    },
  };
}
