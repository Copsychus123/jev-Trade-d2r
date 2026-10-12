// The 裝備掃描 screen (scan-panel.js) is the whole flow around the scan session: it takes frames off the shared
// window, cuts each tooltip out of them, hands the crop to the OCR engine, keeps one record per item and writes the
// list, the status line and the run's counters to the page. scan-session.test.mjs covers the state machine
// underneath; nothing executed this module, so the crop arithmetic, the record markup, 清除紀錄 and every status
// wording could ship unnoticed.
//
// This drives the real module end to end against fakes only: a fake Chrome capture (getDisplayMedia +
// MediaStreamTrackProcessor) feeding synthetic frames, an OffscreenCanvas/createImageBitmap pair whose
// drawImage/getImageData calls are recorded, one second of ticker fired by hand, and an OCR engine with the interface
// ocr/panel.js exposes (missingModels / downloadWithNotice / recognize / match). No timer, socket, network or Chrome.

// scan-panel.js imports "../csv.js", which ships only into extension/dist (extension/build.py copies it from
// src/jev_ultrafast/static/csv.js, it is not in extension/src). A tiny resolve hook points that one specifier at the
// real source file, so the shipped module runs as it is written.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const csvUrl = pathToFileURL(fileURLToPath(new URL("../../src/jev_ultrafast/static/csv.js", import.meta.url))).href;
const loader = `export async function resolve(specifier, context, next) {
  if (specifier === "../csv.js" && context.parentURL?.endsWith("/scan/scan-panel.js")) {
    return { url: ${JSON.stringify(csvUrl)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(new URL("data:text/javascript;base64," + Buffer.from(loader).toString("base64")));

import { indexTables } from "../src/traderie/lookup.js";
import { downscale } from "../src/scan/tooltip.js";

const { initScanPanel } = await import("../src/scan/scan-panel.js");

// --- the pictures these tests scan ---------------------------------------------------------------------------------

const WIDTH = 960;
const HEIGHT = 540;

function noise(width, height, { seed = 12345 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < width * height; i++) {
    const v = 70 + Math.floor(rand() * 91);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function fill(img, x, y, w, h, value) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = value;
      img.data[i + 1] = value;
      img.data[i + 2] = value;
      img.data[i + 3] = 255;
    }
  }
}

/**
 * One frame of the shared window as the real screenshots render a tooltip: a dark panel with antialiased text lines
 * (bright dashes with mid-grey between and around them) on top of mid-grey game noise. `stripes` sets how wide the
 * text lines are, so two calls build two different panels — the session keys a crop by the panel's own content, so
 * the same drawing at another place is one crop while a differently drawn one is a second.
 */
function panelFrame(box, { stripes = 0.6 } = {}) {
  const img = noise(WIDTH, HEIGHT);
  const { x, y, width, height } = box;
  fill(img, x, y, width, height, 20);
  const span = Math.round(width * stripes);
  const left = x + Math.round((width - span) / 2);
  for (let sy = y + 4; sy < y + height; sy += 28) {
    fill(img, left, sy - 2, span, 2, 96);
    fill(img, left, sy + 8, span, 2, 96);
    for (let sx = left; sx < left + span; sx += 48) {
      const dash = Math.min(40, left + span - sx);
      if (dash > 0) fill(img, sx, sy, dash, 8, 200);
      if (dash < 48) fill(img, sx + dash, sy, 48 - dash, 8, 96);
    }
  }
  return img;
}

// Three panels in the frame's own 960x540 pixels, at three places and drawn two ways.
const PANEL_A = { x: 300, y: 120, width: 200, height: 260 }; // the item panel
const PANEL_B = { x: 500, y: 120, width: 200, height: 260 }; // another panel elsewhere
const PANEL_C = { x: 100, y: 120, width: 200, height: 260 }; // a third one, narrow text lines

// --- what the OCR engine reads --------------------------------------------------------------------------------------

const NAME_TEXT = "Arachnid Mesh";
const AFFIX_TEXT = "+27 力量 (STN)";
const UNREADABLE_TEXT = ""; // no name and no affix line: the session refuses it and counts 略過

// The two contingency messages scan-panel.js puts in front of the live status.
const BLACK_ADVICE = "擷取到的是黑畫面：請把遊戲改成「視窗化全螢幕」。";
const SLOW_ADVICE = "遊戲蓋住 Chrome 時畫面會變慢：請把遊戲設為視窗模式並與 Chrome 並排，或用第二個螢幕。";

/** The candidates the shipped matcher answers for the texts these tests read (the shape matchOcrText returns). */
function candidateFor(text) {
  return text === NAME_TEXT ? [{ name: NAME_TEXT, kind: "item", matched: NAME_TEXT }] : [];
}

const tables = indexTables({
  generated_at: "2026-01-01T00:00:00+00:00",
  products: [
    { name: NAME_TEXT, slug: "arachnid-mesh", category: "uniques" },
    { name: "Ring", slug: "ring", category: "base" },
  ],
  zh: { 蛛網紋束帶: NAME_TEXT },
  bases: ["Ring"],
  game_only: [],
});

// --- the clock ------------------------------------------------------------------------------------------------------

// The records are stamped with `new Date()`, and 時間 is part of what the screen shows, so the panel gets one fixed
// instant. Only this file's process is affected (node --test runs each file on its own).
const REAL_DATE = Date;
const FIXED_MS = new REAL_DATE(2026, 9, 12, 12, 34, 56).getTime();

class FixedDate extends REAL_DATE {
  constructor(...args) {
    if (args.length === 0) super(FIXED_MS);
    else super(...args);
  }
}
globalThis.Date = FixedDate;

// --- a DOM just big enough for the screen ---------------------------------------------------------------------------

class FakeNode {
  constructor(tagName = "div") {
    this.nodeType = 1;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.type = "";
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.listeners = {};
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  set innerHTML(_value) {
    throw new Error("scan-panel.js writes textContent only: OCR text must never reach a markup sink");
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }

  /** Dispatch `type` and wait for every listener (the panel's are async) to finish. */
  async fire(type, event = {}) {
    await Promise.all((this.listeners[type] ?? []).map((handler) => handler(event)));
    return this;
  }
}

const IDS = ["scan-start", "scan-stop", "scan-status", "scan-list", "scan-csv", "scan-clear", "scan-stats"];

function makeDocument(ids) {
  const byId = new Map(ids.map((id) => [id, new FakeNode("div")]));
  // The markup's own initial state (sidepanel.html): the list and 停止掃描 ship hidden, the two list buttons disabled.
  byId.get("scan-list").hidden = true;
  byId.get("scan-stop").hidden = true;
  byId.get("scan-csv").disabled = true;
  byId.get("scan-clear").disabled = true;
  return { byId, createElement: (tagName) => new FakeNode(tagName), getElementById: (id) => byId.get(id) ?? null };
}

// --- the browser-only pieces, stubbed -------------------------------------------------------------------------------

let env; // what every stub below reads; setup() replaces it

globalThis.document = {
  createElement: (tagName) => {
    const node = new FakeNode(tagName);
    if (tagName === "a") {
      // download.js (saveText) builds an <a download> and clicks it: the click is this file's download sink.
      node.click = () => env.saved.push({ name: node.download, href: node.href, blob: env.lastBlob });
    }
    return node;
  },
  getElementById: (id) => env.doc.byId.get(id) ?? null,
};

// saveText hands its Blob to URL.createObjectURL; the tests keep it so the CSV's bytes and MIME are observable, and
// the click above is where the download is recorded.
globalThis.URL.createObjectURL = (blob) => {
  env.lastBlob = blob;
  return "blob:scan-download";
};
globalThis.URL.revokeObjectURL = () => {};

/**
 * An OffscreenCanvas stub. The panel builds two: the detector's, which it gives the full-resolution bitmap and
 * DETECT_WIDTH and then reads back (so this one really downscales), and the crop's, whose drawImage is the rectangle
 * grab() asks for (recorded here, so the arithmetic is observable).
 */
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.calls = []; // every drawImage, as its argument list
    this.image = null;
    env.canvases.push(this);
  }

  getContext(_type, options = {}) {
    const canvas = this;
    const readBack = Boolean(options.willReadFrequently); // only the detector asks for its pixels back
    canvas.willRead = readBack; // the role tag the accessors below use instead of the construction order
    return {
      drawImage(source, ...rest) {
        canvas.calls.push(rest);
        if (readBack) canvas.image = downscale(source, canvas.width);
      },
      getImageData(_x, _y, width, height) {
        return { width, height, data: canvas.image.data };
      },
    };
  }

  /** What the panel queues for OCR: a PNG of the crop (only its type and size matter to these tests). */
  async convertToBlob({ type } = {}) {
    return new Blob([new Uint8Array(this.width * this.height)], { type });
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

globalThis.createImageBitmap = async (frame) => {
  env.bitmaps.push(frame.timestamp);
  if (env.failFrames.has(frame.timestamp)) throw new Error("boom"); // a decoder that gave up on this frame
  return {
    width: frame.img.width,
    height: frame.img.height,
    data: frame.img.data,
    close() {}, // the panel closes every bitmap it decoded
  };
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getDisplayMedia: (options) => {
        env.picks.push(options);
        return env.pick(options);
      },
    },
  },
});

/** The fake share: one video track whose reader hands out env.frames, then ends. */
function fakeReader() {
  const reader = {
    drained: false, // set once the loop has asked for a frame and been told there are none: the capture is over
    async read() {
      await env.gate; // frames only start arriving once the capture is wired: the real dialog takes seconds
      if (!env.frames.length) {
        reader.drained = true;
        return { done: true, value: undefined };
      }
      reader.drained = false;
      return { done: false, value: env.frames.shift() };
    },
    async cancel() {},
  };
  env.readers.push(reader);
  return reader;
}

globalThis.MediaStreamTrackProcessor = class {
  constructor() {
    this.readable = { getReader: () => fakeReader() };
  }
};

/** Chrome's ticker, driven by fireTick(): the panel must not be able to schedule a real one. */
globalThis.setInterval = (fn) => {
  const handle = { fn, cleared: false };
  env.tickers.push(handle);
  return handle;
};
globalThis.clearInterval = (handle) => {
  if (handle) handle.cleared = true;
};

globalThis.performance = {
  now: () => {
    if (env.times.length) env.clock = env.times.shift();
    return env.clock;
  },
};

/** No test here may reach the network: a click that started a query would land in env.fetches. */
globalThis.fetch = async (...args) => {
  env.fetches.push(args);
  throw new Error("no network in this test");
};

// --- the harness ----------------------------------------------------------------------------------------------------

/** A fresh screen: new elements, new fakes, nothing queued. `pick`, `missing` and `download` are the browser/engine. */
function setup({ pick, missing = { names: [], bytes: 0 }, download = async () => true } = {}) {
  env = {
    doc: makeDocument(IDS),
    canvases: [],
    bitmaps: [],
    failFrames: new Set(),
    frames: [],
    readers: [],
    tracks: [],
    picks: [],
    stops: 0,
    tickers: [],
    times: [],
    clock: 0,
    fetches: [],
    saved: [], // one entry per download.js click, with the Blob handed to URL.createObjectURL
    lastBlob: null,
    gate: null,
    openGate: null,
    pick: pick ?? (async () => fakeStream()),
    missing,
    download,
    downloads: [],
    handlers: { name: [], stats: [] },
    ocr: null,
  };
  env.gate = new Promise((resolve) => {
    env.openGate = resolve;
  });
  env.ocr = makeOcr();
  initScanPanel({
    ocr: env.ocr,
    tables,
    onSearchName: (record) => env.handlers.name.push(record),
    onSearchStats: (record) => env.handlers.stats.push(record),
  });
  return env;
}

/** A stream as capture.js reads it: one video track, whose "ended" event is the player's own 停止分享. */
function fakeStream() {
  const track = {
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    stopped: 0,
    stop() {
      this.stopped += 1;
      env.stops += 1;
    },
    end() {
      for (const handler of this.listeners.ended ?? []) handler();
    },
  };
  env.tracks.push(track);
  return { getVideoTracks: () => [track], getTracks: () => [track] };
}

/** The OCR engine of ocr/panel.js: reads are held open until a test answers them, so the panel's own timing is told. */
function makeOcr() {
  const api = {
    reads: [], // the crop blobs, in the order the panel handed them over
    matches: [], // the texts the panel asked to match
    pending: [], // one deferred per read
    missingModels: async () => ({ ...env.missing }),
    downloadWithNotice: async (args) => {
      env.downloads.push(args);
      return env.download();
    },
    recognize(blob) {
      api.reads.push(blob);
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      api.pending.push({ blob, resolve });
      return promise;
    },
    match(text) {
      api.matches.push(text);
      return candidateFor(text);
    },
  };
  return api;
}

/** One frame of the fake capture, with the timestamp the panel's frame throttle reads. */
function fakeFrame(img, timestamp) {
  return {
    img,
    timestamp,
    closed: false, // a VideoFrame's close() is idempotent, so this records only whether it was closed at all
    close() {
      this.closed = true;
    },
  };
}

// A frame with no picture at all: mean grey below BLACK_MEAN, and nothing the detector would call a tooltip. The
// picture is shared by every dark frame (this file feeds a few hundred of them) and is already DETECT_WIDTH wide, so
// what the panel reads from it is the mean grey, not a downscale.
const DARK_IMG = { width: 480, height: 270, data: new Uint8ClampedArray(480 * 270 * 4) };

/** One dark frame of the fake capture. */
function darkFrame(timestamp) {
  return fakeFrame(DARK_IMG, timestamp);
}

/**
 * Drains the microtask queue until `done()` holds. Every step of the panel's path is a microtask with these fakes
 * (the capture loop, the crop, the OCR, the render), so nothing has to sleep for it.
 */
async function settle(done, label, limit = 4000) {
  for (let i = 0; i < limit && !done(); i++) await Promise.resolve();
  assert.ok(done(), `the panel never settled: ${label}`);
}

const node = (id) => env.doc.byId.get(id);
const statusText = () => node("scan-status").textContent;
const statsText = () => node("scan-stats").textContent;
const listEl = () => node("scan-list");
// The panel builds two canvases, but their construction order is not a contract, so each is found by its role: the
// detector is the one the panel reads pixels back from (getContext with willReadFrequently), the crop is the other.
const detectCanvas = () => env.canvases.find((canvas) => canvas.willRead);
const cropCanvas = () => env.canvases.find((canvas) => !canvas.willRead);

/** 開始掃描: resolves once the picker answered and the capture is wired. */
const startScan = () => node("scan-start").fire("click");

const openGate = () => env.openGate();

/** Feeds one panel per entry, STABLE_FRAMES frames each (100 ms apart), then lets the frames flow. */
function deliver(panels) {
  for (const { box, stripes = 0.6, frames = 2 } of panels) {
    const img = panelFrame(box, { stripes });
    for (let i = 0; i < frames; i++) env.frames.push(fakeFrame(img, (env.frames.length + 1) * 100000));
  }
  openGate();
}

/** Waits until the panel has cut `n` crops out of the frames. */
const settleCrops = (n) => settle(() => cropCanvas().calls.length === n, `${n} crops`);

/** Pushes frames the test built itself, then waits for the read loop to end on them. */
async function feedFrames(frames) {
  env.frames.push(...frames);
  openGate();
  await drained();
}

/** Waits until the panel has handed `n` crops to the OCR engine (every read is held until a test answers it). */
const settleReads = (n) => settle(() => env.ocr.reads.length === n, `${n} crops at the engine`);

/** Waits until the frame loop is over: every frame pushed so far has been through onFrame and closed. */
const drained = () => settle(() => env.readers[0].drained, "the read loop to end");

/**
 * Answers crop `i` with `text` and waits until the panel has taken the answer (match() ran for it), rather than
 * assuming the product's exact number of awaits: any extra await in scan-panel.js still settles here.
 */
async function answer(i, text) {
  await settle(() => env.ocr.pending.length > i, `crop ${i} to reach the engine`);
  env.ocr.pending[i].resolve(text);
  await settle(() => env.ocr.matches.length > i, `the panel to take crop ${i}'s answer`);
}

/** One second on the panel's own ticker. */
function fireTick() {
  for (const ticker of env.tickers) if (!ticker.cleared) ticker.fn();
}

/** Runs the screen up to `texts.length` records on the list, without stopping the capture. */
async function scanPanels(panels, texts) {
  setup();
  await startScan();
  deliver(panels);
  await settleCrops(texts.length);
  for (let i = 0; i < texts.length; i++) await answer(i, texts[i]);
}

// --- the empty screen ------------------------------------------------------------------------------------------------

test("before anything runs: no records, both list buttons disabled, the status and the stats blank", () => {
  setup();
  assert.equal(statusText(), "");
  assert.equal(statsText(), "每秒畫面 0、偵測 0、略過 0、丟棄 0、平均辨識 — 秒");
  assert.deepEqual(listEl().children, []);
  assert.equal(listEl().hidden, true);
  assert.equal(node("scan-csv").disabled, true);
  assert.equal(node("scan-clear").disabled, true);
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(node("scan-start").disabled, false);
  assert.deepEqual(env.canvases.map((canvas) => [canvas.width, canvas.height]), [[1, 1], [1, 1]]); // both start 1x1
});

// --- the crop --------------------------------------------------------------------------------------------------------

test("a stable panel is cut out of the full-resolution frame: the detected box scaled up, plus the 4-px ring", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }]);
  await settleReads(1);

  // The detector finds the panel this frame draws at 300,120 200x260 in the 480-wide frame the panel shrinks to, i.e.
  // at { x: 150, y: 60, width: 100, height: 132 }. grab() scales that back up by 960/480 = 2 and keeps PAD = 4 px of
  // the frame around it, clamped to the frame: floor(150*2)-4 = 296, floor(60*2)-4 = 116, ceil(250*2)+4 = 504 and
  // ceil(192*2)+4 = 388, so a 208x272 crop drawn into the crop canvas at 0,0.
  assert.deepEqual(detectCanvas().calls, [[0, 0, 480, 270], [0, 0, 480, 270]]);
  assert.deepEqual(cropCanvas().calls, [[296, 116, 208, 272, 0, 0, 208, 272]]);
  assert.deepEqual([cropCanvas().width, cropCanvas().height], [208, 272]);
  assert.equal(env.ocr.reads.length, 1);
  assert.equal(env.ocr.reads[0].type, "image/png"); // what the engine is handed
  assert.equal(env.ocr.pending.length, 1); // held: the engine has not answered yet
  assert.deepEqual(listEl().children, []);
});

test("a frame closer than 66 ms to the last one is counted in the rate but never read", async () => {
  setup();
  await startScan();
  env.times = [0, 1000]; // one read of one second
  const img = panelFrame(PANEL_A);
  // 40 ms after the first frame (closer than the panel's 66 ms) and 70 ms after that one.
  const [first, skipped, third] = [fakeFrame(img, 10000), fakeFrame(img, 50000), fakeFrame(img, 120000)];
  env.frames.push(first, skipped, third);
  openGate();

  await settleCrops(1);
  await drained(); // 3 frames, then the read that ends the loop
  assert.deepEqual(env.bitmaps, [10000, 120000]); // the 40-ms frame never reached the decoder
  // Every frame is closed: the panel closes the ones it decoded and capture.js closes them all again (a no-op); the
  // throttled frame's only close is capture.js's. What matters is that none is left open.
  assert.deepEqual([first.closed, skipped.closed, third.closed], [true, true, true]);
  await answer(0, NAME_TEXT);
  fireTick();
  assert.equal(statsText(), "每秒畫面 3、偵測 2、略過 0、丟棄 0、平均辨識 1.0 秒");
});

// --- the record list -------------------------------------------------------------------------------------------------

test("one list item per record: the name line, the 類型/詞綴 line and two search buttons carrying the index", async () => {
  // The affix-only panel is read first, so the newest record (the named one) lands on top of the list.
  setup();
  await startScan();
  deliver([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }]);
  await settleCrops(2);
  await answer(0, AFFIX_TEXT);
  await answer(1, NAME_TEXT);

  const items = listEl().children;
  assert.equal(items.length, 2);
  assert.equal(listEl().hidden, false);
  assert.equal(node("scan-csv").disabled, false);
  assert.equal(node("scan-clear").disabled, false);

  const named = items[0];
  assert.deepEqual({ index: named.dataset.index, name: named.dataset.name, kind: named.dataset.kind }, {
    index: "0",
    name: NAME_TEXT,
    kind: "item",
  });
  const [line1, line2, actions] = named.children;
  assert.equal(line1.className, "line1");
  assert.deepEqual(line1.children.map((child) => [child.tagName, child.textContent]), [
    ["strong", "Arachnid Mesh（蛛網紋束帶）"],
  ]);
  assert.equal(line2.className, "line2");
  assert.equal(line2.textContent, "12:34:56 · 暗金/套裝/符文之語");
  assert.equal(actions.className, "actions");
  assert.deepEqual(actions.children.map((button) => button.textContent), ["精準搜尋", "模糊搜尋"]);
  assert.deepEqual(actions.children.map((button) => [button.tagName, button.type, button.className, button.dataset.index]), [
    ["button", "button", "link", "0"],
    ["button", "button", "link", "0"],
  ]);
  assert.deepEqual(actions.children.map((button) => button.disabled), [false, false]);

  const unnamed = items[1];
  assert.deepEqual({ index: unnamed.dataset.index, name: unnamed.dataset.name, kind: unnamed.dataset.kind }, {
    index: "1",
    name: "",
    kind: "",
  });
  assert.equal(unnamed.children[0].children[0].textContent, "沒認出名稱");
  assert.equal(unnamed.children[1].textContent, "12:34:56 · — · 力量");
  assert.deepEqual(unnamed.children[2].children.map((button) => button.dataset.index), ["1", "1"]);
  assert.equal(unnamed.children[2].children[0].disabled, true); // no name: 精準搜尋 cannot look anything up
  assert.equal(unnamed.children[2].children[1].disabled, false);
});

// --- 匯出 CSV --------------------------------------------------------------------------------------------------------

test("匯出 CSV downloads the records as a named CSV: header, one row per record and the UTF-8 MIME", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, NAME_TEXT]);
  assert.equal(node("scan-csv").disabled, false);

  await node("scan-csv").fire("click");

  assert.equal(env.saved.length, 1, "exactly one file was handed to the browser");
  const [{ name, href, blob }] = env.saved;
  assert.equal(name, "jev-scan-20261012-1234.csv", "the name is jev-scan-<yyyymmdd-hhmm>.csv at the fixed clock");
  assert.equal(href, "blob:scan-download", "the anchor points at the object URL of the CSV blob");
  assert.equal(blob.type, "text/csv;charset=utf-8", "Excel is told the bytes are UTF-8 CSV");
  const csv = Buffer.from(await blob.arrayBuffer()).toString("utf8");
  assert.equal(
    csv,
    "\uFEFF時間,名稱,中文名稱,類型,詞綴,辨識文字\r\n" +
      "2026-10-12 12:34:56,Arachnid Mesh,蛛網紋束帶,暗金/套裝/符文之語,,Arachnid Mesh\r\n" +
      // The affix text starts with "+": csvCell prefixes it so a spreadsheet does not run it as a formula.
      "2026-10-12 12:34:56,,,—,力量,'+27 力量 (STN)\r\n",
  );
});

test("匯出 CSV on an empty list saves nothing", async () => {
  setup();
  assert.equal(node("scan-csv").disabled, true, "the button ships disabled with no records");

  await node("scan-csv").fire("click");

  assert.deepEqual(env.saved, [], "no file is offered for an empty list");
});

// --- 清除紀錄 --------------------------------------------------------------------------------------------------------

test("清除紀錄 empties the list, disables both list buttons and leaves the run's counters standing", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, NAME_TEXT]);
  assert.equal(listEl().children.length, 2);
  const during = statsText();

  await node("scan-clear").fire("click");

  assert.deepEqual(listEl().children, []);
  assert.equal(listEl().hidden, true);
  assert.equal(node("scan-csv").disabled, true);
  assert.equal(node("scan-clear").disabled, true);
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
  // 掃描統計 counts the run (frames, detections, reads), not the list, so clearing the list does not reset it.
  assert.equal(statsText(), during);
  assert.equal(statsText(), "每秒畫面 0、偵測 4、略過 0、丟棄 0、平均辨識 0.0 秒");
});

test("清除紀錄 before the first crop does not stop the crops taken after it from being recorded", async () => {
  setup();
  await startScan();
  await node("scan-clear").fire("click"); // the player clears an empty list while the scan runs
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  deliver([{ box: PANEL_A }]);
  await settleReads(1);
  await answer(0, NAME_TEXT);

  // A crop captured in the run the panel is in now is a record like any other (only the crops of the cleared run
  // are refused), so the generation the panel carries with each crop is what keeps this working.
  assert.equal(listEl().children.length, 1);
  assert.equal(listEl().children[0].dataset.name, NAME_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 0 件");
});

test("a crop the OCR is still reading when 清除紀錄 is pressed does not come back as a record", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }]);
  await settleReads(1); // the first crop is at the engine and stays there
  await drained(); // 4 frames, then the read that ends the loop
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 1 件"); // the second crop waits behind the open read

  await node("scan-clear").fire("click");
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件"); // the waiting crop went with the clear
  await answer(0, NAME_TEXT); // the read the player outran: its generation is the cleared one

  assert.deepEqual(listEl().children, []);
  assert.equal(env.ocr.reads.length, 1); // the dropped crop was never read
  assert.equal(statsText(), "每秒畫面 4、偵測 4、略過 0、丟棄 0、平均辨識 — 秒"); // no read landed, so no average
});

// --- the status line -------------------------------------------------------------------------------------------------

test("a picker the player closed says so, leaves 開始掃描 usable and never asks for a frame", async () => {
  setup({
    pick: async () => {
      const dismissed = new Error("dismissed");
      dismissed.name = "NotAllowedError";
      throw dismissed;
    },
  });
  await startScan();

  assert.equal(statusText(), "沒有選擇遊戲視窗，掃描沒有開始。");
  assert.equal(node("scan-start").disabled, false);
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(env.readers.length, 0);
  assert.deepEqual(env.tickers, []);
});

test("a picker that failed for another reason shows the reason and leaves the button usable", async () => {
  setup({
    pick: async () => {
      throw new Error("no window server");
    },
  });
  await startScan();

  assert.equal(statusText(), "無法開始掃描：no window server");
  assert.equal(node("scan-start").disabled, false);
  assert.equal(node("scan-stop").hidden, true);
});

test("a cancelled model download never opens the picker and says why nothing started", async () => {
  setup({
    missing: { names: ["det.onnx"], bytes: 4096 },
    download: async () => {
      const cancelled = new Error("stopped by the player");
      cancelled.kind = "cancelled";
      throw cancelled;
    },
  });
  await startScan();

  assert.deepEqual(env.downloads.map((args) => ({
    noticeId: args.noticeId,
    textId: args.textId,
    progressId: args.progressId,
    cancelId: args.cancelId,
    tail: args.tail,
    names: args.names,
    bytes: args.bytes,
    say: typeof args.say,
  })), [{
    noticeId: "scan-download",
    textId: "scan-download-text",
    progressId: "scan-progress",
    cancelId: "scan-cancel",
    tail: "之後可離線使用",
    names: ["det.onnx"],
    bytes: 4096,
    say: "function",
  }]);
  assert.equal(statusText(), "已取消下載辨識模型，掃描沒有開始。");
  assert.deepEqual(env.picks, []); // the share dialog was never opened
  assert.equal(node("scan-start").disabled, false);
});

test("while sharing, the status counts the records and the crops still waiting for OCR", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }]);
  await settleReads(1); // the first crop is at the engine and stays there (every read is held)
  await drained(); // 4 frames, then the read that ends the loop
  assert.equal(node("scan-start").disabled, true);
  assert.equal(node("scan-stop").hidden, false);

  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 1 件"); // one read in flight, one crop behind it

  await answer(0, NAME_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 1 件"); // the record landed, the next crop still waited

  await answer(1, AFFIX_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 2 件，待辨識 0 件");
  assert.deepEqual(listEl().children.map((item) => item.dataset.index), ["0", "1"]);
});

test("停止掃描 releases the share, drops the ticker and states the final count", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }]);
  await settleCrops(1);
  await answer(0, NAME_TEXT);

  await node("scan-stop").fire("click");

  assert.equal(statusText(), "已停止，共記錄 1 件");
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(node("scan-start").disabled, false);
  assert.equal(env.stops, 1); // capture.stop(): the window is no longer shared
  assert.deepEqual(env.tickers.map((ticker) => ticker.cleared), [true]);
  const stopped = statsText();
  fireTick(); // a stopped panel has no ticker left
  assert.equal(statsText(), stopped);
});

test("the player's own 停止分享 ends the run the same way, with no error in front of the count", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }]);
  await settleCrops(1);
  await answer(0, NAME_TEXT);

  env.tracks[0].end(); // Chrome's "stop sharing"

  assert.equal(statusText(), "已停止，共記錄 1 件");
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(node("scan-start").disabled, false);
  assert.equal(env.stops, 1);
});

test("a read loop that gave up ends the capture and puts the reason in front of the final count", async () => {
  setup();
  await startScan();
  const img = panelFrame(PANEL_A);
  const frame = fakeFrame(img, 100000);
  env.frames.push(frame);
  env.failFrames.add(100000); // the decoder refuses this frame
  openGate();

  await settle(() => env.stops === 1, "the failed read loop to end the capture");

  assert.equal(statusText(), "擷取中斷：boom 已停止，共記錄 0 件");
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(node("scan-start").disabled, false);
  assert.deepEqual(listEl().children, []);
});

test("a long run of dark frames warns about a black capture, and a picture coming back drops the advice", async () => {
  const dark = (n, from = 0) => Array.from({ length: n }, (_, i) => darkFrame((from + i + 1) * 100000));

  // One dark frame short of the run the advice needs (BLACK_FRAMES = 30): 29 of them stay silent.
  setup();
  await startScan();
  await feedFrames(dark(29));
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  // The 30th sets it, and it is composed in front of the live count.
  setup();
  await startScan();
  await feedFrames(dark(30));
  fireTick();
  assert.equal(statusText(), `${BLACK_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  // The black-screen advice outranks the slowdown one: slow ticks never replace it.
  fireTick();
  fireTick();
  fireTick();
  assert.equal(statusText(), `${BLACK_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  // Frames with a picture on them are what clear it (the tick has no say here).
  setup();
  await startScan();
  const bright = [panelFrame(PANEL_A), panelFrame(PANEL_A)].map((img, i) => fakeFrame(img, (31 + i) * 100000));
  await feedFrames([...dark(30), ...bright]);
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
});

test("a run of slow seconds advises moving the game beside Chrome, and a fast one drops it", async () => {
  setup();
  await startScan();
  fireTick();
  fireTick();
  // Two seconds below SLOW_FPS = 5 are not enough ...
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  fireTick();
  assert.equal(statusText(), `${SLOW_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  // ... and a second that carries frames (at least SLOW_FPS = 5 of them) recovers it.
  await feedFrames(
    Array.from({ length: 6 }, (_, i) => fakeFrame(panelFrame(PANEL_A), (i + 1) * 100000)),
  );
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
  await answer(0, NAME_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 0 件");
});

// --- the stats line --------------------------------------------------------------------------------------------------

test("the stats line counts frames, detections, refusals and the run's average read", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_C, stripes: 0.2 }, { box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }]);
  env.times = [0, 1000, 2000, 3000, 4000, 5000]; // three reads of one second each
  await settleCrops(3);
  await answer(0, NAME_TEXT);
  await answer(1, AFFIX_TEXT);
  await answer(2, UNREADABLE_TEXT); // neither a name nor an affix line: refused, but still read

  fireTick();
  assert.equal(statsText(), "每秒畫面 6、偵測 6、略過 1、丟棄 0、平均辨識 1.0 秒");
  assert.equal(listEl().children.length, 2);
  assert.equal(env.ocr.matches.length, 3);
});

// --- the two search buttons ------------------------------------------------------------------------------------------

test("the search buttons hand the live record to the injected handlers and start no query themselves", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }]);
  await settleCrops(2);
  await answer(0, AFFIX_TEXT);
  await answer(1, NAME_TEXT);

  const [named, unnamed] = listEl().children;
  const [precise, fuzzy] = named.children[2].children;
  const reads = env.ocr.reads.length;

  await precise.fire("click");
  assert.equal(env.handlers.name.length, 1);
  assert.deepEqual(env.handlers.stats, []);
  const record = env.handlers.name[0];
  assert.deepEqual(
    { name: record.name, zh: record.zh, kind: record.kind, base: record.base, text: record.text, conditions: record.conditions },
    { name: NAME_TEXT, zh: "蛛網紋束帶", kind: "item", base: null, text: NAME_TEXT, conditions: [] },
  );
  assert.ok(record.at instanceof REAL_DATE); // the record itself, with its own Date, not a rendering of it

  await fuzzy.fire("click");
  assert.equal(env.handlers.stats.length, 1);
  assert.equal(env.handlers.name.length, 1);
  assert.equal(env.handlers.stats[0], record); // the same object both times: a copy would fail this

  const [unnamedPrecise, unnamedFuzzy] = unnamed.children[2].children;
  assert.equal(unnamedPrecise.disabled, true);
  await unnamedFuzzy.fire("click");
  assert.equal(env.handlers.stats.length, 2);
  assert.notEqual(env.handlers.stats[1], record);
  assert.deepEqual(
    { name: env.handlers.stats[1].name, text: env.handlers.stats[1].text, labels: env.handlers.stats[1].conditions.map((c) => c.label) },
    { name: null, text: AFFIX_TEXT, labels: ["力量"] },
  );

  assert.equal(env.ocr.reads.length, reads); // pressing a search button read no crop
  assert.deepEqual(env.fetches, []); // and no query left the page
});
