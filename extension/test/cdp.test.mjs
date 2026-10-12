import assert from "node:assert/strict";
import { test } from "node:test";

const noEvents = { addListener() {}, removeListener() {} };
const debuggerEvents = { onDetach: noEvents, onEvent: noEvents };
globalThis.chrome = { debugger: debuggerEvents };
const { Tab, closeStaleWindows, commandTimeoutMs } = await import("../src/cdp.js");
const { AbortedError, StalePage, TimeoutError } = await import("../src/errors.js");

const scripts = { snapshot: "(() => ({}))()", resolveTarget: "(a => null)" };

test("a page-level action is fresh when the marker is equal by value, not by identity", async () => {
  const tab = new Tab(1, scripts);
  const marker = [1700000000000.5, "https://www.traderie.com/diablo2resurrected", 0, 0, 1120, 780, "t", "text", [], []];
  tab.evaluate = async () => JSON.parse(JSON.stringify(marker)); // a new array every read, like the real page
  assert.equal(await tab.fresh({ marker }, { kind: "scroll", id: "scroll_bottom" }), true);
  assert.equal(await tab.fresh({ marker: [...marker.slice(0, 2), 99] }, { kind: "scroll", id: "scroll_bottom" }), false);
});

test("an element action is fresh only while its page key and guard still match", async () => {
  const tab = new Tab(1, scripts);
  tab.evaluate = async () => [["k", 1], ["g", 2]];
  const action = { kind: "click", node: 7 };
  assert.equal(await tab.fresh({ page_key: ["k", 1], guards: { 7: ["g", 2] } }, action), true);
  assert.equal(await tab.fresh({ page_key: ["k", 1], guards: { 7: ["g", 3] } }, action), false);
});

test("the page opens in its own minimized window and that window is closed with the tab", async () => {
  const calls = [];
  globalThis.chrome = {
    windows: {
      create: async (options) => (calls.push(["create", options]), { id: 9, tabs: [{ id: 5 }] }),
      remove: async (id) => calls.push(["remove", id]),
    },
    debugger: {
      ...debuggerEvents,
      attach: async () => {},
      detach: async () => calls.push(["detach"]),
      sendCommand: async () => ({ result: { value: "complete" } }),
    },
  };
  const tab = await Tab.open("https://www.traderie.com/diablo2resurrected", { snapshot: "(() => ({}))()", settle: "(() => 1)" });
  assert.deepEqual(calls[0], ["create", { url: "https://www.traderie.com/diablo2resurrected", state: "minimized" }]);
  await tab.close();
  assert.deepEqual(calls.slice(-2), [["detach"], ["remove", 9]]);
});

function detachingChrome({ alive, value = "ok" }) {
  const state = { sent: [], attaches: 0, listener: null, failNext: true };
  globalThis.chrome = {
    tabs: { get: async () => (alive ? { id: 1 } : Promise.reject(new Error("No tab"))) },
    debugger: {
      onDetach: { addListener: (fn) => (state.listener = fn), removeListener() {} },
      onEvent: noEvents,
      attach: async () => void (state.attaches += 1),
      sendCommand: async (_target, method) => {
        state.sent.push(method);
        if (state.failNext && (method === "Runtime.evaluate" || method === "Input.dispatchMouseEvent")) {
          state.failNext = false;
          setTimeout(() => state.listener({ tabId: 1 }, "target_closed"), 10);
          throw new Error("Detached while handling command.");
        }
        return { result: { value } };
      },
    },
  };
  return state;
}

test("a read that asks for it is repeated once on a re-attached tab when Chrome swaps the page target", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  assert.equal(await tab.evaluate("1", { retryable: true }), "ok");
  assert.equal(state.attaches, 1);
  assert.equal(state.sent.filter((m) => m === "Runtime.evaluate").length, 2);
});

test("an evaluate that does not ask for a retry is never repeated", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  await assert.rejects(tab.evaluate("1"), /target_closed/);
  assert.equal(state.sent.filter((m) => m === "Runtime.evaluate").length, 1);
});

test("finding the click point is never repeated after the target is lost", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  await assert.rejects(tab._operate({ kind: "click", node: 3 }, null), /target_closed/);
  assert.equal(state.sent.filter((m) => m === "Runtime.evaluate").length, 1);
  assert.equal(state.sent.includes("Input.dispatchMouseEvent"), false);
});

test("the read-only steps (observe, fresh, settle, page reads, readyState polling) are repeated once", async () => {
  const page = { url: "https://www.traderie.com/diablo2resurrected", text: "", actions: [], scroll: 0, marker: ["m"] };
  const reads = {
    observe: (tab) => tab.observe(),
    fresh: (tab) => tab.fresh(page),
    settle: (tab) => tab.settle(),
    readSettledPage: (tab) => tab.readSettledPage(),
    waitUntilReady: (tab) => tab.waitUntilReady(50),
    navigate: (tab) => tab.navigate("https://www.traderie.com/diablo2resurrected"),
  };
  for (const [name, run] of Object.entries(reads)) {
    const state = detachingChrome({ alive: true, value: name === "navigate" ? "complete" : page });
    // For navigate the failing command is the readyState poll, not Page.navigate.
    const tab = new Tab(1, { ...scripts, settle: "(() => 1)", settledPage: "(() => 1)" });
    await run(tab);
    assert.equal(state.attaches, 1, name);
  }
});

test("a page script that throws is a real error with the page's description, not a stale page", async () => {
  globalThis.chrome = {
    debugger: {
      ...debuggerEvents,
      sendCommand: async () => ({
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function\n    at <anonymous>" } },
      }),
    },
  };
  const tab = new Tab(1, scripts);
  await assert.rejects(tab.evaluate("1"), (error) => !(error instanceof StalePage) && /x is not a function/.test(error.message));
});

test("only navigation failures are a stale page, whether Chrome reports them as exceptions or as protocol errors", async () => {
  const failures = [
    { exceptionDetails: { exception: { description: "Error: Execution context was destroyed." } } },
    { exceptionDetails: { text: "Inspected target navigated or closed" } },
    new Error("Cannot find context with specified id"),
  ];
  for (const failure of failures) {
    globalThis.chrome = {
      debugger: {
        ...debuggerEvents,
        sendCommand: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
      },
    };
    await assert.rejects(new Tab(1, scripts).evaluate("1"), StalePage);
  }
});

function hangingChrome() {
  const calls = [];
  globalThis.chrome = {
    windows: { remove: async (id) => calls.push(["remove", id]) },
    debugger: {
      ...debuggerEvents,
      detach: async () => calls.push(["detach"]),
      sendCommand: (_target, method) => {
        calls.push(["send", method]);
        return new Promise(() => {}); // Chrome never answers
      },
    },
  };
  return calls;
}

test("every command has a response deadline, longer for a navigation", async () => {
  assert.ok(commandTimeoutMs("Runtime.evaluate") > 0);
  assert.ok(commandTimeoutMs("Page.navigate") > commandTimeoutMs("Runtime.evaluate"));
  hangingChrome();
  await assert.rejects(new Tab(1, scripts).send("Runtime.evaluate", {}, { timeoutMs: 20 }), TimeoutError);
});

test("a command that timed out is not repeated, even a retryable read", async () => {
  const calls = hangingChrome();
  const tab = new Tab(1, scripts);
  await assert.rejects(tab.send("Runtime.evaluate", {}, { retryable: true, timeoutMs: 20 }), TimeoutError);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1);
});

test("Stop fails the command in flight at once and closes the query window", async () => {
  const calls = hangingChrome();
  const tab = new Tab(1, scripts);
  tab.windowId = 9;
  const pending = tab.send("Input.dispatchMouseEvent", {});
  const outcome = assert.rejects(pending, AbortedError);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await tab.abort();
  await outcome;
  assert.deepEqual(calls.filter(([kind]) => kind !== "send"), [["detach"], ["remove", 9]]);
  await assert.rejects(tab.send("Runtime.evaluate", {}), AbortedError);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1); // nothing more is sent after Stop
});

test("a JavaScript dialog is answered so it cannot hang the run", async () => {
  const listeners = [];
  const handled = [];
  globalThis.chrome = {
    debugger: {
      onDetach: noEvents,
      onEvent: { addListener: (fn) => listeners.push(fn), removeListener() {} },
      sendCommand: async (_target, method, params) => void (method === "Page.handleJavaScriptDialog" && handled.push(params)),
    },
  };
  new Tab(1, scripts);
  const [onEvent] = listeners;
  onEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "alert" });
  onEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "confirm" });
  onEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "beforeunload" });
  onEvent({ tabId: 2 }, "Page.javascriptDialogOpening", { type: "alert" }); // another tab: not ours
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(handled, [{ accept: false }, { accept: false }, { accept: true }]);
});

test("attaching enables the Page domain, which is what reports dialogs", async () => {
  const state = detachingChrome({ alive: true });
  state.failNext = false;
  await new Tab(1, scripts)._attach();
  assert.ok(state.sent.includes("Page.enable"));
});

function sessionChrome() {
  const store = {};
  const removed = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (values) => Object.assign(store, values),
      },
    },
    windows: {
      create: async () => ({ id: 9, tabs: [{ id: 5 }] }),
      remove: async (id) => {
        if (id === 404) throw new Error("No window with id");
        removed.push(id);
      },
    },
    debugger: { ...debuggerEvents, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: "complete" } }) },
  };
  return { store, removed };
}

test("the query window is remembered while it is open and forgotten when the tab closes", async () => {
  const { store } = sessionChrome();
  const tab = await Tab.open("https://www.traderie.com/diablo2resurrected", { snapshot: "(() => ({}))()", settle: "(() => 1)" });
  assert.deepEqual(Object.values(store), [[9]]);
  await tab.close();
  assert.deepEqual(Object.values(store), [[]]);
});

test("windows a dead side panel left behind are closed, and ones already gone do not matter", async () => {
  const { store, removed } = sessionChrome();
  store.jevWindows = [404, 12, "x"];
  await closeStaleWindows();
  assert.deepEqual(removed, [12]);
  assert.deepEqual(store.jevWindows, []);
});

test("a window that opens without a tab is closed and reported instead of crashing", async () => {
  const { removed } = sessionChrome();
  chrome.windows.create = async () => ({ id: 9 });
  await assert.rejects(Tab.open("https://www.traderie.com/diablo2resurrected", scripts), /查詢視窗/);
  assert.deepEqual(removed, [9]);
});

test("input is never repeated after the target is lost", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  await assert.rejects(tab.send("Input.dispatchMouseEvent", {}), /target_closed/);
  assert.equal(state.sent.filter((m) => m === "Input.dispatchMouseEvent").length, 1);
});

test("a closed tab is not re-attached", async () => {
  const state = detachingChrome({ alive: false });
  const tab = new Tab(1, scripts);
  await assert.rejects(tab.evaluate("1"), /target_closed/);
  assert.equal(state.attaches, 0);
});

test("a detach between two commands re-attaches before the next command, input included", async () => {
  const state = detachingChrome({ alive: true });
  state.failNext = false;
  const tab = new Tab(1, scripts);
  state.listener({ tabId: 1 }, "target_closed"); // Chrome swapped the page while nothing was running
  await tab.send("Input.dispatchMouseEvent", {});
  assert.equal(state.attaches, 1);
  assert.equal(state.sent.filter((m) => m === "Input.dispatchMouseEvent").length, 1);
});

test("a user cancel is never re-attached", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  state.listener({ tabId: 1 }, "canceled_by_user");
  await assert.rejects(tab.send("Runtime.evaluate", {}), /canceled_by_user/);
  assert.equal(state.attaches, 0);
});

/**
 * A virtual clock: `sleep`/timeouts still resolve, but time moves only when a timer is due and never by waiting on the
 * wall clock. Timers fire in due-time order after the microtask queue drains (like the real event loop), so a promise
 * that resolves first still clears its own deadline first. Restore it in a finally block.
 */
function fakeClock(start = 100000) {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    dateNow: Date.now,
    perfNow: performance.now,
  };
  let now = start;
  let seq = 0;
  let queued = false;
  const timers = new Map();

  const fireEarliest = () => {
    queued = false;
    let next = null;
    for (const timer of timers.values()) {
      if (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
    }
    if (!next) return;
    timers.delete(next.id);
    now = Math.max(now, next.at);
    next.fn(...next.args);
    queue();
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    setImmediate(fireEarliest);
  };
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const timer = { id: (seq += 1), fn, args, at: now + Math.max(Number(ms) || 0, 0) };
    timers.set(timer.id, timer);
    queue();
    return timer;
  };
  globalThis.clearTimeout = (timer) => timers.delete(timer?.id);
  Date.now = () => now;
  performance.now = () => now;

  return {
    pending: () => timers.size,
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      Date.now = real.dateNow;
      performance.now = real.perfNow;
    },
  };
}

test("navigate returns the interactive-grace result only after the grace has elapsed", async () => {
  const sent = [];
  globalThis.chrome = {
    debugger: {
      ...debuggerEvents,
      sendCommand: async (_target, method, params) => {
        sent.push([method, params?.expression]);
        return method === "Runtime.evaluate" ? { result: { value: "interactive" } } : { result: {} };
      },
    },
  };
  const clock = fakeClock();
  try {
    const tab = new Tab(1, scripts);
    // The page sits at "interactive" forever; grace 50 ms means the 4th poll at t+60 crosses it (polls at 0/20/40/60).
    const result = await tab.navigate("https://www.traderie.com/diablo2resurrected", 10000, 50);
    assert.deepEqual(result, { how: "interactive_grace", ms: 60 });
    assert.equal(
      sent.filter(([method, expression]) => method === "Runtime.evaluate" && expression === "document.readyState").length,
      4,
    );
  } finally {
    clock.restore();
  }
});

test("waitUntilReady keeps polling until a later poll reports the page ready", async () => {
  let polls = 0;
  globalThis.chrome = {
    debugger: {
      ...debuggerEvents,
      sendCommand: async (_target, method) => {
        if (method !== "Runtime.evaluate") return { result: {} };
        polls += 1;
        return { result: { value: polls >= 3 } };
      },
    },
  };
  const clock = fakeClock();
  try {
    const tab = new Tab(1, scripts);
    assert.equal(await tab.waitUntilReady(2000, 50), true);
    assert.equal(polls, 3);
  } finally {
    clock.restore();
  }
});

test("waitUntilReady gives up at its deadline and reports the page was not ready", async () => {
  let polls = 0;
  globalThis.chrome = {
    debugger: {
      ...debuggerEvents,
      sendCommand: async (_target, method) => {
        if (method === "Runtime.evaluate") polls += 1;
        return { result: { value: false } };
      },
    },
  };
  const clock = fakeClock();
  try {
    const tab = new Tab(1, scripts);
    assert.equal(await tab.waitUntilReady(100, 50), false);
    assert.equal(polls, 3); // t+0, t+50, t+100: the deadline check ends it after the third poll
  } finally {
    clock.restore();
  }
});

test("observe repeats a snapshot the navigation interrupted and reports both timing fields", async () => {
  const expressions = [];
  globalThis.chrome = {
    debugger: {
      ...debuggerEvents,
      sendCommand: async (_target, method, params) => {
        expressions.push(params?.expression);
        if (expressions.length === 1) throw new Error("Execution context was destroyed.");
        return {
          result: { value: { url: "https://www.traderie.com/diablo2resurrected", text: "hi", actions: [], scroll: 0, marker: ["m"] } },
        };
      },
    },
  };
  const clock = fakeClock();
  try {
    const tab = new Tab(1, { snapshot: "SNAPSHOT" });
    const info = await tab.observe();
    assert.deepEqual(expressions, ["SNAPSHOT", "SNAPSHOT"]); // the interrupted read is retried exactly once
    assert.deepEqual(info.marker, ["m"]);
    assert.deepEqual(info.timing, { after_input_ms: null, snapshot_ms: 20 }); // the retry's 20 ms sleep is the measured cost
    assert.match(info.fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    clock.restore();
  }
});

function settlingChrome() {
  const store = {};
  const calls = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (values) => Object.assign(store, values),
      },
    },
    windows: {
      create: async () => ({ id: 9, tabs: [{ id: 5 }] }),
      remove: async (id) => calls.push(["remove", id]),
    },
    debugger: {
      ...debuggerEvents,
      attach: async () => calls.push(["attach"]),
      detach: async () => calls.push(["detach"]),
      sendCommand: async (_target, method, params) => {
        if (method !== "Runtime.evaluate") return { result: {} };
        if (params.expression === "document.readyState") return { result: { value: "complete" } };
        return { result: { value: { capped: true, ms: 4321, visibility: "hidden" } } };
      },
    },
  };
  return { store, calls };
}

test("the settle measurement the tab opened with is recorded where the caller reads it", async () => {
  settlingChrome();
  const clock = fakeClock();
  try {
    const tab = await Tab.open("https://www.traderie.com/diablo2resurrected", { snapshot: "(() => ({}))()", settle: "SETTLE_SCRIPT" });
    assert.deepEqual(Object.keys(tab.openTiming).sort(), ["navigate", "settle"]);
    assert.deepEqual(tab.openTiming.settle, { capped: true, ms: 4321, visibility: "hidden" });
    assert.deepEqual(tab.openTiming.navigate, { how: "complete", ms: 0 });
  } finally {
    clock.restore();
  }
});

test("closing a tab releases its window bookkeeping and a second close does nothing", async () => {
  const { store, calls } = settlingChrome();
  const tab = await Tab.open("https://www.traderie.com/diablo2resurrected", { snapshot: "(() => ({}))()", settle: "SETTLE_SCRIPT" });
  assert.deepEqual(store.jevWindows, [9]);
  assert.equal(tab.windowId, 9);
  await tab.close();
  assert.equal(tab.windowId, null);
  assert.deepEqual(store.jevWindows, []);
  await tab.close(); // the debugger and the window are already released; nothing is sent again
  assert.deepEqual(calls.filter(([kind]) => kind !== "attach"), [["detach"], ["remove", 9]]);
  assert.deepEqual(store.jevWindows, []);
});

test("a command in flight when the tab is aborted fails with AbortedError and its deadline is retired", async () => {
  const store = {};
  const calls = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (values) => Object.assign(store, values),
      },
    },
    windows: { remove: async (id) => calls.push(["remove", id]) },
    debugger: { ...debuggerEvents, detach: async () => calls.push(["detach"]), sendCommand: () => new Promise(() => {}) },
  };
  const clock = fakeClock();
  try {
    const tab = new Tab(1, scripts);
    tab.windowId = 9;
    const failure = tab.send("Input.dispatchMouseEvent", {}).then(() => null, (error) => error);
    await tab.abort();
    const error = await failure;
    assert.ok(error instanceof AbortedError);
    assert.equal(error.message, "查詢已停止");
    assert.deepEqual(calls, [["detach"], ["remove", 9]]);
    assert.equal(clock.pending(), 0); // the command's 30 s deadline was cleared, so nothing fires later
    await assert.rejects(tab.send("Runtime.evaluate", {}), AbortedError);
    assert.equal(calls.length, 2); // and after Stop nothing more is sent
  } finally {
    clock.restore();
  }
});
