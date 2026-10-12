// background.js is the whole service-worker file: it registers `enablePanel` on install and on startup, and that
// function asks Chrome to open the side panel when the toolbar icon is clicked. It exported nothing and no test
// imported it, so the two registrations, the exact option object and the swallowed rejection could all have been
// removed and every other test would still pass.
//
// This installs a recording (and locked-down) `chrome`, imports the real module with a cache-busting query so each
// test gets a fresh registration, and checks what the import touched. The chrome Proxy throws on any property the
// module did not need, so "nothing else is touched at import time" is proven, not assumed: the only reads are
// `chrome.runtime` and, once the listener fires, `chrome.sidePanel`.

import assert from "node:assert/strict";
import test from "node:test";

const realChrome = globalThis.chrome;

function makeChrome() {
  const reads = [];
  const behavior = [];
  const listeners = { installed: [], startup: [] };
  let result = Promise.resolve();

  const runtime = new Proxy(
    {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    },
    {
      get(target, prop) {
        if (typeof prop === "symbol") return target[prop];
        reads.push(`runtime.${prop}`);
        return target[prop];
      },
    },
  );

  const sidePanel = {
    setPanelBehavior: (options) => {
      behavior.push(options);
      return result;
    },
  };

  const chrome = new Proxy(
    { runtime, sidePanel },
    {
      get(target, prop) {
        if (typeof prop === "symbol") return target[prop];
        reads.push(String(prop));
        if (!(prop in target)) throw new Error(`unexpected chrome.${String(prop)}`);
        return target[prop];
      },
    },
  );

  return {
    chrome,
    reads,
    behavior,
    listeners,
    setResult: (value) => {
      result = value;
    },
  };
}

let boots = 0;
const flush = async (turns = 10) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

/** Imports a fresh copy of the real background.js against a fresh fake chrome. */
async function boot(t) {
  const fake = makeChrome();
  globalThis.chrome = fake.chrome;
  t.after(() => {
    if (realChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = realChrome;
  });
  boots += 1;
  await import(new URL(`../src/background.js?boot=${boots}`, import.meta.url).href);
  await flush();
  return fake;
}

test("importing background.js only registers the two listeners and never opens the panel yet", async (t) => {
  const fake = await boot(t);

  // The strict chrome Proxy already throws on any property outside {runtime, sidePanel}, so an unexpected read
  // fails the import by itself: pin only that the panel was not touched, not how often or in what order the two
  // properties were read (a `const { runtime, sidePanel } = chrome` refactor would change that harmlessly).
  assert.equal(fake.reads.includes("sidePanel"), false, "chrome.sidePanel is untouched until a listener fires");
  assert.equal(fake.listeners.installed.length, 1);
  assert.equal(fake.listeners.startup.length, 1);
  assert.equal(typeof fake.listeners.installed[0], "function");
  assert.equal(typeof fake.listeners.startup[0], "function");
  assert.deepEqual(fake.behavior, [], "setPanelBehavior runs when the event fires, not at import");
});

test("the install listener asks Chrome to open the side panel on a toolbar-icon click", async (t) => {
  const fake = await boot(t);

  fake.listeners.installed[0]();

  assert.deepEqual(fake.behavior, [{ openPanelOnActionClick: true }]);
  assert.ok(fake.reads.includes("sidePanel"), "the click reaches chrome.sidePanel");
});

test("the startup listener does the same", async (t) => {
  const fake = await boot(t);

  fake.listeners.startup[0]();

  assert.deepEqual(fake.behavior, [{ openPanelOnActionClick: true }]);
});

test("a setPanelBehavior rejection is swallowed, not left unhandled", async (t) => {
  // A real rejected promise, watched from inside the test: if the module removed `.catch`, the rejection surfaces
  // through the run's unhandled-rejection hook below and fails THIS test, rather than only the file at large.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const fake = await boot(t);
  fake.setResult(Promise.reject(new Error("no side panel on this Chrome")));

  fake.listeners.installed[0]();
  fake.listeners.startup[0]();
  await flush();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fake.behavior, [{ openPanelOnActionClick: true }, { openPanelOnActionClick: true }]);
  assert.deepEqual(unhandled, [], "every setPanelBehavior rejection must be caught by the module");
});
