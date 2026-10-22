// The screenshot reader (ocr/panel.js) driven against a hand-built DOM. Nothing imported it in a test, so a change to
// the silent first-time download, the candidate buttons, the supersede rule or the status wording could reach the
// player silently. The module takes its own collaborators internally (the model store via IndexedDB, the OCR engine
// via a Worker, the pixels via createImageBitmap/OffscreenCanvas), so this file injects those browser-only pieces as
// globalThis fakes and reads back exactly what the player would see: the status line and its kind, every id the
// module looked up (so the removed download UI stays unreached), and the candidate buttons.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createCorrections } from "../src/ocr/corrections.js";
import { initOcrPanel } from "../src/ocr/panel.js";
import { PPOCR, PPOCR_FILES } from "../src/ocr/models.js";
import { indexTables } from "../src/traderie/lookup.js";

// --- the long timers ------------------------------------------------------------------------------------------
// Timers of a second or more are the long ones: the engine cache's 60 s idle timer, the model manager's 30 s stall
// timer and the read's 15 s slow notice. None of them must really wait for the player (the fake worker answers at
// once), and the slow notice is exactly what a test fires, so they are queued against the fake clock below instead
// of the real one; `advanceClock` then runs the ones that fall due. Shorter timers stay real.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms >= 1_000) {
    const handle = { fn, ms, args, due: clock + ms };
    pendingTimers.add(handle);
    return handle;
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.clearTimeout = (handle) => {
  if (handle && pendingTimers.has(handle)) {
    pendingTimers.delete(handle);
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
  element.focusCount = 0;
  element.focus = () => {
    element.focusCount += 1;
  };
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
  "ocr-file",
  "ocr-drop",
  "ocr-dropzone",
  "ocr-pick",
  "ocr-hint",
  "ocr-dot",
  "ocr-tag",
  "ocr-close",
  "ocr-panel",
  "ocr-preview",
  "ocr-box",
  "ocr-time",
  "ocr-text",
  "item",
  "stats-base",
];

function makeDocument() {
  const byId = new Map(IDS.map((id) => [id, makeElement(id === "ocr-preview" ? "img" : "div")]));
  for (const [id, element] of byId) element.id = id;
  // The states sidepanel.html ships them in, so a missing "unhide" shows up as a test failure. `ocr-dot` is NOT in
  // here: the html ships it hidden but initPreferences sets it on every load, so seeding it hidden would make the
  // "the hint dot is gone once it was seen" assertion pass without the code (the not-seen case asserts it visible).
  for (const id of ["ocr-hint", "ocr-tag", "ocr-dropzone", "ocr-panel", "ocr-preview", "ocr-box"]) {
    byId.get(id).hidden = true;
  }
  // sidepanel.html ships 辨識 disabled and hidden: a picture in the panel is what turns it on.
  byId.get("ocr-go").hidden = true;
  byId.get("ocr-go").disabled = true;
  // Every id the module reaches for, and every status line it writes, in order: the silent download is pinned by
  // asserting that no download id is ever looked up and no status write carries a download line.
  const lookups = [];
  const statusTexts = [];
  const status = byId.get("ocr-status");
  let statusValue = "";
  Object.defineProperty(status, "textContent", {
    get: () => statusValue,
    set: (value) => {
      statusValue = value;
      statusTexts.push(value);
    },
  });
  const listeners = {};
  return {
    byId,
    lookups,
    statusTexts,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      lookups.push(id);
      return byId.get(id) ?? null;
    },
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
    } else if (message.type === "warmup") {
      queueMicrotask(() => {
        this.emit({ type: "warmupResult", id: message.id });
      });
    } else if (message.type === "recognize") {
      if (workerBehaviour.headText !== undefined) {
        // The first lines of the read, ahead of the (possibly held) result.
        queueMicrotask(() => this.emit({ type: "head", id: message.id, text: workerBehaviour.headText, tones: workerBehaviour.headTones ?? [] }));
      }
      const deliver = () => {
        clock += 600; // one read's worth of time, so "辨識用時" is a known string
        if (workerBehaviour.failWith) this.emit({ type: "error", id: message.id, message: workerBehaviour.failWith });
        else this.emit({ type: "result", id: message.id, text: workerBehaviour.text, tones: workerBehaviour.tones });
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
    { name: "Arachnid Mesh", slug: "arachnid-mesh", category: "uniques" },
    { name: "Griswold's Honor", slug: "griswolds-honor", category: "sets" },
  ],
  zh: { 瑞普煞: "Ripsaw", 鎖子甲: "Ring Mail", 蜘蛛之網: "Arachnid Mesh", 格里斯瓦德的榮耀: "Griswold's Honor" },
  bases: ["Ring Mail", "Buckler"],
  game_only: [],
});

// --- harness ---------------------------------------------------------------------------------------------------
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (times = 3) => {
  for (let i = 0; i < times; i += 1) await tick();
};

/** Move the fake clock forward by `ms`, running every queued long timer that falls due, earliest first. */
const advanceClock = async (ms) => {
  const target = clock + ms;
  for (;;) {
    const due = [...pendingTimers].filter((handle) => handle.due <= target).sort((a, b) => a.due - b.due)[0];
    if (!due) break;
    clock = due.due;
    pendingTimers.delete(due);
    due.fn(...due.args);
    await settle(1);
  }
  clock = target;
};

const image = (width = 640, height = 480) => ({ type: "image/png", width, height });

// What the shipped matcher answers for these tables, and what decideCandidates says about it (see match.js).
const SURE_TEXT = "蜘蛛之網\n格里斯瓦德的榮耀"; // two item names, no type line: sure, the longer name first
const SURE_TYPES_TEXT = "鎖子甲\nBuckler"; // two type names: sure
const UNSURE_TEXT = "Ripsaw\nRing Mail"; // an item with its type line under it: could be a rare with that random name
const UNSURE_ALONE_TEXT = "瑞普煞"; // a three-character name alone: collides with stat words too easily

function setup({ seed: seedMode = "missing", busy = false, pick = true, storage = {}, fetch = bytesFetch(), worker = {}, corrections = null, baseCorrections = null } = {}) {
  storageData = { ...storage };
  clock = 1000;
  urlCount = 0;
  workers.length = 0;
  revokedUrls.length = 0;
  canvasSizes.length = 0;
  // The default read is a sure one (two item names, no type line); the unsure and base-only reads set their own text.
  workerBehaviour = { text: SURE_TEXT, hold: false, failWith: null, ...worker };

  const databases = new Map();
  if (seedMode === "present") seed(databases);
  if (seedMode === "short") seed(databases, { short: true });
  globalThis.indexedDB = makeIndexedDB(databases);

  const document = makeDocument();
  globalThis.document = document;
  installChrome(storageData);
  globalThis.fetch = (url, options) => fetch(url, options);

  const picks = [];
  const fields = []; // what the name field is told to show for each pick
  const texts = [];
  let images = 0;
  let isBusy = busy;
  const api = initOcrPanel({
    tables,
    corrections,
    baseCorrections,
    onPick: (name, kind, shown) => {
      picks.push([name, kind]);
      fields.push(shown);
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
    api,
    document,
    el,
    picks,
    fields,
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

/**
 * A panel whose models are already stored, with one whole picture pasted and the read run to completion. The
 * candidate, failure and result tests all start from this prelude; `overrides` reaches `setup` for the ones that
 * need a worker behaviour or a refusing handler.
 */
async function readImage(overrides = {}) {
  const s = setup({ seed: "present", ...overrides });
  await settle(2);
  s.paste([image()]);
  await settle(5);
  return s;
}

// --- the silent first-time download ----------------------------------------------------------------------------

/** The ids the removed download UI carried: the module must never reach for any of them. */
const DOWNLOAD_IDS = ["ocr-download", "ocr-download-text", "ocr-progress", "ocr-cancel"];

test("first use downloads the models by itself, with no download element looked up and no download line shown", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);

  assert.equal(stream.state.readers.length, 1, "the first file is being downloaded");
  assert.equal(s.status().text, "已讀入圖片，正在辨識…", "the read is waiting behind the download");
  for (const id of DOWNLOAD_IDS) {
    assert.equal(s.document.lookups.includes(id), false, `${id} is never looked up`);
  }
  assert.equal(s.document.statusTexts.some((text) => text.includes("下載辨識模型")), false, "no download line");
});

test("the models arriving let the read go on to its candidates, still with no download line", async () => {
  const s = setup({ worker: { text: UNSURE_TEXT } });
  await settle(2);

  s.paste([image()]);
  await settle(5);

  assert.deepEqual(s.texts, ["Ripsaw\nRing Mail"], "the OCR text reached the form");
  assert.equal(s.el("ocr-text").textContent, "Ripsaw（瑞普煞）\nRing Mail（鎖子甲）", "the read text carries the Chinese names");
  assert.equal(s.el("ocr-time").textContent, "辨識用時 0.6 秒");
  assert.equal(s.el("ocr-panel").classes.has("done"), true, "a result shrinks the picture to a thumbnail");
  assert.equal(s.document.statusTexts.some((text) => text.includes("下載辨識模型")), false, "no download line");
});

test("with the models stored, the panel posts init then warmup before any picture is loaded", async () => {
  setup({ seed: "present" });
  await settle(3);

  assert.equal(workers.length, 1, "one engine, built at panel start");
  assert.deepEqual(workers[0].posted.map((m) => m.type), ["init", "warmup"]);
});

test("with no models stored nothing is built at panel start, and the download builds and warms the engine", async () => {
  const s = setup({ worker: { text: UNSURE_TEXT } });
  await settle(2);
  assert.equal(workers.length, 0, "nothing downloaded, nothing built");

  s.paste([image()]);
  await settle(5);
  assert.deepEqual(workers[0].posted.map((m) => m.type).slice(0, 2), ["init", "warmup"]);
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
  assert.deepEqual(s.texts, [SURE_TEXT]);
});

test("the ocrAuto: false storage seam (Chrome checks only) keeps the 辨識 button on screen", async () => {
  const s = setup({ seed: "present", storage: { ocrAuto: false, ocrHintSeen: true } });
  await settle(3);

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

test("the candidates are one button per name, labelled Chinese first, and the best one fills the field", async () => {
  const s = await readImage();

  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]], "the best result goes into the name field through the handler");
  assert.equal(s.el("ocr-tag").hidden, false, "the name is marked as coming from a picture");
  assert.equal(
    s.status().text,
    "已辨識，並填入裝備名稱「格里斯瓦德的榮耀（Griswold's Honor）」。請確認後自己按「開始查詢」。不對的話，可改點下面其他名稱：",
  );
  assert.equal(s.status().kind, "ok");
  assert.deepEqual(s.candidateLabels(), ["格里斯瓦德的榮耀（Griswold's Honor）", "蜘蛛之網（Arachnid Mesh）"]);
  assert.deepEqual(
    s.candidateButtons().map((button) => [button.dataset.kind, button.dataset.name]),
    [
      ["item", "Griswold's Honor"],
      ["item", "Arachnid Mesh"],
    ],
  );
  assert.equal(s.el("ocr-candidates").dataset.firstKind, "item", "the first kind is exposed for the end-to-end check");
  assert.equal(s.el("ocr-candidates").dataset.firstName, "Griswold's Honor", "the query value stays English");
  assert.equal(s.el("ocr-candidates").dataset.unsure, "", "a sure read is not marked unsure");
  assert.deepEqual(s.fields, ["格里斯瓦德的榮耀"], "the name field is told to show the Chinese name");
});

test("a name the table has no Chinese for is shown in English, with no empty brackets", async () => {
  const s = await readImage({ worker: { text: "Buckler" } });

  assert.deepEqual(s.picks, [["Buckler", "base"]]);
  assert.deepEqual(s.fields, ["Buckler"], "no Chinese name: the field shows the English name");
  assert.equal(s.status().text.includes("「Buckler」"), true);
  assert.equal(s.status().text.includes("（）"), false);
});

test("picking another candidate of a sure read writes it into the name field through the handler only", async () => {
  const s = await readImage();
  s.picks.length = 0; // the automatic best pick is not what this test is about
  s.fields.length = 0;

  s.candidateButtons()[1].click();
  assert.deepEqual(s.picks, [["Arachnid Mesh", "item"]]);
  assert.deepEqual(s.fields, ["蜘蛛之網"], "the field shows Chinese, the picked name stays English");
  assert.equal(s.status().text, "已改填「蜘蛛之網（Arachnid Mesh）」。請確認後自己按「開始查詢」。");
  assert.equal(s.status().kind, "ok");
  assert.equal(s.el("ocr-tag").hidden, false);
});

test("a sure read of two type names fills the better one at once and offers the other, as before", async () => {
  const s = await readImage({ worker: { text: SURE_TYPES_TEXT } });

  assert.deepEqual(s.picks, [["Buckler", "base"]]);
  assert.equal(s.status().text.startsWith("只認出底材（不會依品質篩選），並填入裝備名稱「Buckler」"), true);
  assert.deepEqual(s.candidateLabels(), ["Buckler", "鎖子甲（Ring Mail）"]);
});

test("a result the form refuses is not marked as coming from a picture", async () => {
  const s = await readImage({ pick: false });

  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]], "the handler was still offered the name");
  assert.equal(s.el("ocr-tag").hidden, true, "but the refused name is not tagged");
});

// --- an unsure read asks the player ----------------------------------------------------------------------------

test("an unsure read fills nothing and asks: no auto-fill sentence, the names as buttons, then 都不是", async () => {
  const s = await readImage({ worker: { text: UNSURE_TEXT } });

  assert.deepEqual(s.picks, [], "nothing is put into the name field");
  assert.equal(s.el("ocr-tag").hidden, true, "and nothing is marked as coming from a picture");
  assert.equal(s.status().text, "不確定是哪一件，請點選一個：");
  assert.equal(s.status().text.includes("請確認"), false, "the auto-fill sentence is not shown");
  assert.deepEqual(s.candidateLabels(), ["瑞普煞（Ripsaw）", "鎖子甲（Ring Mail）", "都不是，我自己輸入"]);
  assert.deepEqual(
    s.candidateButtons().slice(0, 2).map((button) => [button.dataset.kind, button.dataset.name]),
    [
      ["item", "Ripsaw"],
      ["base", "Ring Mail"],
    ],
    "the decision buttons keep the English name and the kind",
  );
  assert.equal(s.candidateButtons()[2].dataset.none, "true", "the last one is the way out and names nothing");
  assert.equal(s.candidateButtons()[2].dataset.name, undefined);
  assert.equal(s.el("ocr-candidates").dataset.unsure, "true");
  assert.equal(s.texts.length, 1, "the form still hears the text, so the affix conditions are read as always");
});

test("clicking a name of an unsure read fills the Chinese-first name through the handler and marks the tag", async () => {
  const s = await readImage({ worker: { text: UNSURE_TEXT } });

  s.candidateButtons()[1].click();

  assert.deepEqual(s.picks, [["Ring Mail", "base"]], "the English name and its kind");
  assert.deepEqual(s.fields, ["鎖子甲"], "the field shows the Chinese name");
  assert.equal(s.el("ocr-tag").hidden, false, "the name is marked as coming from a picture");
  assert.equal(s.status().text, "已填入「鎖子甲（Ring Mail）」。請確認後自己按「開始查詢」。");
  assert.equal(s.status().kind, "ok");
});

test("都不是 focuses the name field and fills nothing", async () => {
  const s = await readImage({ worker: { text: UNSURE_TEXT } });
  const field = s.el("item");
  assert.equal(field.focusCount, 0);

  s.candidateButtons().at(-1).click();

  assert.equal(field.focusCount, 1, "the player is put in the name field");
  assert.deepEqual(s.picks, [], "nothing was filled in");
  assert.equal(field.value, "");
  assert.equal(s.el("ocr-tag").hidden, true);
});

test("an item with its type line under it fills itself in when its name line is unique gold, and still asks when it is rare yellow", async () => {
  // The worker sends one lettering colour per text line; line 0 is the name line of UNSURE_TEXT.
  const gold = await readImage({ worker: { text: UNSURE_TEXT, tones: [[198, 178, 120], [250, 250, 250]] } });
  assert.deepEqual(gold.picks, [["Ripsaw", "item"]], "a gold name is a catalogue item: it goes into the field by itself");
  assert.equal(
    gold.status().text,
    "已辨識，並填入裝備名稱「瑞普煞（Ripsaw）」。請確認後自己按「開始查詢」。不對的話，可改點下面其他名稱：",
  );
  assert.equal(gold.el("ocr-candidates").dataset.unsure, "");
  const yellow = await readImage({ worker: { text: UNSURE_TEXT, tones: [[248, 248, 100], [250, 250, 250]] } });
  assert.deepEqual(yellow.picks, [], "a yellow name may be a rare item's random name: nothing is filled in");
  assert.equal(yellow.status().text, "不確定是哪一件，請點選一個：");
});

test("the colours of the read are kept on the text for the end-to-end check", async () => {
  const s = await readImage({ worker: { text: UNSURE_TEXT, tones: [[198, 178, 120], null] } });
  assert.equal(s.el("ocr-text").dataset.tones, "[[198,178,120],null]");
});

test("a single candidate that is not sure still asks, with the one name and 都不是", async () => {
  const s = await readImage({ worker: { text: UNSURE_ALONE_TEXT } });

  assert.deepEqual(s.picks, []);
  assert.equal(s.status().text, "不確定是哪一件，請點選一個：");
  assert.deepEqual(s.candidateLabels(), ["瑞普煞（Ripsaw）", "都不是，我自己輸入"]);
});

test("an unsure read the form could not take is not marked either when the player picks a name", async () => {
  const s = await readImage({ worker: { text: UNSURE_TEXT }, pick: false });

  s.candidateButtons()[0].click();
  assert.deepEqual(s.picks, [["Ripsaw", "item"]], "the handler was offered the picked name");
  assert.equal(s.el("ocr-tag").hidden, true, "but a refused name is not tagged");
});

test("a read that matches nothing says so in the error kind", async () => {
  const s = await readImage({ worker: { text: "ZZZZZZ" } });

  assert.equal(
    s.status().text,
    "認不出裝備名稱，請手動輸入英文名稱（或換一張更清楚的圖、框出名稱那幾行）。",
  );
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.candidateButtons(), []);
  assert.deepEqual(s.picks, []);
  assert.equal(s.el("ocr-candidates").dataset.firstKind, "");
  assert.equal(s.el("ocr-candidates").dataset.firstName, "");
  assert.equal(s.el("ocr-candidates").dataset.unsure, "", "no candidates is not an unsure read: today's message stays");
});

// --- the picture and the box -----------------------------------------------------------------------------------

test("a box dragged on the picture is the read region, and the button asks for a manual read", async () => {
  // auto-read on: the first picture is read without the button
  const s = await readImage();
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
  // auto-read on: 辨識 stays hidden while no region is set
  const s = await readImage();
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

test("replacing the picture aborts the download in flight", async () => {
  const stream = streamFetch();
  const s = setup({ fetch: stream.impl });
  await settle(2);

  s.paste([image()]);
  await settle(3);
  assert.equal(stream.state.readers.length, 1, "the download is in flight");

  s.setBusy(true); // the second picture waits for the player, so it does not start a download of its own
  s.paste([image(320, 200)]);
  await settle(3);

  assert.equal(stream.state.signals[0].aborted, true, "the download in flight was aborted");
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
  const s = await readImage({ worker: { failWith: "boom" } });

  assert.equal(s.status().text, "辨識失敗：boom。可以再按一次「辨識」重試。");
  assert.equal(s.status().kind, "error");
  assert.deepEqual(s.texts, []);
  assert.deepEqual(s.candidateButtons(), []);
});

// --- the slow-read notice --------------------------------------------------------------------------------------

test("a read still running after 15 s shows the slow notice, which the finished read clears", async () => {
  const s = setup({ seed: "present", worker: { hold: true } });
  await settle(2);

  s.paste([image()]);
  await settle(4);
  assert.equal(workers.length, 1, "the read reached the engine");
  assert.notEqual(s.status().text, "這張圖比較大，還在辨識中…", "before 15 s the slow notice has not shown yet");

  await advanceClock(16_000);
  assert.equal(s.status().text, "這張圖比較大，還在辨識中…", "the slow read tells the player why it takes a while");
  assert.equal(s.status().kind, "", "the notice is not an error");

  workers[0].respond();
  await settle(4);
  assert.equal(
    s.status().text,
    "已辨識，並填入裝備名稱「格里斯瓦德的榮耀（Griswold's Honor）」。請確認後自己按「開始查詢」。不對的話，可改點下面其他名稱：",
    "the result replaced the notice once the read finished",
  );
  assert.deepEqual(s.texts, [SURE_TEXT]);
});

test("a read that finishes quickly never shows the slow notice, and its timer is cleared", async () => {
  const s = await readImage();
  const finished = s.status().text;
  assert.equal(finished.startsWith("已辨識"), true, "the read already finished");
  assert.equal([...pendingTimers].some((handle) => handle.ms === 15_000), false, "the slow notice timer was cleared");

  await advanceClock(16_000);
  assert.equal(s.status().text, finished, "advancing the clock past 15 s did not bring the notice back");
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

test("the read text gets a Chinese name only on lines that matched; the raw text is what the form hears", async () => {
  const raw = "Ripsaw\n+9 力量(STR)\n需要等級:46\n鎖子甲\nZZZZZZ";
  const s = await readImage({ worker: { text: raw } });

  assert.equal(
    s.el("ocr-text").textContent,
    "Ripsaw（瑞普煞）\n+9 力量(STR)\n需要等級:46\n鎖子甲\nZZZZZZ",
    "a stat line, a line already in Chinese and an unmatched line stay as read",
  );
  assert.deepEqual(s.texts, [raw], "the form still receives the raw OCR text");
});

// --- possible names: a read that matched nothing still offers the next best table names ---------------------------------

test("a read that matched nothing but sits near a table name lists it as a possible name and fills nothing", async () => {
  // Three wrong characters in an eight-character name: more than the matcher accepts, within the possible-names tolerance.
  const s = await readImage({ worker: { text: "格里斯好德的好好" } });

  assert.deepEqual(s.picks, [], "nothing is put into the name field");
  assert.equal(s.status().text, "沒有把握，可能是下面這些，請點選一個：");
  assert.deepEqual(s.candidateLabels(), ["格里斯瓦德的榮耀（Griswold's Honor）", "都不是，我自己輸入"]);
  assert.equal(s.candidateButtons()[0].dataset.name, "Griswold's Honor", "the button keeps the English name");
  assert.equal(s.el("ocr-candidates").dataset.unsure, "true");

  s.candidateButtons()[0].click();
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]]);
  assert.deepEqual(s.fields, ["格里斯瓦德的榮耀"], "the field gets the Chinese name, the query value stays English");
});

test("an unsure read lists its own candidates first and a sure read lists no extra names", async () => {
  const unsure = await readImage({ worker: { text: UNSURE_TEXT } });
  assert.deepEqual(unsure.candidateLabels().slice(0, 2), ["瑞普煞（Ripsaw）", "鎖子甲（Ring Mail）"]);
  const sure = await readImage({ worker: { text: SURE_TEXT } });
  assert.deepEqual(sure.candidateLabels(), ["格里斯瓦德的榮耀（Griswold's Honor）", "蜘蛛之網（Arachnid Mesh）"]);
});

// --- the correction memory ----------------------------------------------------------------------------------------------

/** A correction memory over a plain object, written at once, so a second panel start can read what the first kept. */
async function memory(stored) {
  const storage = { stored, get: async () => storage.stored, set: async (value) => (storage.stored = JSON.parse(JSON.stringify(value))) };
  const corrections = createCorrections({ storage, setTimer: (fn) => queueMicrotask(fn), clearTimer: () => {} });
  await corrections.load();
  return { corrections, storage };
}

/** Paste the same picture again and wait for its read. */
async function readAgain(s) {
  s.picks.length = 0;
  s.fields.length = 0;
  s.paste([image()]);
  await settle(5);
}

test("one earlier choice puts that name first with a hint and still asks; two make it sure and fill it", async () => {
  const { corrections } = await memory();
  const s = await readImage({ worker: { text: UNSURE_TEXT }, corrections });
  assert.deepEqual(s.candidateLabels(), ["瑞普煞（Ripsaw）", "鎖子甲（Ring Mail）", "都不是，我自己輸入"], "nothing learned yet");

  s.candidateButtons()[1].click(); // the player says it is the type name, Ring Mail
  await readAgain(s);
  assert.deepEqual(s.candidateLabels(), ["鎖子甲（Ring Mail） · 你上次選過這個", "瑞普煞（Ripsaw）", "都不是，我自己輸入"]);
  assert.equal(s.status().text, "不確定是哪一件，請點選一個：", "one choice only moves it up");
  assert.deepEqual(s.picks, [], "and nothing is filled in by itself");

  s.candidateButtons()[0].click(); // the same choice again
  await readAgain(s);
  assert.deepEqual(s.picks, [["Ring Mail", "base"]], "chosen twice: the field is filled by itself");
  assert.equal(s.status().text.includes("（照你之前的選擇）"), true);
  assert.equal(s.el("ocr-candidates").dataset.unsure, "");
});

test("clicking another name than the one a sure read filled in is a correction the next read remembers", async () => {
  const { corrections } = await memory();
  const s = await readImage({ corrections }); // SURE_TEXT: Griswold's Honor filled in, Arachnid Mesh offered
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]]);

  s.candidateButtons()[1].click(); // "不對的話，可改點下面其他名稱"
  await readAgain(s);

  assert.deepEqual(s.picks, [], "the sure read now asks");
  assert.equal(s.candidateButtons()[0].dataset.name, "Arachnid Mesh");
  assert.equal(s.candidateButtons()[0].dataset.learned, "1");
});

test("a different choice for the same text starts the count again, so one mis-click never auto-fills", async () => {
  const { corrections } = await memory();
  const s = await readImage({ worker: { text: UNSURE_TEXT }, corrections });
  s.candidateButtons()[1].click();
  await readAgain(s);
  s.candidateButtons()[1].click(); // the second read: the player now says Ripsaw (not what it said before)
  await readAgain(s);

  assert.deepEqual(s.picks, [], "Ring Mail was chosen once and Ripsaw once: neither is sure");
  assert.equal(s.candidateButtons()[0].dataset.name, "Ripsaw", "the latest choice leads");
  assert.equal(s.candidateButtons()[0].dataset.learned, "1");
});

test("the memory is read again after a restart of the panel: the same read is promoted by what the last session stored", async () => {
  const first = await memory();
  const a = await readImage({ worker: { text: UNSURE_TEXT }, corrections: first.corrections });
  a.candidateButtons()[1].click();
  await first.corrections.flush();

  const second = await memory(first.storage.stored);
  const b = await readImage({ worker: { text: UNSURE_TEXT }, corrections: second.corrections });

  assert.equal(b.candidateButtons()[0].dataset.name, "Ring Mail");
  assert.equal(b.candidateLabels()[0].endsWith("你上次選過這個"), true);
});

test("a name typed over an auto-filled read is a correction: the next read of the same text asks, never fills the first name again", async () => {
  const { corrections } = await memory();
  const s = await readImage({ corrections }); // SURE_TEXT: Griswold's Honor is filled in by itself
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]]);

  s.el("item").fire("input"); // the player types another name over it ...
  s.api.noteQueryName("蜘蛛之網"); // ... and starts the search
  await readAgain(s);

  assert.deepEqual(s.picks, [], "a sure read of the matcher became a question: the player corrected it before");
  assert.deepEqual(s.candidateLabels().slice(0, 2), ["蜘蛛之網（Arachnid Mesh） · 你上次選過這個", "格里斯瓦德的榮耀（Griswold's Honor）"]);
});

test("a name typed for a read nothing named is remembered under the read's first name line", async () => {
  const { corrections } = await memory();
  const s = await readImage({ worker: { text: "Hxnor Of Dxrkness" }, corrections });
  assert.equal(s.el("ocr-candidates").dataset.unsure, "", "nothing was offered at all");

  s.el("item").fire("input");
  s.api.noteQueryName("Griswold's Honor");
  await readAgain(s);

  assert.deepEqual(s.candidateLabels(), ["格里斯瓦德的榮耀（Griswold's Honor） · 你上次選過這個", "都不是，我自己輸入"]);
});

test("a search with a name that was not typed after the read teaches nothing, and a name the tables lack is never kept", async () => {
  const { corrections } = await memory();
  const s = await readImage({ worker: { text: UNSURE_TEXT }, corrections });
  s.api.noteQueryName("蜘蛛之網"); // the field was filled some other way: no input event
  assert.equal(corrections.size, 0);

  const t = await readImage({ worker: { text: UNSURE_TEXT }, corrections });
  t.el("item").fire("input");
  t.api.noteQueryName("Not An Item");
  assert.equal(corrections.size, 0);
});

test("a base typed over a read in the affix form is remembered for exactly that text, and an untouched or non-base one is not", async () => {
  const storage = { get: async () => undefined, set: async () => {} };
  const baseCorrections = createCorrections({ storage, only: "base", setTimer: () => 0, clearTimer: () => {} });
  await baseCorrections.load();
  const text = "Hxnor Of Dxrkness";
  const s = await readImage({ worker: { text }, baseCorrections });
  assert.equal(s.api.learnedBase(text), null);

  s.api.noteBaseQuery("Ring Mail"); // the box was not typed in after the read: nothing to learn
  assert.equal(baseCorrections.size, 0);

  const t = await readImage({ worker: { text }, baseCorrections });
  t.el("stats-base").fire("input");
  t.api.noteBaseQuery("Griswold's Honor"); // typed, but an item and not a base
  assert.equal(baseCorrections.size, 0);

  const u = await readImage({ worker: { text }, baseCorrections });
  u.el("stats-base").fire("input");
  u.api.noteBaseQuery("鎖子甲");
  assert.equal(u.api.learnedBase(text).name, "Ring Mail");
  assert.equal(u.api.learnedBase("some other text"), null);
});

test("only the first search after a read counts as the player's verdict on it", async () => {
  const { corrections } = await memory();
  const s = await readImage({ worker: { text: UNSURE_TEXT }, corrections });
  s.api.noteQueryName("Ripsaw"); // the first search: nothing was typed
  s.el("item").fire("input");
  s.api.noteQueryName("蜘蛛之網"); // a later search for something else
  assert.equal(corrections.size, 0);
});

test("a memory that cannot be read changes nothing about a read", async () => {
  const storage = { get: async () => { throw new Error("gone"); }, set: async () => {} };
  const corrections = createCorrections({ storage, setTimer: () => 0, clearTimer: () => {} });
  await corrections.load();
  const s = await readImage({ worker: { text: UNSURE_TEXT }, corrections });

  assert.deepEqual(s.candidateLabels(), ["瑞普煞（Ripsaw）", "鎖子甲（Ring Mail）", "都不是，我自己輸入"]);
  s.candidateButtons()[0].click(); // choosing still works
  assert.deepEqual(s.picks, [["Ripsaw", "item"]]);
});

// --- the name is decided on the first lines, before the rest of the picture is read ----------------------------------

test("the name is filled in and the candidates shown as soon as the head arrives, before the rest is read", async () => {
  const s = setup({ seed: "present", worker: { hold: true, headText: SURE_TEXT, text: `${SURE_TEXT}\n+20% Faster Cast Rate` } });
  await settle(2);
  s.paste([image()]);
  await settle(5);

  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]], "the head's name is already in the field");
  assert.equal(s.el("ocr-time").textContent, "", "the rest is still being read");
  assert.equal(s.el("ocr-text").textContent, "");
  assert.deepEqual(s.texts, [], "the affix handoff waits for the whole text");

  workers[0].respond();
  await settle(3);
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]], "a head that was sure is not decided again by the rest");
  assert.match(s.el("ocr-time").textContent, /^辨識用時 \d+\.\d 秒（名稱 \d+\.\d 秒）$/);
  assert.deepEqual(s.texts, [`${SURE_TEXT}\n+20% Faster Cast Rate`]);
});

test("a head the reader was not sure about is decided again on the whole text", async () => {
  const s = await readImage({ worker: { headText: UNSURE_TEXT, text: SURE_TEXT } });
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]], "the whole text was sure, so it fills in now");
  assert.equal(s.el("ocr-candidates").dataset.unsure, "");
});

test("a read with no head is decided once, on the whole text, and shows no name time", async () => {
  const s = await readImage();
  assert.deepEqual(s.picks, [["Griswold's Honor", "item"]]);
  assert.match(s.el("ocr-time").textContent, /^辨識用時 \d+\.\d 秒$/);
});

test("a name the player picked from an unsure head's buttons is not replaced when the rest of the read arrives", async () => {
  const s = setup({ seed: "present", worker: { hold: true, headText: UNSURE_TEXT, text: SURE_TEXT } });
  await settle(2);
  s.paste([image()]);
  await settle(5);
  assert.deepEqual(s.picks, [], "the head asked");
  s.candidateButtons()[1].click(); // the player answers while the rest is still being read
  const picked = [...s.picks];
  assert.equal(picked.length, 1);

  workers[0].respond();
  await settle(3);
  assert.deepEqual(s.picks, picked, "the whole text, sure of another name, leaves the player's pick alone");
});
