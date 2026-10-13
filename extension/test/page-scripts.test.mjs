import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The extension injects page scripts whose real logic nothing else executes: resolve_target.js (which decides where
// an action's click lands, or that the target is unusable), settle.js (which waits for the page to stop changing),
// after_input.js (the wait for the page to react to an action) and traderie/settled_page.js (the settled-page
// reader). Each is a single arrow function reading page globals only as bare names, so — exactly like
// covered-overlay.test.mjs — rebuilding it with `new Function` and passing fakes keeps the page's globals (and
// ours) out of this file.

const RESOLVE_SOURCE = readFileSync(new URL("../../src/jev_ultrafast/resolve_target.js", import.meta.url), "utf8");
const SETTLE_SOURCE = readFileSync(new URL("../../src/jev_ultrafast/settle.js", import.meta.url), "utf8");

// ---------------------------------------------------------------- resolve_target.js ---------------------------------

const BUILD_RESOLVE = new Function(
  "window",
  "document",
  "innerWidth",
  "innerHeight",
  "Event",
  "return (" + RESOLVE_SOURCE + ");",
);

const WIDTH = 1000;
const HEIGHT = 800;

/** The event the page script constructs and dispatches; records the type and bubbling it was made with. */
class FakeEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = init?.bubbles;
  }
}

/** A fake element exposing every method the page script probes, with sane defaults a caller can override. */
function node({
  rect = { x: 100, y: 100, width: 200, height: 100 }, // centre (200, 150), mid-viewport
  connected = true,
  disabled = false,
  inert = false,
  visible = true,
  readOnly = false,
  ariaReadonly = false,
  tagName = "BUTTON",
  options = [],
  contains = [],
} = {}) {
  const el = {
    isConnected: connected,
    readOnly,
    tagName,
    options,
    value: "initial",
    events: [],
    matches: (selector) => selector === ":disabled" && disabled,
    closest: (selector) => (selector === '[aria-disabled="true"],[inert]' && inert ? {} : null),
    checkVisibility: () => visible,
    getAttribute: (name) => (name === "aria-readonly" && ariaReadonly ? "true" : null),
    getBoundingClientRect: () => rect,
    contains: (other) => other === el || contains.includes(other),
    dispatchEvent: (event) => {
      el.events.push(event);
      return true;
    },
  };
  return el;
}

/** Run the page script with `nodes` behind window.__jevFast and one elementFromPoint answer. */
function resolve(nodes, hit) {
  const fakeWindow = { __jevFast: { nodes } };
  const fakeDocument = { elementFromPoint: () => hit };
  return BUILD_RESOLVE(fakeWindow, fakeDocument, WIDTH, HEIGHT, FakeEvent);
}

/** Convenience: the given element under node id 7, hit-tested by itself unless `hit` is given. */
function runNode(el, action, hit = el) {
  return resolve(new Map([[7, el]]), hit)({ node: 7, ...action });
}

/** One <option> for a fake SELECT: enabled and outside a disabled optgroup unless told otherwise. */
const selectOption = (value, { disabled = false, disabledGroup = false } = {}) => ({
  value,
  disabled,
  closest: (selector) => (disabledGroup && selector === "optgroup[disabled]" ? {} : null),
});

test("resolve: a node id the snapshot never recorded resolves to null", () => {
  assert.equal(resolve(new Map(), undefined)({ node: 7, kind: "click" }), null);
});

test("resolve: a node that has left the document resolves to null", () => {
  assert.equal(runNode(node({ connected: false }), { kind: "click" }), null);
});

test("resolve: a disabled node resolves to null", () => {
  assert.equal(runNode(node({ disabled: true }), { kind: "click" }), null);
});

test("resolve: a node inside [inert] or [aria-disabled=true] resolves to null", () => {
  assert.equal(runNode(node({ inert: true }), { kind: "click" }), null);
});

test("resolve: a node the page reports as not visible resolves to null", () => {
  assert.equal(runNode(node({ visible: false }), { kind: "click" }), null);
});

test("resolve: filling a readonly field resolves to null (property or aria)", () => {
  assert.equal(runNode(node({ readOnly: true }), { kind: "fill" }), null);
  assert.equal(runNode(node({ ariaReadonly: true }), { kind: "fill" }), null);
});

test("resolve: a zero-area rect resolves to null", () => {
  assert.equal(runNode(node({ rect: { x: 100, y: 100, width: 0, height: 50 } }), { kind: "click" }), null);
  assert.equal(runNode(node({ rect: { x: 100, y: 100, width: 50, height: 0 } }), { kind: "click" }), null);
});

test("resolve: a centre off every viewport edge resolves to null", () => {
  const edges = [
    { x: -60, y: 100, width: 20, height: 20 }, // centre x = -50
    { x: 100, y: -60, width: 20, height: 20 }, // centre y = -50
    { x: 990, y: 100, width: 20, height: 20 }, // centre x = 1000 == innerWidth
    { x: 100, y: 790, width: 20, height: 20 }, // centre y = 800 == innerHeight
  ];
  for (const rect of edges) assert.equal(runNode(node({ rect }), { kind: "click" }), null, JSON.stringify(rect));
});

test("resolve: a centre covered by another element resolves to null", () => {
  const target = node();
  const cover = node();
  assert.equal(runNode(target, { kind: "click" }, cover), null);
});

test("resolve: a click returns the centre point", () => {
  assert.deepEqual(runNode(node(), { kind: "click" }), { x: 200, y: 150 });
});

test("resolve: a fill into a writable field returns the centre point", () => {
  assert.deepEqual(runNode(node(), { kind: "fill" }), { x: 200, y: 150 });
});

test("resolve: a select against a non-SELECT tag resolves to null", () => {
  assert.equal(runNode(node({ tagName: "DIV" }), { kind: "select", value: "b" }), null);
});

test("resolve: a select with no option matching the value resolves to null", () => {
  const options = [selectOption("a")];
  assert.equal(runNode(node({ tagName: "SELECT", options }), { kind: "select", value: "b" }), null);
});

test("resolve: a select whose only matching option is disabled resolves to null", () => {
  const options = [selectOption("b", { disabled: true })];
  assert.equal(runNode(node({ tagName: "SELECT", options }), { kind: "select", value: "b" }), null);
});

test("resolve: a select whose matching option sits in a disabled optgroup resolves to null", () => {
  const options = [selectOption("b", { disabledGroup: true })];
  assert.equal(runNode(node({ tagName: "SELECT", options }), { kind: "select", value: "b" }), null);
});

test("resolve: a select sets the value and dispatches input then change, in that order", () => {
  const options = [selectOption("a"), selectOption("b")];
  const el = node({ tagName: "SELECT", options });
  assert.deepEqual(runNode(el, { kind: "select", value: "b" }), { x: 200, y: 150 });
  assert.equal(el.value, "b");
  assert.deepEqual(
    el.events.map((event) => [event.type, event.bubbles]),
    [["input", true], ["change", true]],
  );
});

// --------------------------------------------------------------------- settle.js ------------------------------------

const BUILD_SETTLE = new Function(
  "document",
  "MutationObserver",
  "setTimeout",
  "clearTimeout",
  "performance",
  "return (" + SETTLE_SOURCE + ");",
);

/** A MutationObserver whose callback and disconnect count we can inspect; observe() records its call and does nothing. */
function observer() {
  const record = { callback: null, observed: null, disconnects: 0 };
  class FakeMutationObserver {
    constructor(callback) {
      record.callback = callback;
    }
    observe(target, options) {
      record.observed = { target, options };
    }
    disconnect() {
      record.disconnects += 1;
    }
  }
  return { FakeMutationObserver, record };
}

/** An injectable timer: nothing fires by itself, so the test decides exactly when each callback runs. */
function timer() {
  let seq = 0;
  const pending = new Map();
  return {
    pending,
    // Insertion order mirrors the order the page script scheduled them: [quiet, cap].
    ids: () => [...pending.keys()],
    // The delay each pending timer was armed with, in the same order: the settle script must use quietMs for the
    // quiet timer and timeoutMs for the cap, so a swapped delay has to be visible.
    delays: () => [...pending.values()].map((slot) => slot.delay),
    setTimeout: (fn, delay) => {
      const id = (seq += 1);
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    fire: (id) => {
      const slot = pending.get(id);
      pending.delete(id);
      slot?.fn();
    },
  };
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (by) => (t += by) };
}

/** Drain the microtask queue so a resolve() has definitely reached the `.then` we attached. */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/** Build the settle script over fakes and return a handle to observe its result. */
function startSettle(quietMs, timeoutMs, minChars, { doc, observerFake, timers, clockFake }) {
  const settled = { result: null, done: false };
  const promise = BUILD_SETTLE(doc, observerFake, timers.setTimeout, timers.clearTimeout, { now: clockFake.now })(
    quietMs,
    timeoutMs,
    minChars,
  );
  promise.then((result) => {
    settled.result = result;
    settled.done = true;
  });
  return settled;
}

/**
 * A settle run whose body shows `innerText` at `visibilityState`, over a driven timer and clock: the fixture set all
 * six settle tests share. `minChars` is the text threshold the quiet timer must clear.
 */
function settleRun(innerText, visibilityState, { minChars = 100 } = {}) {
  const timers = timer();
  const clockFake = clock(0);
  const { FakeMutationObserver, record } = observer();
  const doc = { body: { innerText }, visibilityState };
  const settled = startSettle(400, 15000, minChars, { doc, observerFake: FakeMutationObserver, timers, clockFake });
  return { settled, doc, timers, clockFake, record };
}

test("settle: the cap resolves capped:true when the timeout fires before the page stops changing", async () => {
  const { settled, timers, clockFake, record } = settleRun("", "visible");

  await flush();
  assert.equal(settled.done, false, "nothing resolves until a timer fires");
  const [, capId] = timers.ids(); // [quiet, cap]
  assert.deepEqual(timers.delays(), [400, 15000], "the quiet timer is armed with quietMs and the cap with timeoutMs");
  clockFake.advance(15000);
  timers.fire(capId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.result.capped, true);
  assert.equal(settled.result.ms, 15000);
  assert.equal(settled.result.visibility, "visible");
  assert.equal(record.disconnects, 1);
});

test("settle: quiet for quietMs with enough text resolves capped:false and echoes visibility", async () => {
  const { settled, timers, clockFake } = settleRun("x".repeat(150), "hidden");

  const [quietId] = timers.ids();
  clockFake.advance(700);
  timers.fire(quietId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.result.capped, false);
  assert.equal(settled.result.ms, 700);
  assert.equal(settled.result.visibility, "hidden");
});

test("settle: a quiet timer that finds too little text re-arms instead of resolving", async () => {
  const { settled, doc, timers, clockFake } = settleRun("short", "visible");

  const [quietId, capId] = timers.ids();
  timers.fire(quietId);
  await flush();
  assert.equal(settled.done, false, "not enough text: the wait continues");

  const afterIds = timers.ids();
  assert.equal(afterIds.length, 2);
  assert.ok(afterIds.includes(capId), "the cap is still armed");
  const rearmed = afterIds.find((id) => id !== capId);
  assert.ok(rearmed !== undefined && rearmed !== quietId, "a fresh quiet timer replaced the fired one");
  assert.deepEqual(
    [...timers.delays()].sort((a, b) => a - b),
    [400, 15000],
    "the re-armed quiet timer keeps quietMs and the cap keeps timeoutMs",
  );

  doc.body.innerText = "y".repeat(150);
  clockFake.advance(400);
  timers.fire(rearmed);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.result.capped, false);
});

test("settle: a MutationObserver callback with unchanged text does not re-arm the quiet timer", async () => {
  const { doc, timers, record } = settleRun("stable", "visible");
  const [quietId, capId] = timers.ids();

  record.callback();
  assert.deepEqual(timers.ids(), [quietId, capId], "no change: both timers left exactly as they were");

  doc.body.innerText = "changed";
  record.callback();
  const afterIds = timers.ids();
  assert.equal(afterIds.length, 2);
  assert.ok(afterIds.includes(capId));
  assert.ok(!afterIds.includes(quietId), "a change cleared the old quiet timer");
});

test("settle: the promise resolves once even when the cap and the quiet timer both fire", async () => {
  const { settled, timers, clockFake, record } = settleRun("z".repeat(150), "visible");
  const [quietId, capId] = timers.ids();

  clockFake.advance(15000);
  timers.fire(capId);
  await flush();
  assert.equal(settled.result.capped, true);

  timers.fire(quietId); // the quiet timer was never cancelled by done(); firing it must be a no-op
  await flush();
  assert.equal(settled.result.capped, true, "the first resolution stands");
  assert.equal(record.disconnects, 1, "done() ran its body once");
});

test("settle: the script observes the document and echoes an empty visibilityState", async () => {
  const { settled, doc, timers, record } = settleRun("v".repeat(150), "");

  assert.deepEqual(record.observed, { target: doc, options: { subtree: true, childList: true, characterData: true } });
  const [quietId] = timers.ids();
  timers.fire(quietId);
  await flush();
  assert.equal(settled.result.visibility, "", "visibility is whatever document reports, not a default");
});

// --------------------------------------------------------------- after_input.js -------------------------------------
// The wait-for-the-page-to-react step. A click settles on its own clock: it observes the DOM, restarts a 400ms quiet
// timer on every text change, arms that timer at 1000ms even if the page never changed, and caps the whole wait at
// 6000ms. A fill instead watches two animation frames (and, for a combobox, a visible option) with a 50ms/200ms cap.

const AFTER_INPUT_SOURCE = readFileSync(new URL("../../src/jev_ultrafast/after_input.js", import.meta.url), "utf8");

const BUILD_AFTER_INPUT = new Function(
  "window",
  "document",
  "MutationObserver",
  "setTimeout",
  "clearTimeout",
  "requestAnimationFrame",
  "innerHeight",
  "return (" + AFTER_INPUT_SOURCE + ");",
);

/** An injectable requestAnimationFrame: nothing runs by itself, so the test drives each frame explicitly. */
function frameQueue() {
  const queue = [];
  return {
    pending: () => queue.length,
    requestAnimationFrame: (fn) => queue.push(fn),
    frame: () => queue.shift()?.(),
  };
}

/** Build the after_input script over fakes and return a handle to observe whether (and how often) it resolves. */
function startAfterInput(action, { win, doc, observerFake, timers, frames }) {
  const settled = { done: false, resolutions: 0, value: "unset" };
  const promise = BUILD_AFTER_INPUT(
    win,
    doc,
    observerFake,
    timers.setTimeout,
    timers.clearTimeout,
    frames.requestAnimationFrame,
    HEIGHT,
  )(action);
  promise.then((value) => {
    settled.done = true;
    settled.resolutions += 1;
    settled.value = value;
  });
  return settled;
}

/**
 * A click on a page whose body shows `innerText`, over a driven timer, frame queue and observer record: every click
 * test drives this same fixture set.
 */
function startClick(innerText) {
  const timers = timer();
  const frames = frameQueue();
  const { FakeMutationObserver, record } = observer();
  const doc = { body: { innerText } };
  const settled = startAfterInput(
    { kind: "click", node: 7 },
    { win: { __jevFast: { nodes: new Map() } }, doc, observerFake: FakeMutationObserver, timers, frames },
  );
  return { settled, doc, timers, frames, record };
}

test("after_input: a click resolves once the page's text goes quiet", async () => {
  const { settled, doc, timers, frames, record } = startClick("ready");

  assert.deepEqual(timers.delays(), [6000, 1000], "the 6s cap is scheduled before the 1s kickstart");
  assert.deepEqual(record.observed, {
    target: doc,
    options: { subtree: true, childList: true, characterData: true, attributes: true },
  });
  await flush();
  assert.equal(settled.done, false, "nothing resolves before the page reacts");

  const [capId] = timers.ids();
  doc.body.innerText = "ready now";
  record.callback();
  const quietId = timers.ids().at(-1);
  assert.deepEqual(timers.delays().at(-1), 400, "a text change arms the 400ms quiet timer");
  timers.fire(quietId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
  assert.equal(settled.value, undefined, "the wait resolves with no value");
  assert.equal(record.disconnects, 1);

  timers.fire(capId); // the 6000ms cap is still armed; firing it after done() must be a no-op
  await flush();
  assert.equal(settled.resolutions, 1, "the first resolution stands");
  assert.equal(record.disconnects, 1, "finish() ran its body once");
});

test("after_input: a click that never goes quiet resolves on the 6000ms cap", async () => {
  const { settled, doc, timers, record } = startClick("a");

  const [capId] = timers.ids();
  assert.deepEqual(timers.delays()[0], 6000);
  timers.fire(capId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
  assert.equal(record.disconnects, 1, "the cap disconnects the observer");

  doc.body.innerText = "b";
  record.callback(); // a change after the cap still arms, but the timer it arms must not resolve again
  timers.fire(timers.ids().at(-1));
  await flush();
  assert.equal(settled.resolutions, 1);
  assert.equal(record.disconnects, 1, "the cap's finish does not run a second time");
});

test("after_input: a click whose page keeps changing does not resolve early", async () => {
  const { settled, doc, timers, record } = startClick("start");

  const [capId, kickId] = timers.ids();
  const quietIds = [];
  for (const text of ["one", "two", "three"]) {
    doc.body.innerText = text;
    record.callback();
    quietIds.push(timers.ids().at(-1));
  }
  await flush();
  assert.equal(settled.done, false, "every change restarted the quiet period");
  assert.equal(new Set(quietIds).size, 3, "each change armed a fresh quiet timer");
  assert.equal(timers.ids().length, 3, "cap, kickstart and exactly one quiet timer are pending");
  assert.ok(timers.ids().includes(capId));

  timers.fire(kickId); // the page already changed, so the kickstart must not arm a second quiet timer
  assert.deepEqual(timers.ids(), [capId, quietIds.at(-1)], "started is already true: the kickstart is inert");
  assert.equal(settled.done, false);

  timers.fire(quietIds.at(-1));
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
});

test("after_input: a click on a page that never reacts arms its quiet timer at 1000ms", async () => {
  const { settled, timers } = startClick("static");

  const [, kickId] = timers.ids();
  assert.equal(settled.done, false);
  timers.fire(kickId);
  const quietId = timers.ids().at(-1);
  assert.notEqual(quietId, kickId);
  assert.deepEqual(timers.delays().sort((a, b) => a - b), [400, 6000], "the kickstart armed the 400ms quiet timer");
  await flush();
  assert.equal(settled.done, false, "arming alone does not resolve");

  timers.fire(quietId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
});

test("after_input: a plain fill resolves after two animation frames and never observes the DOM", async () => {
  const timers = timer();
  const { FakeMutationObserver, record } = observer();
  const doc = { body: { innerText: "" }, querySelectorAll: () => [] };
  const frames = frameQueue();
  const settled = startAfterInput(
    { kind: "fill", node: 7 },
    { win: { __jevFast: { nodes: new Map() } }, doc, observerFake: FakeMutationObserver, timers, frames },
  );

  assert.deepEqual(timers.delays(), [50], "a plain fill caps at 50ms");
  assert.equal(frames.pending(), 1, "one animation frame is requested");
  assert.equal(record.observed, null, "a fill never observes the DOM");

  frames.frame();
  await flush();
  assert.equal(settled.done, false, "one frame is not enough");
  assert.equal(frames.pending(), 1, "a second frame is requested");

  frames.frame();
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
  assert.equal(record.disconnects, 1, "finish() still disconnects the observer it never used");
});

test("after_input: an autocomplete fill resolves once two frames show a visible option", async () => {
  const timers = timer();
  const { FakeMutationObserver } = observer();
  const option = {
    getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, bottom: 5 }),
    checkVisibility: () => true,
  };
  const list = { querySelectorAll: () => [option] };
  const field = {
    getAttribute: (name) => (name === "role" ? "combobox" : name === "aria-controls" ? "opts" : null),
  };
  const doc = { body: { innerText: "" }, getElementById: (id) => (id === "opts" ? list : null) };
  const frames = frameQueue();
  const settled = startAfterInput(
    { kind: "fill", node: 7 },
    { win: { __jevFast: { nodes: new Map([[7, field]]) } }, doc, observerFake: FakeMutationObserver, timers, frames },
  );

  assert.deepEqual(timers.delays(), [200], "an autocomplete fill caps at 200ms");
  frames.frame();
  frames.frame();
  await flush();
  assert.equal(settled.done, true, "two frames with a visible option resolve");
  assert.equal(settled.resolutions, 1);
});

test("after_input: an autocomplete fill whose option is invisible waits for the cap", async () => {
  const timers = timer();
  const { FakeMutationObserver } = observer();
  const option = {
    getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, bottom: 5 }),
    checkVisibility: () => false,
  };
  const list = { querySelectorAll: () => [option] };
  const field = {
    getAttribute: (name) => (name === "role" ? "combobox" : name === "aria-controls" ? "opts" : null),
  };
  const doc = { body: { innerText: "" }, getElementById: (id) => (id === "opts" ? list : null) };
  const frames = frameQueue();
  const settled = startAfterInput(
    { kind: "fill", node: 7 },
    { win: { __jevFast: { nodes: new Map([[7, field]]) } }, doc, observerFake: FakeMutationObserver, timers, frames },
  );

  const [capId] = timers.ids();
  frames.frame();
  frames.frame();
  await flush();
  assert.equal(settled.done, false, "an invisible option keeps the frames coming");
  assert.equal(frames.pending(), 1);

  timers.fire(capId);
  await flush();
  assert.equal(settled.done, true);
  assert.equal(settled.resolutions, 1);
});

// ------------------------------------------------------------- traderie/settled_page.js -----------------------------
// The settled-page reader whose result feeds verification.read_settled_page: it must hand back url/title/text plus a
// settled flag, or the reader treats the answer as malformed. It resolves quiet when the visible text stops changing
// and, failing that, when its own cap fires with settled:false.

const SETTLED_PAGE_SOURCE = readFileSync(
  new URL("../../src/jev_ultrafast/traderie/settled_page.js", import.meta.url),
  "utf8",
);

const BUILD_SETTLED_PAGE = new Function(
  "location",
  "document",
  "MutationObserver",
  "setTimeout",
  "clearTimeout",
  "return (" + SETTLED_PAGE_SOURCE + ");",
);

/** Build the settled_page script over fakes and return a handle to observe its result. */
function startSettledPage({ location, doc, observerFake, timers }, quietMs = 500, timeoutMs = 5000) {
  const settled = { result: "unset", done: false, resolutions: 0 };
  const promise = BUILD_SETTLED_PAGE(location, doc, observerFake, timers.setTimeout, timers.clearTimeout)(
    quietMs,
    timeoutMs,
  );
  promise.then((result) => {
    settled.result = result;
    settled.done = true;
    settled.resolutions += 1;
  });
  return settled;
}

/** A settled_page run for `href` over `doc`, with a driven timer and an observer record. */
function settledPageRun(href, doc) {
  const timers = timer();
  const { FakeMutationObserver, record } = observer();
  const settled = startSettledPage({ location: { href }, doc, observerFake: FakeMutationObserver, timers });
  return { settled, timers, record };
}

test("settled page: a text that settles reports url, title, text and settled:true", async () => {
  const doc = { title: "Product", body: { innerText: "hello" }, documentElement: {}, visibilityState: "visible" };
  const { settled, timers, record } = settledPageRun("https://traderie/item", doc);

  assert.deepEqual(timers.delays(), [5000, 500], "the cap takes timeoutMs and the quiet timer takes quietMs");
  assert.deepEqual(record.observed, {
    target: doc.body,
    options: { childList: true, subtree: true, characterData: true },
  });
  const [, quietId] = timers.ids();
  timers.fire(quietId);
  await flush();
  assert.deepEqual(settled.result, {
    url: "https://traderie/item",
    title: "Product",
    text: "hello",
    settled: true,
  });
  assert.equal(record.disconnects, 1);
});

test("settled page: a text that never settles is capped with settled:false and the text it last saw", async () => {
  const doc = { title: "Chatty", body: { innerText: "a" }, documentElement: {} };
  const { settled, timers, record } = settledPageRun("https://traderie/chatty", doc);

  const [capId] = timers.ids();
  for (const text of ["b", "c", "d"]) {
    doc.body.innerText = text;
    record.callback();
  }
  await flush();
  assert.equal(settled.done, false, "each change re-armed the quiet timer, so nothing resolved yet");

  timers.fire(capId);
  await flush();
  assert.deepEqual(settled.result, {
    url: "https://traderie/chatty",
    title: "Chatty",
    text: "d",
    settled: false,
  });
  assert.equal(record.disconnects, 1);
});

test("settled page: with no document.body it observes documentElement and reports empty text", async () => {
  const doc = { title: "Bare", documentElement: {}, body: undefined };
  const { settled, timers, record } = settledPageRun("https://traderie/bare", doc);

  assert.equal(record.observed.target, doc.documentElement);
  const [, quietId] = timers.ids();
  timers.fire(quietId);
  await flush();
  assert.deepEqual(settled.result, {
    url: "https://traderie/bare",
    title: "Bare",
    text: "",
    settled: true,
  });
});

test("settled page: an observe failure is tolerated and the wait still resolves", async () => {
  const timers = timer();
  class ThrowingObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      throw new Error("detached document");
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const doc = { title: "X", body: { innerText: "t" }, documentElement: {} };
  const settled = startSettledPage({
    location: { href: "u" },
    doc,
    observerFake: ThrowingObserver,
    timers,
  });

  const [, quietId] = timers.ids();
  timers.fire(quietId);
  await flush();
  assert.equal(settled.done, true);
  assert.deepEqual(settled.result, { url: "u", title: "X", text: "t", settled: true });
});
