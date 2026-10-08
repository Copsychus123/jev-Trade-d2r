import assert from "node:assert/strict";
import { test } from "node:test";

const noEvents = { addListener() {}, removeListener() {} };
globalThis.chrome = { debugger: { onDetach: noEvents, onEvent: noEvents } };
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
      onDetach: noEvents,
      onEvent: noEvents,
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
      onDetach: noEvents,
      onEvent: noEvents,
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
        onDetach: noEvents,
        onEvent: noEvents,
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
      onDetach: noEvents,
      onEvent: noEvents,
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
    debugger: { onDetach: noEvents, onEvent: noEvents, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: "complete" } }) },
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
