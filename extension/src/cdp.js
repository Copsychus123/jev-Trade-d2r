// Port of src/jev_ultrafast/browser.py (Browser + browser_operation) onto chrome.debugger.
// chrome.* is only touched inside functions, never at import time.

import { AbortedError, StalePage, TimeoutError } from "./errors.js";

const VIEWPORT_WIDTH = 1120;
const VIEWPORT_HEIGHT = 780;
const COMMAND_TIMEOUT_MS = 30000;
const NAVIGATE_TIMEOUT_MS = 60000;
const DIALOG_TIMEOUT_MS = 5000;
// How long `readyState` may sit at "interactive" before `navigate` stops waiting for "complete". Measured 2026-10 on
// the real side panel with an interleaved A/B (500 vs 1500, 3 runs each): the grace bound in 1 of 3 runs, while a
// product page always reached complete (~0.6-0.9 s). It only saves time when "complete" is slow: a bound navigate
// returned after ~1.08 s at 500 ms vs ~1.85 s at 1500 ms, i.e. roughly 1 s; when the page completes first the value
// changes nothing and the query total was within noise. The settle() that follows every navigate is the real content
// gate, so the grace only needs to be long enough to tell "still loading a document" from "loaded".
const NAVIGATE_INTERACTIVE_GRACE_MS = 500;
const WINDOWS_KEY = "jevWindows"; // chrome.storage.session: query windows that are open right now
// What Chrome reports when a navigation or process swap destroys the page a script was running in.
const NAVIGATION_FAILURE = /Execution context was destroyed|Cannot find context|Inspected target navigated/i;
// The action kinds the page's own guards can go stale on: they name an observed node, so a page change invalidates them.
const INPUT_KINDS = ["click", "select", "fill"];
const SNAPSHOT_ATTEMPTS = 10; // a snapshot a navigation interrupted is retried this many times at most

/** The text a failure carries; a CDP protocol error has no message. */
const messageOf = (error) => error?.message ?? "";

/** A navigation or process swap tearing down the page's context is a stale page, not a real failure. */
const isNavigationFailure = (message) => NAVIGATION_FAILURE.test(message);

/** How long Chrome may take to answer a command before the run gives up on it. */
export const commandTimeoutMs = (method) => (method === "Page.navigate" ? NAVIGATE_TIMEOUT_MS : COMMAND_TIMEOUT_MS);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a read that a navigation may interrupt; a StalePage means the old document is gone, not a failure. */
const ignoringStalePage = async (read) => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StalePage) return null;
    throw error;
  }
};

/** Compares by value, never by identity: the page's own markers and guards are arrays. */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The expression that calls an injected page script (one arrow function) with JSON-encoded arguments. */
const pageCall = (script, ...args) => `${script}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

/** A page read that waits for its promise and, being read-only, survives a swapped target. */
const AWAITED_READ = { awaitPromise: true, retryable: true };

/** Runs a chrome.* call that may fail because the thing is already gone; never throws. */
const quiet = async (call) => {
  try {
    await call();
  } catch {
    // already gone
  }
};

/** Closes a query window that may already be gone. */
const closeWindow = (id) => quiet(() => chrome.windows.remove(id));

async function readWindows() {
  const stored = await chrome.storage.session.get(WINDOWS_KEY);
  return Array.isArray(stored[WINDOWS_KEY]) ? stored[WINDOWS_KEY].filter(Number.isInteger) : [];
}

/** Rewrites the open-window list from its current value; a dead session storage is not an error. */
const updateWindows = (change) =>
  quiet(async () => chrome.storage.session.set({ [WINDOWS_KEY]: change(await readWindows()) }));

const rememberWindow = (id) => updateWindows((windows) => [...windows, id]);

const forgetWindow = (id) => updateWindows((windows) => windows.filter((w) => w !== id));

/**
 * Closes query windows left behind when the side panel died mid-run (session storage lives as long as the browser, so
 * ids from before a browser restart are never read back). The caller makes sure no other panel owns a window.
 */
export async function closeStaleWindows() {
  const ids = await readWindows();
  await Promise.all(ids.map(closeWindow));
  await chrome.storage.session.set({ [WINDOWS_KEY]: [] });
}

// The page scripts the run injects, in the order `loadPageScripts` fetches them.
const PAGE_SCRIPT_FILES = {
  snapshot: "snapshot.js",
  afterInput: "after_input.js",
  resolveTarget: "resolve_target.js",
  coveredOverlay: "covered_overlay.js",
  settle: "settle.js",
  settledPage: "settled_page.js",
  fetchJson: "fetch_json.js",
  postForm: "post_form.js",
};

async function readPageScript(name) {
  const response = await fetch(chrome.runtime.getURL(`page/${name}`));
  return (await response.text()).trim();
}

export async function loadPageScripts() {
  const entries = await Promise.all(
    Object.entries(PAGE_SCRIPT_FILES).map(async ([key, file]) => [key, await readPageScript(file)]),
  );
  return Object.fromEntries(entries);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function fingerprint(state) {
  const { url, text, actions, scroll } = state;
  const bytes = new TextEncoder().encode(stableStringify({ url, text, actions, scroll }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Tab {
  constructor(tabId, scripts) {
    this.tabId = tabId;
    this.scripts = scripts;
    this.detached = false;
    this.aborted = false;
    this.afterInput = null;
    this.marker = `(() => { const state=${scripts.snapshot}; return state?.marker ?? null; })()`;
    this.reattaches = 0;
    this.detachReason = "";
    this._pending = new Set(); // reject functions of the commands in flight: Stop fails them at once
    this._onDetach = (source, reason) => {
      if (source.tabId === this.tabId) {
        this.detached = true;
        this.detachReason = reason ?? "";
      }
    };
    // An open alert/confirm/prompt/beforeunload dialog blocks the page's JavaScript, so every command would hang.
    this._onEvent = (source, method, params) => {
      if (source.tabId !== this.tabId || method !== "Page.javascriptDialogOpening") return;
      // beforeunload is the page asking to stay while a navigation the run (or the page) started is under way: leave.
      // Everything else is dismissed, never confirmed.
      this._command("Page.handleJavaScriptDialog", { accept: params?.type === "beforeunload" }, DIALOG_TIMEOUT_MS).catch(
        () => {},
      );
    };
    chrome.debugger.onDetach.addListener(this._onDetach);
    chrome.debugger.onEvent.addListener(this._onEvent);
  }

  /** Opens the page in its own minimized window: nothing covers or steals focus from what the user is doing. */
  static async open(url, scripts) {
    // Straight to the target URL: another extension may take over an about:blank window (new-tab pages etc.).
    const created = await chrome.windows.create({ url, state: "minimized" });
    const first = created.tabs?.[0];
    if (!first) {
      await closeWindow(created.id);
      throw new Error("Chrome 沒有開出查詢視窗，查詢已停止");
    }
    await rememberWindow(created.id);
    const tab = new Tab(first.id, scripts);
    tab.windowId = created.id;
    try {
      await tab._attach();
      const navigate = await tab.navigate(url);
      // Measurement only (read-only): a minimized window may count as hidden, which slows page timers. visibility is
      // carried by settle.js, which already ran on the page, so no extra round trip is spent on it.
      const settle = await tab.settle();
      tab.openTiming = { navigate, settle };
    } catch (error) {
      await tab.close().catch(() => {});
      throw error;
    }
    return tab;
  }

  /** Attaches the debugger and applies the viewport; also used to recover when Chrome swaps the page's target. */
  async _attach() {
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
    } catch (error) {
      if (/different extension/i.test(messageOf(error))) {
        throw new Error("你的 Chrome 有其他擴充功能接管了查詢視窗。請暫時停用其他擴充功能，或改用乾淨的 Chrome 使用者設定檔再試");
      }
      throw error;
    }
    this.detached = false;
    this.detachReason = "";
    // Viewport and event setup change nothing on the page: safe to repeat if the target is swapped again.
    await this.send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      { retryable: true },
    );
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { retryable: true });
    await this.send("Page.enable", {}, { retryable: true });
  }

  /**
   * target_closed with the tab still alive means Chrome swapped the page's process (the tab itself stays).
   * Re-attach once per swap, at most 6 times a query. A user cancel or a closed tab is never recovered.
   */
  async _recover() {
    if (this.aborted || this.detachReason !== "target_closed" || this.reattaches >= 6) return false;
    const alive = await chrome.tabs.get(this.tabId).then(() => true, () => false);
    if (!alive) return false;
    this.reattaches += 1;
    await this._attach();
    return true;
  }

  _detachedError(method) {
    const reason = this.detachReason ? `，原因 ${this.detachReason}` : "";
    return new Error(`偵錯連線已關閉（執行 ${method} 時${reason}），查詢已停止`);
  }

  /** One command with a response deadline. Stop (`abort`) rejects it at once instead of waiting for Chrome. */
  async _command(method, params, timeoutMs) {
    let timer;
    let cancel;
    const guard = new Promise((_, reject) => {
      cancel = reject;
      this._pending.add(cancel);
      timer = setTimeout(
        () => reject(new TimeoutError(`Chrome 在 ${Math.round(timeoutMs / 1000)} 秒內沒有回應（${method}），查詢已停止`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([chrome.debugger.sendCommand({ tabId: this.tabId }, method, params), guard]);
    } finally {
      clearTimeout(timer);
      this._pending.delete(cancel);
    }
  }

  /**
   * `retryable` is set only by callers whose command changes nothing on the page (reads, viewport). When the target is
   * swapped under such a command it is repeated once on the re-attached tab; every other command fails instead,
   * because it may already have run (never retry a browser mutation).
   */
  async send(method, params = {}, { retryable = false, timeoutMs = commandTimeoutMs(method) } = {}) {
    if (this.aborted) throw new AbortedError();
    // Detached between two commands: nothing of this command was sent yet, so re-attaching first is safe.
    if (this.detached && !(await this._recover())) throw this._detachedError(method);
    try {
      return await this._command(method, params, timeoutMs);
    } catch (error) {
      if (this.aborted || error instanceof TimeoutError) throw error;
      // Chrome rejects the in-flight command before onDetach fires.
      if (/detached/i.test(messageOf(error))) {
        this.detached = true;
        await sleep(100); // onDetach carries the reason and fires just after
      }
      if (!this.detached) throw error;
      if (retryable && (await this._recover())) return this.send(method, params, { retryable, timeoutMs });
      throw this._detachedError(method);
    }
  }

  /**
   * Runs a page expression. Only a failure caused by navigation (the document or its context went away) is a
   * StalePage; any other exception is a real error that carries the page's own description of it.
   */
  async evaluate(expression, { awaitPromise = false, retryable = false } = {}) {
    let response;
    try {
      response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, { retryable });
    } catch (error) {
      if (isNavigationFailure(messageOf(error))) throw new StalePage(error.message);
      throw error;
    }
    const details = response?.exceptionDetails;
    if (!details) return response?.result?.value;
    const description = details.exception?.description ?? details.text ?? "unknown exception";
    if (isNavigationFailure(description)) throw new StalePage(description);
    throw new Error(`頁面腳本發生錯誤：${description}`);
  }

  /** Resolves { capped, ms, visibility } (settle.js): whether the cap ended the wait, how long it took, and the document's visibility state. */
  async settle(quietMs = 600, timeoutMs = 15000, minChars = 100) {
    return this.evaluate(pageCall(this.scripts.settle, quietMs, timeoutMs, minChars), AWAITED_READ);
  }

  async readSettledPage(quietMs = 500, timeoutMs = 5000) {
    const page = await this.evaluate(pageCall(this.scripts.settledPage, quietMs, timeoutMs), AWAITED_READ);
    if (!page || typeof page.url !== "string") throw new TimeoutError("頁面沒有穩定下來");
    return page;
  }

  /** A retryable page read whose StalePage the poll loops below simply ignore and re-read. */
  async _readStable(expression) {
    return ignoringStalePage(() => this.evaluate(expression, { retryable: true }));
  }

  /** Resolves { how: "complete" | "interactive_grace", ms } for measurement; callers may ignore it. */
  async navigate(url, timeoutMs = 30000, interactiveGraceMs = NAVIGATE_INTERACTIVE_GRACE_MS) {
    const started = performance.now();
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    let interactiveSince = null;
    while (Date.now() < deadline) {
      const state = await this._readStable("document.readyState");
      if (state === "complete") return { how: "complete", ms: Math.round(performance.now() - started) };
      if (state === "interactive") {
        if (interactiveSince === null) interactiveSince = Date.now();
        if (Date.now() - interactiveSince >= interactiveGraceMs) {
          return { how: "interactive_grace", ms: Math.round(performance.now() - started) };
        }
      }
      await sleep(20);
    }
    throw new TimeoutError(`Navigation to ${url} did not finish`);
  }

  async waitUntilReady(timeoutMs = 2000, intervalMs = 50) {
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      const complete = await this._readStable("document.readyState === 'complete' && !!document.body");
      if (complete) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /**
   * Runs the pending after-input read and clears it. Read-only, after execution was logged, so a navigation that
   * interrupts it is ignored here rather than reported.
   */
  async _runAfterInput() {
    const action = this.afterInput;
    this.afterInput = null;
    try {
      await this.send(
        "Runtime.evaluate",
        { expression: pageCall(this.scripts.afterInput, action), awaitPromise: true, returnByValue: true },
        { retryable: true },
      );
    } catch (error) {
      if (this.detached) throw error;
    }
  }

  async observe() {
    const started = performance.now();
    let afterInputMs = null;
    if (this.afterInput) {
      await this._runAfterInput();
      afterInputMs = Math.round(performance.now() - started);
    }
    const snapshotStarted = performance.now();
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
      try {
        const info = await this.evaluate(this.scripts.snapshot, { retryable: true });
        if (info === null || info === undefined) throw new StalePage("Document is navigating");
        info.fingerprint = await fingerprint(info);
        // Measurement only: the fingerprint above and the request to Jev (api.js) never read it.
        info.timing = { after_input_ms: afterInputMs, snapshot_ms: Math.round(performance.now() - snapshotStarted) };
        return info;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === SNAPSHOT_ATTEMPTS - 1) throw error;
        await sleep(20);
      }
    }
  }

  async fresh(page, action = null) {
    if (action && INPUT_KINDS.includes(action.kind)) {
      const node = action.node;
      if (!Number.isInteger(node)) return false;
      const current = await this.evaluate(
        "(() => { const c=window.__jevFast; " +
          `return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
        { retryable: true },
      );
      return sameValue(current, [page.page_key, page.guards[String(node)]]);
    }
    return sameValue(await this.evaluate(this.marker, { retryable: true }), page.marker);
  }

  async act(action, page, text = null) {
    if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision. Observe again.");
    if (action.kind === "wait") await sleep(4000);
    await this._operate(action, text);
    this.afterInput = action.kind !== "wait" ? action : null;
    return { executed: action.id };
  }

  async _operate(action, text) {
    const kind = action.kind;
    if (kind === "scroll") {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 550,
        y: 650,
        deltaX: 0,
        deltaY: action.delta,
      });
      return;
    }
    if (kind === "wait") return;
    const target = await this._resolveTarget(action, kind);
    if (kind === "select") return;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
    }
    if (kind === "fill") await this._selectAllThenType(text);
  }

  /**
   * The click point of the action's code-owned node id: actual observed elements, never model-generated selectors.
   * The read is not retryable — it decides where the click lands, so a swapped target must go back to observe.
   */
  async _resolveTarget(action, kind) {
    if (!Number.isInteger(action.node)) throw new Error("Invalid observed node");
    let target;
    try {
      target = await this.evaluate(pageCall(this.scripts.resolveTarget, action));
    } catch (error) {
      if (error instanceof StalePage && kind === "select") {
        throw new Error("下拉選單操作被中斷，查詢已停止");
      }
      throw error;
    }
    if (target === null || target === undefined) {
      if (kind === "select") throw new Error("下拉選單操作無法確認，查詢已停止");
      throw new StalePage("Target changed or is covered. Observe again.");
    }
    return target;
  }

  /** Replaces the focused field's content: select everything first, then insert `text` as one paste-like event. */
  async _selectAllThenType(text) {
    const modifiers = navigator.userAgentData?.platform === "macOS" ? 4 : 2;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers,
      commands: ["selectAll"],
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
    await this.send("Input.insertText", { text });
  }

  /**
   * Whether a full-viewport fixed overlay (a pop-up) covers the action's target, measured once in the page. The stop
   * message uses it to tell the player what to do; it clicks nothing and names no site element, and a page that
   * cannot answer simply reports nothing.
   */
  async overlayCover(action) {
    return this.evaluate(pageCall(this.scripts.coveredOverlay, action));
  }

  /**
   * Stop, or the panel going away: commands in flight fail at once (Chrome may take a long time to answer a hung
   * page) and the query window is closed. Nothing is sent to the page afterwards.
   */
  abort() {
    this.aborted = true;
    for (const cancel of [...this._pending]) cancel(new AbortedError());
    return this.close();
  }

  /**
   * Detach the debugger and close the minimized window this Tab opened. Both calls start at once (this also runs
   * from a `pagehide` handler, where nothing after the first await is certain to happen).
   */
  async close() {
    chrome.debugger.onDetach.removeListener(this._onDetach);
    chrome.debugger.onEvent.removeListener(this._onEvent);
    const work = [];
    if (!this.detached) {
      this.detached = true;
      work.push(quiet(() => chrome.debugger.detach({ tabId: this.tabId })));
    }
    const windowId = this.windowId;
    if (windowId !== null && windowId !== undefined) {
      this.windowId = null;
      work.push(closeWindow(windowId));
      work.push(forgetWindow(windowId));
    }
    await Promise.all(work);
  }
}
