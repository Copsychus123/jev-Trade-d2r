// The item-name combobox (name-suggest.js) driven through a hand-built DOM. The module only ever reaches for
// `document.createElement`, so the small element graph below is all it needs; the suggestion source is the real
// `suggestNames` over an indexed table, so the list these tests see is the list a player sees.
import assert from "node:assert/strict";
import test from "node:test";

import { initNameSuggest } from "../src/name-suggest.js";
import { indexTables } from "../src/traderie/lookup.js";

/** One element: the handful of DOM members the combobox touches, plus `fire` to dispatch a listener. */
function makeElement(tagName = "div") {
  const element = {
    tagName,
    id: "",
    hidden: false,
    textContent: "",
    dataset: {},
    attributes: new Map(),
    children: [],
    classes: new Set(),
    listeners: {},
  };
  element.classList = {
    add: (name) => element.classes.add(name),
    contains: (name) => element.classes.has(name),
  };
  element.append = (...nodes) => element.children.push(...nodes);
  element.replaceChildren = (...nodes) => {
    element.children = [...nodes];
  };
  element.setAttribute = (name, value) => element.attributes.set(name, String(value));
  element.getAttribute = (name) => (element.attributes.has(name) ? element.attributes.get(name) : null);
  element.removeAttribute = (name) => element.attributes.delete(name);
  element.addEventListener = (type, handler) => (element.listeners[type] ??= []).push(handler);
  element.fire = (type, event = {}) => {
    const detail = {
      ...event,
      preventDefault() {
        detail.defaultPrevented = true;
      },
    };
    for (const handler of element.listeners[type] ?? []) handler(detail);
    return detail;
  };
  return element;
}

globalThis.document = { createElement: (tagName) => makeElement(tagName) };

const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: "Ring", slug: "ring", category: "base" },
    { name: "Ripsaw", slug: "ripsaw", category: "uniques" },
    { name: "Ring Mail", slug: "ring-mail", category: "base" },
  ],
  zh: { 哈勒昆之冠: "Harlequin Crest" },
  bases: ["Ring"],
  game_only: [],
});

/** The input and its `<ul id="item-suggest">` sibling, wired by the module under test. `source` is what `getTables()` yields. */
function setup({ source = tables } = {}) {
  const input = makeElement("input");
  const list = makeElement("ul");
  list.id = "item-suggest";
  initNameSuggest({ input, list, getTables: () => source });
  return {
    input,
    list,
    type: (value) => {
      input.value = value;
      input.fire("input");
    },
    press: (key) => input.fire("keydown", { key }),
    selected: () => list.children.map((li) => li.getAttribute("aria-selected")),
    labels: () => list.children.map((li) => li.children[0].textContent),
  };
}

test("the field starts as a collapsed combobox wired to the suggestion list", () => {
  const { input, list } = setup();
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-controls"), "item-suggest");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  assert.equal(list.getAttribute("role"), "listbox");
  assert.equal(list.getAttribute("aria-label"), "名稱建議");
});

test("typing filters the tables and opens one unselected option per suggestion", () => {
  const { input, list, type, labels } = setup();
  type("ri");
  assert.equal(list.hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.deepEqual(labels(), ["Ring", "Ripsaw", "Ring Mail"]);
  assert.deepEqual(
    list.children.map((li) => li.id),
    ["item-suggest-0", "item-suggest-1", "item-suggest-2"],
  );
  assert.deepEqual(
    list.children.map((li) => li.dataset.index),
    ["0", "1", "2"],
  );
  assert.ok(list.children.every((li) => li.getAttribute("role") === "option"));
  assert.deepEqual(
    list.children.map((li) => li.getAttribute("aria-selected")),
    ["false", "false", "false"],
  );
  assert.equal(input.getAttribute("aria-activedescendant"), null);
});

test("a Chinese query suggests the table names with the English name as the hint", () => {
  const { type, list, labels } = setup();
  type("哈");
  assert.deepEqual(labels(), ["哈勒昆之冠"]);
  const hint = list.children[0].children[1];
  assert.equal(hint.textContent, "Harlequin Crest");
  assert.ok(hint.classes.has("suggest-hint"));
});

test("before the tables load, typing closes the list instead of suggesting", () => {
  const { input, list, type } = setup({ source: null });
  type("ri");
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
});

test("a query the tables cannot match closes the open list", () => {
  const { input, list, type } = setup();
  type("ri");
  assert.equal(list.hidden, false);
  type("zz");
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("ArrowDown moves the highlight down one and wraps past the last option", () => {
  const { input, type, press, selected } = setup();
  type("ri");
  const down = press("ArrowDown");
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(selected(), ["true", "false", "false"]);
  assert.equal(input.getAttribute("aria-activedescendant"), "item-suggest-0");
  press("ArrowDown");
  assert.deepEqual(selected(), ["false", "true", "false"]);
  assert.equal(input.getAttribute("aria-activedescendant"), "item-suggest-1");
  press("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), "item-suggest-2");
  press("ArrowDown");
  assert.deepEqual(selected(), ["true", "false", "false"], "wraps back to the first option");
  assert.equal(input.getAttribute("aria-activedescendant"), "item-suggest-0");
});

test("ArrowUp moves up one and wraps from the first option to the last", () => {
  const { input, type, press, selected } = setup();
  type("ri");
  press("ArrowDown");
  const up = press("ArrowUp");
  assert.equal(up.defaultPrevented, true);
  assert.deepEqual(selected(), ["false", "false", "true"]);
  assert.equal(input.getAttribute("aria-activedescendant"), "item-suggest-2");
});

test("Enter picks the highlighted suggestion into the field and closes the list", () => {
  const { input, list, type, press } = setup();
  type("ri");
  press("ArrowDown");
  press("ArrowDown"); // Ripsaw
  const enter = press("Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, "Ripsaw");
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
});

test("Enter with nothing highlighted leaves the field and the open list alone", () => {
  const { input, list, type, press } = setup();
  type("ri");
  const enter = press("Enter");
  assert.equal(enter.defaultPrevented, undefined);
  assert.equal(input.value, "ri");
  assert.equal(list.hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
});

test("Escape closes the list without picking, and the closed list ignores the keys", () => {
  const { input, list, type, press } = setup();
  type("ri");
  press("ArrowDown");
  press("Escape");
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  assert.equal(input.value, "ri", "the typed text is kept");
  press("ArrowDown"); // no items left: nothing to move
  press("Enter");
  assert.equal(input.value, "ri");
  assert.equal(list.hidden, true);
});

test("typing more resets the highlight, so the next Enter cannot pick the stale option", () => {
  const { input, type, press, selected } = setup();
  type("ri");
  press("ArrowDown");
  assert.deepEqual(selected(), ["true", "false", "false"]);
  type("rin");
  assert.deepEqual(selected(), ["false", "false"], "no option stays selected after the list changes");
  const enter = press("Enter");
  assert.equal(enter.defaultPrevented, undefined, "nothing is highlighted to pick");
  assert.equal(input.value, "rin");
});

test("a mousedown on an option picks it and closes the list", () => {
  const { input, list, type } = setup();
  type("ri");
  const event = list.children[1].fire("mousedown");
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, "Ripsaw");
  assert.equal(list.hidden, true);
});

test("blur closes the list a moment later so a mousedown can still land", () => {
  const { input, list, type } = setup();
  type("ri");
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = null;
  globalThis.setTimeout = (fn, ms) => {
    scheduled = { fn, ms };
    return 0;
  };
  try {
    input.fire("blur");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(list.hidden, false, "still open until the delay passes");
  assert.ok(scheduled.ms > 0, "the close is deferred (the module's 100 ms is not a documented rule), not synchronous");
  scheduled.fn();
  assert.equal(list.hidden, true);
});
