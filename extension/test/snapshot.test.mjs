import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// snapshot.js is the page-side script that decides what the model ever sees: it collects the visible safe elements as
// e1..eN, builds the page text, a `marker` and a `page_key`/`guards` identity, and appends the scroll/wait controls.
// Nothing else executes it — tests/test_snapshot_limits.py only regex-checks two numbers in its text — so, exactly
// like page-scripts.test.mjs, we rebuild it with `new Function` and pass a fake DOM as the page's globals. Its own
// off-viewport/zero-size filtering is pure rect arithmetic and is pinned here; real hit-testing lives in
// resolve_target.js / covered_overlay.js, which have their own fake-driven tests.
const SOURCE = readFileSync(new URL("../../src/jev_ultrafast/snapshot.js", import.meta.url), "utf8");

const BUILD = new Function(
  "window",
  "document",
  "location",
  "performance",
  "scrollX",
  "scrollY",
  "innerWidth",
  "innerHeight",
  "NodeFilter",
  "return (" + SOURCE + ");",
);

const WIDTH = 1000;
const HEIGHT = 800;
// The range of a text node measures as this unless the node carries its own `rect`: inside the viewport, non-empty.
const TEXT_RECT = { x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 };

// --------------------------------------------------------------------------------------- a tiny selector engine ---

/**
 * Match one comma-free selector part (`[class*="banner" i]`, `header`, `a[href]`, `[role="button"]`) against a fake
 * element. Only the shapes snapshot.js itself uses: a tag name, presence, `=`/`*=`/`^=`/`$=`, and the ` i` flag.
 */
function matchesSimple(el, part) {
  const tag = part.match(/^[A-Za-z]+/);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const raw of part.matchAll(/\[([^\]]+)\]/g)) {
    const [, attr, op, value = "", ci] = raw[1].match(/^([A-Za-z-]+)(?:([*^$]?=)"(.*)"(\s+i)?)?$/) || [];
    if (!attr) return false;
    const actual = el.getAttribute(attr);
    if (actual === null || actual === undefined) return false;
    if (!op) continue;
    let have = String(actual);
    let want = value;
    if (ci) {
      have = have.toLowerCase();
      want = want.toLowerCase();
    }
    if (op === "=" && have !== want) return false;
    if (op === "*=" && !have.includes(want)) return false;
    if (op === "^=" && !have.startsWith(want)) return false;
    if (op === "$=" && !have.endsWith(want)) return false;
  }
  return true;
}

const matchesSelector = (el, selector) => selector.split(",").some((part) => matchesSimple(el, part.trim()));

// ----------------------------------------------------------------------------------------------- the fake DOM ----

/**
 * A fake element exposing the properties and methods snapshot.js probes. Defaults: a 100x40 <button type=submit>
 * whose centre (60, 30) sits well inside the viewport, enabled, connected, visible and named by its `text`.
 * Only the tags that really carry them get `value`/`checked`/`selectedIndex`/`readOnly`, so `guards` matches a browser.
 */
function el({
  tagName = "BUTTON",
  type = tagName === "BUTTON" ? "submit" : tagName === "INPUT" ? "text" : "",
  id = "",
  className = "",
  role = null,
  text = "",
  innerText = text,
  value = "",
  checked = false,
  selectedIndex = -1,
  disabled = false,
  readOnly = false,
  ariaDisabled = false,
  hiddenAria = false,
  inert = false,
  checkVisible = true,
  connected = true,
  rect = { x: 10, y: 10, width: 100, height: 40 },
  title = null,
  alt = null,
  placeholder = null,
  ariaLabel = null,
  ariaLabelledby = null,
  ariaExpanded = null,
  href = null,
  labels = [],
  parent = null,
  childNodes = text ? [{ nodeType: 3, textContent: text }] : [],
  contentEditable = false,
  options = [],
  selectedOptions = null,
  hasInnerButton = false,
  attrs: extra = {},
} = {}) {
  const attrs = { ...extra };
  const set = (name, v) => {
    if (v !== null && v !== undefined && v !== "") attrs[name] = v;
  };
  set("id", id);
  set("class", className);
  set("role", role);
  set("type", type);
  set("title", title);
  set("alt", alt);
  set("placeholder", placeholder);
  set("aria-label", ariaLabel);
  set("aria-labelledby", ariaLabelledby);
  set("aria-expanded", ariaExpanded);
  set("href", href);
  if (contentEditable) attrs.contenteditable = "true";
  if (hiddenAria) attrs["aria-hidden"] = "true";
  if (ariaDisabled) attrs["aria-disabled"] = "true";
  if (inert) attrs.inert = "";

  const self = {
    tagName,
    type,
    id,
    className,
    labels,
    innerText,
    childNodes,
    isContentEditable: contentEditable,
    isConnected: connected,
    parentElement: parent,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, v) => {
      attrs[name] = String(v);
    },
    matches: (selector) => (selector === ":disabled" ? disabled : matchesSelector(self, selector)),
    closest: (selector) => {
      for (let n = self; n; n = n.parentElement) if (n.matches(selector)) return n;
      return null;
    },
    checkVisibility: () => checkVisible,
    getBoundingClientRect: () => rect,
    querySelector: () => (hasInnerButton ? { matches: () => true } : null),
    contains: (other) => other === self,
  };
  // A real <input> has no `selectedIndex` (only a <select> does), so neither does the fake one.
  if (tagName === "INPUT") Object.assign(self, { value, checked, readOnly, disabled });
  else if (tagName === "SELECT") {
    Object.assign(self, { value, selectedIndex, disabled, options, selectedOptions: selectedOptions ?? options.filter((o) => o.selected) });
  } else if (tagName === "TEXTAREA") Object.assign(self, { value, readOnly, disabled });
  else if (tagName === "BUTTON") Object.assign(self, { value, disabled });
  return self;
}

function makeDocument({ elements, textNodes, pageHeight, title, ids, body }) {
  let selected = null;
  return {
    body: body === undefined ? {} : body,
    documentElement: { scrollHeight: pageHeight },
    title,
    querySelectorAll: (selector) => elements.filter((e) => matchesSelector(e, selector)),
    getElementById: (id) => ids.get(id) || null,
    createTreeWalker: () => {
      let i = -1;
      return { nextNode: () => ((i += 1) < textNodes.length ? textNodes[i] : null) };
    },
    createRange: () => ({
      selectNodeContents(node) {
        selected = node;
      },
      getBoundingClientRect: () => selected.rect || TEXT_RECT,
    }),
  };
}

/** Run snapshot.js once over a fresh fake page. `win` may be shared to reuse the script's `window.__jevFast` cache. */
function snap({
  elements = [],
  textNodes = [],
  scrollX = 0,
  scrollY = 0,
  width = WIDTH,
  height = HEIGHT,
  pageHeight = 2000,
  href = "https://example.com/trade",
  hostname = "example.com",
  pathname = "/trade",
  title = "Jev",
  timeOrigin = 1000,
  ids = new Map(),
  body,
  win = {},
} = {}) {
  const document = makeDocument({ elements, textNodes, pageHeight, title, ids, body });
  const location = { href, hostname, pathname };
  return BUILD(win, document, location, { timeOrigin }, scrollX, scrollY, width, height, { SHOW_TEXT: 4 });
}

const elementActions = (s) => s.actions.filter((a) => /^e\d+$/.test(a.id));
// The `[{id, value, checked, selectedIndex, disabled, readOnly}]` block: the last slot of `page_key`, copied into
// `marker`. Found by shape so tests do not pin its position in either array.
const inputState = (arr) => arr.find((v) => Array.isArray(v) && v.every(Array.isArray));

// ---------------------------------------------------------------------------------------------------- tests -------

test("snapshot: a shared page cache keeps a node's id stable and numbers new nodes next", () => {
  const win = {}; // the same window.__jevFast the extension sees while it polls one page
  const input = el({ tagName: "INPUT", ariaLabel: "Query", value: "x", rect: { x: 200, y: 10, width: 100, height: 40 } });
  // The first poll of the session sees only the input, so the input takes id 1.
  const first = snap({ elements: [input], win });
  assert.deepEqual(Object.keys(first.guards), ["1"], "one element, one guard");
  assert.equal(first.guards["1"][0], 1);

  // A later poll adds a button ahead of the input in document order. Only a SHARED cache can leave the input at
  // id 1 and continue the sequence at 2; a fresh cache would number the button 1 and the input 2 instead.
  const button = el({ text: "Buy" });
  const second = snap({ elements: [button, input], win });
  assert.equal(second.guards["1"][0], 1, "the known element is not renumbered");
  assert.equal(second.guards["1"][1], "textbox", "id 1 still belongs to the input that was seen first");
  assert.equal(second.guards["2"][0], 2, "the new element continues the sequence");
  assert.equal(second.guards["2"][1], "button", "the newcomer is the button");
  assert.deepEqual(second.guards["1"], first.guards["1"], "the input's identity is unchanged across polls");

  // The id lives on the node, not on its slot: reordering the same page does not renumber it.
  const third = snap({ elements: [input, button], win });
  assert.equal(third.guards["1"][1], "textbox");
  assert.equal(third.guards["2"][1], "button");

  // A node that leaves the page and returns keeps the id it was given (ids are never reused).
  input.isConnected = false;
  snap({ elements: [button], win }); // the disconnected input's cache entry is pruned
  input.isConnected = true;
  assert.equal(snap({ elements: [button, input], win }).guards["1"][1], "textbox");
});

test("snapshot: the returned object has exactly these keys", () => {
  const region = el({ tagName: "DIV" });
  const s = snap({ elements: [el({ id: "buy", text: "Buy" })], textNodes: [{ nodeType: 3, textContent: "Hello", parentElement: region }] });
  // Consumers compare two snapshots for equality; they never index the object by slot, so key order is not a contract.
  assert.deepEqual(Object.keys(s).sort(), ["actions", "guards", "h", "marker", "omitted_actions", "page_key", "scroll", "text", "title", "url", "w"]);
  assert.equal(s.url, "https://example.com/trade");
  assert.equal(s.title, "Jev");
  assert.equal(s.w, 1000);
  assert.equal(s.h, 800);
  assert.equal(s.text, "Hello");
  assert.deepEqual(s.scroll, { y: 0, height: 2000 });
  assert.equal(s.omitted_actions, 0);
  assert.ok(Array.isArray(s.actions) && Array.isArray(s.marker));
});

test("snapshot: no body means no snapshot", () => {
  assert.equal(snap({ body: null, elements: [el({ text: "Buy" })] }), null);
});

test("snapshot: a broken accessible name falls back to the element's visible text", () => {
  for (const broken of ["[object Object]", "[OBJECT OBJECT]", "undefined", "null", "NaN", "  null  "]) {
    const s = snap({ elements: [el({ ariaLabel: broken, text: "Sign in" })] });
    assert.equal(elementActions(s)[0].label, "Sign in", `aria-label=${broken} must be ignored`);
  }
  // A real name that merely CONTAINS a broken-looking word must be kept: the rule only rejects a whole-string match.
  for (const real of ["Null pointer exception", "undefined behaviour", "NaN is not a number", "[object Object] mapper", "format: null"]) {
    const s = snap({ elements: [el({ ariaLabel: real, text: "Sign in" })] });
    assert.equal(elementActions(s)[0].label, real, `aria-label=${real} is a real name and must be kept`);
  }
  // A usable aria-label wins, and when nothing at all names the element the role is the last resort.
  assert.equal(elementActions(snap({ elements: [el({ ariaLabel: "Checkout", text: "Buy now" })] }))[0].label, "Checkout");
  assert.equal(elementActions(snap({ elements: [el({ ariaLabel: "undefined", text: "" })] }))[0].label, "button");
  // `title` and `placeholder` sit below the visible text in the fallback chain.
  assert.equal(elementActions(snap({ elements: [el({ ariaLabel: "NaN", text: "", title: "Tooltip" })] }))[0].label, "Tooltip");
});

test("snapshot: aria-labelledby is resolved through document.getElementById", () => {
  const label = el({ tagName: "SPAN", text: "Search" });
  const button = el({ ariaLabelledby: "lbl", text: "" });
  const s = snap({ elements: [button], ids: new Map([["lbl", label]]) });
  assert.equal(elementActions(s)[0].label, "Search");
});

test("snapshot: the 250-action cap keeps e1..e250 in order and counts the rest as omitted", () => {
  const elements = [];
  for (let i = 0; i < 300; i += 1) elements.push(el({ id: `b${i}`, text: `Item ${i}` }));
  const s = snap({ elements });
  assert.equal(s.omitted_actions, 50);
  assert.equal(s.actions.length, 253, "250 element actions + scroll_down + scroll_bottom + wait");
  assert.equal(elementActions(s).length, 250);
  assert.deepEqual(
    s.actions.map((a) => a.id),
    [...Array.from({ length: 250 }, (_, i) => `e${i + 1}`), "scroll_down", "scroll_bottom", "wait"],
  );
  assert.equal(s.actions[0].label, "Item 0", "the first candidates are kept, not the last");
  assert.equal(s.actions[249].label, "Item 249");
});

test("snapshot: the page text is capped at 6000 characters", () => {
  const region = el({ tagName: "DIV" });
  const chunks = ["a".repeat(2500), "b".repeat(2500), "c".repeat(2500)];
  const s = snap({ elements: [], textNodes: chunks.map((text) => ({ nodeType: 3, textContent: text, parentElement: region })) });
  assert.equal(s.text.length, 6000);
  assert.equal(s.text, "a".repeat(2500) + "\n" + "b".repeat(2500) + "\n" + "c".repeat(998));
});

test("snapshot: a short promo banner is dropped, a long one is kept", () => {
  const shortBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "Play now" });
  const shortButton = el({ text: "Play", parent: shortBanner });
  // Exactly one character short of the threshold: the boundary is `< 200`, so a 199-char banner is still an advert.
  const almostBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "z".repeat(199) });
  const almostButton = el({ text: "Almost", parent: almostBanner });
  const longBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "x".repeat(200) });
  const longButton = el({ text: "Read more", parent: longBanner });
  // closest() matches the element itself too: a short element that carries "banner" in its own class/id is dropped.
  const selfBanner = el({ id: "banner-cta", className: "banner-cta", text: "Ad" });
  // The rule is `innerText.length < 200`: the 8- and 199-char adverts (and the self-banner) go, the 200-char copy stays.
  const s = snap({ elements: [shortButton, almostButton, longButton, selfBanner] });
  assert.deepEqual(
    elementActions(s).map((a) => a.label),
    ["Read more"],
  );
});

test("snapshot: the promo rule also keeps banner text out of the page text", () => {
  const shortBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "Play now" });
  const almostBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "z".repeat(199) });
  const longBanner = el({ tagName: "DIV", className: "promo-banner", innerText: "y".repeat(200) });
  const s = snap({
    elements: [],
    textNodes: [
      { nodeType: 3, textContent: "Play now", parentElement: shortBanner },
      { nodeType: 3, textContent: "Ad copy", parentElement: almostBanner },
      { nodeType: 3, textContent: "Real content", parentElement: longBanner },
    ],
  });
  assert.equal(s.text, "Real content");
});

test("snapshot: only visible, on-screen text counts", () => {
  const region = el({ tagName: "DIV" });
  const script = el({ tagName: "SCRIPT" });
  const rect = (over) => ({ ...TEXT_RECT, ...over });
  const s = snap({
    elements: [],
    textNodes: [
      { nodeType: 3, textContent: "Welcome", parentElement: region },
      { nodeType: 3, textContent: "   ", parentElement: region },
      { nodeType: 3, textContent: "hidden template", parentElement: script },
      { nodeType: 3, textContent: "orphan", parentElement: null },
      { nodeType: 3, textContent: "no area", parentElement: region, rect: rect({ width: 0 }) },
      { nodeType: 3, textContent: "above the fold", parentElement: region, rect: rect({ top: -15, bottom: -5, y: -15 }) },
      { nodeType: 3, textContent: "off to the left", parentElement: region, rect: rect({ left: -15, right: -5, x: -15 }) },
      { nodeType: 3, textContent: "below the fold", parentElement: region, rect: rect({ top: 900, bottom: 920, y: 900 }) },
    ],
  });
  assert.equal(s.text, "Welcome");
});

test("snapshot: the scroll controls follow the scroll position and wait is always last", () => {
  const atTop = snap({});
  assert.deepEqual(atTop.actions, [
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "scroll_bottom", kind: "scroll", label: "Scroll to bottom of page", delta: 1200 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ]);

  const midPage = snap({ scrollY: 300 });
  assert.deepEqual(midPage.actions, [
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 },
    { id: "scroll_bottom", kind: "scroll", label: "Scroll to bottom of page", delta: 900 },
    { id: "scroll_top", kind: "scroll", label: "Scroll to top of page", delta: -300 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ]);

  const atBottom = snap({ scrollY: 1200 });
  assert.deepEqual(atBottom.actions, [
    { id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 },
    { id: "scroll_top", kind: "scroll", label: "Scroll to top of page", delta: -1200 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ]);
  assert.deepEqual(atBottom.scroll, { y: 1200, height: 2000 });

  // A fractional scroll offset is rounded up: both the bottom delta and the top delta stay integers.
  const fractional = snap({ scrollY: 300.5 });
  assert.deepEqual(
    fractional.actions.map(({ id, delta }) => [id, delta]),
    [
      ["scroll_down", 560],
      ["scroll_up", -560],
      ["scroll_bottom", 900], // ceil(2000 - 300.5 - 800)
      ["scroll_top", -301], // ceil(300.5)
      ["wait", undefined],
    ],
  );
});

test("snapshot: an identical observation produces an identical marker, page_key and guards", () => {
  const button = el({ id: "buy", text: "Buy" });
  const input = el({ tagName: "INPUT", id: "q", ariaLabel: "Query", value: "alfa", rect: { x: 200, y: 10, width: 100, height: 40 } });
  const page = { elements: [button, input] };
  const a = snap(page);
  const same = snap(page);

  assert.deepEqual(a.marker, same.marker);
  assert.deepEqual(a.page_key, same.page_key);
  assert.deepEqual(a.guards, same.guards);

  // Everything below is compared between two polls, so the slot order is not the contract — only the values are.
  assert.deepEqual(inputState(a.page_key), [[2, "alfa", false, undefined, false, false]],
    "the value/checked/disabled/readOnly state of every safe input belongs to the page key");
  assert.ok(a.page_key.includes("https://example.com/trade"));
  assert.ok(a.marker.includes("Jev"), "the marker carries the page title");
  assert.deepEqual(inputState(a.marker), inputState(a.page_key), "the marker carries the page key's input state");
  // The marker carries meaning and identity, not the display ids: they are handed out only after it is built.
  const semantics = a.marker.find((x) => Array.isArray(x) && x.some((y) => y.label === "Buy"));
  assert.deepEqual(semantics, [
    { node: 1, role: "button", label: "Buy", kind: "click", value: "" },
    { node: 2, role: "textbox", label: "Query", kind: "fill", value: "alfa" },
    { node: 2, role: "textbox", label: "Open Query", kind: "click", value: "alfa" },
  ]);
  assert.ok(semantics.every((s) => !("id" in s)), "no display id leaks into the marker");
  assert.deepEqual(Object.keys(a.guards).sort(), ["1", "2"]);
  assert.ok(a.guards["1"].includes("Buy") && a.guards["2"].includes("Query") && a.guards["2"].includes("alfa"),
    "each guard carries its node's name and value");
});

test("snapshot: text, url, scroll and input value all move the marker", () => {
  const button = el({ id: "buy", text: "Buy" });
  const input = el({ tagName: "INPUT", id: "q", ariaLabel: "Query", value: "alfa", rect: { x: 200, y: 10, width: 100, height: 40 } });
  const region = el({ tagName: "DIV" });
  const base = { elements: [button, input], textNodes: [{ nodeType: 3, textContent: "Hello", parentElement: region }] };
  const a = snap(base);

  const newText = snap({ ...base, textNodes: [{ nodeType: 3, textContent: "Goodbye", parentElement: region }] });
  assert.notDeepEqual(newText.marker, a.marker);

  const renamed = snap({ ...base, elements: [el({ id: "buy", text: "Sell" }), input] });
  assert.notDeepEqual(renamed.marker, a.marker);
  assert.notDeepEqual(renamed.guards, a.guards, "the guard carries the accessible name");

  const moved = snap({ ...base, href: "https://example.com/other" });
  assert.notDeepEqual(moved.marker, a.marker);

  const scrolled = snap({ ...base, scrollY: 300 });
  assert.notDeepEqual(scrolled.marker, a.marker);
  assert.notDeepEqual(scrolled.page_key, a.page_key, "scrollY is part of the page key");

  input.value = "bravo";
  const retyped = snap(base);
  assert.notDeepEqual(retyped.marker, a.marker);
  assert.notDeepEqual(retyped.page_key, a.page_key, "an input value is part of the page key");
});

test("snapshot: like a real DOM, only a <select> carries a selectedIndex", () => {
  assert.equal(el({ tagName: "INPUT" }).selectedIndex, undefined, "HTMLInputElement has no selectedIndex");
  assert.equal(el({ tagName: "SELECT", selectedIndex: 2 }).selectedIndex, 2, "HTMLSelectElement does");

  const s = snap({ elements: [el({ tagName: "INPUT", ariaLabel: "Query", value: "alfa" })] });
  assert.deepEqual(inputState(s.page_key), [[1, "alfa", false, undefined, false, false]],
    "the page key reads the input's absent property as undefined");
  assert.ok(!s.guards["1"].includes(-1), "the guard never sees a phantom -1 for an input");
});

test("snapshot: the guard reacts to a change in any single field it copies", () => {
  // The guard exists so a poll can tell that an element changed: every field it copies must move it on its own.
  const reacts = (make, mutate) => {
    const element = make();
    const before = snap({ elements: [element] });
    assert.ok(before.guards["1"], "the element is guarded to begin with");
    mutate(element);
    const after = snap({ elements: [element] });
    assert.notDeepEqual(after.guards["1"], before.guards["1"]);
  };

  reacts(() => el({ tagName: "INPUT", ariaLabel: "Query", value: "alfa" }), (e) => { e.value = "bravo"; });
  reacts(() => el({ tagName: "INPUT", type: "checkbox", ariaLabel: "Agree" }), (e) => { e.checked = true; });
  reacts(() => el({ text: "Buy", attrs: { "aria-expanded": "false" } }), (e) => { e.setAttribute("aria-expanded", "true"); });
  reacts(() => el({ text: "Buy", attrs: { "aria-checked": "false" } }), (e) => { e.setAttribute("aria-checked", "true"); });
  reacts(() => el({ tagName: "A", href: "/home", text: "Home" }), (e) => { e.setAttribute("href", "/away"); });
  reacts(() => el({ text: "Buy", parent: el({ tagName: "FORM", innerText: "Checkout" }) }), (e) => { e.parentElement.innerText = "Cart"; });
  reacts(
    () => el({ tagName: "SELECT", ariaLabel: "Fruit", selectedIndex: 0, options: [{ value: "b", label: "Beta", selected: false, disabled: false, closest: () => null }], selectedOptions: [] }),
    (e) => { e.selectedIndex = 1; },
  );

  // Conversely, a change to one node must not move another node's guard.
  const button = el({ text: "Buy" });
  const input = el({ tagName: "INPUT", ariaLabel: "Query", value: "alfa", rect: { x: 200, y: 10, width: 100, height: 40 } });
  const before = snap({ elements: [button, input] });
  input.value = "bravo";
  const after = snap({ elements: [button, input] });
  assert.deepEqual(after.guards["1"], before.guards["1"], "a change elsewhere leaves the button's guard alone");
  assert.notDeepEqual(after.guards["2"], before.guards["2"]);
});

test("snapshot: the marker tracks an input the action list never collected", () => {
  const button = el({ text: "Buy" });
  // Below the fold: never an action, but still an input the page key (and so the marker) must watch.
  const below = el({ tagName: "INPUT", value: "alfa", rect: { x: 10, y: 900, width: 100, height: 40 } });
  const page = { elements: [button, below] };
  const a = snap(page);
  assert.deepEqual(
    elementActions(a).map((x) => x.label),
    ["Buy"],
  );
  assert.deepEqual(inputState(a.page_key), [[2, "alfa", false, undefined, false, false]]);

  below.value = "bravo";
  const b = snap(page);
  assert.notDeepEqual(b.marker, a.marker, "the value of an uncollected input still moves the marker");
  assert.deepEqual(inputState(b.marker), [[2, "bravo", false, undefined, false, false]]);
});

test("snapshot: hidden, disabled and off-viewport candidates are not collected", () => {
  const candidates = [
    el({ id: "ok", text: "OK" }),
    // A centre exactly on the top/left edge is still inside; the far edges (== innerWidth/innerHeight) are not.
    el({ id: "origin", text: "Origin", rect: { x: -50, y: -50, width: 100, height: 100 } }),
    el({ id: "disabled", text: "Disabled", disabled: true }),
    el({ id: "aria", text: "Aria", ariaDisabled: true }),
    el({ id: "hidden", text: "Hidden", hiddenAria: true }),
    el({ id: "inert", text: "Inert", inert: true }),
    el({ id: "css", text: "CSS", checkVisible: false }),
    el({ id: "password", tagName: "INPUT", type: "password", value: "secret" }),
    el({ id: "hidden-input", tagName: "INPUT", type: "hidden", value: "token" }),
    el({ id: "zero", text: "Zero", rect: { x: 10, y: 10, width: 0, height: 40 } }),
    el({ id: "left", text: "Left", rect: { x: -30, y: 10, width: 20, height: 20 } }), // centre x = -20 < 0
    el({ id: "right", text: "Right", rect: { x: 950, y: 10, width: 100, height: 40 } }), // centre x = 1000 == innerWidth
    el({ id: "below", text: "Below", rect: { x: 10, y: 780, width: 100, height: 40 } }), // centre y = 800 == innerHeight
  ];
  const s = snap({ elements: candidates });
  assert.deepEqual(
    elementActions(s).map((a) => a.label),
    ["OK", "Origin"],
  );
  assert.deepEqual(inputState(s.page_key), [], "a password or hidden input is not even part of the page key");
});

test("snapshot: a switch's aria state and a checkbox's checked state are copied into the action", () => {
  const toggle = el({ role: "switch", text: "Auto", attrs: { "aria-checked": "true", "aria-selected": "true", "aria-expanded": "false" } });
  const checkbox = el({ tagName: "INPUT", type: "checkbox", ariaLabel: "Agree", checked: true, rect: { x: 300, y: 10, width: 100, height: 40 } });
  const s = snap({ elements: [toggle, checkbox] });
  assert.deepEqual(s.actions.slice(0, 2), [
    { node: 1, role: "switch", label: "Auto", rect: { x: 10, y: 10, w: 100, h: 40 }, checked: "true", selected: "true", expanded: "false", kind: "click", value: "", id: "e1" },
    { node: 2, role: "checkbox", label: "Agree", rect: { x: 300, y: 10, w: 100, h: 40 }, checked: "true", kind: "click", value: "", id: "e2" },
  ]);
});

test("snapshot: the role comes from the tag, and an explicit role wins", () => {
  const elements = [
    el({ tagName: "SUMMARY", text: "Details" }),
    el({ tagName: "A", href: "/home", text: "Home" }),
    el({ tagName: "DIV", role: "link", text: "Fake link" }),
    el({ tagName: "SELECT", ariaLabel: "Fruit", value: "a", options: [{ value: "b", label: "Beta", selected: false, disabled: false, closest: () => null }], selectedOptions: [] }),
    el({ tagName: "TEXTAREA", ariaLabel: "Notes", value: "hi" }),
    el({ tagName: "INPUT", type: "number", ariaLabel: "Qty", value: "3" }),
    el({ tagName: "INPUT", type: "search", ariaLabel: "Find", value: "" }),
    el({ tagName: "INPUT", type: "checkbox", ariaLabel: "Agree", checked: false }),
    el({ tagName: "DIV", contentEditable: true, text: "Draft" }),
  ];
  const s = snap({ elements });
  const firstByNode = new Map();
  const counts = new Map();
  for (const a of elementActions(s)) {
    if (!firstByNode.has(a.node)) firstByNode.set(a.node, a.role);
    counts.set(a.node, (counts.get(a.node) || 0) + 1);
  }
  assert.deepEqual([...firstByNode.values()], ["button", "link", "link", "combobox", "textbox", "spinbutton", "searchbox", "checkbox", "textbox"]);
  // A textbox/searchbox/spinbutton/contenteditable also gets the "Open <label>" click; a plain click target does not.
  assert.deepEqual([...counts.values()], [1, 1, 1, 1, 2, 2, 2, 1, 2]);
  // The guard of the anchor carries its href: node 1 is the summary, node 2 the anchor, node 3 the role=link div.
  // A different href on the same anchor must therefore move that guard.
  const moved = snap({ elements: [elements[0], el({ tagName: "A", href: "/away", text: "Home" }), ...elements.slice(2)] });
  assert.notDeepEqual(moved.guards["2"], s.guards["2"], "the guard carries the anchor's href");
  assert.deepEqual(moved.guards["1"], s.guards["1"], "the summary's guard is unaffected");
});

test("snapshot: a gridcell that already holds a button is not itself an action", () => {
  const withButton = el({ tagName: "DIV", role: "gridcell", ariaLabel: "Cell A", hasInnerButton: true });
  const empty = el({ tagName: "DIV", role: "gridcell", ariaLabel: "Cell B" });
  const s = snap({ elements: [withButton, empty] });
  assert.deepEqual(
    elementActions(s).map((a) => a.label),
    ["Cell B"],
  );
});

test("snapshot: an editable field emits a fill action and an Open click", () => {
  const input = el({ tagName: "INPUT", id: "q", ariaLabel: "Query", value: "alfa", rect: { x: 200, y: 10, width: 100, height: 40 } });
  const s = snap({ elements: [input] });
  assert.deepEqual(s.actions.slice(0, 2), [
    { node: 1, role: "textbox", label: "Query", rect: { x: 200, y: 10, w: 100, h: 40 }, kind: "fill", value: "alfa", id: "e1" },
    { node: 1, role: "textbox", label: "Open Query", rect: { x: 200, y: 10, w: 100, h: 40 }, kind: "click", value: "alfa", id: "e2" },
  ]);
});

test("snapshot: a select emits one action per enabled, unselected option", () => {
  const option = (value, label, selected, disabled, inDisabledGroup = false) => ({ value, label, selected, disabled, closest: () => (inDisabledGroup ? { tagName: "OPTGROUP" } : null) });
  const options = [
    option("a", "Alpha", true, false),
    option("b", "Beta", false, false),
    option("c", "Gamma", false, true), // disabled itself
    option("d", "Delta", false, false, true), // enabled but inside a disabled optgroup
  ];
  const select = el({ tagName: "SELECT", id: "fruit", ariaLabel: "Fruit", options, selectedOptions: [options[0]], rect: { x: 300, y: 10, width: 100, height: 40 } });
  const s = snap({ elements: [select] });
  assert.deepEqual(s.actions, [
    { node: 1, role: "combobox", label: "Fruit → Beta", rect: { x: 300, y: 10, w: 100, h: 40 }, kind: "select", value: "b", current_value: "Alpha", id: "e1" },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "scroll_bottom", kind: "scroll", label: "Scroll to bottom of page", delta: 1200 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ]);
});

test("snapshot: the Traderie chrome keeps the search box and the Recent Trades tab, drops the rest", () => {
  const nav = el({ tagName: "NAV" });
  const settings = el({ text: "Settings", parent: nav });
  const recent = el({ text: "Recent Trades", parent: nav });
  const search = el({ tagName: "INPUT", type: "search", placeholder: "Find", parent: nav, rect: { x: 400, y: 10, width: 100, height: 40 } });

  const elsewhere = snap({ elements: [settings] });
  assert.deepEqual(
    elementActions(elsewhere).map((a) => a.label),
    ["Settings"],
    "off Traderie the chrome branch keeps everything",
  );

  const traderie = snap({ elements: [settings, recent, search], href: "https://traderie.com/diablo2resurrected", hostname: "traderie.com", pathname: "/diablo2resurrected" });
  assert.deepEqual(
    elementActions(traderie).map((a) => [a.kind, a.label]),
    [
      ["click", "Recent Trades"],
      ["fill", "Find"],
      ["click", "Open Find"],
    ],
  );
});
