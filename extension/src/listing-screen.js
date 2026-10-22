// The TR交易 screen as the panel drives it: building the form once the tables are loaded, opening it for a scan record,
// the one place a listing is posted (上架, one `postListing` call per press, the busy flag that locks 返回 and every
// control meanwhile), what a posted listing teaches the number memory, and the 上架預設 settings block (state, storage
// and selects). The form itself is listing-form.js and the flow listing_flow.js; this module never imports sidepanel.js.
import { Tab, loadPageScripts } from "./cdp.js";
import { $ } from "./dom.js";
import { DEFAULT_LISTING, LISTING_DEFAULTS_KEY, LISTING_FIELDS, normalizeListingDefaults } from "./listing-defaults.js";
import { initListingForm } from "./listing-form.js";
import { newTimeline } from "./timeline.js";
import { postListing } from "./traderie/listing_flow.js";
import { productUrlFor } from "./traderie/lookup.js";

/**
 * `invite` is the panel's invite state (a listing costs one use of the code), `loadTables()` resolves with the indexed
 * item tables, `showScreen()` switches the panel to the listing screen, `isRunning()` says a query runs and `render()`
 * redraws the panel.
 */
export function createListingScreen({ invite, valueCorrections, loadTables, showScreen, isRunning, render }) {
  let form = null; // the TR交易 screen's form (listing-form.js), built once the tables are loaded
  let busy = false; // a listing is being posted: the screen's 返回 and every control are locked
  let listingSession = null; // the post in flight, kept so closing the panel can abort its tab
  let defaults = DEFAULT_LISTING; // the four required listing properties (settings screen), saved in chrome.storage.local

  /** The form, built once the tables are loaded; a scan record's 「TR交易」 button needs it. */
  function build(tables) {
    form = initListingForm({
      getTables: () => tables,
      getDefaults: () => defaults,
      onChange: () => form.update(),
      getBlock: invite.blockReason,
    });
  }

  /** The scan list's 「TR交易」: the listing screen for that record; nothing is posted until the player presses 上架. */
  function open(record) {
    if (busy || invite.blockReason() || !record.name || !form) return; // the button is disabled without a name
    showScreen();
    form.load(record);
    render();
  }

  /** A listing that went through is the player's confirmation of its numbers: the ones they changed from what was read are remembered. */
  function noteCorrections() {
    for (const c of form.get().conditions) {
      if (!c.on || c.available === false || c.kind === "bool" || !c.line || c.readValue == null || c.value === null || c.value === "") continue;
      if (Number(c.value) !== c.readValue) valueCorrections.learn(c.line, c.key, Number(c.value));
    }
  }

  /**
   * 上架: the one place a listing is posted. Exactly one `postListing` call per press; the button stays off afterwards
   * (a second press is never an automatic retry: pressing TR交易 on the record again is a new, explicit listing).
   */
  async function post() {
    if (busy || !form?.canPost()) return;
    busy = true;
    form.setBusy(true);
    render();
    listingSession = { tab: null, timeline: newTimeline() };
    try {
      const scripts = await loadPageScripts();
      const result = await postListing({
        form: form.get(),
        tables: await loadTables(),
        openTab: (url) => Tab.open(url, scripts),
        scripts,
        session: listingSession,
        // 上架 costs one use of the invite, counted by the flow right before the request (the same start a name query
        // makes). A used-up or refused code stops the listing with the server's own words; nothing is sent to Traderie.
        beforePost: async () => {
          const code = invite.current();
          try {
            await invite.startRequest(code)({ itemName: form.get().product.name, loadMore: 0 });
          } catch (error) {
            invite.blockIfRefused(error, error.message, code);
            throw error;
          }
        },
        // Published before the request leaves, so the evidence survives a panel closed mid-request.
        onSend: (body) => {
          globalThis.__jevLastListing = { timeline: listingSession.timeline.entries, listing: { body } };
        },
        onStatus: (text) => {
          $("listing-status").textContent = text;
        },
      });
      form.setBusy(false);
      if (result.outcome === "posted") noteCorrections();
      form.showResult(result);
    } catch (error) {
      form.setBusy(false);
      form.showResult({ outcome: "failed", reason: error?.message || String(error), profileUrl: null, verified: false });
    } finally {
      busy = false;
      globalThis.__jevLastListing = { timeline: listingSession.timeline.entries, listing: listingSession.listing ?? null };
      render();
    }
  }

  /** The 上架預設 selects mirror `defaults`; locked while a query runs like every other setting. */
  function renderDefaults() {
    for (const { key } of LISTING_FIELDS) {
      const select = $(`listing-${key}`);
      select.value = defaults[key];
      select.disabled = isRunning();
    }
  }

  /** The 上架預設 selects, filled from the same field list the listing uses; a change stores the whole normalised object. */
  function buildDefaults() {
    for (const { key, options } of LISTING_FIELDS) {
      const select = $(`listing-${key}`);
      for (const { value, label } of options) select.append(new Option(label, value));
      select.addEventListener("change", () => {
        defaults = normalizeListingDefaults({ ...defaults, [key]: select.value });
        chrome.storage.local.set({ [LISTING_DEFAULTS_KEY]: defaults });
        render();
      });
    }
  }

  /** The 上架 and 開啟商品頁 buttons, and the settings block's selects. */
  function wire(on) {
    buildDefaults();
    on("listing-post", post);
    on("listing-open-site", () => {
      const product = form?.get()?.product;
      if (product) chrome.tabs.create({ url: productUrlFor(product) });
    });
  }

  return {
    build,
    open,
    wire,
    renderDefaults,
    /** The stored 上架預設 (damaged storage falls back to the shipped defaults). */
    loadDefaults: (saved) => {
      defaults = normalizeListingDefaults(saved);
    },
    isBusy: () => busy,
    /** The panel is closing: the listing's own Traderie tab must not stay open with the debugger attached. */
    abort: () => listingSession?.tab?.abort().catch(() => {}),
    /** The block reason changed: the form re-judges its 上架 button. */
    update: () => form?.update(),
  };
}
