// sidepanel.js is the panel hub: it exports nothing, it wires the whole screen and then runs init() as it is imported.
// No test executed it. So this file builds a DOM, a chrome and a fetch just big enough for the module, imports it (one
// fresh instance per test, through a cache-busting query), and drives the reachable surface: the first render (every
// cell of an unread market), the invite flow, the mode form, the filters, the tabs, the load-more count, the banner,
// the running screen's locks, and four endings: a failed name query, a failed affix query, a refused invite and the
// player closing the panel mid-run.
//
// Two specifiers it imports exist only in the built package (extension/build.py writes dist/config.js and copies
// csv.js), so a tiny resolve hook points them at a stand-in and at the real csv source.
//
// The fake DOM is built from sidepanel.html itself: every id the markup carries is there, seeded with the hidden and
// disabled it ships, and an id the markup does not carry (and the module does not create itself) is missing. Without
// that, a `hidden === false` assertion would pass whether or not the module wrote it.
//
// NOT covered here, honestly: renderMarket's row-drawing branch (the two-line rows, "—" for an empty cell, the details
// line that carries the merged high-rune value). Rows reach the module only through a live query (cdp.js Tab over
// chrome.debugger); the panel's only row source is that read, so a fake Tab would assert our own fake instead of the
// module. The empty-market half of renderMarket IS pinned below.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FILTER_FIELDS, FILTER_OPTION_LABELS } from "../src/filters.js";
import { STATUS_LABELS } from "../src/labels.js";
import { countLine } from "../src/learning-panel.js";
import { LISTING_FIELDS } from "../src/listing-defaults.js";
import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { LEARNED_SURE } from "../src/ocr/match.js";
import { affixHandoff } from "../src/panel-state.js";
import { viewConfigFor } from "../src/result-views.js";
import { viewNote } from "../src/rows.js";
import { VIEW_LABELS } from "../src/traderie/controller.js";

import { installStubResolver } from "./support/stubs.mjs";

const configUrl = `data:text/javascript,${encodeURIComponent('export const API_BASE = "https://api.test";')}`;

// sidepanel.js alone meets an Agent stand-in: every other test stops at the query window, so the panel never builds an
// Agent there, and this is the only seam that hands the run's choose/vetoBlocked over to a test. It records what the
// panel asked for and then builds the real Agent, so the test drives the very callbacks the product passed.
const agentUrl = new URL("../src/agent.js", import.meta.url).href;
const agentStandIn = `data:text/javascript,${encodeURIComponent(
  `import * as real from ${JSON.stringify(agentUrl)};
export const newCallBudget = real.newCallBudget;
export const Agent = {
  create: (options) => (globalThis.__jevAgentCreates.push(options), real.Agent.create(options)),
};`,
)}`;
// The scan screen needs a model download and IndexedDB before it can run a capture, so this file cannot start a real
// scan. scan-panel.js's own test covers the capture; here the real panel is built and only the handle it hands back is
// watched, to see that 返回 never calls its stop.
const scanUrl = new URL("../src/scan/scan-panel.js", import.meta.url).href;
const scanSpy = `data:text/javascript,${encodeURIComponent(
  `import * as real from ${JSON.stringify(scanUrl)};
export const initScanPanel = (options) => {
  globalThis.__jevScanOptions = options;
  const handle = real.initScanPanel(options);
  return { stop: () => (globalThis.__jevScanStops.push(1), handle.stop()), refresh: () => handle.refresh() };
};`,
)}`;
// The listing flow opens a Traderie window and posts there; here it is a stand-in that records the form it was handed
// and answers what the test set in globalThis.__jevListingReply (the real flow has its own test, listing-flow.test.mjs).
const listingStandIn = `data:text/javascript,${encodeURIComponent(
  `export const postListing = async (options) => {
  options.onStatus?.("開啟商品頁…");
  if (globalThis.__jevListingTab) {
    options.session.tab = globalThis.__jevListingTab; // the flow owns its tab: the panel's abort must reach it
    await globalThis.__jevListingTab.aborted; // the create is in flight until the tab is aborted
    return { outcome: "failed", reason: "aborted", profileUrl: null, verified: false };
  }
  try {
    await options.beforePost?.(); // the real flow counts the invite use here, right before the request
  } catch (error) {
    return { outcome: "refused", reason: error.message, profileUrl: null, verified: false };
  }
  globalThis.__jevListingCalls.push(options);
  const reply = globalThis.__jevListingReply;
  return typeof reply === "function" ? reply(options) : reply;
};`,
)}`;
installStubResolver([
  { specifier: "./config.js", parent: "/sidepanel.js", url: configUrl },
  { specifier: "./config.js", parent: "/invite-state.js", url: configUrl },
  { specifier: "./traderie/listing_flow.js", parent: "/listing-screen.js", url: listingStandIn },
  { specifier: "./agent.js", parent: "/sidepanel.js", url: agentStandIn },
  { specifier: "./scan/scan-panel.js", parent: "/sidepanel.js", url: scanSpy },
]);

// --- the shipped markup, so the fake starts where a browser starts --------------------------------------------

/**
 * Every id `sidepanel.html` carries, with the `hidden`/`disabled` it ships. Without this the fake invented a node for
 * any id and started every one of them visible and enabled, so a `hidden === false` assertion passed whether or not
 * the module wrote it, and a typo'd id was answered with a node instead of being missing.
 */
const MARKUP = (() => {
  const html = readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8");
  const found = new Map();
  for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (id && !found.has(id)) {
      found.set(id, {
        tag,
        hidden: /(?:^|\s)hidden(?:\s|=|$)/.test(attrs),
        disabled: /(?:^|\s)disabled(?:\s|=|$)/.test(attrs),
      });
    }
  }
  return found;
})();

// --- a DOM just big enough for sidepanel.js and the panel modules it builds ------------------------------------

class FakeNode {
  constructor(tag, register, { hidden = false, disabled = false } = {}) {
    this.tagName = tag;
    this._register = register;
    this._id = "";
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.classes = new Set();
    this.hidden = hidden;
    this.disabled = disabled;
    this.value = "";
    this.checked = false;
    this.tabIndex = 0;
    this._text = "";
    this._handlers = {};
    // classList is backed by className, so a `classList.toggle` the panel does is observable here (a no-op stub
    // would let a class bug through this suite; stats-form.test.mjs's node is the same shape).
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => {
        const want = force === undefined ? !this.classes.has(name) : force;
        if (want) this.classes.add(name);
        else this.classes.delete(name);
        return want;
      },
      contains: (name) => this.classes.has(name),
    };
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  // An id makes a node findable, the way the browser registers one put in the tree under that id.
  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value);
    this._register?.(this._id, this);
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  set innerHTML(_value) {
    throw new Error("innerHTML is a markup sink");
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, handler) {
    (this._handlers[type] ??= []).push(handler);
  }

  removeEventListener() {}

  focus() {
    this.focused = true;
  }

  click() {
    return this.dispatch("click");
  }

  /**
   * Runs every handler of `type` on `event` itself (so a test can read what a handler did to it) and resolves once
   * the promises they returned have settled.
   */
  dispatch(type, event = {}) {
    event.type ??= type;
    event.target ??= this;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    return Promise.all((this._handlers[type] ?? []).map((handler) => handler(event)));
  }
}

class FakeOption {
  constructor(text, value) {
    this.textContent = String(text);
    this.value = String(value);
  }
}

/** Only constructed by scan-panel.js at init; its canvas is never drawn on here. */
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(0) }) };
  }
}

function makeDocument() {
  const nodes = new Map();
  const register = (id, node) => nodes.set(id, node);
  const body = new FakeNode("body", register);
  // The nodes a browser would have found, seeded with what the markup ships.
  for (const [id, { tag, hidden, disabled }] of MARKUP) {
    const node = new FakeNode(tag, register, { hidden, disabled });
    node.id = id; // the same registration path a browser uses, and the one the module's own nodes take
  }
  return {
    body,
    // Only ids that exist: the markup's, plus the ones the module makes itself (its filter selects). A typo is null
    // here, exactly as in the browser, instead of a node that answers every assertion.
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => new FakeNode(tag, register),
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

// --- fakes for chrome, fetch and window -----------------------------------------------------------------------

const TABLE = {
  generated_at: "2026-01-01T00:00:00Z",
  version: 3,
  products: [
    { name: "Monarch", slug: "monarch", category: "base" },
    { name: "The Stone of Jordan", slug: "the-stone-of-jordan", category: "uniques" },
    { name: "Ber Rune", slug: "ber-rune", category: "runes" },
  ],
  zh: { 君主盾: "Monarch", 喬丹之石: "The Stone of Jordan" },
  bases: ["Monarch", "Bone Wand"],
  game_only: [],
};

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const okText = (body) => ({ ok: true, status: 200, text: async () => body });

/** Answers the addresses the panel reads: the shipped tables, the page scripts and the backend's run start. */
const defaultFetch = (overrides = {}) => (href, init = {}) => {
  for (const [match, answer] of Object.entries(overrides)) if (href.includes(match)) return answer(href, init);
  if (href.endsWith("/traderie/data/items.json")) return okJson(TABLE);
  if (href.includes("/page/")) return okText("// page script");
  if (href.endsWith("/api/run/start")) return okJson({ run_token: "tok", item_name: "Monarch", load_more: 0, used: 3, limit: 5 });
  throw new Error(`unexpected fetch ${href}`);
};

const pick = (store, keys) => {
  if (keys == null) return { ...store };
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]));
  // A plain key: the form the panel asks for its property cache in (traderie/properties.js store.get(PROPERTIES_KEY)).
  // Reading it as an object would turn the key into one pair per character and lose the cache silently.
  if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, key in store ? store[key] : fallback]));
};

// The module is a script: importing it is what runs the panel. A fresh instance per test needs a fresh URL.
let boots = 0;
/** Drains the microtasks init() and its fire-and-forget branches queued; every fake here resolves at once. */
const flush = async (turns = 25) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

const realFetch = globalThis.fetch;

async function boot({ storage = {}, fetchImpl = defaultFetch(), windowsCreate, debuggerImpl } = {}) {
  const document = makeDocument();
  const store = { ...storage };
  const session = {};
  const calls = { fetch: [], local: [], tabs: [], windows: [] };
  const listeners = {};

  globalThis.__jevAgentCreates = []; // the Agent stand-in appends here each time the panel builds one
  globalThis.__jevScanStops = []; // the scan-panel spy appends here each time the panel asks the scan to stop
  globalThis.__jevScanOptions = null; // what the panel handed initScanPanel (onList is reached through it)
  globalThis.__jevListingCalls = [];
  globalThis.__jevListingReply = { outcome: "posted", reason: "", listingId: "42", listingUrl: "https://traderie.com/diablo2resurrected/listing/42", profileUrl: "https://traderie.com/diablo2resurrected/profile/1002468859845/listings", verified: true };
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, handler) => (listeners[type] ??= []).push(handler) };
  globalThis.Option = FakeOption;
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.fetch.push({ href, init });
    return fetchImpl(href, init);
  };
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, getContexts: async () => [] },
    storage: {
      local: {
        get: async (keys) => pick(store, keys),
        set: async (patch) => {
          calls.local.push(patch);
          Object.assign(store, patch);
        },
      },
      session: {
        // Chrome omits a key it does not have; the panel's window list reads that absence as "no window".
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (patch) => Object.assign(session, patch),
      },
    },
    tabs: { create: async (options) => (calls.tabs.push(options), { id: 1 }) },
    // A Tab is only ever constructed where windows.create succeeds, so a plain boot needs no debugger at all.
    ...(debuggerImpl ? { debugger: debuggerImpl } : {}),
    windows: {
      create: async (options) => {
        calls.windows.push(options);
        if (windowsCreate) return windowsCreate(options);
        throw new Error(WINDOW_ERROR);
      },
      remove: async () => {},
    },
  };

  boots += 1;
  await import(new URL(`../src/sidepanel.js?boot=${boots}`, import.meta.url).href);
  await flush();

  return {
    document,
    store,
    calls,
    listeners,
    get: (id) => document.getElementById(id),
    fire: (id, type, event) => document.getElementById(id).dispatch(type, event),
    // The name and affix forms have no first-screen button: the panel's own seam opens them (as the e2e scripts do).
    choose: async (mode) => globalThis.__jevChooseMode(mode),
  };
}

test.after(() => {
  globalThis.fetch = realFetch;
});

const strings = (nodes) => nodes.map((node) => node.textContent);
const values = (nodes) => nodes.map((node) => node.value);

// Text a fake supplies and the panel must show exactly as it was told (a backend's own message, a thrown error's
// message, an item's name): one constant each, so the fake and the assertion cannot drift apart. Text the panel
// composes itself is asserted as the state that causes it, as the numbers it carries, or against the module that exports
// it; never as a repeated literal.
const WINDOW_ERROR = "無法開啟查詢視窗"; // what chrome.windows.create fails with in boot()
const ITEMS_ERROR = "items.json 讀不到";
const INVITE_INVALID = "邀請碼無效";
const INVITE_EXPIRED = "邀請碼過期";
const INVITE_DEAD = "邀請碼無效或已停用";
const USED_UP = "這組邀請碼的 5 次查詢已用完";
const THROTTLED = "錯誤次數太多，請 15 分鐘後再試";
const CAPTCHA_REFUSAL = "Traderie 要求驗證碼，無法代為上架";
const MONARCH_ZH = "君主盾";
const SOJ_ZH = "喬丹之石";
const MISREAD = "君主盾x"; // a misreading of the Monarch's Chinese name, as the correction memory holds it
const SKILLS_LABEL = "所有技能";
const MANA_LABEL = "法力";

/** A node's text must be there; what it says is the product's wording and is not pinned. */
const assertShows = (node, message) => assert.ok(node.textContent.trim().length > 0, message);
/** Every integer a composed sentence carries, in order. */
const numbersIn = (text) => (text.match(/\d+/g) ?? []).map(Number);
/** The two numbers of the `已用 a/b` quota line (the format the owner chose), or null while the line shows no count. */
const quotaShown = (node) => {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(node.textContent);
  return match ? { used: Number(match[1]), limit: Number(match[2]) } : null;
};
/** A market list that has not been read, as rows.js takes one. */
const UNREAD = { status: "NOT_RUN", rows: [] };
const THREE_OF_FIVE = { used: 3, limit: 5 };
/** The name of each step of the progress list (a step is mark, name, screen-reader state). */
const stepLabels = (get) => get("steps").children.map((step) => step.children[1].textContent);
/** What the form shows about the search kind it is on; a switch of kind has to change every one of them. */
const formTexts = (get) => ({
  title: get("mode-title").textContent,
  help: get("mode-help").textContent,
  label: get("item-label").textContent,
  itemHelp: get("item-help").textContent,
});
/** The option labels the filters module ships for one filter field, without the leading "no filter" option. */
const optionLabels = (key) => FILTER_FIELDS.find((field) => field.key === key).options.map((option) => FILTER_OPTION_LABELS[option]);
/** The closed environment line of the listing form: the four selects' option labels as the settings define them. */
const envLine = (chosen) => LISTING_FIELDS.map(({ key, options }) => options.find((option) => option.value === chosen[key]).label).join(" · ");
const LISTED_ENV = { platform: "PC", mode: "hardcore", ladder: "ladder", version: "reign of the warlock" };

// --- the fake's own footing ------------------------------------------------------------------------------------

test("the fake DOM starts from the shipped markup: shipped-hidden nodes stay hidden and unknown ids are missing", async () => {
  const panel = await boot();

  // Every one of these ships hidden in sidepanel.html and this boot never writes it, so it is still hidden: the seed
  // is what makes the `hidden === false` assertions elsewhere mean the module wrote something.
  for (const id of ["banner-hint", "ocr-panel", "ocr-preview", "ocr-file", "ocr-dropzone", "ocr-hint", "scan-stop"]) {
    assert.equal(panel.document.getElementById(id).hidden, true, id);
  }
  // The nodes the first render reveals shipped hidden too, so those assertions are the module's doing.
  assert.equal(panel.get("part-welcome").hidden, false);
  assert.equal(panel.get("part-stats").hidden, true);

  // An id the markup does not carry is missing, never invented - the module creates only its filter selects.
  assert.equal(panel.document.getElementById("trading-tabs"), null);
  assert.equal(panel.document.getElementById("result-copyy"), null);
  assert.ok(panel.get("filter-game_version"), "a node the module makes itself is registered when it sets its id");
});

// --- the first render -----------------------------------------------------------------------------------------

/**
 * Every cell of both result lists on a market that has not been read: the header says so, nothing drew rows, the
 * three buttons under the tabs are refused and the name search's four steps are all pending.
 */
function assertUnreadResultLists(panel) {
  const { get } = panel;

  assert.equal(get("trading-tab").dataset.status, "NOT_RUN");
  assert.equal(get("trading-count").textContent, "");
  assert.equal(get("trading-mark").textContent, STATUS_LABELS.NOT_RUN);
  assert.equal(get("trading-meta").textContent, viewNote(UNREAD));
  assertShows(get("trading-meta"), "an unread list says so");
  assert.equal(get("trading-meta").hidden, false);
  assert.equal(get("trading-clear").hidden, true);
  assert.equal(get("trading-pager").hidden, true);
  assert.deepEqual(numbersIn(get("trading-page").textContent), [1, 1], "page 1 of 1");
  assert.equal(get("trading-prev").disabled, true);
  assert.equal(get("trading-next").disabled, true);
  assert.equal(get("trading-list").hidden, true);
  assert.equal(get("trading-list").children.length, 0);
  // Same for the other list.
  assert.equal(get("recent-trades-count").textContent, "");
  assert.equal(get("recent-trades-meta").textContent, viewNote(UNREAD));
  assert.equal(get("trading-label").textContent, VIEW_LABELS.trading);

  // No rows and no address: the three buttons under the tabs are all refused.
  assert.equal(get("result-csv").disabled, true);
  assert.equal(get("result-copy").disabled, true);
  assert.equal(get("result-open").disabled, true);

  // The name search's steps are all pending and the status line is empty.
  assert.deepEqual(
    get("steps").children.map((step) => step.dataset.state),
    ["pending", "pending", "pending", "pending"],
  );
  const labels = stepLabels(get);
  assert.equal(labels.length, 4);
  assert.ok(labels.every(Boolean), "every step is named");
  assert.equal(new Set(labels).size, 4, "and the four are told apart");
  assert.equal(get("progress-status").textContent, "");
}

/** The form of the home screen's panel before any search kind is opened: the name-search labels, the affix half hidden. */
function assertUntouchedForm(panel) {
  const { get } = panel;

  assert.equal(panel.document.body.dataset.mode, "scan");
  assert.equal(get("mode-title").textContent, "");
  assert.equal(get("mode-help").textContent, "");
  assertShows(get("item-label"), "the name search's field is labelled");
  assert.equal(get("item-label").htmlFor, "item");
  assertShows(get("item-help"), "and explained");
  assert.equal(get("item").hidden, false);
  assert.equal(get("stats-base").hidden, true);
  assert.equal(get("part-stats").hidden, true);
  assert.equal(get("more-value").textContent, "0");
  assert.equal(get("more-minus").disabled, true);
  assert.equal(get("more-plus").disabled, false);
  assert.equal(get("start").hidden, false);
  assert.equal(get("stop").hidden, true);
}

test("the panel boots into the invite screen and pins the untouched result lists", async () => {
  const panel = await boot();
  const { get } = panel;

  assert.equal(panel.document.body.dataset.view, "welcome");
  assert.equal(get("part-welcome").hidden, false);
  for (const id of ["part-form", "part-run", "part-results", "part-scan", "part-settings"]) {
    assert.equal(get(id).hidden, true, id);
  }

  assertUnreadResultLists(panel);

  // Nothing to trust yet, nothing to note, nothing said about the quota.
  assert.equal(get("trust").dataset.kind, "none");
  assert.equal(get("trust-line").hidden, true);
  assert.equal(get("trust-head").textContent, "");
  assert.equal(get("part-notes").textContent, "");
  assert.equal(get("part-notes").hidden, true);
  assert.equal(get("quota").textContent, "");
  assertShows(get("invite-masked"), "no code yet is said, not left blank");
  assert.equal(get("invite-masked").textContent.includes("•"), false, "and it is not a mask of a code");
  assert.equal(get("invite-note").hidden, true);
  assert.equal(get("invite-quota").textContent, "");
  assert.equal(get("invite-quota").hidden, true);

  assertUntouchedForm(panel);

  // The results summary names the name search's list.
  assert.equal(get("results-caption").hidden, true);
  assertShows(get("summary-text"), "the summary has its label before any query");
  assert.equal(get("recent-trades-tab").hidden, false);
});

test("the tabs are wired for the first render: trading is selected and its panel is the visible one", async () => {
  const panel = await boot();

  assert.equal(panel.get("trading-tab").getAttribute("aria-selected"), "true");
  assert.equal(panel.get("trading-tab").tabIndex, 0);
  assert.equal(panel.get("trading-panel").hidden, false);
  assert.equal(panel.get("recent-trades-tab").getAttribute("aria-selected"), "false");
  assert.equal(panel.get("recent-trades-tab").tabIndex, -1);
  assert.equal(panel.get("recent-trades-panel").hidden, true);
});

// --- the invite ------------------------------------------------------------------------------------------------

test("a stored invite is masked and the quota line says nothing was spent yet", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });

  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(panel.get("part-scan").hidden, false);
  assert.equal(panel.get("part-welcome").hidden, true);
  // The mask keeps the last four characters of a long code and nothing of a short one.
  assert.equal(panel.get("invite-masked").textContent, "••••••••-ABC");
  assertShows(panel.get("quota"), "an unspent quota still says so");
  assert.equal(quotaShown(panel.get("quota")), null, "but shows no count");
});

test("the welcome form keeps the typed code in memory only, and the settings can replace it", async () => {
  const panel = await boot();
  const { get, fire } = panel;

  get("welcome-invite").value = "ABCD-1234";
  await fire("part-welcome", "submit");
  assert.equal(get("invite-masked").textContent, "••••••••1234");
  assert.equal(get("welcome-invite").value, "");
  // A code the backend has not accepted yet is never written to storage.
  assert.deepEqual(panel.calls.local, []);
  assert.equal("invite" in panel.store, false);
  // It is pending until the backend accepts it: the note says so.
  assertShows(get("invite-note"), "the pending note says something");
  assert.equal(get("invite-note").hidden, false);

  // An empty submit only sends the focus back to the field.
  await fire("part-welcome", "submit");
  assert.equal(get("welcome-invite").focused, true);
  assert.equal(get("invite-masked").textContent, "••••••••1234");

  await fire("invite-change", "click");
  assert.equal(get("invite-edit").hidden, false);
  assert.equal(get("invite-change").hidden, true);
  assert.equal(get("invite-new").focused, true);

  get("invite-new").value = "NEW-CODE"; // exactly eight characters: masked without a visible tail
  await fire("invite-edit", "submit");
  assert.equal(get("invite-edit").hidden, true);
  assert.equal(get("invite-change").hidden, false);
  assert.equal(get("invite-new").value, "");
  assert.equal(get("invite-masked").textContent, "••••••••");
  assert.deepEqual(panel.calls.local, []);
});

// --- the mode form ---------------------------------------------------------------------------------------------

test("a stored invite opens straight on the scan screen: no first-choice screen and no 返回 on it", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(panel.get("part-scan").hidden, false);
  assert.equal(panel.get("part-choose"), null);
  assert.equal(panel.get("choose-scan"), null);
  assert.equal(panel.get("scan-change"), null, "nothing is behind the home screen");
  await panel.choose("name");
  assert.equal(panel.document.body.dataset.mode, "name", "the form stays reachable through the seam");
});

test("choosing the name search fills the form and the panel's own search kind is written on the body", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire, choose } = panel;

  const untouched = formTexts(get); // the first render already carries the name search's labels
  await choose("name");
  assert.equal(panel.document.body.dataset.mode, "name");
  assert.equal(panel.document.body.dataset.view, "ready");
  assertShows(get("mode-title"), "the form is titled");
  assertShows(get("mode-help"), "and explained");
  assert.equal(get("item-label").textContent, untouched.label);
  assert.equal(get("item-label").htmlFor, "item");
  assert.equal(get("item").hidden, false);
  assert.equal(get("stats-base").hidden, true);
  assert.equal(get("part-stats").hidden, true);
  assert.equal(get("item-help").textContent, untouched.itemHelp);
  assert.equal(get("item").focused, true);
  assert.equal(get("part-form").hidden, false);
  assert.equal(get("part-run").hidden, false);
  assert.equal(get("part-results").hidden, true);
});

test("switching to the affix search swaps the form and offers the shipped base types", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire, choose } = panel;

  await choose("name");
  const nameForm = formTexts(get);
  await fire("mode-change", "click");
  await choose("stats");
  assert.equal(panel.document.body.dataset.mode, "stats");
  const statsForm = formTexts(get);
  for (const field of Object.keys(statsForm)) {
    assert.notEqual(statsForm[field], "", field);
    assert.notEqual(statsForm[field], nameForm[field], `the affix form changes the ${field}`);
  }
  assert.equal(get("item-label").htmlFor, "stats-base");
  assert.equal(get("item").hidden, true);
  assert.equal(get("stats-base").hidden, false);
  assert.equal(get("part-stats").hidden, false);
  assert.equal(get("stats-base").focused, true);
  // The results header describes the results on screen: it still names the name search's lists, because choosing the
  // affix form has not run an affix query yet (only a stats run renames them - see the start test below).
  assert.equal(get("recent-trades-tab").hidden, false);
  assert.equal(get("trading-label").textContent, VIEW_LABELS.trading);

  // The base suggestions come from the shipped table, once, through warmUpAffixForm.
  await flush();
  assert.deepEqual(values(get("stats-base-options").children), ["Monarch", "Bone Wand"]);

  // 返回 is not a switch to the other kind: it goes back to the scan screen, which is home.
  await fire("mode-change", "click");
  assert.equal(panel.document.body.dataset.mode, "scan");
  assert.equal(panel.document.body.dataset.view, "scan");
});

// --- 返回: from every screen to the scan list, and nowhere else ------------------------------------------------------

test("返回 on the name form shows the scan screen and hides the form, keeping what was typed", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire, choose } = panel;

  await choose("name");
  get("item").value = "Monarch";
  await fire("mode-change", "click");

  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("part-scan").hidden, false);
  assert.equal(get("part-form").hidden, true);
  assert.equal(get("scan-title").focused, true);
  assert.equal(get("item").value, "Monarch");
  assert.equal(panel.calls.windows.length, 0, "going back never starts a query");
  assert.equal(panel.calls.fetch.some((call) => call.href.includes("/api/run/start")), false);
});

test("返回 on the fuzzy form shows the scan screen and hides the form, keeping the typed base", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire, choose } = panel;

  await choose("stats");
  get("stats-base").value = "Monarch";
  await fire("mode-change", "click");

  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("part-scan").hidden, false);
  assert.equal(get("part-form").hidden, true);
  assert.equal(get("scan-title").focused, true);
  assert.equal(get("stats-base").value, "Monarch");
  assert.equal(panel.calls.windows.length, 0);
});

test("返回 is refused while a query runs: the screen stays on the running query", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire, choose } = panel;

  await choose("name");
  get("item").value = "Monarch";
  const pending = fire("start", "click");
  assert.equal(panel.document.body.dataset.view, "running");

  await fire("mode-change", "click");
  assert.equal(panel.document.body.dataset.view, "running");
  assert.equal(panel.document.body.dataset.mode, "name");

  for (const handler of panel.listeners.pagehide) handler({ type: "pagehide" });
  await pending;
  assert.equal(panel.document.body.dataset.view, "stopped");
});

test("返回 from a form leaves the capture running: the scan is never asked to stop", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { fire, choose } = panel;
  globalThis.__jevScanStops = [];

  await choose("name");
  await fire("mode-change", "click");
  await choose("stats");
  await fire("mode-change", "click");
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(globalThis.__jevScanStops.length, 0, "a capture behind the forms keeps going; only its stop button or closing the panel ends it");
});

test("after 返回 each kind opens its own screen again", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire, choose } = panel;

  await choose("name");
  await fire("mode-change", "click");
  await choose("stats");
  assert.equal(panel.document.body.dataset.mode, "stats");
  assert.equal(get("part-form").hidden, false);
  assert.equal(get("part-stats").hidden, false);

  await fire("mode-change", "click");
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("part-scan").hidden, false);

  await choose("name");
  assert.equal(panel.document.body.dataset.mode, "name");
  assert.equal(panel.document.body.dataset.view, "ready");
  assert.equal(get("part-form").hidden, false);
  assert.equal(get("part-stats").hidden, true);
});

test("the 上架預設 selects show the stored listing defaults and a change stores the whole object", async () => {
  const stored = { platform: "xbox", mode: "hardcore", ladder: "nonladder", version: "classic (base game)" };
  const panel = await boot({ storage: { invite: "STORED", listingDefaults: stored } });
  const { get, fire } = panel;

  assert.deepEqual(
    ["platform", "mode", "ladder", "version"].map((key) => get(`listing-${key}`).value),
    ["xbox", "hardcore", "nonladder", "classic (base game)"],
  );
  get("listing-mode").value = "softcore";
  await fire("listing-mode", "change");
  assert.deepEqual(panel.calls.local.at(-1), { listingDefaults: { ...stored, mode: "softcore" } });

  const fresh = await boot({ storage: { invite: "STORED", listingDefaults: { mode: "nonsense" } } });
  assert.deepEqual(
    ["platform", "mode", "ladder", "version"].map((key) => fresh.get(`listing-${key}`).value),
    ["PC", "softcore", "ladder", "reign of the warlock"],
    "a damaged store shows the defaults",
  );
});

// --- the property cache (read with a plain storage key) --------------------------------------------------------

test("a fresh stored property list is used as it is, so no Traderie window is opened for it", async () => {
  const properties = [{ id: 3, name: "+{{value}}% 施法速度", type: "number", options: null, label: "+X% 施法速度" }];
  const panel = await boot({ storage: { invite: "STORED", traderieProperties: { fetchedAt: Date.now(), properties } } });

  await panel.choose("stats"); // warmUpAffixForm -> ensureProperties, best effort
  await flush(60);

  // The stored copy was found and used: no window is opened for a fresh read and nothing is stored again. Finding it
  // means chrome.storage.local.get("traderieProperties") (traderie/properties.js cachedProperties); a fake that reads
  // a plain key as an object of defaults hands back one pair per character, the panel sees no cache, and the window
  // this asserts against is opened.
  assert.deepEqual(panel.calls.windows, []);
  assert.deepEqual(panel.calls.local, []);
});

// --- the tabs --------------------------------------------------------------------------------------------------

test("the tabs switch the shown list by click and by arrow key", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire } = panel;

  await fire("recent-trades-tab", "click");
  assert.equal(get("recent-trades-tab").getAttribute("aria-selected"), "true");
  assert.equal(get("recent-trades-tab").tabIndex, 0);
  assert.equal(get("recent-trades-panel").hidden, false);
  assert.equal(get("trading-tab").getAttribute("aria-selected"), "false");
  assert.equal(get("trading-tab").tabIndex, -1);
  assert.equal(get("trading-panel").hidden, true);

  // ArrowLeft on the tab strip wraps back to the first tab and takes the focus with it.
  const key = { key: "ArrowLeft" };
  await fire("results-tabs", "keydown", key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(get("trading-tab").getAttribute("aria-selected"), "true");
  assert.equal(get("trading-panel").hidden, false);
  assert.equal(get("recent-trades-panel").hidden, true);
  assert.equal(get("trading-tab").focused, true);

  // Any other key is left to the browser.
  const other = { key: "a" };
  await fire("results-tabs", "keydown", other);
  assert.equal(other.defaultPrevented, undefined);
  assert.equal(get("trading-tab").getAttribute("aria-selected"), "true");
});

// --- the filters -----------------------------------------------------------------------------------------------

test("the filter selects are built from the filter fields and mirror what storage holds", async () => {
  const panel = await boot({ storage: { filters: { platform: "PC", mode: "Hardcore", ladder: "", game_version: "" } } });
  const { get, fire } = panel;

  // One label and one select per field, in the order the filters module lists them.
  assert.equal(strings(get("filter-fields").children.filter((node) => node.tagName === "label")).join("|"), FILTER_FIELDS.map((field) => field.label).join("|"));
  const platform = get("filter-platform");
  // The very select the module built is the one it later reads and writes.
  assert.equal(get("filter-fields").children[1], platform);
  assert.equal(strings(platform.children).slice(1).join("|"), optionLabels("platform").join("|"));
  assert.equal(platform.children[0].value, "", "the first option is the unfiltered one");
  assertShows(platform.children[0], "and it is named");
  assert.equal(values(platform.children).join("|"), "|PC|Playstation|Xbox|Switch");
  // The label of an option is the one the filters module ships, not the value itself.
  assert.equal(strings(get("filter-game_version").children).slice(1).join("|"), optionLabels("game_version").join("|"));
  assert.equal(get("filter-fields").children[0].htmlFor, "filter-platform");
  assert.equal(get("filter-fields").children[0].textContent, FILTER_FIELDS[0].label);

  // The saved filters are the ones shown, and a filter is active so it can be cleared.
  assert.equal(platform.value, "PC");
  assert.equal(get("filter-mode").value, "Hardcore");
  assert.equal(get("filter-ladder").value, "");
  assert.equal(get("filter-clear").disabled, false);
  // No rows have been read, so the filter line stays away.
  assert.equal(get("filter-line").hidden, true);

  // The preset replaces every field and is saved at once; "clear" puts them all back to 不限.
  await fire("filter-preset", "click");
  assert.deepEqual(panel.calls.local.at(-1), { filters: { platform: "PC", mode: "Softcore", ladder: "Ladder", game_version: "" } });
  assert.equal(platform.value, "PC");
  assert.equal(get("filter-mode").value, "Softcore");
  assert.equal(get("filter-ladder").value, "Ladder");

  await fire("filter-clear", "click");
  assert.deepEqual(panel.calls.local.at(-1), { filters: { platform: "", mode: "", ladder: "", game_version: "" } });
  assert.equal(platform.value, "");
  assert.equal(get("filter-mode").value, "");
  assert.equal(get("filter-clear").disabled, true);
});

test("a damaged saved filter falls back to 不限, and the clear button follows what survived", async () => {
  // One field damaged, one that is a real option: the surviving value is still a filter, so the clear button can undo
  // it (the old title claimed the opposite of what the panel does).
  const panel = await boot({ storage: { invite: "STORED", filters: { platform: "Switch", mode: "Nonsense" } } });

  assert.equal(panel.get("filter-platform").value, "Switch");
  assert.equal(panel.get("filter-mode").value, "");
  assert.equal(panel.get("filter-clear").disabled, false);

  // Every stored value damaged instead: all four fall back to 不限 together and there is nothing left to clear.
  const damaged = await boot({
    storage: { invite: "STORED", filters: { platform: "Nonsense", mode: "Nonsense", ladder: "Nonsense", game_version: "Nonsense" } },
  });

  for (const key of ["platform", "mode", "ladder", "game_version"]) {
    assert.equal(damaged.get(`filter-${key}`).value, "", key);
  }
  assert.equal(damaged.get("filter-clear").disabled, true);
});

// --- the load-more count ---------------------------------------------------------------------------------------

test("the load-more count moves one at a time and stops at the maximum", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire } = panel;

  for (let i = 0; i < 7; i += 1) await fire("more-plus", "click");
  assert.equal(get("more-value").textContent, "5");
  assert.equal(get("more-plus").disabled, true);

  await fire("more-minus", "click");
  assert.equal(get("more-value").textContent, "4");
  // A taller count only changes what the next query reads: no query is started from here.
  assert.equal(get("start").hidden, false);

  for (let i = 0; i < 6; i += 1) await fire("more-minus", "click");
  assert.equal(get("more-value").textContent, "0");
  assert.equal(get("more-minus").disabled, true);
});

test("the load-more count is remembered: read from storage at start, written back on every change", async () => {
  const panel = await boot({ storage: { invite: "STORED", loadMore: 3 } });
  assert.equal(panel.get("more-value").textContent, "3");

  await panel.fire("more-plus", "click");
  assert.equal(panel.get("more-value").textContent, "4");
  assert.deepEqual(panel.calls.local.at(-1), { loadMore: 4 });
  await panel.fire("more-minus", "click");
  assert.deepEqual(panel.calls.local.at(-1), { loadMore: 3 });

  for (const bad of [9, -1, 2.5, "3"]) {
    const fresh = await boot({ storage: { invite: "STORED", loadMore: bad } });
    assert.equal(fresh.get("more-value").textContent, "0", `a stored ${JSON.stringify(bad)} is not a count`);
  }
});

// --- the banner ------------------------------------------------------------------------------------------------

test("a start-up failure is reported in the banner, which hides on the settings screen", async () => {
  const panel = await boot({
    storage: { invite: "STORED" },
    fetchImpl: defaultFetch({ "/traderie/data/items.json": () => { throw new Error(ITEMS_ERROR); } }),
  });
  const { get, fire } = panel;

  assert.equal(get("banner").hidden, false);
  assertShows(get("banner-message"), "the failure is reported");
  assert.equal(get("banner-hint").textContent, ITEMS_ERROR);
  assert.equal(get("banner-hint").hidden, false);
  assert.equal(get("banner-retry").hidden, false);
  assertShows(get("banner-retry"), "the button that dismisses it is named");
  assert.equal(get("banner-open-site").hidden, true);
  assert.equal(get("banner-settings").hidden, true);

  // The settings screen is never covered by the banner.
  await fire("settings-open", "click");
  assert.equal(panel.document.body.dataset.view, "settings");
  assert.equal(get("part-settings").hidden, false);
  assert.equal(get("banner").hidden, true);

  await fire("settings-back", "click");
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("banner").hidden, false);
});

test("without the item table the base form has no suggestions to offer", async () => {
  const panel = await boot({
    storage: { invite: "STORED" },
    fetchImpl: defaultFetch({ "/traderie/data/items.json": () => { throw new Error(ITEMS_ERROR); } }),
  });

  await panel.choose("stats");
  await flush();
  // The table download failed, so there is nothing to suggest - and the failure is what the player is told about.
  assert.equal(panel.get("banner").hidden, false);
  assertShows(panel.get("banner-message"), "the failure is what the player is told about");
  assert.equal(panel.get("stats-base-options").children.length, 0);
});

// --- queries that fail -----------------------------------------------------------------------------------------

/** Every control a running query locks, on the first frame of the running screen. */
function assertRunningScreenLocksEverything(get, summaryLabel) {
  assert.equal(get("start").hidden, true);
  assert.equal(get("stop").hidden, false);
  assert.equal(get("summary-text").textContent, `${summaryLabel}Monarch`);
  assert.equal(get("item").disabled, true);
  assert.equal(get("mode-change").disabled, true);
  assert.equal(get("settings-open").disabled, true);
  assert.equal(get("invite-change").disabled, true);
  assert.equal(get("invite-new-ok").disabled, true);
  assert.equal(get("welcome-invite").disabled, true);
  assert.equal(get("welcome-go").disabled, true);
  assert.equal(get("filter-platform").disabled, true);
  assert.equal(get("filter-preset").disabled, true);
  assert.equal(get("filter-clear").disabled, true);
  assert.equal(get("more-plus").disabled, true);
  assert.equal(get("more-minus").disabled, true);
  assert.equal(get("part-progress").hidden, false);
}

test("a name query whose window cannot be opened ends in the problem view, with the quota the backend counted", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire, choose } = panel;
  const summaryLabel = get("summary-text").textContent;

  await choose("name");
  get("item").value = "Monarch";
  const pending = fire("start", "click");

  // Everything a query locks is locked from the first frame of the running screen.
  assert.equal(panel.document.body.dataset.view, "running");
  assertRunningScreenLocksEverything(get, summaryLabel);

  await pending;

  // The run failed: the panel shows what happened, and the quota the backend accepted is on the line.
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner").hidden, false);
  assert.equal(get("banner-message").textContent, WINDOW_ERROR);
  assert.equal(get("banner-retry").hidden, false);
  assertShows(get("banner-retry"), "the retry is named");
  assert.equal(get("banner-hint").hidden, true);
  assert.equal(get("banner-settings").hidden, true);
  assert.deepEqual(quotaShown(get("quota")), THREE_OF_FIVE);
  assert.deepEqual(quotaShown(get("invite-quota")), THREE_OF_FIVE);
  assert.equal(get("invite-quota").hidden, false);
  // The banner already offers the retry, so the separate button steps aside.
  assert.equal(get("part-requery").hidden, true);
  assert.equal(get("stop").hidden, true);
  assert.equal(get("start").hidden, false);
  assert.equal(get("item").disabled, false);

  // The run's measurement is published for the Chrome checks (scripts/extension_e2e.py).
  assert.deepEqual(globalThis.__jevLastRun.timeline.map((entry) => entry.stage), ["start_run", "open_tab"]);
  assert.equal(globalThis.__jevLastRun.timeline.at(-1).error, "Error");
  assert.deepEqual(globalThis.__jevLastRun.history, []);

  // Starting over brings the form back and turns the quota line into what is left.
  await fire("banner-retry", "click");
  assert.equal(panel.document.body.dataset.view, "ready");
  assert.equal(get("banner").hidden, true);
  assert.deepEqual(quotaShown(get("quota")), THREE_OF_FIVE);
  assert.equal(get("part-form").hidden, false);
});

test("the affix search renames the results list and drops the recent-trades tab once it runs", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire, choose } = panel;
  const summaryLabel = get("summary-text").textContent;
  const nameSteps = stepLabels(get);
  const nameListLabel = get("trading-label").textContent;

  await choose("stats");
  // A base is enough to search with, and the start button says so by being usable.
  get("stats-base").value = "Monarch";
  await fire("stats-base", "input");
  assert.equal(get("start").disabled, false);
  assert.equal(get("start-why").hidden, true);

  const pending = fire("start", "click");

  await pending;

  // The affix search has one list: it drops the recent-trades tab and renames the remaining one.
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner-message").textContent, WINDOW_ERROR);
  assert.equal(get("summary-text").textContent, `${summaryLabel}Monarch`);
  assert.equal(get("recent-trades-tab").hidden, true);
  assert.equal(get("trading-label").textContent, viewConfigFor({ mode: "stats" }, "trading").label);
  assert.notEqual(get("trading-label").textContent, nameListLabel);
  assert.equal(get("results-caption").hidden, true);
  // The affix search counts one use of the invite too, so the quota is known now.
  assert.deepEqual(quotaShown(get("quota")), THREE_OF_FIVE);
  // Its own four steps, and the first one is where the run stopped.
  const statsSteps = stepLabels(get);
  assert.equal(statsSteps.length, 4);
  assert.ok(statsSteps.every(Boolean));
  assert.notDeepEqual(statsSteps, nameSteps, "the affix search has steps of its own");
  assert.deepEqual(
    get("steps").children.map((step) => step.dataset.state),
    ["pending", "pending", "pending", "pending"],
  );
});

test("closing the panel while a query runs ends it as the player's stop, not as a problem", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire, choose } = panel;

  await choose("name");
  get("item").value = "Monarch";
  const pending = fire("start", "click");

  // The panel is going away: wireClose asks the run to stop before the window is even open.
  for (const handler of panel.listeners.pagehide) handler({ type: "pagehide" });
  await pending;

  assert.equal(panel.document.body.dataset.view, "stopped");
  assert.equal(get("part-stopped").hidden, false);
  assert.equal(get("banner").hidden, true);
  assert.deepEqual(quotaShown(get("quota")), THREE_OF_FIVE);
  // A stop is no failure, so the "start over" button is offered.
  assert.equal(get("part-requery").hidden, false);
});

test("a refused invite is dropped, never stored, and the banner explains it on the invite screen", async () => {
  const rejected = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_INVALID }) });
  const panel = await boot({ fetchImpl: defaultFetch({ "/api/run/start": rejected }) });
  const { get, fire, choose } = panel;
  const noInvite = get("invite-masked").textContent;

  get("welcome-invite").value = "TYPED-CODE";
  await fire("part-welcome", "submit");
  await choose("name");
  get("item").value = "Monarch";
  await fire("start", "click");

  // Without a code left the panel is back on the invite screen, and the banner is the only thing explaining why.
  assert.equal(panel.document.body.dataset.view, "welcome");
  assert.equal(get("part-welcome").hidden, false);
  assert.equal(get("banner").hidden, false);
  assert.equal(get("banner-message").textContent, INVITE_INVALID);
  assert.equal(get("banner-retry").hidden, true);
  assert.equal(get("banner-settings").hidden, true);
  assert.equal(get("invite-masked").textContent, noInvite, "the masked line is back to \"no code\"");
  assert.equal(get("quota").textContent, "");
  // The backend refused it, so it was never kept.
  assert.equal("invite" in panel.store, false);
  assert.deepEqual(panel.calls.local, []);

  // What was sent: the typed code, the name and how many extra batches to read.
  const posted = panel.calls.fetch.find((call) => call.href.endsWith("/api/run/start"));
  assert.equal(posted.href, "https://api.test/api/run/start");
  assert.deepEqual(JSON.parse(posted.init.body), { invite: "TYPED-CODE", item_name: "Monarch", load_more: 0 });
});

test("a refused invite with a stored code leaves the settings button in the banner", async () => {
  const rejected = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_EXPIRED }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/run/start": rejected }) });
  const { get, fire, choose } = panel;

  await choose("name");
  get("item").value = "Monarch";
  await fire("start", "click");

  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner-message").textContent, INVITE_EXPIRED);
  assert.equal(get("banner-settings").hidden, false);
  assert.equal(get("banner-retry").hidden, true);
  // No retry of its own: the "start over" button is the way back.
  assert.equal(get("part-requery").hidden, false);
  assertShows(get("quota"), "an unspent quota still says so");
  assert.equal(quotaShown(get("quota")), null, "but shows no count");
  // A stored code is never dropped by a refusal.
  assert.equal(panel.store.invite, "STORED");
  assert.deepEqual(panel.calls.local, []);

  await fire("banner-settings", "click");
  assert.equal(panel.document.body.dataset.view, "settings");
  assert.equal(get("part-settings").hidden, false);
});

// --- the agent a query builds (the window really opens here) ---------------------------------------------------

const noEvents = { addListener() {}, removeListener() {} };

/**
 * One page, shaped the way cdp.js `observe` returns one (url, title, text, actions, scroll, marker). The debugger
 * below answers the page scripts with it, so the table jump lands and the finder goes on to build the Agent.
 */
const PAGE = {
  url: "https://www.traderie.com/diablo2resurrected/product/monarch",
  title: "Monarch",
  text: "Monarch\nTrading For\nMake an Offer",
  actions: [],
  scroll: 0,
  marker: ["monarch"],
};

/** The window the table jump opens for that page: what sidepanel.js hands chrome.windows.create. */
const PRODUCT_WINDOW = { url: PAGE.url, state: "minimized" };

/** The page scripts the panel's Tab runs, each a sentinel so the fake debugger can tell one read from another. */
const pageScriptFetch = defaultFetch({
  "/page/snapshot.js": () => okText("__snapshot__"),
  "/page/settle.js": () => okText("__settle__"),
  "/page/settled_page.js": () => okText("__settledPage__"),
  // The backend echoes the run it was asked for, so the panel's load-more count and cleaned name reach the Agent.
  "/api/run/start": (_href, init) => {
    const body = JSON.parse(init.body);
    return okJson({ run_token: "tok-7f3", item_name: body.item_name, load_more: body.load_more, used: 3, limit: 5 });
  },
});

const queryDebugger = () => ({
  onDetach: noEvents,
  onEvent: noEvents,
  attach: async () => {},
  detach: async () => {},
  sendCommand: async (_target, method, params = {}) => {
    if (method !== "Runtime.evaluate") return { result: {} };
    const expression = params.expression;
    if (expression === "document.readyState") return { result: { value: "complete" } };
    if (expression.startsWith("__settle__")) return { result: { value: { capped: false, ms: 1, visibility: "visible" } } };
    if (expression.startsWith("__settledPage__")) return { result: { value: PAGE } };
    if (expression === "__snapshot__") return { result: { value: PAGE } };
    return { result: { value: false } }; // the guard's challenge-frame probe and everything else boolean
  },
});

/** A query that really opens its window: choose the name search, ask for two extra batches, type the name, start. */
async function bootQuery(item = "  monarch ") {
  const panel = await boot({
    storage: { invite: "STORED" },
    fetchImpl: pageScriptFetch,
    debuggerImpl: queryDebugger(),
    windowsCreate: async () => ({ id: 1, tabs: [{ id: 1 }] }),
  });
  await panel.choose("name");
  panel.get("item").value = item;
  await panel.fire("more-plus", "click");
  await panel.fire("more-plus", "click");
  await panel.fire("start", "click"); // the choose fetch has no answer, so the run ends as a problem - the Agent is built
  return panel;
}

test("the query builds its Agent with the run's cleaned name and the load-more rule the run carries", async () => {
  const panel = await bootQuery("  monarch ");
  const built = globalThis.__jevAgentCreates;

  // The table jump really opened the product window and the finder went on to make exactly one Agent.
  assert.deepEqual(panel.calls.windows, [PRODUCT_WINDOW]);
  assert.equal(built.length, 1);
  // The two kinds of search the Agent reads, and the rule that ends a phase after the count the run asked for.
  assert.deepEqual(built[0].phases, ["trading", "recent_trades"]);
  assert.deepEqual(built[0].finishPhaseAfter, ["Load More", 2]);
  // "  monarch " was cleaned to the table's own spelling before the run, and that is the text the Agent types.
  assert.equal(built[0].text, "Monarch");
});

test("the choose the query builds posts the run's own token", async () => {
  const panel = await bootQuery();
  const choose = globalThis.__jevAgentCreates[0].choose;
  const asked = () => panel.calls.fetch.filter((call) => call.href.endsWith("/api/choose")).map((call) => JSON.parse(call.init.body));

  // The run's own first choice (its fetch has no answer, so the call rejects) ...
  await assert.rejects(choose(PAGE, "trading", []));
  // ... and one more call through the same callback: every one of them carries the token the backend issued.
  assert.ok(asked().length >= 2);
  for (const body of asked()) assert.equal(body.run_token, "tok-7f3");
});

test("the veto the query builds fires on a search page that lists the item, quiet on the product page", async () => {
  const panel = await bootQuery();
  const vetoBlocked = globalThis.__jevAgentCreates[0].vetoBlocked;

  // A search page whose own headline names a different item, yet lists a clickable link named exactly the run's item:
  // Jev's BLOCKED verdict on such a page is the misjudgement this predicate exists to catch.
  const searchPage = {
    url: "https://www.traderie.com/diablo2resurrected?search=monarch",
    title: "Bone Wand",
    text: "Best Match\nBone Wand\nMonarch",
    actions: [{ kind: "click", role: "link", label: "Monarch" }],
  };
  // The wanted item's own product page lists the same link but is not a search page: nothing to reconsider here.
  const productPage = { ...searchPage, url: PAGE.url, title: "Monarch", text: "Monarch" };

  assert.equal(vetoBlocked(searchPage), true);
  assert.equal(vetoBlocked(productPage), false);
  assert.equal(panel.document.body.dataset.view, "problem");
});

// --- not covered -----------------------------------------------------------------------------------------------

test("the row drawing stays out of reach, as the design says", async () => {
  // The panel's only way to rows is cdp.js Tab over chrome.debugger, so the table jump is stopped at the window and
  // the two-line row drawing is never reached. Recorded here so the gap is deliberate, not forgotten.
  const panel = await boot({ storage: { invite: "STORED" } });
  await panel.choose("name");
  panel.get("item").value = "Monarch";
  await panel.fire("start", "click");

  assert.equal(panel.get("trading-list").children.length, 0);
  assert.equal(panel.get("trading-count").textContent, "");
  assert.deepEqual(panel.calls.windows, [PRODUCT_WINDOW]);
});

// --- 學習紀錄 (the correction memory in the settings screen) ----------------------------------------------------------

const learned = (entries) => ({ v: 1, e: entries.map(([key, n, c]) => [key, { n, k: "base", c, u: 5 }]) });

test("the 學習紀錄 block counts what the store holds and drops a pair the tables no longer list", async () => {
  const panel = await boot({
    storage: { jevCorrections: learned([[MISREAD, "Monarch", 2], ["喬丹x", "Retired Name", 1]]) },
  });

  assert.deepEqual(numbersIn(panel.get("learn-count").textContent), [1, 1, 1, LEARNED_SURE], "one pair counted, one of them sure");
  const listed = strings(panel.get("learn-list").children);
  assert.equal(listed.length, 1, "the retired pair is not listed");
  assert.ok(listed[0].includes(MISREAD) && listed[0].includes(MONARCH_ZH) && listed[0].includes("Monarch"), "the pair is read key, then table name");
  assert.equal(listed[0].includes("Retired Name"), false);
});

test("清除學習紀錄 asks first, then empties the memory and writes the empty store when the panel closes", async () => {
  const panel = await boot({ storage: { jevCorrections: learned([["君主盾x", "Monarch", 1]]) } });

  panel.fire("learn-clear", "click");
  assert.equal(panel.get("learn-confirm").hidden, false);
  assert.equal(panel.calls.local.some((patch) => "jevCorrections" in patch), false, "asking changes nothing");

  panel.fire("learn-clear-yes", "click");
  assert.equal(panel.get("learn-count").textContent, countLine());
  for (const handler of panel.listeners.pagehide) handler(); // the panel closes: what is waiting is written now
  await flush();

  const writes = panel.calls.local.filter((patch) => "jevCorrections" in patch);
  assert.deepEqual(writes.at(-1), { jevCorrections: { v: 1, e: [] } });
});

test("closing the panel on pagehide aborts the listing's own tab while the post is in flight", async () => {
  // The stand-in flow takes the tab the test plants (as the real flow takes the one openTab returned) and waits on a
  // promise only that tab's abort resolves. pagehide during the post must reach the tab through sidepanel ->
  // listing-screen: without the abort the post never settles and the timeout below fails the test.
  try {
    let settleAborted;
    globalThis.__jevListingTab = {
      aborted: new Promise((resolve) => { settleAborted = resolve; }),
      abort: () => { settleAborted(); return Promise.resolve(); },
    };
    const panel = await boot({ storage: { invite: "STORED", listingDefaults: { mode: "hardcore" } } });
    await flush(40);
    globalThis.__jevScanOptions.onList(SOJ_RECORD());
    await flush();
    assert.equal(panel.document.body.dataset.view, "listing");
    const mana = panel.get("listing-affixes").children[1].children[0].children[0]; // the unticked line: untick to lift the blocker
    mana.checked = false;
    await mana.dispatch("change");
    panel.get("listing-make-offer").checked = true;
    await panel.fire("listing-make-offer", "change");
    const post = panel.fire("listing-post", "click");
    await flush(20);
    assert.equal(panel.get("listing-post").disabled, true, "the post is in flight");
    for (const handler of panel.listeners.pagehide) handler(); // the player closes the panel mid-post
    const settled = await Promise.race([post.then(() => true), flush(200).then(() => false)]);
    assert.ok(settled, "the abort settles the post (without it the stub waits forever)");
  } finally {
    delete globalThis.__jevListingTab; // every later test must run without the planted tab, even when this one failed
  }
});

test("a choice made while the save is still waiting survives the panel closing on pagehide", async () => {
  // The memory batches its writes (SAVE_DELAY_MS); a player who closes the side panel inside that second and a half
  // must not lose the choice: pagehide writes what the timer has not yet written, and the next panel reads it.
  // The learning screen's 清除 is the reachable way to change the memory in this suite (the reader path needs a
  // picture); it calls corrections.clear(), which schedules the same delayed write a choice would.
  const panel = await boot({ storage: { jevCorrections: learned([["君主盾x", "Monarch", 1]]) } });
  await flush(60); // init's reader boots last; the test waits for it like the other tests wait for their queries
  panel.calls.local.length = 0;

  panel.fire("learn-clear", "click");
  panel.fire("learn-clear-yes", "click"); // the write is now waiting for its timer
  assert.equal(panel.calls.local.some((patch) => "jevCorrections" in patch), false, "the debounced write has not run yet");

  for (const handler of panel.listeners.pagehide) handler(); // the player closes the panel before the timer
  await flush();

  const writes = panel.calls.local.filter((patch) => "jevCorrections" in patch);
  assert.equal(writes.length, 1, "the closing wrote once, outside the timer");
  assert.deepEqual(writes[0], { jevCorrections: { v: 1, e: [] } });

  const next = await boot({ storage: panel.store }); // the panel is opened again
  assert.equal(next.get("learn-count").textContent, countLine());
});

test("a memory that cannot be read leaves the settings block empty and the rest of the panel working", async () => {
  const panel = await boot({ storage: { jevCorrections: "damaged" } });
  assert.equal(panel.get("learn-count").textContent, countLine());
  assert.equal(panel.get("learn-clear").hidden, true);
});

test("改 on the filter line opens the settings with 進階 expanded, where the filters are", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  assert.notEqual(panel.get("settings-advanced").open, true, "the advanced block ships collapsed");
  await panel.fire("filter-edit", "click");
  assert.equal(panel.document.body.dataset.view, "settings");
  assert.equal(panel.get("settings-advanced").open, true);
});

test("the settings screen reads what the invite has left without a query, and a reopened panel shows the last number", async () => {
  const asked = [];
  const status = () => (href, init) => {
    asked.push(JSON.parse(init.body));
    return okJson({ used: 3, limit: 5, left: 2 });
  };
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": status() }) });
  await flush();
  assert.equal(asked.length, 1, "the panel asks once when it opens, so a used-up code is known before any press");
  await panel.fire("settings-open", "click");
  await flush();
  assert.deepEqual(asked, [{ invite: "STORED" }, { invite: "STORED" }]);
  assert.deepEqual(quotaShown(panel.get("invite-quota")), THREE_OF_FIVE);
  assert.deepEqual(quotaShown(panel.get("quota")), THREE_OF_FIVE);
  assert.equal(panel.calls.fetch.some((call) => call.href.endsWith("/api/run/start")), false, "no query was started");
  assert.deepEqual(panel.store.quota, { used: 3, limit: 5, invite: "STORED" });

  // Reopened: the stored number is there before the backend answers; another code's number is not used.
  const again = await boot({ storage: panel.store });
  assert.deepEqual(quotaShown(again.get("invite-quota")), THREE_OF_FIVE);
  const other = await boot({ storage: { ...panel.store, invite: "OTHER" } });
  await flush(); // another code never inherits the stored number; the status read of this boot has no answer here
  assert.notDeepEqual(quotaShown(other.get("invite-quota")), THREE_OF_FIVE);
});

test("a number asked for a code that is later dropped is never shown for the code in use", async () => {
  const status = (href, init) => okJson(JSON.parse(init.body).invite === "NEW-CODE" ? { used: 1, limit: 9, left: 8 } : { used: 3, limit: 5, left: 2 });
  const throttled = () => ({ ok: false, status: 429, json: async () => ({ error: THROTTLED, code: "too_many_failures" }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": status, "/api/run/start": throttled }) });
  await flush(40);
  await panel.fire("settings-open", "click");
  await panel.fire("invite-change", "click");
  panel.get("invite-new").value = "NEW-CODE";
  await panel.fire("invite-edit", "submit");
  await flush(40);
  assert.deepEqual(quotaShown(panel.get("invite-quota")), { used: 1, limit: 9 }, "the pending code's own number is shown while it is the one in use");

  await panel.fire("settings-open", "click"); // back to the query screen
  await panel.choose("name");
  panel.get("item").value = "Monarch";
  await panel.fire("start", "click"); // a throttle drops the pending code but does not refuse it
  await flush(60);
  await panel.fire("settings-open", "click");
  assert.notDeepEqual(quotaShown(panel.get("invite-quota")), { used: 1, limit: 9 }, "the dropped code's number is not the saved code's");
  assert.notDeepEqual(quotaShown(panel.get("quota")), { used: 1, limit: 9 });
});

test("a failed step that may have been refunded makes the panel read the count again", async () => {
  const down = () => ({ ok: false, status: 502, json: async () => ({ error: "model down", code: "model_unavailable" }) });
  const open = await boot({ storage: { invite: "STORED", quota: { used: 3, limit: 5, invite: "STORED" } }, fetchImpl: defaultFetch({ "/api/invite/status": () => okJson({ used: 3, limit: 5, left: 2 }), "/api/run/start": down }) });
  await flush(40);
  await open.choose("name");
  open.get("item").value = "Monarch";
  const before = open.calls.fetch.filter((call) => call.href.endsWith("/api/invite/status")).length;
  await open.fire("start", "click");
  await flush(60);
  const after = open.calls.fetch.filter((call) => call.href.endsWith("/api/invite/status")).length;
  assert.equal(after, before + 1, "the failed query is followed by one status read");
});

test("the numbers a started run returns are tagged with the code the run was started for", async () => {
  // The start of a query on the pending code NEW is slow; while it flies, the player types DONE and a second query
  // succeeds there. NEW's late numbers must not land on DONE's display or storage.
  const releases = []; // held answers released at the end: an unanswered fetch keeps the client's 300 s timer alive
  const slowStart = (href, init) =>
    JSON.parse(init.body).invite === "NEW"
      ? new Promise((resolve) => { releases.push(() => resolve(okJson({ run_token: "tok", item_name: "Monarch", load_more: 0, used: 9, limit: 9 }))); })
      : okJson({ run_token: "tok", item_name: "Monarch", load_more: 0, used: 1, limit: 5 });
  const panel = await boot({ fetchImpl: defaultFetch({ "/api/run/start": slowStart }) });
  panel.get("welcome-invite").value = "NEW";
  await panel.fire("part-welcome", "submit");
  await panel.choose("name");
  panel.get("item").value = "Monarch";
  const running = panel.fire("start", "click");
  await flush(20);
  await panel.fire("settings-open", "click");
  panel.get("invite-new").value = "DONE";
  await panel.fire("invite-edit", "submit");
  await flush();
  releases.forEach((release) => release()); // NEW's start answers now, with NEW no longer the code in use
  await flush();
  await running;
  // The problem of the dropped NEW run leaves the panel on the query screen: a second query on DONE succeeds there
  // and its own numbers are the ones that land.
  await panel.choose("name");
  panel.get("item").value = "Monarch";
  await panel.fire("start", "click");
  await flush(60);
  await panel.fire("settings-open", "click");
  await flush();
  assert.notDeepEqual(quotaShown(panel.get("invite-quota")), { used: 9, limit: 9 }, "NEW's numbers never show for DONE");
  assert.deepEqual(quotaShown(panel.get("invite-quota")), { used: 1, limit: 5 }, "DONE's own numbers do");
  assert.deepEqual(panel.store.quota, { used: 1, limit: 5, invite: "DONE" }, "and are stored under DONE's name");
});

test("a refused code or an unreachable backend is said in the settings line instead of a guessed number", async () => {
  const refuse = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_DEAD }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": refuse }) });
  await panel.fire("settings-open", "click");
  await flush();
  assert.equal(panel.get("invite-quota").textContent, INVITE_DEAD);
  const down = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": () => { throw new Error("offline"); } }) });
  await down.fire("settings-open", "click");
  await flush();
  assertShows(down.get("invite-quota"), "an unreachable backend is said, not left blank");
  assert.equal(quotaShown(down.get("invite-quota")), null, "and no number is guessed");
});

// --- the listing screen (TR交易) ---------------------------------------------------------------------------------

const SOJ_RECORD = () => ({
  id: 5,
  name: "The Stone of Jordan",
  zh: "喬丹之石",
  kind: "item",
  quality: "gold",
  text: "The Stone of Jordan\nRing\n+1 To All Skills",
  conditions: [
    { key: "all_skills", label: SKILLS_LABEL, kind: "plain", line: "+1 To All Skills", min: 1, max: null, on: false, confident: true },
    { key: "mana", label: MANA_LABEL, kind: "plain", line: "+25% mana", min: null, max: null, on: false, confident: true },
  ],
});

async function bootListing(record = SOJ_RECORD()) {
  const panel = await boot({ storage: { invite: "STORED", listingDefaults: { mode: "hardcore" } } });
  await flush(40);
  assert.ok(globalThis.__jevScanOptions?.onList, "the panel hands onList to the scan screen");
  globalThis.__jevScanOptions.onList(record);
  await flush();
  return panel;
}

test("TR交易 on a record opens the listing screen prefilled from the record and the saved defaults; 返回 goes to the scan screen", async () => {
  const panel = await bootListing();
  const { get } = panel;
  assert.equal(panel.document.body.dataset.view, "listing");
  assert.equal(get("part-listing").hidden, false);
  assert.equal(get("part-scan").hidden, true);
  const shownItem = get("listing-item").textContent;
  assert.ok(shownItem.includes(SOJ_ZH) && shownItem.includes("The Stone of Jordan"), "the item is named in both languages");
  assert.equal(get("listing-rarity-row").hidden, true, "a unique chooses no Rarity");
  const rows = get("listing-affixes").children;
  assert.equal(rows.length, 2);
  const [skills, mana] = rows;
  assert.equal(skills.children[0].children[0].checked, true);
  assert.equal(skills.children[1].value, 1);
  assert.equal(skills.children[1].classList.contains("from-capture"), true);
  assert.ok(skills.children[1].title, "the mark says why the number is asked about");
  assert.equal(mana.children[1].classList.contains("from-capture"), false, "a line with no number read is not marked");
  assert.ok(!mana.children[1].title);
  assert.equal(get("listing-env-mode").value, "hardcore");
  assert.equal(get("listing-env-summary").textContent, envLine(LISTED_ENV));
  get("listing-env-mode").value = "softcore";
  await panel.fire("listing-env-mode", "change");
  assert.equal(get("listing-env-summary").textContent, envLine({ ...LISTED_ENV, mode: "softcore" }), "the closed environment line follows the selects");
  get("listing-env-mode").value = "hardcore";
  await panel.fire("listing-env-mode", "change");
  assert.equal(get("listing-env-platform").value, "PC");
  assert.equal(get("listing-groups").children.length, 1);
  assert.equal(get("listing-groups").children[0].children[0].children.length, 2, "blank first option, then the table's runes");
  // No price, and a ticked line without a number: the first blocker is the number.
  assert.equal(get("listing-post").disabled, true);
  assert.ok(get("listing-why").textContent.includes(MANA_LABEL), "the blocker names the line that lacks a number");
  assert.equal(get("listing-why").textContent.includes(SKILLS_LABEL), false, "and not the one that has it");
  assert.equal(get("listing-why").hidden, false);

  await panel.fire("listing-change", "click");
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("scan-title").focused, true);
  assert.equal(globalThis.__jevScanStops.length, 0, "the scan is not stopped by going back to it");
  assert.deepEqual(globalThis.__jevListingCalls, []);
});

test("the listing screen's blockers follow the edits: untick the empty line, pick a price or 接受出價, and 上架 posts once", async () => {
  const panel = await bootListing();
  const { get, fire } = panel;
  const numberBlocker = get("listing-why").textContent;
  assert.ok(numberBlocker.includes(MANA_LABEL));
  const mana = get("listing-affixes").children[1].children[0].children[0];
  mana.checked = false;
  await mana.dispatch("change");
  assert.equal(get("listing-post").disabled, true);
  assert.equal(get("listing-why").hidden, false);
  assertShows(get("listing-why"), "the next blocker is the missing price");
  assert.notEqual(get("listing-why").textContent, numberBlocker, "the number blocker is gone once the empty line is unticked");
  get("listing-make-offer").checked = true;
  await fire("listing-make-offer", "change");
  assert.equal(get("listing-post").disabled, false);
  assert.equal(get("listing-why").hidden, true);

  await fire("listing-post", "click");
  await flush(40);
  assert.equal(globalThis.__jevListingCalls.length, 1);
  const form = globalThis.__jevListingCalls[0].form;
  assert.deepEqual([form.product.slug, form.makeOffer, form.env.mode, form.conditions.map((c) => c.on)], ["the-stone-of-jordan", true, "hardcore", [true, false]]);
  assertShows(get("listing-status"), "a posted listing says so");
  assert.equal(get("listing-status").dataset.tone, "ok");
  assert.equal(get("listing-open-site").hidden, true);
  assert.equal(get("listing-profile-link").hidden, false);
  assert.equal(get("listing-profile-link").textContent, "traderie.com/diablo2resurrected/profile/1002468859845/listings");
  assert.equal(get("listing-profile-link").href, "https://traderie.com/diablo2resurrected/profile/1002468859845/listings");
  assert.equal(get("listing-post").disabled, true, "a second press is never an automatic retry");
  await fire("listing-post", "click");
  assert.equal(globalThis.__jevListingCalls.length, 1);
  const apiCalls = panel.calls.fetch.filter((call) => call.href.includes("/api/") && !call.href.includes("/api/invite/status"));
  assert.deepEqual(apiCalls.map((call) => call.href.replace(/^.*\/api/, "/api")), ["/api/run/start"], "posting counts one use and asks no model");
  assert.deepEqual(JSON.parse(apiCalls[0].init.body), { invite: "STORED", item_name: "The Stone of Jordan", load_more: 0 });
  assert.deepEqual(quotaShown(get("quota")), THREE_OF_FIVE);
});

test("an invite with no uses left stops 上架 before anything is posted, with the server's own words", async () => {
  const used = () => ({ ok: false, status: 429, json: async () => ({ error: USED_UP }) });
  const panel = await boot({
    storage: { invite: "STORED", listingDefaults: { mode: "hardcore" } },
    fetchImpl: defaultFetch({ "/api/run/start": used }),
  });
  await flush(40);
  globalThis.__jevScanOptions.onList(SOJ_RECORD());
  await flush();
  const { get, fire } = panel;
  get("listing-affixes").children[1].children[0].children[0].checked = false;
  await get("listing-affixes").children[1].children[0].children[0].dispatch("change");
  get("listing-make-offer").checked = true;
  await fire("listing-make-offer", "change");
  await fire("listing-post", "click");
  await flush(40);
  assert.deepEqual(globalThis.__jevListingCalls, [], "nothing was sent to Traderie");
  assert.equal(get("listing-status").textContent, USED_UP);
  assert.equal(get("listing-open-site").hidden, false);
});

test("an invite with no uses left stops the affix search before any window is opened", async () => {
  const used = () => ({ ok: false, status: 429, json: async () => ({ error: USED_UP }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/run/start": used }) });
  await flush(40);
  globalThis.__jevScanOptions.onSearchStats({ id: 9, name: "Monarch", zh: "君主盾", kind: "base", quality: "yellow", text: "Monarch", conditions: [] });
  await flush(60);
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(panel.get("banner-message").textContent, USED_UP);
  // Only the form's own best-effort warm-up of Traderie's property list may have opened a window: no search page.
  assert.deepEqual(panel.calls.windows.map((w) => w.url), ["https://www.traderie.com/diablo2resurrected"]);
});

test("a used-up or refused invite switches off 精準搜尋, 模糊搜尋, TR交易 and 上架, and says why", async () => {
  const status = () => okJson({ used: 5, limit: 5, left: 0 });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": status }) });
  await flush(40);
  const why = panel.get("scan-block").textContent;
  assert.equal(panel.get("scan-block").hidden, false);
  assertShows(panel.get("scan-block"), "the block says why");
  assert.deepEqual(numbersIn(why), [5], "and how many uses the code had");
  assert.equal(panel.get("start").disabled, true);
  assert.equal(panel.get("start-why").textContent, why);

  // Each press does nothing, even when called directly: no start, no window.
  await globalThis.__jevScanOptions.onSearchName({ id: 1, name: "Monarch", zh: "君主盾", kind: "base", conditions: [] });
  assert.equal(panel.calls.fetch.some((call) => call.href.endsWith("/api/run/start")), false);

  globalThis.__jevScanOptions.onList(SOJ_RECORD());
  await flush();
  assert.equal(globalThis.__jevScanOptions.getBlock(), why, "the scan list disables its three buttons with this reason");
  assert.equal(panel.document.body.dataset.view, "scan", "the listing button does not open the listing screen either");

  const refused = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_DEAD }) });
  const bad = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": refused }) });
  await flush(40);
  assert.equal(bad.get("scan-block").textContent, INVITE_DEAD);

  const fine = await boot({ storage: { invite: "STORED" } }); // no answer for status: unknown is not blocked
  await flush(40);
  assert.equal(fine.get("scan-block").hidden, true);
  assert.equal(fine.get("start").disabled, false);
});

test("a refusal belongs to the code that was refused: a new code typed on the welcome screen is not blocked by it", async () => {
  const refuse = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_DEAD, code: "invite_invalid" }) });
  const panel = await boot({ fetchImpl: defaultFetch({ "/api/run/start": refuse }) });
  await panel.fire("part-welcome", "submit"); // empty: nothing
  panel.get("welcome-invite").value = "TYPO";
  await panel.fire("part-welcome", "submit");
  await panel.choose("name");
  panel.get("item").value = "Monarch";
  await panel.fire("start", "click");
  await flush(60);
  assert.equal(panel.get("banner-message").textContent, INVITE_DEAD);

  panel.get("welcome-invite").value = "RIGHT";
  await panel.fire("part-welcome", "submit");
  await flush();
  assert.equal(panel.get("scan-block").hidden, true, "the earlier refusal was about TYPO");
});

test("a throttle 429 is shown but never locks a valid code; only 401 or used-up does", async () => {
  const throttled = () => ({ ok: false, status: 429, json: async () => ({ error: THROTTLED, code: "too_many_failures" }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/invite/status": throttled }) });
  await flush(40);
  await panel.fire("settings-open", "click");
  await flush();
  assert.equal(panel.get("invite-quota").textContent, THROTTLED);
  assert.equal(panel.get("scan-block").hidden, true);
  assert.equal(panel.get("start").disabled, false);
});

test("a status answer for a code that was replaced meanwhile is dropped, and a refused saved code is not polled on every open", async () => {
  const releases = []; // every held answer is released at the end: an unanswered fetch keeps the client's 300 s timer alive
  const slow = (_h, init) =>
    JSON.parse(init.body).invite === "OLD"
      ? new Promise((resolve) => { releases.push(() => resolve(okJson({ used: 5, limit: 5, left: 0 }))); })
      : okJson({ used: 1, limit: 5, left: 4 });
  const panel = await boot({ storage: { invite: "OLD" }, fetchImpl: defaultFetch({ "/api/invite/status": slow }) });
  await flush(40);
  await panel.fire("settings-open", "click");
  panel.get("invite-new").value = "NEW";
  await panel.fire("invite-edit", "submit");
  await flush();
  releases.forEach((release) => release());
  await flush();
  assert.deepEqual(quotaShown(panel.get("invite-quota")), { used: 1, limit: 5 }, "OLD's used-up answer did not land on NEW");
  assert.equal(panel.get("scan-block").hidden, true);

  const refused = () => ({ ok: false, status: 401, json: async () => ({ error: INVITE_DEAD }) });
  const asked = [];
  const dead = await boot({
    storage: { invite: "DEAD", quota: { invite: "DEAD", refused: INVITE_DEAD, at: Date.now() } },
    fetchImpl: defaultFetch({ "/api/invite/status": (...a) => (asked.push(1), refused(...a)) }),
  });
  await flush(40);
  assert.equal(asked.length, 0, "no automatic ask for a code already known to be refused");
  assert.equal(dead.get("scan-block").textContent, INVITE_DEAD);

  // An old refusal is asked again once: the admin may have fixed the code since, and it must recover by itself.
  const old2 = await boot({
    storage: { invite: "DEAD", quota: { invite: "DEAD", refused: INVITE_DEAD, at: Date.now() - 16 * 60 * 1000 } },
    fetchImpl: defaultFetch({ "/api/invite/status": () => okJson({ used: 1, limit: 5, left: 4 }) }),
  });
  await flush(40);
  assert.equal(old2.get("scan-block").hidden, true);
  assert.deepEqual(quotaShown(old2.get("invite-quota")), { used: 1, limit: 5 });
});

test("pressing the affix search twice in a row charges one use and opens one window", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  await flush(40);
  const record = { id: 9, name: "Monarch", zh: "君主盾", kind: "base", quality: "yellow", text: "Monarch", conditions: [] };
  const first = globalThis.__jevScanOptions.onSearchStats(record);
  const second = globalThis.__jevScanOptions.onSearchStats(record); // before the first one reached `running`
  await Promise.all([first, second]);
  await flush(60);
  assert.equal(panel.calls.fetch.filter((call) => call.href.endsWith("/api/run/start")).length, 1);
}); 

test("a refused listing sent nothing: the form stays editable, the unavailable row is unticked and greyed, and 上架 works again", async () => {
  const panel = await bootListing();
  const { get, fire } = panel;
  globalThis.__jevListingReply = { outcome: "refused", reason: "這件物品在 Traderie 沒有這些屬性欄位：所有技能（請取消勾選）", unavailable: ["all_skills"], profileUrl: null, verified: false };
  get("listing-affixes").children[1].children[0].children[0].checked = false;
  await get("listing-affixes").children[1].children[0].children[0].dispatch("change");
  get("listing-make-offer").checked = true;
  await fire("listing-make-offer", "change");
  await fire("listing-post", "click");
  await flush(40);
  const skills = get("listing-affixes").children[0];
  assert.equal(skills.children[0].children[0].checked, false, "the row the item lacks is unticked");
  assert.equal(skills.children[0].children[0].disabled, true, "and greyed");
  assert.equal(get("listing-post").disabled, false, "nothing was sent, so the player can press post again");

  globalThis.__jevListingReply = { outcome: "failed", reason: "Traderie 回覆 HTTP 400", profileUrl: null, verified: false };
  await fire("listing-post", "click");
  await flush(40);
  assert.equal(get("listing-post").disabled, true, "a request that was sent locks the form");
});

test("a refused or failed listing shows the reason and the way to the site; 返回 is refused while posting", async () => {
  const panel = await bootListing();
  const { get, fire } = panel;
  let release;
  globalThis.__jevListingReply = () => new Promise((resolve) => {
    release = resolve;
  });
  get("listing-affixes").children[1].children[0].children[0].checked = false;
  await get("listing-affixes").children[1].children[0].children[0].dispatch("change");
  get("listing-make-offer").checked = true;
  await fire("listing-make-offer", "change");
  const pressed = fire("listing-post", "click");
  await flush();
  assertShows(get("listing-status"), "the flow's progress is shown while posting");
  const working = get("listing-status").textContent;
  assert.equal(get("listing-change").disabled, true);
  await fire("listing-change", "click");
  assert.equal(panel.document.body.dataset.view, "listing", "going back is refused while the post runs");
  release({ outcome: "refused", reason: CAPTCHA_REFUSAL, listingId: null, listingUrl: null, verified: false });
  await pressed;
  await flush();
  assert.equal(get("listing-status").textContent, CAPTCHA_REFUSAL);
  assert.notEqual(get("listing-status").textContent, working, "the progress line is replaced by the reason");
  assert.equal(get("listing-open-site").hidden, false);
  assert.equal(get("listing-change").disabled, false);
  await fire("listing-open-site", "click");
  assert.deepEqual(panel.calls.tabs, [{ url: "https://www.traderie.com/diablo2resurrected/product/the-stone-of-jordan" }]);
});

test("a base record with a yellow name line prefills 黃裝 marked from the capture, and a record off the table cannot be listed", async () => {
  const panel = await bootListing({ id: 6, name: "Monarch", zh: "君主盾", kind: "base", quality: "yellow", text: "Monarch", conditions: [] });
  const { get } = panel;
  assert.equal(get("listing-rarity-row").hidden, false);
  assert.equal(get("listing-rarity").value, "rare");
  assert.equal(get("listing-rarity").classList.contains("from-capture"), true);
  assert.equal(get("listing-post").disabled, true);
  assert.equal(get("listing-why").hidden, false);
  assertShows(get("listing-why"), "the missing price is what blocks it");
  const priceBlocker = get("listing-why").textContent;

  globalThis.__jevScanOptions.onList({ id: 7, name: "Nowhere Item", zh: "", kind: "item", quality: null, text: "x", conditions: [] });
  await flush();
  assert.ok(get("listing-item").textContent.includes("Nowhere Item"));
  assert.notEqual(get("listing-item").textContent, "Nowhere Item", "the line says more than the name: the item is not in the table");
  assert.equal(get("listing-post").disabled, true);
  assert.ok(get("listing-why").textContent.includes("Nowhere Item"), "the blocker names the item");
  assert.notEqual(get("listing-why").textContent, priceBlocker, "and is not the price blocker");
});

// --- a record's search buttons start the query ---------------------------------------------------------------------

const BASE_RECORD = () => ({
  id: 1,
  name: "Monarch",
  zh: "君主盾",
  kind: "base",
  quality: "yellow",
  base: null,
  text: "君主盾\n+7% Faster Cast Rate",
  conditions: [],
  at: new Date("2026-01-01T12:34:56Z"),
});

async function bootScan(storage = { invite: "STORED-ABC" }) {
  const panel = await boot({ storage });
  await flush(40);
  assert.ok(globalThis.__jevScanOptions?.onSearchName, "the panel hands the search handlers to the scan screen");
  return panel;
}

const runStarts = (panel) => panel.calls.fetch.filter((call) => call.href.endsWith("/api/run/start"));

test("精準搜尋 on a record starts the name query at once, with no 開始查詢 press", async () => {
  const panel = await bootScan();
  const { get } = panel;
  const summaryLabel = get("summary-text").textContent;

  const pending = globalThis.__jevScanOptions.onSearchName(BASE_RECORD());
  assert.equal(panel.document.body.dataset.view, "running");
  assert.equal(get("item").value, MONARCH_ZH);
  assert.equal(get("summary-text").textContent, `${summaryLabel}${MONARCH_ZH}`);
  await pending;

  assert.equal(runStarts(panel).length, 1, "exactly one start, never a retry");
  assert.equal(JSON.parse(runStarts(panel)[0].init.body).item_name, "Monarch");
  assert.equal(panel.document.body.dataset.view, "problem");
});

test("a second press while the query runs starts nothing more", async () => {
  const panel = await bootScan();
  const first = globalThis.__jevScanOptions.onSearchName(BASE_RECORD());
  await globalThis.__jevScanOptions.onSearchName(BASE_RECORD());
  await first;
  assert.equal(runStarts(panel).length, 1);
});

test("模糊搜尋 on a base record starts the affix query with the base and the name line's quality, and no condition", async () => {
  const panel = await bootScan();
  const { get } = panel;
  // The fake document finds no radios by selector; point it at the ones the form built so the check sees them.
  panel.document.querySelectorAll = () => get("quality-group").children.map((label) => label.children[0]);

  const pending = globalThis.__jevScanOptions.onSearchStats(BASE_RECORD());
  await flush(2); // the query's first awaits (the tables are cached) and then the running screen
  assert.equal(panel.document.body.dataset.view, "running");
  await pending;

  assert.equal(get("stats-base").value, "Monarch");
  assert.deepEqual(
    get("quality-group").children.map((label) => [label.children[0].value, label.children[0].checked]).filter(([, on]) => on),
    [["rare", true]],
  );
  assert.equal(get("affix-list").children.length, 0, "the read affix lines are not carried: they are added afterwards");
  assert.equal(runStarts(panel).length, 1, "the affix search counts one use of the invite");
  assert.equal(JSON.parse(runStarts(panel)[0].init.body).item_name, "Monarch");
  assert.equal(panel.document.body.dataset.view, "problem", "the query really started: its window could not be opened");
});

test("模糊搜尋 on a record with no base opens the affix form with the base box focused and starts nothing", async () => {
  const panel = await bootScan();
  const { get } = panel;

  await globalThis.__jevScanOptions.onSearchStats({ ...BASE_RECORD(), name: "The Stone of Jordan", kind: "item", quality: "gold", base: null });

  assert.equal(panel.document.body.dataset.view, "ready");
  assert.equal(panel.document.body.dataset.mode, "stats");
  assert.equal(get("stats-base").focused, true);
  assert.equal(get("stats-base").value, "");
  assert.equal(get("affix-fill").disabled, false, "the record's text is still there to fill the form from");
  assert.equal(runStarts(panel).length, 0);
});

test("after a failed name query from a record, 用詞綴找同類 opens the affix form with the read lines ticked", async () => {
  const panel = await bootScan();
  const { get, fire } = panel;

  await globalThis.__jevScanOptions.onSearchName(BASE_RECORD());
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("fuzzy-handoff").hidden, false);
  assert.ok(handoffLabel("name", "problem"), "a failed name query has a hand-off");
  assert.equal(get("fuzzy-handoff").textContent, handoffLabel("name", "problem"));

  await fire("fuzzy-handoff", "click");
  await flush(60);

  assert.equal(panel.document.body.dataset.view, "ready");
  assert.equal(panel.document.body.dataset.mode, "stats");
  assert.equal(get("stats-base").value, "Monarch");
  const rows = get("affix-list").children;
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].children[0].children[0].checked, true);
});

test("after an affix query from a record, the hand-off offers 加詞綴條件縮小範圍", async () => {
  const panel = await bootScan();
  await globalThis.__jevScanOptions.onSearchStats(BASE_RECORD());
  assert.equal(panel.get("fuzzy-handoff").hidden, false);
  assert.equal(panel.get("fuzzy-handoff").textContent, handoffLabel("stats", "done"));
  assert.ok(handoffLabel("stats", "done"));
  assert.notEqual(handoffLabel("stats", "done"), handoffLabel("name", "problem"), "the two hand-offs say different things");
});

/** What the result screen's hand-off button is called for a scan record's query, as the module that names it says. */
const handoffLabel = (mode, ended) => affixHandoff(new Set(["requery"]), { kind: "scan", record: BASE_RECORD() }, ended, mode);

/** A named item whose read had a base candidate, as the scan list hands it to the affix search. */
const ITEM_RECORD = (over = {}) => ({
  ...BASE_RECORD(),
  name: "The Stone of Jordan",
  zh: "喬丹之石",
  kind: "item",
  quality: "gold",
  base: "Monarch",
  baseKey: "monarchkey",
  baseLearned: 0,
  ...over,
});

test("a base typed over a record's own base is remembered for that record's read, and a base left alone is not", async () => {
  const panel = await bootScan();
  const { get, fire } = panel;
  const record = ITEM_RECORD();

  await globalThis.__jevScanOptions.onSearchStats(record); // the query for the record's own base runs and ends
  assert.equal(panel.store.jevBaseCorrections, undefined, "nothing was changed: nothing is learned");

  await fire("fuzzy-handoff", "click"); // 加詞綴條件縮小範圍: the form opens, nothing started
  assert.equal(get("stats-base").value, "Monarch");
  get("stats-base").value = "Bone Wand";
  await fire("stats-base", "input");
  await fire("start", "click");
  await flush(20);
  await panel.listeners.pagehide[0]();
  await flush(5);

  assert.deepEqual(panel.store.jevBaseCorrections.e.map(([key, v]) => [key, v.n, v.k, v.c]), [["monarchkey", "Bone Wand", "base", 1]]);
  assert.deepEqual([record.base, record.baseLearned], ["Bone Wand", 1], "the record on the list knows the correction at once");
});

test("a record whose base was corrected once opens the form for confirmation, a second identical choice starts at once", async () => {
  const panel = await bootScan({ invite: "STORED-ABC", jevBaseCorrections: { v: 1, e: [["monarchkey", { n: "Bone Wand", k: "base", c: 1, u: 1 }]] } });
  const { get, fire } = panel;
  const record = ITEM_RECORD({ base: "Bone Wand", baseLearned: 1 });

  await globalThis.__jevScanOptions.onSearchStats(record);
  assert.equal(panel.document.body.dataset.view, "ready", "asked, nothing started");
  assert.equal(get("stats-base").value, "Bone Wand");
  assert.equal(get("stats-base").dataset.from, "learned");
  assert.ok(get("stats-base").title, "a learned base asks to be confirmed");
  assert.equal(panel.calls.windows.length, 0);

  await fire("start", "click"); // the player confirms it as it is
  await flush(20);
  assert.ok(panel.calls.windows.length > 0, "the query ran");
  assert.equal(record.baseLearned, 2, "the confirmation counts as the second identical choice");

  await fire("summary-back", "click");
  const pending = globalThis.__jevScanOptions.onSearchStats(record);
  await flush(2); // the query's first awaits, then the running screen
  assert.equal(panel.document.body.dataset.view, "running", "two choices: the query starts by itself");
  await pending;
});

/** The first number row of the affix form, with the closest() the fake node lacks so a typed number reaches the form. */
function firstNumberRow(panel) {
  const li = panel.get("affix-list").children[0];
  const [min] = li.children[1].children;
  min.closest = () => li;
  return { li, min };
}

test("a number typed over a read one is remembered for that line and comes back marked as the player's own", async () => {
  const text = "君主盾\n+7% Faster Cast Rate";
  const first = await bootScan();
  await globalThis.__jevScanOptions.onSearchStats(ITEM_RECORD({ text }));
  await first.fire("fuzzy-handoff", "click");
  await flush(60);
  const { min } = firstNumberRow(first);
  assert.equal(min.value, 7);
  assert.equal(min.classList.contains("from-capture"), true, "the reader's own number asks to be checked");

  min.value = "8";
  await first.get("affix-list").dispatch("input", { target: min });
  await first.fire("start", "click");
  await flush(20);
  await first.listeners.pagehide[0]();
  await flush(5);
  const [[key, stored]] = first.store.jevValueCorrections.e;
  assert.deepEqual([key, stored.k, stored.m, stored.c], ["7 faster cast rate", "fcr", 8, 1]);

  const second = await bootScan({ invite: "STORED-ABC", jevValueCorrections: first.store.jevValueCorrections });
  await globalThis.__jevScanOptions.onSearchStats(ITEM_RECORD({ text }));
  await second.fire("fuzzy-handoff", "click");
  await flush(60);
  const again = firstNumberRow(second).min;
  assert.equal(again.value, 8, "the number the player typed last time");
  assert.equal(again.classList.contains("from-learned"), true);
  assert.equal(again.classList.contains("from-capture"), false, "their own number is not a question");
});

test("a listing that went through remembers the number the player changed from the read one, and one that was refused learns nothing", async () => {
  const posted = await bootListing();
  const number = posted.get("listing-affixes").children[0].children[1];
  number.value = "2";
  await number.dispatch("input");
  posted.get("listing-make-offer").checked = true;
  await posted.fire("listing-make-offer", "change");
  const mana = posted.get("listing-affixes").children[1].children[0].children[0];
  mana.checked = false;
  await mana.dispatch("change");
  await posted.fire("listing-post", "click");
  await flush(40);
  await posted.listeners.pagehide[0]();
  await flush(5);
  const [[key, stored]] = posted.store.jevValueCorrections.e;
  assert.deepEqual([key, stored.k, stored.m], ["1 to all skills", "all_skills", 2]);

  const refused = await bootListing();
  globalThis.__jevListingReply = { outcome: "failed", reason: "no", listingUrl: null, verified: false };
  const again = refused.get("listing-affixes").children[0].children[1];
  again.value = "3";
  await again.dispatch("input");
  refused.get("listing-make-offer").checked = true;
  await refused.fire("listing-make-offer", "change");
  const other = refused.get("listing-affixes").children[1].children[0].children[0];
  other.checked = false;
  await other.dispatch("change");
  await refused.fire("listing-post", "click");
  await flush(40);
  await refused.listeners.pagehide[0]();
  await flush(5);
  assert.equal(refused.store.jevValueCorrections, undefined);
});

test("the listing screen lets the player add an attribute of their own, blocks 上架 until it has a number, and removes it again", async () => {
  const panel = await bootListing();
  const { get, fire } = panel;
  const select = get("listing-affix-select");
  const before = select.children.length;
  assert.ok(before > 2, "the dictionary's attributes are offered, after the blank first option");
  assert.equal(select.children.some((o) => o.value === "all_skills"), false, "one the record already carries is not offered again");

  select.value = "fcr";
  await fire("listing-affix-select", "change");
  const rows = get("listing-affixes").children;
  assert.equal(rows.length, 3);
  assert.equal(select.children.length, before - 1);
  assert.equal(select.children.some((o) => o.value === "fcr"), false);
  const added = rows[2];
  assert.equal(added.children[0].children[0].checked, true, "ticked at once");
  assert.equal(added.children[1].value, "", "no number yet");
  assert.equal(added.children[1].classList.contains("from-capture"), false, "it was not read from a picture");
  assert.ok(get("listing-why").textContent.includes(AFFIXES.find((affix) => affix.key === "fcr").zh), "the blocker names the added attribute");

  const remove = added.children.at(-1);
  await remove.dispatch("click");
  assert.equal(get("listing-affixes").children.length, 2);
  assert.equal(get("listing-affix-select").children.length, before);
});

test("← 掃描清單 on the result screen goes back to the scan screen, and is locked while the query runs", async () => {
  const panel = await bootScan();
  const { get, fire } = panel;

  const pending = globalThis.__jevScanOptions.onSearchName(BASE_RECORD());
  assert.equal(get("summary-back").disabled, true);
  await fire("summary-back", "click");
  assert.equal(panel.document.body.dataset.view, "running", "refused while running");
  await pending;

  assert.equal(get("summary-back").disabled, false);
  await fire("summary-back", "click");
  assert.equal(panel.document.body.dataset.view, "scan");
  assert.equal(get("part-scan").hidden, false);
  assert.equal(get("scan-title").focused, true);
  assert.equal(globalThis.__jevScanStops.length, 0, "going back never stops the capture");
});
