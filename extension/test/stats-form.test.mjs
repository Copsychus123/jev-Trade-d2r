// stats-form.js is the DOM binder of the affix form: stats-form-state.js owns the rules, but nothing tested the half
// that draws them - the quality radios, the row a condition becomes, the capture mark on a value that came from a
// read, the add menu, the limit boxes and the base field, or the fact that the form's own change notification reaches
// the caller. This file drives the REAL initStatsForm against a fake DOM seeded from the shipped sidepanel.html, with
// a getProperties that answers with Traderie's own property list (the saved fixture every other stats test uses, so
// the shapes are the product's, not invented ones).
//
// NOT covered here, honestly: nothing. The module has no timers, no sockets and no chrome.*, so the whole reachable
// surface - the first render, every wiring branch, and the nine returned helpers - is driven below.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AFFIXES } from "../src/ocr/affix_dictionary.js";
import { initStatsForm } from "../src/stats-form.js";
import { EMPTY_LIST, FIX_LIMITS, NEED_SOMETHING, NEED_VALUES } from "../src/stats-form-state.js";
import { normalizeProperties } from "../src/traderie/properties.js";
import { QUALITIES } from "../src/traderie/stats.js";

// --- the product's own answers ----------------------------------------------------------------------------------
// The 742 entries Traderie answered with (saved by scripts/probe_stats.py), reduced the way the panel reduces them.
const PROPERTIES = normalizeProperties(
  JSON.parse(readFileSync(new URL("./fixtures/properties.json", import.meta.url), "utf8")),
);
// The item types sidepanel.js turns into the datalist: the shipped lookup table's own list.
const BASES = JSON.parse(readFileSync(new URL("../src/traderie/data/items.json", import.meta.url), "utf8")).bases;
const FROM_CAPTURE_TITLE = "從擷取讀到，請確認";

// --- the shipped markup -----------------------------------------------------------------------------------------

/**
 * A tag's attributes as name -> value: `name="value"` keeps the value, a bare flag (`hidden`, `disabled`, `checked`)
 * becomes "", and the trailing `/` of a self-closing tag is skipped. One scan over the whole tag, so a word inside a
 * quoted value can never pass for an attribute of its own.
 */
function readAttributes(text) {
  const values = {};
  for (const [, name, value] of text.matchAll(/([\w-]+)(?:="([^"]*)")?|"[^"]*"/g)) {
    if (name) values[name] = value ?? "";
  }
  return values;
}

/** Every id sidepanel.html carries, with the attributes it ships (so `list` is a real attribute and `hidden` a real flag). */
const MARKUP = (() => {
  const html = readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8");
  const found = new Map();
  for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id || found.has(id)) continue;
    found.set(id, { tag, attrs: readAttributes(attrs) });
  }
  return found;
})();

// --- a DOM just big enough for stats-form.js --------------------------------------------------------------------

class FakeNode {
  constructor(tag, register, { hidden = false, disabled = false } = {}) {
    this.tagName = tag;
    this._register = register;
    this._id = "";
    this._parent = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.hidden = hidden;
    this.disabled = disabled;
    this.value = "";
    this.checked = false;
    this._text = "";
    this._handlers = {};
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value);
    this._register?.(this._id, this);
  }

  // classList is derived from className, like the browser's, so `element("input", { className: "affix-min from-capture" })`
  // is found by classList.contains and a toggle shows up in className.
  get className() {
    return [...this.classes].join(" ");
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : force;
        if (want) classes.add(name);
        else classes.delete(name);
        return want;
      },
      contains: (name) => classes.has(name),
    };
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      node._parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** The browser's closest: the node itself first, then its ancestors, by tag or by .class. */
  closest(selector) {
    for (let node = this; node; node = node._parent) {
      if (selector.startsWith(".")) {
        if (node.classList.contains(selector.slice(1))) return node;
      } else if (node.tagName === selector) {
        return node;
      }
    }
    return null;
  }

  addEventListener(type, handler) {
    (this._handlers[type] ??= []).push(handler);
  }

  removeEventListener() {}

  focus() {}

  click() {
    return this.dispatch("click");
  }

  /** Runs `type`'s handlers with `event`, awaiting anything they return (affix-fill's handler returns fillFromText). */
  dispatch(type, event = {}) {
    event.type ??= type;
    event.target ??= this;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    return Promise.all((this._handlers[type] ?? []).map((handler) => handler(event)));
  }
}

// The content attributes a browser reflects from these properties. Without the mirror `input.min = "0"` (which is how
// the module sets the bound) would leave getAttribute("min") null and the assertion about the shipped bound would be
// meaningless; `type` and `placeholder` are the same story.
for (const name of ["type", "min", "max", "step", "placeholder", "name", "title"]) {
  Object.defineProperty(FakeNode.prototype, name, {
    configurable: true,
    get() {
      return this.attributes.get(name) ?? null;
    },
    set(value) {
      this.attributes.set(name, String(value));
    },
  });
}

/** The only `new Option(...)` the module builds its menus with. */
class FakeOption {
  constructor(text, value) {
    this.tagName = "option";
    this.textContent = String(text);
    this.value = String(value);
    this.children = [];
    this._parent = null;
  }
}

function makeDocument() {
  const nodes = new Map();
  const register = (id, node) => nodes.set(id, node);
  const body = new FakeNode("body", register);
  for (const [id, { tag, attrs }] of MARKUP) {
    const node = new FakeNode(tag, register, { hidden: "hidden" in attrs, disabled: "disabled" in attrs });
    node.id = id;
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "class") node.className = value;
      else if (name !== "hidden" && name !== "disabled") node.setAttribute(name, value);
    }
    body.append(node);
  }
  const walk = (node) => [node, ...(node.children ?? []).flatMap(walk)];
  /** Only `input[name="quality"]` is asked for; the tag[attr="value"] selector is all this fake has to understand. */
  const matches = (node, selector) => {
    const found = /^([a-zA-Z][\w-]*)\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (!found) return false;
    const [, tag, attr, value] = found;
    if (node.tagName !== tag) return false;
    const actual = attr in node ? node[attr] : node.getAttribute(attr);
    return String(actual) === value;
  };
  return {
    body,
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => new FakeNode(tag, register),
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelectorAll: (selector) => walk(body).filter((node) => matches(node, selector)),
    addEventListener: () => {},
  };
}

/** A fresh DOM with the shipped markup, the shipped item types already in the datalist, and one binder over it. */
function boot({ properties = PROPERTIES } = {}) {
  const document = makeDocument();
  globalThis.document = document;
  globalThis.Option = FakeOption;

  const datalist = document.getElementById("stats-base-options");
  for (const name of BASES.slice(0, 2)) {
    const option = document.createElement("option");
    option.setAttribute("value", name);
    datalist.append(option);
  }

  const calls = [];
  const form = initStatsForm({ getProperties: async () => properties, onChange: (...args) => calls.push(args) });
  return {
    document,
    form,
    calls,
    get: (id) => document.getElementById(id),
    radios: () => [...document.querySelectorAll('input[name="quality"]')],
    rows: () => document.getElementById("affix-list").children,
    row: (key) => document.getElementById("affix-list").children.find((li) => li.dataset.key === key),
  };
}

// --- the fake's own footing -------------------------------------------------------------------------------------

test("the fake starts from the shipped markup and the shipped item types", () => {
  // Bare flags are markup too, and the shipped page carries two that matter here: `stats-base` is `hidden` and
  // `affix-fill` is `disabled`, neither with a value. Both are the panel's own render's to change later (sidepanel.js
  // shows the base field in stats mode; stats-form.js enables the fill button once a picture is read), so the fake has
  // to start with them on, exactly as the browser's parser would leave them.
  const raw = makeDocument();
  assert.equal(raw.getElementById("stats-base").hidden, true, "stats-base ships hidden");
  assert.equal(raw.getElementById("affix-fill").disabled, true, "affix-fill ships disabled");

  const panel = boot();

  // The binder runs over that same markup: it leaves the base field's visibility to the panel, and it owns the fill
  // button, which the shipped `disabled` only starts off.
  assert.equal(panel.get("stats-base").hidden, true, "the first render does not touch the shipped hidden");
  assert.equal(panel.get("affix-fill").disabled, true, "nothing was read yet");
  panel.form.rememberScreenshot("+7% Faster Cast Rate");
  assert.equal(panel.get("affix-fill").disabled, false, "the render is what turns the shipped-disabled button on");
  panel.form.forgetScreenshot();
  assert.equal(panel.get("affix-fill").disabled, true, "and back off when the picture goes");

  // The datalist holds real base names before the binder runs, so "the binder leaves them" means something.
  assert.deepEqual(
    panel.get("stats-base-options").children.map((o) => o.getAttribute("value")),
    BASES.slice(0, 2),
  );
  assert.equal(panel.get("stats-base").getAttribute("list"), "stats-base-options");
  assert.equal(panel.get("affix-list").tagName, "ul");
  assert.equal(panel.get("quality-group").tagName, "fieldset");
  // An id the markup does not carry is missing, never invented: the module creates no node with an id of its own.
  assert.equal(panel.get("affix-listt"), null);
});

// --- the first render -------------------------------------------------------------------------------------------

test("the first render draws the quality radios, the empty list and the add menu, and tells the caller nothing changed", () => {
  const panel = boot();
  const { get } = panel;

  // The first render is not a change: the caller would otherwise see one before the player touched anything.
  assert.deepEqual(panel.calls, []);

  assert.equal(panel.rows().length, 0);
  assert.equal(get("affix-empty").hidden, false);
  assert.equal(get("affix-empty").textContent, EMPTY_LIST);
  assert.equal(get("affix-fill").disabled, true, "nothing was read yet");
  assert.equal(get("stats-base").disabled, false);

  // One radio per QUALITIES row, same value and same label, "any" chosen: the two lists cannot drift apart.
  assert.deepEqual(
    get("quality-group").children.map((label) => [label.children[0].value, label.children[0].checked, label.children[1].textContent]),
    QUALITIES.map((q) => [q.key, q.key === "any", q.label]),
  );

  // The add menu: the placeholder, then every affix the reader knows, in the player's own words.
  const options = get("affix-select").children;
  assert.deepEqual([options[0].textContent, options[0].value], ["新增條件…", ""]);
  assert.deepEqual(options.slice(1).map((o) => o.textContent), AFFIXES.map((a) => a.zh));
  assert.deepEqual(options.slice(1).map((o) => o.value), AFFIXES.map((a) => a.key));
});

// --- a row built from a hand-picked affix -----------------------------------------------------------------------

test("picking an affix from the menu adds one ticked-off row with the player-facing name, its limits and a remove button", async () => {
  const panel = boot();
  const select = panel.get("affix-select");
  select.value = "fcr";
  await select.dispatch("change");

  const row = panel.row("fcr");
  assert.equal(row.dataset.key, "fcr");
  assert.equal(row.classList.contains("unmapped"), false);
  assert.equal(row.children.length, 3, "a name, its limits and a remove button");

  const [name, limits, remove] = row.children;
  const [checkbox, span] = name.children;
  assert.equal(checkbox.type, "checkbox");
  assert.equal(checkbox.checked, false, "a row the player picked starts switched off");
  assert.equal(span.textContent, "施法速度", "the name is the entry's zh, the words the player sees");

  // A number affix has its two boxes; the bool case is the next test.
  assert.equal(limits.className, "affix-limits");
  assert.deepEqual(limits.children.map((input) => input.getAttribute("aria-label")), ["施法速度最小值", "施法速度最大值"]);
  assert.equal(remove.getAttribute("aria-label"), "移除施法速度");

  // onChange fired once, with no arguments, and the whole form is readable through get() in the shape the caller expects.
  assert.deepEqual(panel.calls, [[]]);
  assert.deepEqual(panel.form.get(), {
    conditions: [{ key: "fcr", label: "施法速度", kind: "percent", line: "", min: null, max: null, on: false }],
    quality: "any",
    base: "",
    unavailable: [],
  });
  assert.equal(panel.form.startBlocker(), NEED_SOMETHING, "nothing ticked, no base: the base is what is missing");

  // The menu no longer offers what is already in the list, and removing the row puts it back.
  assert.ok(!panel.get("affix-select").children.some((o) => o.value === "fcr"));
  await panel.get("affix-list").dispatch("click", { target: remove });
  assert.equal(panel.rows().length, 0);
  assert.ok(panel.get("affix-select").children.some((o) => o.value === "fcr"));
  assert.equal(panel.calls.length, 2);
});

test("a bool affix gets a row with no limit boxes at all", async () => {
  const panel = boot();
  const select = panel.get("affix-select");
  select.value = "ethereal";
  await select.dispatch("change");

  const row = panel.row("ethereal");
  assert.equal(row.children.length, 2, "a bool has no 最小/最大 boxes");
  assert.equal(row.children[0].children[1].textContent, "無形");
  assert.equal(row.children[0].children[0].type, "checkbox");
  assert.equal(panel.form.get().conditions[0].kind, "bool");
});

// --- the capture mark -------------------------------------------------------------------------------------------

test("a value read from a picture is marked on the box that carries it, and not on the empty one", async () => {
  const panel = boot();
  panel.form.rememberScreenshot("+7% Faster Cast Rate\n+15 to Life");
  assert.equal(panel.get("affix-fill").disabled, false, "a picture was read, so the fill button works");
  await panel.get("affix-fill").dispatch("click");

  const rows = panel.rows().map((li) => li.dataset.key);
  assert.deepEqual(rows, ["fcr", "life"], "one row per affix the reader recognised, in reading order");
  assert.deepEqual(
    panel.form.get().conditions.map((c) => [c.key, c.label, c.on, c.min, c.fromCapture]),
    [
      ["fcr", "施法速度", true, 7, true],
      ["life", "生命", true, 15, true],
    ],
  );

  const minBox = panel.row("fcr").children[1].children[0];
  const maxBox = panel.row("fcr").children[1].children[1];
  assert.equal(minBox.value, 7);
  assert.equal(minBox.classList.contains("from-capture"), true);
  assert.equal(minBox.title, FROM_CAPTURE_TITLE);
  assert.equal(maxBox.value, "");
  assert.equal(maxBox.classList.contains("from-capture"), false, "the empty box came from nothing");
  assert.equal(maxBox.title, null);

  // A new picture retires the old fill: the button goes dead again.
  panel.form.forgetScreenshot();
  assert.equal(panel.get("affix-fill").disabled, true);
  panel.form.rememberScreenshot("");
  assert.equal(panel.get("affix-fill").disabled, true);
});

test("editing a captured number clears the mark on the box the player is typing in", async () => {
  const panel = boot();
  await panel.form.fillFromText("+7% Faster Cast Rate", { carryValues: true });

  const minBox = panel.row("fcr").children[1].children[0];
  assert.equal(panel.form.get().conditions[0].fromCapture, true);
  assert.equal(minBox.title, FROM_CAPTURE_TITLE);
  minBox.value = "9";
  await panel.get("affix-list").dispatch("input", { target: minBox });

  assert.equal(panel.form.get().conditions[0].min, 9);
  assert.equal(panel.form.get().conditions[0].fromCapture, false, "the player's own number is not a captured one");
  // The mark is the capture asking the player to check a number; typing the answer retires it there and then, so it
  // cannot sit on the box the player is looking at until some unrelated redraw clears it.
  assert.equal(minBox.classList.contains("from-capture"), false);
  assert.equal(minBox.title, null);

  // Any structural change redraws the list, and the rebuilt box carries the player's number with no mark.
  const select = panel.get("affix-select");
  select.value = "mana";
  await select.dispatch("change");
  const rebuilt = panel.row("fcr").children[1].children[0];
  assert.notEqual(rebuilt, minBox);
  assert.equal(rebuilt.value, 9);
  assert.equal(rebuilt.className, "affix-min");
  assert.equal(rebuilt.title, null);
});

test("a read affix Traderie has no property for is drawn greyed, switched off and disabled", async () => {
  // Traderie's real list with the Faster Cast Rate property taken out: the reader knows the affix, the site does not.
  const cut = PROPERTIES.filter((p) => p.id !== 520);
  const panel = boot({ properties: cut });
  await panel.form.fillFromText("+7% Faster Cast Rate\n+15 to Life");

  const row = panel.row("fcr");
  assert.equal(row.classList.contains("unmapped"), true);
  assert.equal(row.children[0].children[0].disabled, true, "cannot be switched on");
  assert.equal(row.children[0].children[2].textContent, "（Traderie 沒有這個屬性）");
  assert.deepEqual(
    panel.form.get().conditions.map((c) => [c.key, c.on]),
    [
      ["fcr", false],
      ["life", true],
    ],
  );
  assert.deepEqual(panel.form.get().unavailable, ["fcr"]);

  // markUnavailable is the same rule arriving from a later read: the switch goes off and the row greys out.
  panel.form.markUnavailable(["life"]);
  assert.equal(panel.form.get().conditions.find((c) => c.key === "life").on, false);
  assert.equal(panel.row("life").classList.contains("unmapped"), true);
});

test("without a property list at all nothing is greyed", async () => {
  // The caller answers null when the read failed (sidepanel.js catches and returns null), so filling carries on as before.
  const panel = boot({ properties: null });
  await panel.form.fillFromText("+7% Faster Cast Rate");
  assert.equal(panel.row("fcr").classList.contains("unmapped"), false);
  assert.equal(panel.form.get().conditions[0].on, true);
  assert.deepEqual(panel.form.get().unavailable, []);
});

// --- the start gate ---------------------------------------------------------------------------------------------

test("a ticked number condition with no value refuses the search, and 0 counts as a value", async () => {
  const panel = boot();
  await panel.form.fillFromText("+7% Faster Cast Rate");
  assert.equal(panel.form.get().conditions[0].min, null, "without carryValues the reader fills no number");

  assert.equal(panel.form.startBlocker(), NEED_VALUES + "施法速度");
  // The base is still missing too, but the values are what the player is told about first.
  assert.equal(panel.form.get().base, "");

  const minBox = panel.row("fcr").children[1].children[0];
  minBox.value = "0";
  await panel.get("affix-list").dispatch("input", { target: minBox });
  assert.equal(panel.form.get().conditions[0].min, 0);
  assert.equal(panel.form.startBlocker(), NEED_SOMETHING, "0 is a value; only the base is missing now");

  minBox.value = "";
  await panel.get("affix-list").dispatch("input", { target: minBox });
  assert.equal(panel.form.startBlocker(), NEED_VALUES + "施法速度", "cleared again: refused once more");
});

test("a bool condition needs no number, and ticking nothing at all stays legal as long as a base is named", async () => {
  const panel = boot();
  await panel.form.fillFromText("Ethereal");
  const row = panel.row("ethereal");
  assert.deepEqual([row.children.length, panel.form.get().conditions[0].on], [2, true]);

  const base = panel.get("stats-base");
  base.value = "Ring";
  await base.dispatch("input");
  assert.equal(panel.form.startBlocker(), "");

  // Nothing ticked at all: a base-only search is still a search.
  const empty = boot();
  assert.equal(empty.form.startBlocker(), NEED_SOMETHING);
  const emptyBase = empty.get("stats-base");
  emptyBase.value = "Ring";
  await emptyBase.dispatch("input");
  assert.equal(empty.form.get().conditions.length, 0);
  assert.equal(empty.form.startBlocker(), "");
});

test("a maximum below its minimum is refused first and marks the row invalid", async () => {
  const panel = boot();
  await panel.form.fillFromText("+7% Faster Cast Rate");
  const [minBox, maxBox] = panel.row("fcr").children[1].children;
  minBox.value = "20";
  await panel.get("affix-list").dispatch("input", { target: minBox });
  maxBox.value = "10";
  await panel.get("affix-list").dispatch("input", { target: maxBox });

  assert.equal(panel.row("fcr").classList.contains("invalid"), true);
  assert.equal(panel.form.startBlocker(), FIX_LIMITS, "before the missing base is even mentioned");

  maxBox.value = "";
  await panel.get("affix-list").dispatch("input", { target: maxBox });
  assert.equal(panel.row("fcr").classList.contains("invalid"), false);
  assert.equal(panel.form.startBlocker(), NEED_SOMETHING);
});

// --- the limit boxes --------------------------------------------------------------------------------------------

test("a limit box admits digits only, is bounded below by zero, and carries the affix's name in its label", async () => {
  const panel = boot();
  await panel.form.fillFromText("+7% Faster Cast Rate");
  const [minBox, maxBox] = panel.row("fcr").children[1].children;

  assert.equal(minBox.type, "number");
  assert.equal(minBox.getAttribute("min"), "0");
  assert.equal(minBox.getAttribute("step"), "1");
  assert.equal(minBox.placeholder, "最小");
  assert.equal(maxBox.placeholder, "最大");
  assert.deepEqual([minBox.getAttribute("aria-label"), maxBox.getAttribute("aria-label")], ["施法速度最小值", "施法速度最大值"]);

  const type = async (input, value) => {
    input.value = value;
    await panel.get("affix-list").dispatch("input", { target: input });
  };
  // A negative or unreadable entry is refused by the state (the fake does not enforce type=number, so this is the rule, not the widget).
  await type(minBox, "-5");
  assert.equal(panel.form.get().conditions[0].min, null);
  await type(minBox, "abc");
  assert.equal(panel.form.get().conditions[0].min, null);
  await type(minBox, "12.5");
  assert.equal(panel.form.get().conditions[0].min, 12.5);
  await type(minBox, "0");
  assert.equal(panel.form.get().conditions[0].min, 0);
  await type(minBox, "");
  assert.equal(panel.form.get().conditions[0].min, null);
});

// --- the base field ---------------------------------------------------------------------------------------------

test("the base field suggests the shipped item types and restricts nothing", async () => {
  const panel = boot();
  const base = panel.get("stats-base");

  assert.equal(base.disabled, false);
  assert.equal(base.getAttribute("list"), "stats-base-options");
  assert.equal(base.getAttribute("pattern"), null);
  assert.equal(base.getAttribute("required"), null);
  // The binder never touches the datalist, so the options sidepanel.js filled from the shipped table are still there.
  assert.deepEqual(
    panel.get("stats-base-options").children.map((o) => o.getAttribute("value")),
    BASES.slice(0, 2),
  );

  // A name that is not one of them is still the base: a suggestion, not a membership test.
  base.value = "Not A Real Base";
  await base.dispatch("input");
  assert.equal(panel.form.get().base, "Not A Real Base");
  assert.equal(panel.calls.length, 1, "typing the base is a change the caller hears about");

  // A base the player typed is never replaced by a later reading, and is not marked.
  panel.form.setBaseFromScreenshot("Monarch");
  assert.equal(base.dataset.from, "");
  assert.equal(base.classList.contains("from-capture"), false);
  assert.equal(panel.form.get().base, "Not A Real Base");

  // Cleared, a reading fills it and marks it; a second reading does not replace the marked value.
  base.value = "";
  await base.dispatch("input");
  panel.form.setBaseFromScreenshot("Monarch");
  assert.equal(base.dataset.from, "ocr");
  assert.equal(base.classList.contains("from-capture"), true);
  assert.equal(base.title, FROM_CAPTURE_TITLE);
  assert.equal(panel.form.get().base, "Monarch");
  panel.form.setBaseFromScreenshot("Bone Wand");
  assert.equal(panel.form.get().base, "Bone Wand", "a marked value is refreshed by a later reading; only the player's typing is protected");

  // Typing clears the source flag and the mark at once: a base the player typed is their own.
  base.value = "Ring";
  await base.dispatch("input");
  assert.equal(base.dataset.from, "");
  assert.equal(panel.form.get().base, "Ring");
  assert.equal(base.classList.contains("from-capture"), false);
  assert.equal(base.getAttribute("title"), null);

  // The player's own base then wins over later readings.
  panel.form.setBaseFromScreenshot("Bone Wand");
  assert.equal(panel.form.get().base, "Ring");
});

// --- busy and quality -------------------------------------------------------------------------------------------

test("busy locks every control without telling the caller anything changed", async () => {
  const panel = boot();
  await panel.form.fillFromText("+7% Faster Cast Rate");
  const select = panel.get("affix-select");
  select.value = "life";
  await select.dispatch("change");
  const before = panel.calls.length;

  panel.form.setBusy(true);
  assert.equal(panel.calls.length, before, "setBusy is not a form change");
  assert.equal(panel.get("affix-select").disabled, true);
  assert.equal(panel.get("stats-base").disabled, true);
  assert.equal(panel.get("affix-fill").disabled, true);
  assert.ok(panel.radios().every((r) => r.disabled));
  for (const li of panel.rows()) {
    assert.equal(li.children[0].children[0].disabled, true, "the tick box");
    assert.equal(li.children.at(-1).disabled, true, "the remove button");
    assert.ok(li.children[1].children.every((input) => input.disabled), "the limit boxes");
  }

  panel.form.setBusy(false);
  assert.equal(panel.get("affix-select").disabled, false);
  assert.equal(panel.get("stats-base").disabled, false);
  assert.ok(panel.radios().every((r) => !r.disabled));
  assert.ok(panel.rows().every((li) => !li.children[0].children[0].disabled));
});

test("a quality radio switches the form's quality and goes through onChange", async () => {
  const panel = boot();
  const magic = panel.radios().find((r) => r.value === "magic");
  await magic.dispatch("change");

  assert.equal(panel.form.get().quality, "magic");
  assert.deepEqual(panel.radios().map((r) => [r.value, r.checked]), QUALITIES.map((q) => [q.key, q.key === "magic"]));
  assert.deepEqual(panel.calls, [[]]);
});
