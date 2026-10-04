// Port of core/jev_ultrafast/browser.py (Browser + browser_operation) onto chrome.debugger.
// chrome.* is only touched inside functions, never at import time.

import { StalePage, TimeoutError } from "./errors.js";

const VIEWPORT_WIDTH = 1120;
const VIEWPORT_HEIGHT = 780;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loadPageScripts() {
  const read = async (name) => {
    const response = await fetch(chrome.runtime.getURL(`page/${name}`));
    return (await response.text()).trim();
  };
  const [snapshot, afterInput, resolveTarget, settle, settledPage] = await Promise.all([
    read("snapshot.js"),
    read("after_input.js"),
    read("resolve_target.js"),
    read("settle.js"),
    read("settled_page.js"),
  ]);
  return { snapshot, afterInput, resolveTarget, settle, settledPage };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function fingerprint(state) {
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
    this.afterInput = null;
    this.marker = `(() => { const state=${scripts.snapshot}; return state?.marker ?? null; })()`;
    this.reattaches = 0;
    this.detachReason = "";
    this._onDetach = (source, reason) => {
      if (source.tabId === this.tabId) {
        this.detached = true;
        this.detachReason = reason ?? "";
      }
    };
    chrome.debugger.onDetach.addListener(this._onDetach);
  }

  /** Opens the page in its own minimized window: nothing covers or steals focus from what the user is doing. */
  static async open(url, scripts) {
    // Straight to the target URL: another extension may take over an about:blank window (new-tab pages etc.).
    const created = await chrome.windows.create({ url, state: "minimized" });
    const tab = new Tab(created.tabs[0].id, scripts);
    tab.windowId = created.id;
    try {
      await tab._attach();
      await tab.navigate(url);
      await tab.settle();
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
      if (/different extension/i.test(error?.message ?? "")) {
        throw new Error("你的 Chrome 有其他擴充功能接管了查詢視窗。請暫時停用其他擴充功能，或改用乾淨的 Chrome 使用者設定檔再試");
      }
      throw error;
    }
    this.detached = false;
    this.detachReason = "";
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  /**
   * target_closed with the tab still alive means Chrome swapped the page's process (the tab itself stays).
   * Re-attach once per swap, at most 6 times a query. A user cancel or a closed tab is never recovered.
   */
  async _recover() {
    if (this.detachReason !== "target_closed" || this.reattaches >= 6) return false;
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

  async send(method, params = {}) {
    // Detached between two commands: nothing of this command was sent yet, so re-attaching first is safe.
    if (this.detached && !(await this._recover())) throw this._detachedError(method);
    try {
      return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
    } catch (error) {
      // Chrome rejects the in-flight command before onDetach fires.
      if (/detached/i.test(error?.message ?? "")) {
        this.detached = true;
        await new Promise((resolve) => setTimeout(resolve, 100)); // onDetach carries the reason and fires just after
      }
      if (!this.detached) throw error;
      // The command may have run: repeat only commands that change nothing (reads and viewport), never input.
      if (/^(Runtime\.evaluate|Emulation\.)/.test(method) && (await this._recover())) return this.send(method, params);
      throw this._detachedError(method);
    }
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (response?.exceptionDetails) throw new StalePage("Document changed during evaluation");
    return response?.result?.value;
  }

  async settle(quietMs = 600, timeoutMs = 15000, minChars = 100) {
    await this.evaluate(`${this.scripts.settle}(${quietMs}, ${timeoutMs}, ${minChars})`, { awaitPromise: true });
  }

  async readSettledPage(quietMs = 500, timeoutMs = 5000) {
    const page = await this.evaluate(`${this.scripts.settledPage}(${quietMs}, ${timeoutMs})`, {
      awaitPromise: true,
    });
    if (!page || typeof page.url !== "string") throw new TimeoutError("頁面沒有穩定下來");
    return page;
  }

  async navigate(url, timeoutMs = 30000, interactiveGraceMs = 1500) {
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    let interactiveSince = null;
    while (Date.now() < deadline) {
      const state = await this.evaluate("document.readyState");
      if (state === "complete") return;
      if (state === "interactive") {
        if (interactiveSince === null) interactiveSince = Date.now();
        if (Date.now() - interactiveSince >= interactiveGraceMs) return;
      }
      await sleep(20);
    }
    throw new TimeoutError(`Navigation to ${url} did not finish`);
  }

  async waitUntilReady(timeoutMs = 2000, intervalMs = 50) {
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      try {
        if (await this.evaluate("document.readyState === 'complete' && !!document.body")) return true;
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
      }
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  async observe() {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = null;
      // Read-only, after execution was logged; navigation may interrupt it.
      try {
        await this.send("Runtime.evaluate", {
          expression: `${this.scripts.afterInput}(${JSON.stringify(action)})`,
          awaitPromise: true,
          returnByValue: true,
        });
      } catch (error) {
        if (this.detached) throw error;
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const info = await this.evaluate(this.scripts.snapshot);
        if (info === null || info === undefined) throw new StalePage("Document is navigating");
        info.fingerprint = await fingerprint(info);
        return info;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 9) throw error;
        await sleep(20);
      }
    }
    throw new StalePage("Page did not settle");
  }

  async fresh(page, action = null) {
    if (action && ["click", "select", "fill"].includes(action.kind)) {
      const node = action.node;
      if (!Number.isInteger(node)) return false;
      const current = await this.evaluate(
        "(() => { const c=window.__jevFast; " +
          `return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      );
      return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(node)]]);
    }
    // The marker is an array: compare by value, never by identity.
    return JSON.stringify(await this.evaluate(this.marker)) === JSON.stringify(page.marker);
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
    if (!Number.isInteger(action.node)) throw new Error("Invalid observed node");
    // Code-owned node ids refer to actual observed elements, never model-generated selectors.
    let target;
    try {
      target = await this.evaluate(`${this.scripts.resolveTarget}(${JSON.stringify(action)})`);
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
    if (kind === "select") return;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
    }
    if (kind === "fill") {
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
  }

  /** Detach the debugger and close the minimized window this Tab opened. */
  async close() {
    chrome.debugger.onDetach.removeListener(this._onDetach);
    if (!this.detached) {
      this.detached = true;
      try {
        await chrome.debugger.detach({ tabId: this.tabId });
      } catch {
        // already detached
      }
    }
    if (this.windowId !== null && this.windowId !== undefined) {
      const windowId = this.windowId;
      this.windowId = null;
      try {
        await chrome.windows.remove(windowId);
      } catch {
        // the user already closed it
      }
    }
  }
}
