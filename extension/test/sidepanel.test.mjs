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
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const csvUrl = pathToFileURL(fileURLToPath(new URL("../../src/jev_ultrafast/static/csv.js", import.meta.url))).href;
const configUrl = `data:text/javascript,${encodeURIComponent('export const API_BASE = "https://api.test";')}`;
const loader = `export async function resolve(specifier, context, next) {
  if (specifier.endsWith("csv.js")) return { url: ${JSON.stringify(csvUrl)}, shortCircuit: true };
  if (specifier === "./config.js" && context.parentURL?.includes("/sidepanel.js")) {
    return { url: ${JSON.stringify(configUrl)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(new URL("data:text/javascript;base64," + Buffer.from(loader).toString("base64")));

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
    this.className = "";
    this.hidden = hidden;
    this.disabled = disabled;
    this.value = "";
    this.checked = false;
    this.tabIndex = 0;
    this._text = "";
    this._handlers = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
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
    { name: "Monarch", slug: "monarch" },
    { name: "The Stone of Jordan", slug: "the-stone-of-jordan" },
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

async function boot({ storage = {}, fetchImpl = defaultFetch(), windowsCreate } = {}) {
  const document = makeDocument();
  const store = { ...storage };
  const session = {};
  const calls = { fetch: [], local: [], tabs: [], windows: [] };
  const listeners = {};

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
    windows: {
      create: async (options) => {
        calls.windows.push(options);
        if (windowsCreate) return windowsCreate(options);
        throw new Error("無法開啟查詢視窗");
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
  };
}

test.after(() => {
  globalThis.fetch = realFetch;
});

const strings = (nodes) => nodes.map((node) => node.textContent);
const values = (nodes) => nodes.map((node) => node.value);

// --- the fake's own footing ------------------------------------------------------------------------------------

test("the fake DOM starts from the shipped markup: shipped-hidden nodes stay hidden and unknown ids are missing", async () => {
  const panel = await boot();

  // Every one of these ships hidden in sidepanel.html and this boot never writes it, so it is still hidden: the seed
  // is what makes the `hidden === false` assertions elsewhere mean the module wrote something.
  for (const id of ["banner-hint", "ocr-panel", "ocr-preview", "ocr-file", "ocr-dropzone", "ocr-hint", "scan-stop", "scan-download"]) {
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

test("the panel boots into the invite screen and pins the untouched result lists", async () => {
  const panel = await boot();
  const { get } = panel;

  assert.equal(panel.document.body.dataset.view, "welcome");
  assert.equal(get("part-welcome").hidden, false);
  for (const id of ["part-choose", "part-form", "part-run", "part-results", "part-scan", "part-settings"]) {
    assert.equal(get(id).hidden, true, id);
  }

  // The market has not been read: every cell of the results header says so, and nothing draws rows.
  assert.equal(get("trading-tab").dataset.status, "NOT_RUN");
  assert.equal(get("trading-count").textContent, "");
  assert.equal(get("trading-mark").textContent, "未讀取");
  assert.equal(get("trading-meta").textContent, "尚未讀取。");
  assert.equal(get("trading-meta").hidden, false);
  assert.equal(get("trading-clear").hidden, true);
  assert.equal(get("trading-pager").hidden, true);
  assert.equal(get("trading-page").textContent, "第 1 / 1 頁");
  assert.equal(get("trading-prev").disabled, true);
  assert.equal(get("trading-next").disabled, true);
  assert.equal(get("trading-list").hidden, true);
  assert.equal(get("trading-list").children.length, 0);
  // Same for the other list.
  assert.equal(get("recent-trades-count").textContent, "");
  assert.equal(get("recent-trades-meta").textContent, "尚未讀取。");
  assert.equal(get("trading-label").textContent, "目前掛單");

  // No rows and no address: the three buttons under the tabs are all refused.
  assert.equal(get("result-csv").disabled, true);
  assert.equal(get("result-copy").disabled, true);
  assert.equal(get("result-open").disabled, true);

  // The name search's steps are all pending and the status line is empty.
  assert.deepEqual(
    get("steps").children.map((step) => step.dataset.state),
    ["pending", "pending", "pending", "pending"],
  );
  assert.equal(
    strings(get("steps").children).join("|"),
    "○找到商品（還沒開始）|○讀取目前掛單（還沒開始）|○讀取近期成交（還沒開始）|○核對資料（還沒開始）",
  );
  assert.equal(get("progress-status").textContent, "");

  // Nothing to trust yet, nothing to note, nothing said about the quota.
  assert.equal(get("trust").dataset.kind, "none");
  assert.equal(get("trust-line").hidden, true);
  assert.equal(get("trust-head").textContent, "");
  assert.equal(get("part-notes").textContent, "");
  assert.equal(get("part-notes").hidden, true);
  assert.equal(get("quota").textContent, "");
  assert.equal(get("invite-masked").textContent, "（還沒有邀請碼）");
  assert.equal(get("invite-note").hidden, true);
  assert.equal(get("invite-quota").textContent, "");
  assert.equal(get("invite-quota").hidden, true);

  // The form before a search kind is chosen.
  assert.equal(panel.document.body.dataset.mode, "");
  assert.equal(get("mode-title").textContent, "");
  assert.equal(get("mode-help").textContent, "");
  assert.equal(get("item-label").textContent, "裝備名稱");
  assert.equal(get("item-label").htmlFor, "item");
  assert.equal(get("item-help").textContent, "中文或英文都可以，也可貼上截圖");
  assert.equal(get("item").hidden, false);
  assert.equal(get("stats-base").hidden, true);
  assert.equal(get("part-stats").hidden, true);
  assert.equal(get("more-box").hidden, false);
  assert.equal(get("more-value").textContent, "0");
  assert.equal(get("more-minus").disabled, true);
  assert.equal(get("more-plus").disabled, false);
  assert.equal(get("start").hidden, false);
  assert.equal(get("stop").hidden, true);

  // The results summary names the name search's list.
  assert.equal(get("results-caption").hidden, true);
  assert.equal(get("summary-text").textContent, "查詢：");
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

  assert.equal(panel.document.body.dataset.view, "choose");
  assert.equal(panel.get("part-choose").hidden, false);
  assert.equal(panel.get("part-welcome").hidden, true);
  // The mask keeps the last four characters of a long code and nothing of a short one.
  assert.equal(panel.get("invite-masked").textContent, "••••••••-ABC");
  assert.equal(panel.get("quota").textContent, "已用 —");
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
  assert.equal(get("invite-note").textContent, "新的邀請碼要等下一次查詢成功，才會儲存。");
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

test("choosing the name search fills the form and the panel's own search kind is written on the body", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire } = panel;

  await fire("choose-name", "click");
  assert.equal(panel.document.body.dataset.mode, "name");
  assert.equal(panel.document.body.dataset.view, "ready");
  assert.equal(get("mode-title").textContent, "精準搜尋");
  assert.equal(get("mode-help").textContent, "輸入裝備名稱就能查（暗金、套裝等固定名稱）");
  assert.equal(get("item-label").textContent, "裝備名稱");
  assert.equal(get("item-label").htmlFor, "item");
  assert.equal(get("item").hidden, false);
  assert.equal(get("stats-base").hidden, true);
  assert.equal(get("part-stats").hidden, true);
  assert.equal(get("more-box").hidden, false);
  assert.equal(get("item-help").textContent, "中文或英文都可以，也可貼上截圖");
  assert.equal(get("item").focused, true);
  assert.equal(get("part-form").hidden, false);
  assert.equal(get("part-run").hidden, false);
  assert.equal(get("part-results").hidden, true);
});

test("switching to the affix search swaps the form and offers the shipped base types", async () => {
  const panel = await boot({ storage: { invite: "STORED" } });
  const { get, fire } = panel;

  await fire("choose-stats", "click");
  assert.equal(panel.document.body.dataset.mode, "stats");
  assert.equal(get("mode-title").textContent, "模糊搜尋");
  assert.equal(get("mode-help").textContent, "用底材、品質和詞綴條件找");
  assert.equal(get("item-label").textContent, "底材名稱");
  assert.equal(get("item-label").htmlFor, "stats-base");
  assert.equal(get("item").hidden, true);
  assert.equal(get("stats-base").hidden, false);
  assert.equal(get("part-stats").hidden, false);
  assert.equal(get("more-box").hidden, true);
  assert.equal(get("item-help").textContent, "可輸入中文或英文裝備");
  assert.equal(get("stats-base").focused, true);
  // The results header describes the results on screen: it still names the name search's lists, because choosing the
  // affix form has not run an affix query yet (only a stats run renames them - see the start test below).
  assert.equal(get("recent-trades-tab").hidden, false);
  assert.equal(get("trading-label").textContent, "目前掛單");

  // The base suggestions come from the shipped table, once, through warmUpAffixForm.
  await flush();
  assert.deepEqual(values(get("stats-base-options").children), ["Monarch", "Bone Wand"]);

  // Back with the one button that switches between the two kinds.
  await fire("mode-change", "click");
  assert.equal(panel.document.body.dataset.mode, "name");
  assert.equal(get("item-label").textContent, "裝備名稱");
});

// --- the property cache (read with a plain storage key) --------------------------------------------------------

test("a fresh stored property list is used as it is, so no Traderie window is opened for it", async () => {
  const properties = [{ id: 3, name: "+{{value}}% 施法速度", type: "number", options: null, label: "+X% 施法速度" }];
  const panel = await boot({ storage: { invite: "STORED", traderieProperties: { fetchedAt: Date.now(), properties } } });

  await panel.fire("choose-stats", "click"); // warmUpAffixForm -> ensureProperties, best effort
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
  assert.equal(strings(get("filter-fields").children.filter((node) => node.tagName === "label")).join("|"), "平台|模式|天梯|遊戲版本");
  const platform = get("filter-platform");
  // The very select the module built is the one it later reads and writes.
  assert.equal(get("filter-fields").children[1], platform);
  assert.equal(strings(platform.children).join("|"), "不限|PC|PlayStation|Xbox|Switch");
  assert.equal(values(platform.children).join("|"), "|PC|Playstation|Xbox|Switch");
  // The label of an option is the one the filters module ships, not the value itself.
  assert.equal(strings(get("filter-game_version").children).join("|"), "不限|Reign of the Warlock（新版）|Lord of Destruction（舊版）|Classic（原版）");
  assert.equal(get("filter-fields").children[0].htmlFor, "filter-platform");
  assert.equal(get("filter-fields").children[0].textContent, "平台");

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

// --- the banner ------------------------------------------------------------------------------------------------

test("a start-up failure is reported in the banner, which hides on the settings screen", async () => {
  const panel = await boot({
    storage: { invite: "STORED" },
    fetchImpl: defaultFetch({ "/traderie/data/items.json": () => { throw new Error("items.json 讀不到"); } }),
  });
  const { get, fire } = panel;

  assert.equal(get("banner").hidden, false);
  assert.equal(get("banner-message").textContent, "截圖辨識無法啟動，其他功能不受影響");
  assert.equal(get("banner-hint").textContent, "items.json 讀不到");
  assert.equal(get("banner-hint").hidden, false);
  assert.equal(get("banner-retry").hidden, false);
  assert.equal(get("banner-retry").textContent, "知道了");
  assert.equal(get("banner-open-site").hidden, true);
  assert.equal(get("banner-settings").hidden, true);

  // The settings screen is never covered by the banner.
  await fire("settings-open", "click");
  assert.equal(panel.document.body.dataset.view, "settings");
  assert.equal(get("part-settings").hidden, false);
  assert.equal(get("banner").hidden, true);

  await fire("settings-back", "click");
  assert.equal(panel.document.body.dataset.view, "choose");
  assert.equal(get("banner").hidden, false);
});

test("without the item table the base form has no suggestions to offer", async () => {
  const panel = await boot({
    storage: { invite: "STORED" },
    fetchImpl: defaultFetch({ "/traderie/data/items.json": () => { throw new Error("items.json 讀不到"); } }),
  });

  await panel.fire("choose-stats", "click");
  await flush();
  // The table download failed, so there is nothing to suggest - and the failure is what the player is told about.
  assert.equal(panel.get("banner").hidden, false);
  assert.equal(panel.get("banner-message").textContent, "截圖辨識無法啟動，其他功能不受影響");
  assert.equal(panel.get("stats-base-options").children.length, 0);
});

// --- queries that fail -----------------------------------------------------------------------------------------

test("a name query whose window cannot be opened ends in the problem view, with the quota the backend counted", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire } = panel;

  await fire("choose-name", "click");
  get("item").value = "Monarch";
  const pending = fire("start", "click");

  // Everything a query locks is locked from the first frame of the running screen.
  assert.equal(panel.document.body.dataset.view, "running");
  assert.equal(get("start").hidden, true);
  assert.equal(get("stop").hidden, false);
  assert.equal(get("summary-text").textContent, "查詢：Monarch");
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

  await pending;

  // The run failed: the panel shows what happened, and the quota the backend accepted is on the line.
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner").hidden, false);
  assert.equal(get("banner-message").textContent, "無法開啟查詢視窗");
  assert.equal(get("banner-retry").hidden, false);
  assert.equal(get("banner-retry").textContent, "重新查詢");
  assert.equal(get("banner-hint").hidden, true);
  assert.equal(get("banner-settings").hidden, true);
  assert.equal(get("quota").textContent, "已用 3/5");
  assert.equal(get("invite-quota").textContent, "已用 3 / 5 次（剩 2 次）");
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
  assert.equal(get("quota").textContent, "剩 2 次");
  assert.equal(get("part-form").hidden, false);
});

test("the affix search renames the results list and drops the recent-trades tab once it runs", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire } = panel;

  await fire("choose-stats", "click");
  // A base is enough to search with, and the start button says so by being usable.
  get("stats-base").value = "Monarch";
  await fire("stats-base", "input");
  assert.equal(get("start").disabled, false);
  assert.equal(get("start-why").hidden, true);

  const pending = fire("start", "click");

  await pending;

  // The affix search has one list: it drops the recent-trades tab and renames the remaining one.
  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner-message").textContent, "無法開啟查詢視窗");
  assert.equal(get("summary-text").textContent, "查詢：Monarch");
  assert.equal(get("recent-trades-tab").hidden, true);
  assert.equal(get("trading-label").textContent, "符合條件的掛單");
  assert.equal(get("results-caption").hidden, true);
  // The affix search never asks the backend for a run, so no quota was counted.
  assert.equal(get("quota").textContent, "已用 —");
  // Its own four steps, and the first one is where the run stopped.
  assert.equal(
    strings(get("steps").children).join("|"),
    "○取得屬性清單（還沒開始）|○套用條件（還沒開始）|○讀取掛單（還沒開始）|○核對資料（還沒開始）",
  );
});

test("closing the panel while a query runs ends it as the player's stop, not as a problem", async () => {
  const panel = await boot({ storage: { invite: "STORED-ABC" } });
  const { get, fire } = panel;

  await fire("choose-name", "click");
  get("item").value = "Monarch";
  const pending = fire("start", "click");

  // The panel is going away: wireClose asks the run to stop before the window is even open.
  for (const handler of panel.listeners.pagehide) handler({ type: "pagehide" });
  await pending;

  assert.equal(panel.document.body.dataset.view, "stopped");
  assert.equal(get("part-stopped").hidden, false);
  assert.equal(get("banner").hidden, true);
  assert.equal(get("quota").textContent, "已用 3/5");
  // A stop is no failure, so the "start over" button is offered.
  assert.equal(get("part-requery").hidden, false);
});

test("a refused invite is dropped, never stored, and the banner explains it on the invite screen", async () => {
  const rejected = () => ({ ok: false, status: 401, json: async () => ({ error: "邀請碼無效" }) });
  const panel = await boot({ fetchImpl: defaultFetch({ "/api/run/start": rejected }) });
  const { get, fire } = panel;

  get("welcome-invite").value = "TYPED-CODE";
  await fire("part-welcome", "submit");
  await fire("choose-name", "click");
  get("item").value = "Monarch";
  await fire("start", "click");

  // Without a code left the panel is back on the invite screen, and the banner is the only thing explaining why.
  assert.equal(panel.document.body.dataset.view, "welcome");
  assert.equal(get("part-welcome").hidden, false);
  assert.equal(get("banner").hidden, false);
  assert.equal(get("banner-message").textContent, "邀請碼無效");
  assert.equal(get("banner-retry").hidden, true);
  assert.equal(get("banner-settings").hidden, true);
  assert.equal(get("invite-masked").textContent, "（還沒有邀請碼）");
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
  const rejected = () => ({ ok: false, status: 401, json: async () => ({ error: "邀請碼過期" }) });
  const panel = await boot({ storage: { invite: "STORED" }, fetchImpl: defaultFetch({ "/api/run/start": rejected }) });
  const { get, fire } = panel;

  await fire("choose-name", "click");
  get("item").value = "Monarch";
  await fire("start", "click");

  assert.equal(panel.document.body.dataset.view, "problem");
  assert.equal(get("banner-message").textContent, "邀請碼過期");
  assert.equal(get("banner-settings").hidden, false);
  assert.equal(get("banner-retry").hidden, true);
  // No retry of its own: the "start over" button is the way back.
  assert.equal(get("part-requery").hidden, false);
  assert.equal(get("quota").textContent, "已用 —");
  // A stored code is never dropped by a refusal.
  assert.equal(panel.store.invite, "STORED");
  assert.deepEqual(panel.calls.local, []);

  await fire("banner-settings", "click");
  assert.equal(panel.document.body.dataset.view, "settings");
  assert.equal(get("part-settings").hidden, false);
});

// --- not covered -----------------------------------------------------------------------------------------------

test("the row drawing stays out of reach, as the design says", async () => {
  // The panel's only way to rows is cdp.js Tab over chrome.debugger, so the table jump is stopped at the window and
  // the two-line row drawing is never reached. Recorded here so the gap is deliberate, not forgotten.
  const panel = await boot({ storage: { invite: "STORED" } });
  await panel.fire("choose-name", "click");
  panel.get("item").value = "Monarch";
  await panel.fire("start", "click");

  assert.equal(panel.get("trading-list").children.length, 0);
  assert.equal(panel.get("trading-count").textContent, "");
  assert.deepEqual(panel.calls.windows, [
    { url: "https://www.traderie.com/diablo2resurrected/product/monarch", state: "minimized" },
  ]);
});
