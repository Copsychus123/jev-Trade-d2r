// The screenshot reader (ocr/panel.js) driven against a hand-built DOM. Nothing imported it in a test, so a change to
// the download notice, the candidate buttons, the supersede rule or the status wording could reach the player
// silently. The module takes its own collaborators internally (the model store via IndexedDB, the OCR engine via a
// Worker, the pixels via createImageBitmap/OffscreenCanvas), so this file injects those browser-only pieces as
// globalThis fakes and reads back exactly what the player would see: the notice text, the progress value, the status
// line and its kind, and the candidate buttons.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { initOcrPanel } from "../src/ocr/panel.js";
import { formatMB, PPOCR, PPOCR_FILES } from "../src/ocr/models.js";
import { indexTables } from "../src/traderie/lookup.js";

// --- the long timers ------------------------------------------------------------------------------------------
// The engine cache arms a 60 s idle timer and the model manager a 30 s stall timer. They only keep the node process
// alive when they can never fire (the fake worker answers at once), so long delays are recorded but not scheduled.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const swallowed = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms >= 30_000) {
    const handle = { swallowed: true };
    swallowed.add(handle);
    return handle;
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.clearTimeout = (handle) => {
  if (handle && handle.swallowed) {
    swallowed.delete(handle);
    return;
  }
  realClearTimeout(handle);
};

// --- a DOM just big enough for the panel ----------------------------------------------------------------------
// Every element the module reaches for by id, plus the members it touches. `fire`/`click` dispatch a listener so a
// test can be the player's click.
function makeElement(tagName = "div") {
  const element = {
    tagName,
    id: "",
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    textContent: "",
    naturalWidth: 640,
    onclick: null,
    dataset: {},
    style: {},
    attributes: new Map(),
    children: [],
    classes: new Set(),
    listeners: {},
  };
  element.classList = {
    add: (name) => element.classes.add(name),
    remove: (name) => element.classes.delete(name),
    toggle: (name, on) => {
      const want = on === undefined ? !element.classes.has(name) : on;
      if (want) element.classes.add(name);
      else element.classes.delete(name);
      return want;
    },
    contains: (name) => element.classes.has(name),
  };
  // showPreview() assigns `preview.src`, clearPreview() removes the attribute: mirror the two so an assertion on
  // getAttribute("src") can tell a cleared picture from one that was never cleared.
  Object.defineProperty(element, "src", {
    get: () => element.getAttribute("src"),
    set: (value) => element.setAttribute("src", value),
  });
  element.append = (...nodes) => element.children.push(...nodes);
  element.replaceChildren = (...nodes) => {
    element.children = [...nodes];
  };
  element.setAttribute = (name, value) => element.attributes.set(name, String(value));
  element.getAttribute = (name) => (element.attributes.has(name) ? element.attributes.get(name) : null);
  element.removeAttribute = (name) => element.attributes.delete(name);
  element.addEventListener = (type, handler) => (element.listeners[type] ??= []).push(handler);
  element.setPointerCapture = () => {};
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480 });
  element.click = () => element.fire("click");
  element.fire = (type, event = {}) => {
    const detail = {
      ...event,
      preventDefault() {
        detail.defaultPrevented = true;
      },
    };
    if (type === "click" && element.onclick) element.onclick(detail);
    for (const handler of element.listeners[type] ?? []) handler(detail);
    return detail;
  };
  return element;
}

const IDS = [
  "ocr-status",
  "ocr-candidates",
  "ocr-go",
  "ocr-auto",
  "ocr-file",
  "ocr-drop",
  "ocr-dropzone",
  "ocr-pick",
  "ocr-hint",
  "ocr-dot",
  "ocr-tag",
  "ocr-close",
  "ocr-cancel",
  "ocr-panel",
  "ocr-preview",
  "ocr-box",
  "ocr-time",
  "ocr-text",
  "ocr-download",
  "ocr-download-text",
  "ocr-progress",
  "item",
];

function makeDocument() {
  const byId = new Map(IDS.map((id) => [id, makeElement(id === "ocr-preview" ? "img" : "div")]));
  for (const [id, element] of byId) element.id = id;
  // The states sidepanel.html ships them in, so a missing "unhide" shows up as a test failure. `ocr-dot` is NOT in
  // here: the html ships it hidden but initPreferences sets it on every load, so seeding it hidden would make the
  // "the hint dot is gone once it was seen" assertion pass without the code (the not-seen case asserts it visible).
  for (const id of ["ocr-hint", "ocr-tag", "ocr-dropzone", "ocr-panel", "ocr-preview", "ocr-box", "ocr-download"]) {
    byId.get(id).hidden = true;
  }
  // sidepanel.html ships 辨識 disabled and hidden: a picture in the panel is what turns it on.
  byId.get("ocr-go").hidden = true;
  byId.get("ocr-go").disabled = true;
  const listeners = {};
  return {
    byId,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener: (type, handler) => (listeners[type] ??= []).push(handler),
    fire: (type, event = {}) => {
      const detail = { ...event, preventDefault() {} };
      for (const handler of listeners[type] ?? []) handler(detail);
      return detail;
    },
  };
}

// --- the browser-only globals the module's collaborators read -------------------------------------------------
let clock = 0;
globalThis.performance = { now: () => clock };

const revokedUrls = [];
let urlCount = 0;
globalThis.URL.createObjectURL = () => `blob:fake/${(urlCount += 1)}`;
globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);

// readPixels(): a decoded bitmap and a canvas; the canvas size records the region a read used.
const canvasSizes = [];
globalThis.createImageBitmap = async (blob) => ({
  width: blob.width ?? 640,
  height: blob.height ?? 480,
  close() {},
});
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    canvasSizes.push([width, height]);
  }
  getContext() {
    return {
      drawImage() {},
      getImageData: (x, y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    };
  }
};

// The real model manager checks each download against the pinned SHA-256 in PPOCR. The fake fetch below serves one
// deterministic buffer per model, and the pinned digest is repointed at those exact bytes, so `crypto.subtle.digest`
// hashes the bytes the manager actually hands it (node:crypto) instead of echoing a pinned value: the comparison is
// live on the real bytes, and a download whose content differs fails with a checksum ModelError (see the corrupt
// download test). Without this the digest fake would pass any bytes and only the size check would be exercised.
const serveBytes = (name) => new Uint8Array(PPOCR[name].bytes);
const digestHex = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const name of PPOCR_FILES) PPOCR[name].sha256 = digestHex(serveBytes(name));
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    subtle: { digest: async (_algorithm, bytes) => new Uint8Array(createHash("sha256").update(new Uint8Array(bytes)).digest()) },
  },
});

// chrome.storage.local: the preferences the panel reads and writes. `chrome.runtime.getURL` is only reached by the
// real worker loader, which the fake Worker below replaces.
let storageData = {};
function installChrome(data) {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of keys ?? []) if (key in data) out[key] = data[key];
          return out;
        },
        set: async (values) => Object.assign(data, values),
      },
    },
    runtime: { getURL: (path) => `chrome-extension://fake/${path}` },
  };
}

// The engine's worker protocol, faked: it reports ready, then answers a recognize with the configured text (or an
// error), and it can hold an answer so a test can pull the picture out from under a read that is still waiting.
const workers = [];
let workerBehaviour = {};
class FakeWorker {
  constructor() {
    workers.push(this);
    this.listeners = { message: [], error: [] };
    this.posted = [];
    this.held = [];
    this.closed = false;
  }
  addEventListener(type, handler) {
    this.listeners[type].push(handler);
  }
  emit(data) {
    for (const handler of this.listeners.message) handler({ data });
  }
  postMessage(message) {
    this.posted.push(message);
    if (message.type === "init") {
      queueMicrotask(() => {
        this.emit({ type: "status", stage: "loading" });
        this.emit({ type: "status", stage: "ready" });
      });
    } else if (message.type === "recognize") {
      const deliver = () => {
        clock += 600; // one read's worth of time, so "辨識用時" is a known string
        if (workerBehaviour.failWith) this.emit({ type: "error", id: message.id, message: workerBehaviour.failWith });
        else this.emit({ type: "result", id: message.id, text: workerBehaviour.text });
      };
      if (workerBehaviour.hold) this.held.push(deliver);
      else queueMicrotask(deliver);
    } else if (message.type === "close") {
      this.closed = true;
    }
  }
  respond() {
    this.held.shift()?.();
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = FakeWorker;

// --- the IndexedDB the real model manager stores the models in -------------------------------------------------
function request(executor) {
  const handle = { result: undefined, error: null };
  queueMicrotask(() => {
    try {
      handle.result = executor();
      handle.onsuccess?.();
    } catch (error) {
      handle.error = error;
      handle.onerror?.();
    }
  });
  return handle;
}

const storeHandle = (map) => ({
  get: (key) => request(() => map.get(key)),
  getKey: (key) => request(() => (map.has(key) ? key : undefined)),
  put: (value, key) =>
    request(() => {
      map.set(key, value);
      return key;
    }),
  delete: (key) =>
    request(() => {
      map.delete(key);
    }),
});

function makeIndexedDB(databases) {
  return {
    open(name) {
      const handle = { result: null };
      queueMicrotask(() => {
        let database = databases.get(name);
        let fresh = false;
        if (!database) {
          database = { stores: new Map() };
          databases.set(name, database);
          fresh = true;
        }
        handle.result = {
          createObjectStore: (storeName) => {
            database.stores.set(storeName, new Map());
            return {};
          },
          transaction: (storeName) => ({ objectStore: (name) => storeHandle(database.stores.get(name)) }),
          close: () => {},
        };
        if (fresh) handle.onupgradeneeded?.();
        handle.onsuccess?.();
      });
      return handle;
    },
  };
}

const bytesKey = (name) => `jev/ppocr/${name}`;
const hashKey = (name) => `jev/ppocr/${name}.sha256`;
const TOTAL_BYTES = PPOCR_FILES.reduce((sum, name) => sum + PPOCR[name].bytes, 0);

/** A store that already holds every model (or, with `short`, only the version record plus a stub byte array). */
function seed(databases, { short = false } = {}) {
  const store = new Map();
  for (const name of PPOCR_FILES) {
    store.set(bytesKey(name), new Uint8Array(short ? 1 : PPOCR[name].bytes));
    store.set(hashKey(name), PPOCR[name].sha256);
  }
  databases.set("keyval-store", { stores: new Map([["keyval", store]]) });
}

// --- the fetch the model manager downloads through -------------------------------------------------------------
const nameOfUrl = (url) => PPOCR_FILES.find((name) => PPOCR[name].url === url);

/** A download that answers at once with the bytes whose digest PPOCR pins for each file. */
function bytesFetch() {
  return async (url) => {
    const name = nameOfUrl(url);
    return { ok: true, status: 200, arrayBuffer: async () => serveBytes(name) };
  };
}

/** A download the test drives by hand: each file gets a reader that delivers only when the test says so. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReader(signal) {
  let pending = deferred();
  signal?.addEventListener("abort", () => {
    const current = pending;
    pending = deferred();
    current.reject(new Error("download aborted"));
  });
  return {
    read: () => pending.promise,
    deliver: (value) => {
      const current = pending;
      pending = deferred();
      current.resolve({ done: false, value });
    },
  };
}

function streamFetch() {
  const state = { readers: [], signals: [] };
  const impl = async (url, { signal } = {}) => {
    const reader = makeReader(signal);
    state.readers.push(reader);
    state.signals.push(signal);
    return { ok: true, status: 200, body: { getReader: () => reader } };
  };
  return { impl, state };
}

// --- the item tables the matcher reads ------------------------------------------------------------------------
const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: "Ripsaw", slug: "ripsaw", category: "uniques" },
    { name: "Ring Mail", slug: "ring-mail", category: "base" },
    { name: "Buckler", slug: "buckler", category: "base" },
  ],
  zh: { 瑞普煞: "Ripsaw", 鎖子甲: "Ring Mail" },
  bases: ["Ring Mail", "Buckler"],
  game_only: [],
});

// --- harness ---------------------------------------------------------------------------------------------------
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (times = 3) => {
  for (let i = 0; i < times; i += 1) await tick();
};

const image = (width = 640, height = 480) => ({ type: "image/png", width, height });

function setup({ seed: seedMode = "missing", busy = false, pick = true, storage = {}, fetch = bytesFetch(), worker = {} } = {}) {
  storageData = { ...storage };
  clock = 1000;
  urlCount = 0;
  workers.length = 0;
  revokedUrls.length = 0;
  canvasSizes.length = 0;
  workerBehaviour = { text: "Ripsaw\nRing Mail", hold: false, failWith: null, ...worker };

  const databases = new Map();
  if (seedMode === "present") seed(databases);
  if (seedMode === "short") seed(databases, { short: true });
  globalThis.indexedDB = makeIndexedDB(databases);

  const document = makeDocument();
  globalThis.document = document;
  installChrome(storageData);
  globalThis.fetch = (url, options) => fetch(url, options);

  const picks = [];
  const texts = [];
  let images = 0;
  let isBusy = busy;
  initOcrPanel({
    tables,
    onPick: (name, kind) => {
      picks.push([name, kind]);
      return pick;
    },
    onText: (text) => texts.push(text),
    onImage: () => {
      images += 1;
    },
    isBusy: () => isBusy,
  });

  const el = (id) => document.byId.get(id);
  return {
    document,
    el,
    picks,
    texts,
    images: () => images,
    setBusy: (value) => {
      isBusy = value;
    },
    status: () => ({ text: el("ocr-status").textContent, kind: el("ocr-status").dataset.kind }),
    paste: (files) => document.fire("paste", { clipboardData: { files } }),
    candidateButtons: () => el("ocr-candidates").children,
    candidateLabels: () => el("ocr-candidates").children.map((button) => button.textContent),
  };
}

const noticeText = `首次使用，正在下載辨識模型（約 ${formatMB(TOTAL_BYTES)} MB，只下載一次，存在這個瀏覽器裡，之後可以離線使用）。`;

// --- the download notice ---------------------------------------------------------------------------------------

test("while the models are missing the download notice appears with a progress value and a cancel button", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);

  assert.equal(s.el("ocr-download").hidden, false, "the notice is on screen");
  assert.equal(s.el("ocr-download-text").textContent, noticeText);
  assert.equal(s.el("ocr-progress").value, 0, "nothing has arrived yet");
  assert.equal(s.status().text, "已讀入圖片，正在辨識…", "the read is waiting behind the download");
  assert.equal(stream.state.readers.length, 1, "the first file is being downloaded");
});

test("a running download reports its progress on the notice as bytes arrive", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);
  stream.state.readers[0].deliver(new Uint8Array(1_000_000));
  await settle(3);

  assert.equal(s.el("ocr-progress").value, 3, "1 of 31.8 MB is 3%");
  assert.equal(s.status().text, "下載辨識模型（1.0 / 31.8 MB）");
  assert.equal(s.status().kind, "");
});

test("cancelling the download hides the notice, aborts the transfer and does not start a read", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);
  assert.equal(s.el("ocr-download").hidden, false);

  s.el("ocr-cancel").click();
  await settle(3);

  assert.equal(stream.state.signals[0].aborted, true, "the transfer itself was aborted");
  assert.equal(s.el("ocr-download").hidden, true, "the notice is gone");
  assert.equal(s.status().text, "已取消下載，沒有辨識模型就無法辨識。");
  assert.deepEqual(s.texts, [], "no read ran");
  assert.deepEqual(s.candidateButtons(), [], "no candidates");
  assert.deepEqual(s.picks, []);

  // The notice is reusable: pressing 辨識 again offers the download once more.
  s.el("ocr-go").click();
  await settle(3);
  assert.equal(s.el("ocr-download").hidden, false, "a second press starts a fresh download");
  assert.equal(s.el("ocr-progress").value, 0);
});

test("the models arriving hide the notice and the read goes on to its candidates", async () => {
  const s = setup();
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.equal(s.el("ocr-download").hidden, true, "the notice is gone once the models are stored");
  assert.equal(s.el("ocr-progress").value, 100);
  assert.deepEqual(s.texts, ["Ripsaw\nRing Mail"], "the OCR text reached the form");
  assert.equal(s.el("ocr-text").textContent, "Ripsaw\nRing Mail");
  assert.equal(s.el("ocr-time").textContent, "辨識用時 0.6 秒");
  assert.equal(s.el("ocr-panel").classes.has("done"), true, "a result shrinks the picture to a thumbnail");
});

test("with the models already stored the read starts by itself, and waits for the player while a query runs", async () => {
  const s = setup({ seed: "present", busy: true });
  await settle(2);

  s.paste([image()]);
  await settle(3);
  assert.equal(s.el("ocr-go").hidden, false, "a running query makes the read wait for the player");
  assert.equal(s.status().text, "已讀入圖片。可在圖上拖一個框只讀那一塊（不框就讀整張），再按「辨識」。");
  assert.deepEqual(s.texts, [], "nothing was read yet");

  s.setBusy(false);
  s.el("ocr-go").click();
  await settle(5);
  assert.deepEqual(s.texts, ["Ripsaw\nRing Mail"]);
});

test("auto-read turned off in storage keeps the 辨識 button on screen", async () => {
  const s = setup({ seed: "present", storage: { ocrAuto: false, ocrHintSeen: true } });
  await settle(3);

  assert.equal(s.el("ocr-auto").checked, false);
  assert.equal(s.el("ocr-dot").hidden, true, "the hint dot is gone once it was seen");
  s.paste([image()]);
  await settle(3);
  assert.equal(s.el("ocr-go").hidden, false);
  assert.deepEqual(s.texts, []);
});

test("the hint dot shows until the pick is first used, and using the pick remembers it", async () => {
  const s = setup({ seed: "present" }); // no ocrHintSeen in storage yet
  await settle(3);

  assert.equal(s.el("ocr-dot").hidden, false, "with the hint never seen the dot is visible");

  s.el("ocr-pick").click();
  await settle(2);
  assert.equal(s.el("ocr-dot").hidden, true, "the first use takes the dot away");
  assert.equal(storageData.ocrHintSeen, true, "and the fact is stored for the next load");
});

// --- the candidates --------------------------------------------------------------------------------------------

test("the candidates are one button per name, labelled with the Chinese name, and the best one fills the field", async () => {
  const s = setup({ seed: "present" });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.deepEqual(s.picks, [["Ripsaw", "item"]], "the best result goes into the name field through the handler");
  assert.equal(s.el("ocr-tag").hidden, false, "the name is marked as coming from a picture");
  assert.equal(
    s.status().text,
    "已辨識，並填入裝備名稱「Ripsaw（瑞普煞）」。請確認後自己按「開始查詢」。不對的話，可改點下面其他名稱：",
  );
  assert.equal(s.status().kind, "ok");
  assert.deepEqual(s.candidateLabels(), ["Ripsaw（瑞普煞）", "Ring Mail（鎖子甲）"]);
  assert.deepEqual(
    s.candidateButtons().map((button) => [button.dataset.kind, button.dataset.name]),
    [
      ["item", "Ripsaw"],
      ["base", "Ring Mail"],
    ],
  );
  assert.equal(s.el("ocr-candidates").dataset.firstKind, "item", "the first kind is exposed for the end-to-end check");
  assert.equal(s.el("ocr-candidates").dataset.firstName, "Ripsaw");
});

test("picking another candidate writes it into the name field through the handler only", async () => {
  const s = setup({ seed: "present" });
  await settle(2);

  s.paste([image()]);
  await settle(5);
  s.picks.length = 0; // the automatic best pick is not what this test is about

  s.candidateButtons()[1].click();
  assert.deepEqual(s.picks, [["Ring Mail", "base"]]);
  assert.equal(s.status().text, "已改填「Ring Mail（鎖子甲）」。請確認後自己按「開始查詢」。");
  assert.equal(s.status().kind, "ok");
  assert.equal(s.el("ocr-tag").hidden, false);
});

test("a result the form refuses is not marked as coming from a picture", async () => {
  const s = setup({ seed: "present", pick: false });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.deepEqual(s.picks, [["Ripsaw", "item"]], "the handler was still offered the name");
  assert.equal(s.el("ocr-tag").hidden, true, "but the refused name is not tagged");
});

test("a read that matches nothing says so in the error kind", async () => {
  const s = setup({ seed: "present", worker: { text: "ZZZZZZ" } });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.equal(
    s.status().text,
    "認不出裝備名稱，請手動輸入英文名稱（或換一張更清楚的圖、框出名稱那幾行）。",
  );
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.candidateButtons(), []);
  assert.deepEqual(s.picks, []);
  assert.equal(s.el("ocr-candidates").dataset.firstKind, "");
  assert.equal(s.el("ocr-candidates").dataset.firstName, "");
});

// --- the picture and the box -----------------------------------------------------------------------------------

test("a box dragged on the picture is the read region, and the button asks for a manual read", async () => {
  const s = setup({ seed: "present" }); // auto-read on: the first picture is read without the button
  await settle(2);

  s.paste([image()]);
  await settle(5);
  assert.equal(s.el("ocr-go").hidden, true, "auto-read runs by itself, so 辨識 stays out of the way");

  const preview = s.el("ocr-preview");
  canvasSizes.length = 0; // the whole-picture auto-read is not what this test measures
  preview.fire("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
  preview.fire("pointermove", { clientX: 100, clientY: 60, pointerId: 1 });
  assert.equal(s.el("ocr-box").hidden, false, "the box follows the pointer");
  assert.equal(s.el("ocr-go").hidden, true, "while the box is still being dragged there is no region yet");
  preview.fire("pointerup", { clientX: 100, clientY: 60, pointerId: 1 });

  assert.equal(s.el("ocr-go").hidden, false, "a boxed region means a manual read");
  s.el("ocr-go").click();
  await settle(5);
  assert.deepEqual(canvasSizes, [[90, 50]], "only the boxed region was read");
});

test("a box under the 20x10 image-pixel minimum is refused; just over it is the region the read uses", async () => {
  const s = setup({ seed: "present" }); // auto-read on: 辨識 stays hidden while no region is set
  await settle(2);

  s.paste([image()]);
  await settle(5);
  const preview = s.el("ocr-preview");
  canvasSizes.length = 0; // the whole-picture auto-read is not what this test measures

  // The preview shows its natural 640x480 at CSS size, so one CSS pixel is one image pixel: the dragged box is
  // already in image pixels.
  const drag = (width, height) => {
    preview.fire("pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
    preview.fire("pointermove", { clientX: 100 + width, clientY: 100 + height, pointerId: 1 });
    preview.fire("pointerup", { clientX: 100 + width, clientY: 100 + height, pointerId: 1 });
  };

  drag(20, 10); // exactly the minimum on both axes: still a sliver
  assert.equal(s.el("ocr-box").hidden, true, "a 20x10 box is refused");
  assert.equal(s.el("ocr-go").hidden, true, "and leaves no region to read");
  drag(30, 10);
  assert.equal(s.el("ocr-go").hidden, true, "10 image pixels tall is too thin whatever the width");
  drag(20, 40);
  assert.equal(s.el("ocr-go").hidden, true, "20 image pixels wide is too thin whatever the height");

  drag(21, 11); // one image pixel over each minimum
  assert.equal(s.el("ocr-box").hidden, false, "a 21x11 box is kept");
  assert.equal(s.el("ocr-go").hidden, false, "a boxed region means a manual read");
  s.el("ocr-go").click();
  await settle(5);
  assert.deepEqual(canvasSizes, [[21, 11]], "the read used exactly the box, in image pixels");
});

test("the dragged region is scaled by the preview's width, not by its height", async () => {
  const s = setup({ seed: "present" });
  await settle(2);

  const preview = s.el("ocr-preview");
  preview.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }); // laid out twice as wide as tall
  preview.naturalWidth = 400; // 400 image pixels across 200 CSS pixels: 2 image pixels per CSS pixel
  s.paste([image()]);
  await settle(5);
  canvasSizes.length = 0;

  preview.fire("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
  preview.fire("pointermove", { clientX: 40, clientY: 30, pointerId: 1 }); // a 30x20 CSS box
  preview.fire("pointerup", { clientX: 40, clientY: 30, pointerId: 1 });

  s.el("ocr-go").click();
  await settle(5);
  // 30*2 = 60 wide and 20*2 = 40 tall. A scale taken from the preview's height (400/100 = 4) would read 120x80.
  assert.deepEqual(canvasSizes, [[60, 40]], "the region is in image pixels, scaled by width over width");
});

test("a drag the panel could not turn into numbers leaves no region, instead of reading {width: NaN}", async () => {
  const s = setup({ seed: "present" });
  await settle(2);

  const preview = s.el("ocr-preview");
  s.paste([image()]);
  await settle(5);
  canvasSizes.length = 0; // the whole-picture auto-read is not what this test measures

  preview.fire("pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
  // pointermove builds the box from the event's own coordinates, so a coordinate that is not a number leaves the box
  // style unparsable ("NaNpx"). The read must be refused here, not handed a region of NaN pixels.
  preview.fire("pointermove", { clientX: Number.NaN, clientY: Number.NaN, pointerId: 1 });
  preview.fire("pointerup", { clientX: Number.NaN, clientY: Number.NaN, pointerId: 1 });

  assert.equal(s.el("ocr-box").hidden, true, "a box that is not a number is refused");
  assert.equal(s.el("ocr-go").hidden, true, "and leaves no region to read");
  assert.deepEqual(canvasSizes, [], "and nothing was read again for it");
});

// --- supersede: a new picture or a closed panel drops the read in flight ----------------------------------------

test("replacing the picture aborts the download in flight and leaves no notice behind", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);
  assert.equal(s.el("ocr-download").hidden, false);

  s.setBusy(true); // the second picture waits for the player, so it does not start a download of its own
  s.paste([image(320, 200)]);
  await settle(3);

  assert.equal(stream.state.signals[0].aborted, true, "the download in flight was aborted");
  assert.equal(s.el("ocr-download").hidden, true, "the notice is gone");
  assert.equal(s.status().text, "已讀入圖片。可在圖上拖一個框只讀那一塊（不框就讀整張），再按「辨識」。");
  assert.deepEqual(s.texts, []);
});

test("closing the panel supersedes a read in flight so its result never reaches the screen", async () => {
  const s = setup({ seed: "present", worker: { hold: true } });
  await settle(2);

  s.paste([image()]);
  await settle(4);
  assert.equal(workers.length, 1, "the read reached the engine");
  assert.equal(workers[0].held.length, 1, "and the engine is still working");

  s.el("ocr-close").click();
  workers[0].respond();
  await settle(4);

  assert.equal(s.el("ocr-panel").hidden, true, "the panel is closed");
  assert.equal(s.el("ocr-preview").getAttribute("src"), null, "the picture is cleared");
  assert.deepEqual(revokedUrls, ["blob:fake/1"], "its object URL was revoked");
  assert.equal(s.el("ocr-time").textContent, "", "the stale result never wrote the time");
  assert.equal(s.el("ocr-text").textContent, "", "nor the text");
  assert.deepEqual(s.texts, [], "and the form never heard about it");
  assert.deepEqual(s.candidateButtons(), []);
});

// --- failures --------------------------------------------------------------------------------------------------

test("a model record whose bytes are wrong fails the read, clears the stored models and says so", async () => {
  const s = setup({ seed: "short" });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.equal(
    s.status().text,
    "辨識引擎啟動失敗（本機的辨識模型不完整）。已清除已下載的模型紀錄，再按一次「辨識」會重新下載。",
  );
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.texts, []);
  assert.equal(s.el("ocr-go").disabled, false, "the player can try again");
});

test("a download whose bytes do not match the pinned digest fails the read with a checksum error", async () => {
  // Same length as the model (the size check passes) but different content: only the SHA-256 comparison can catch it.
  const corrupt = async (url) => {
    const bytes = serveBytes(nameOfUrl(url));
    bytes[0] = 1;
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
  const s = setup({ fetch: corrupt });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.equal(s.status().text, "辨識失敗：模型檢查碼不符，檔案已丟棄。可以再按一次「辨識」重試。");
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.texts, [], "the corrupt model was never used to read");
  assert.deepEqual(s.candidateButtons(), []);
});

test("a read that fails after the engine started reports the failure and offers a retry", async () => {
  const s = setup({ seed: "present", worker: { failWith: "boom" } });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.equal(s.status().text, "辨識失敗：boom。可以再按一次「辨識」重試。");
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.texts, []);
  assert.deepEqual(s.candidateButtons(), []);
});

// --- the other ways a picture gets in --------------------------------------------------------------------------

test("a non-image paste says so, a cancelled file dialog does nothing", async () => {
  const s = setup({ seed: "present" });
  await settle(2);

  s.document.fire("paste", { clipboardData: { files: [{ type: "text/plain" }] } });
  await settle(2);
  assert.equal(s.status().text, "這不是圖片檔");
  assert.equal(s.status().kind, "error");
  assert.equal(s.images(), 0);

  s.el("ocr-file").fire("change", { target: { files: [] } });
  await settle(2);
  assert.equal(s.images(), 0, "an empty file dialog is ignored");
  assert.equal(s.status().text, "這不是圖片檔", "and the status is untouched");

  s.el("ocr-file").fire("change", { target: { files: [image(10, 10)] } });
  await settle(3);
  assert.equal(s.images(), 1);
  assert.equal(s.el("ocr-panel").hidden, false);
});
