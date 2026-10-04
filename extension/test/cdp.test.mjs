import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.chrome = { debugger: { onDetach: { addListener() {}, removeListener() {} } } };
const { Tab } = await import("../src/cdp.js");

const scripts = { snapshot: "(() => ({}))()" };

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
      onDetach: { addListener() {}, removeListener() {} },
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

function detachingChrome({ alive }) {
  const state = { sent: [], attaches: 0, listener: null, failNext: true };
  globalThis.chrome = {
    tabs: { get: async () => (alive ? { id: 1 } : Promise.reject(new Error("No tab"))) },
    debugger: {
      onDetach: { addListener: (fn) => (state.listener = fn), removeListener() {} },
      attach: async () => void (state.attaches += 1),
      sendCommand: async (_target, method) => {
        state.sent.push(method);
        if (state.failNext && (method === "Runtime.evaluate" || method === "Input.dispatchMouseEvent")) {
          state.failNext = false;
          setTimeout(() => state.listener({ tabId: 1 }, "target_closed"), 10);
          throw new Error("Detached while handling command.");
        }
        return { result: { value: "ok" } };
      },
    },
  };
  return state;
}

test("a read is repeated once on a re-attached tab when Chrome swaps the page target", async () => {
  const state = detachingChrome({ alive: true });
  const tab = new Tab(1, scripts);
  assert.equal(await tab.evaluate("1"), "ok");
  assert.equal(state.attaches, 1);
  assert.equal(state.sent.filter((m) => m === "Runtime.evaluate").length, 2);
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
