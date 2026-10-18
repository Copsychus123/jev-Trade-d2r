// The 裝備掃描 screen (scan-panel.js) is the whole flow around the scan session: it takes frames off the shared
// window, cuts each tooltip out of them, hands the crop to the OCR engine, keeps one record per item and writes the
// list, the status line and the run's counters to the page. scan-session.test.mjs covers the state machine
// underneath; nothing executed this module, so the crop arithmetic, the record markup, 清除紀錄 and every status
// wording could ship unnoticed.
//
// This drives the real module end to end against fakes only: a fake Chrome capture (getDisplayMedia +
// MediaStreamTrackProcessor) feeding synthetic frames, an OffscreenCanvas/createImageBitmap pair whose
// drawImage/getImageData calls are recorded, one second of ticker fired by hand, and an OCR engine with the interface
// ocr/panel.js exposes (missingModels / downloadModels / recognize / match). No timer, socket, network or Chrome.

// scan-panel.js imports "../csv.js", which ships only into extension/dist (extension/build.py copies it from
// src/jev_ultrafast/static/csv.js, it is not in extension/src). A tiny resolve hook points that one specifier at the
// real source file, so the shipped module runs as it is written.

import assert from "node:assert/strict";
import test from "node:test";

import { installStubResolver } from "./support/stubs.mjs";

installStubResolver();

import { toneQuality } from "../src/ocr/tone.js";
import { indexTables } from "../src/traderie/lookup.js";
import { downscale } from "../src/scan/tooltip.js";
import { fill, noise } from "./support/images.mjs";

const { initScanPanel } = await import("../src/scan/scan-panel.js");

/** `img` with a bright patch in the top-left corner: something else in the game moving, far from any tooltip panel. */
function cornerPatch(img, step) {
  const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  fill(copy, 8 + step * 40, 8, 30, 30, 250);
  return copy;
}

// --- the pictures these tests scan ---------------------------------------------------------------------------------

const WIDTH = 960;
const HEIGHT = 540;

/**
 * One frame of the shared window as the real screenshots render a tooltip: a dark panel with antialiased text lines
 * (bright dashes with mid-grey between and around them) on top of mid-grey game noise. `stripes` sets how wide the
 * text lines are, so two calls build two different panels — the session keys a crop by the panel's own content, so
 * the same drawing at another place is one crop while a differently drawn one is a second.
 */
function panelFrame(box, { stripes = 0.6, seed = 12345 } = {}) {
  const img = noise(WIDTH, HEIGHT, { seed });
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
const UNSURE_TEXT = "Arachnid Mesh Ring"; // read as an item with its type line under it: not sure which of the two
const UNREADABLE_TEXT = ""; // no name and no affix line: the session refuses it and counts 略過

// The two contingency messages scan-panel.js puts in front of the live status.
const BLACK_ADVICE = "擷取到的是黑畫面：請把遊戲改成「視窗化全螢幕」。";
const HIDDEN_ADVICE = "遊戲視窗蓋住了這個面板，掃描會變慢、快速掠過的裝備可能漏掉。建議把遊戲改成視窗模式、和 Chrome 並排。";
const SLOW_ADVICE = "畫面更新偏慢，快速掠過的裝備可能漏掉。建議把遊戲改成視窗模式、和 Chrome 並排，並關掉其他吃資源的程式。";

/** The candidates the shipped matcher answers for the texts these tests read (the shape matchOcrText returns). */
function candidateFor(text, tones = []) {
  if (text.startsWith(UNSURE_TEXT)) {
    return [
      // The name is on line 0; matchOcrText gives it the quality its line's lettering colour says.
      { kind: "item", name: NAME_TEXT, distance: 0, matched: NAME_TEXT, size: 4, at: 0, quality: toneQuality(tones[0]) },
      { kind: "base", name: "Ring", distance: 0, matched: "Ring", size: 2, at: 1 },
    ];
  }
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
    this.classList = { add: (name) => (this.className = [this.className, name].filter(Boolean).join(" ")) };
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

  setAttribute(name, value) {
    (this.attributes ??= {})[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes?.[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes?.[name];
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
  get visibilityState() {
    return env.visibility; // "hidden" while the game covers the side panel
  },
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
  if (env.holdFrames.has(frame.timestamp)) await new Promise((resolve) => (env.held = resolve)); // a decoder still at work
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
      // A live capture keeps waiting for the next second's frames; otherwise it ends once the frames are out.
      while (!env.frames.length && env.live) {
        reader.idle = true;
        await new Promise((resolve) => {
          env.wake = resolve;
        });
      }
      reader.idle = false;
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
    holdFrames: new Set(),
    held: null,
    frames: [],
    readers: [],
    tracks: [],
    picks: [],
    stops: 0,
    tickers: [],
    times: [],
    visibility: "visible",
    live: false, // a capture that goes on waiting for frames (liveSecond) instead of ending when they are out
    wake: null,
    stamp: 0,
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
  env.scan = initScanPanel({
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
    downloadModels: async (args) => {
      env.downloads.push(args);
      return env.download();
    },
    recognize(blob, options = {}) {
      api.reads.push(blob);
      api.readOptions.push(options);
      let resolve;
      let reject;
      const promise = new Promise((r, j) => {
        resolve = r;
        reject = j;
      });
      api.pending.push({ blob, resolve, reject });
      return promise;
    },
    match(text, tones) {
      api.matches.push(text);
      return candidateFor(text, tones);
    },
    // The possible names of an unsure read: the shipped extendCandidates needs the real name index, so the tests that
    // want more than the matcher's own candidates set `extra`.
    possible(candidates, text) {
      api.possibles.push(text);
      return [...candidates, ...(api.extra ?? [])];
    },
    firstKey: (text) => (api.firstKeys ? api.firstKeys[text] ?? "" : ""),
    learn(key, name) {
      api.learned.push([key, name]);
      return true;
    },
    async detectBoxes(img) {
      api.detectCalls.push(img);
      return api.detBoxes ? api.detBoxes(img) : (api.boxes ?? []);
    },
    detectCalls: [],
    boxes: null,
    detBoxes: null,
    readOptions: [], // what each read was asked for (the scan never caps detection: its crops are small)
    possibles: [], // the texts the panel asked possible names for
    learned: [], // what the panel asked the correction memory to remember: [key, name]
    extra: null, // names appended to the candidates of an unsure read
    firstKeys: null, // text -> the read's first name line
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
 * Runs the panel's queued work until `done()` holds, then asserts it did. The wait is driven by that observable
 * state, one turn of the event loop at a time (setImmediate: a yield to the loop, not a timer and not a sleep), so a
 * loaded machine cannot starve it the way a fixed microtask budget could. The count is only a guard against a panel
 * that really is stuck, and it is far above what any test here needs (the busiest wait takes a few turns).
 */
async function settle(done, label, limit = 10000) {
  for (let i = 0; i < limit && !done(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

/**
 * Pushes frames into a capture that stays open (the reader idles between them, like a real share): `feedFrames`
 * above ends the reader once its frames are out, so a second batch pushed that way would never be read at all.
 */
async function feedLive(frames) {
  env.live = true;
  env.frames.push(...frames);
  openGate();
  env.wake?.();
  await settle(() => env.frames.length === 0 && env.readers[0].idle, "the pushed frames to be processed");
}

/** Waits until the panel has handed `n` crops to the OCR engine (every read is held until a test answers it). */
const settleReads = (n) => settle(() => env.ocr.reads.length === n, `${n} crops at the engine`);

/** Waits until the frame loop is over: every frame pushed so far has been through onFrame and closed. */
const drained = () => settle(() => env.readers[0].drained, "the read loop to end");

/** Lets the one frame the fake decoder is holding (env.holdFrames) through, so the read loop goes on to the rest. */
function releaseFrame() {
  env.held();
  env.held = null;
}

/**
 * Answers crop `i` with `text` and waits until the panel has taken the answer (match() ran for it), rather than
 * assuming the product's exact number of awaits: any extra await in scan-panel.js still settles here.
 */
async function answer(i, text, tones = []) {
  await settle(() => env.ocr.pending.length > i, `crop ${i} to reach the engine`);
  env.ocr.pending[i].resolve({ text, tones });
  await settle(() => env.ocr.matches.length > i, `the panel to take crop ${i}'s answer`);
}

/** One second on the panel's own ticker. */
function fireTick() {
  for (const ticker of env.tickers) if (!ticker.cleared) ticker.fn();
}

/** `count` seconds on the panel's own ticker. */
function fireTicks(count) {
  for (let i = 0; i < count; i += 1) fireTick();
}

/**
 * One second of a live capture: `count` frames (all stamped alike, so the panel counts them but processes only the
 * first, like frames that arrive inside its 66 ms throttle), then the second's tick. The capture stays open between
 * seconds, which the frames-then-end harness above cannot do.
 */
async function liveSecond(count) {
  env.live = true;
  const stamp = (env.stamp += 1_000_000);
  env.frames.push(...Array.from({ length: count }, () => darkFrame(stamp)));
  openGate();
  env.wake?.();
  await settle(() => env.frames.length === 0 && env.readers[0].idle, `${count} frames of one second`);
  fireTick();
}

/** Runs the screen up to `texts.length` records on the list, without stopping the capture. */
async function scanPanels(panels, texts, tonesOf = [], configure = () => {}) {
  setup();
  configure(env.ocr); // what the stand-in matcher and memory answer for this scan
  await startScan();
  deliver(panels);
  await settleCrops(texts.length);
  for (let i = 0; i < texts.length; i++) await answer(i, texts[i], tonesOf[i]);
}

/** A fresh screen fed `frames`, one tick blown after them: the status line those frames produce. */
async function statusAfterFrames(frames) {
  setup();
  await startScan();
  await feedFrames(frames);
  fireTick();
  return statusText();
}

/** Two panels delivered, the first crop held at the engine, then the read loop ended: one crop waits behind it. */
async function twoCropsWithOneHeldAtTheEngine() {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }]);
  await settleReads(1);
  await drained();
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
  env.times = [0, 0, 1000]; // accept at 0, one read from 0 to 1 s
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
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, NAME_TEXT]);

  const items = listEl().children;
  assert.equal(items.length, 2);
  assert.equal(listEl().hidden, false);
  assert.equal(node("scan-csv").disabled, false);
  assert.equal(node("scan-clear").disabled, false);

  assertNamedItem(items[0]);
  assertUnnamedItem(items[1]);
});

/** The named record (index 0): its 類型 line and two enabled search buttons. */
function assertNamedItem(named) {
  assert.deepEqual({ index: named.dataset.index, name: named.dataset.name, kind: named.dataset.kind }, {
    index: "0",
    name: NAME_TEXT,
    kind: "item",
  });
  const [line1, line2, actions] = named.children;
  assert.equal(line1.className, "line1");
  assert.deepEqual(line1.children.map((child) => [child.tagName, child.textContent]), [
    ["strong", "蛛網紋束帶（Arachnid Mesh）"],
    ["button", "✕"],
  ]);
  assert.deepEqual([line1.children[1].type, line1.children[1].getAttribute("aria-label")], [
    "button",
    "刪除這一筆：Arachnid Mesh",
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
}

/** The affix-only record (index 1): no name, so 精準搜尋 is disabled and only 模糊搜尋 can be pressed. */
function assertUnnamedItem(unnamed) {
  assert.deepEqual({ index: unnamed.dataset.index, name: unnamed.dataset.name, kind: unnamed.dataset.kind }, {
    index: "1",
    name: "",
    kind: "",
  });
  assert.equal(unnamed.children[0].children[0].textContent, "沒認出名稱");
  assert.equal(unnamed.children[1].textContent, "12:34:56 · — · 力量");
  const actions = unnamed.children.at(-1); // after the 「輸入名稱」 box every record without a name has
  assert.equal(unnamed.children.length, 4, "name line, type line, the box to type a name, the search buttons");
  assert.deepEqual(actions.children.map((button) => button.dataset.index), ["1", "1"]);
  assert.equal(actions.children[0].disabled, true); // no name: 精準搜尋 cannot look anything up
  assert.equal(actions.children[1].disabled, false);
}

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

// --- ✕ on one row ----------------------------------------------------------------------------------------------------

const removeButton = (item) => item.children[0].children[1];

test("the ✕ of a row deletes that record only, and the status, the list and the CSV follow", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, NAME_TEXT]);
  assert.equal(removeButton(listEl().children[1]).getAttribute("aria-label"), "刪除這一筆：沒認出名稱");

  await removeButton(listEl().children[0]).fire("click"); // the named record on top

  assert.equal(listEl().children.length, 1);
  const [left] = listEl().children;
  assert.deepEqual([left.dataset.name, left.children[0].children[0].textContent], ["", "沒認出名稱"]);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 0 件");
  assert.equal(node("scan-csv").disabled, false);
  await node("scan-csv").fire("click");
  const csv = Buffer.from(await env.saved[0].blob.arrayBuffer()).toString("utf8");
  assert.equal(csv.includes("Arachnid Mesh"), false, "the deleted record is not in the file");
  assert.equal(csv.includes("力量"), true);
  assert.deepEqual(env.handlers.name, []);
  assert.deepEqual(env.fetches, [], "deleting starts no query");
});

test("deleting the last record hides the list and disables 下載 CSV and 清除紀錄", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);

  await removeButton(listEl().children[0]).fire("click");

  assert.equal(listEl().hidden, true);
  assert.equal(node("scan-csv").disabled, true);
  assert.equal(node("scan-clear").disabled, true);
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
});

test("a row can be deleted after the scan stopped, without touching the capture", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);
  await node("scan-stop").fire("click");
  const stops = env.stops;

  await removeButton(listEl().children[0]).fire("click");

  assert.equal(listEl().children.length, 0);
  assert.equal(statusText(), "已停止，共記錄 0 件");
  assert.equal(env.stops, stops);
});

test("a deleted item is recorded again when the same tooltip is hovered again", async () => {
  setup();
  await startScan();
  // The tooltip, then a frame with none (the decoder holds it), then the same tooltip again: the capture is still
  // feeding frames when the player deletes the first record.
  env.holdFrames.add(300000);
  const img = panelFrame(PANEL_A, { stripes: 0.6 });
  env.frames.push(fakeFrame(img, 100000), fakeFrame(img, 200000), darkFrame(300000));
  env.frames.push(fakeFrame(img, 400000), fakeFrame(img, 500000));
  openGate();
  await settleCrops(1);
  await answer(0, NAME_TEXT);
  await removeButton(listEl().children[0]).fire("click");
  assert.equal(listEl().children.length, 0);

  releaseFrame();
  await settleCrops(2);
  await answer(1, NAME_TEXT);

  assert.equal(listEl().children.length, 1);
  assert.equal(listEl().children[0].dataset.name, NAME_TEXT);
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
  await twoCropsWithOneHeldAtTheEngine();
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

  assert.deepEqual(env.downloads.map((args) => ({ names: args.names })), [{
    names: ["det.onnx"],
  }]);
  assert.equal(statusText(), "已取消下載辨識模型，掃描沒有開始。");
  assert.deepEqual(env.picks, []); // the share dialog was never opened
  assert.equal(node("scan-start").disabled, false);
});

test("while sharing, the status counts the records and the crops still waiting for OCR", async () => {
  await twoCropsWithOneHeldAtTheEngine();
  assert.equal(node("scan-start").disabled, true);
  assert.equal(node("scan-stop").hidden, false);

  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 1 件"); // one read in flight, one crop behind it

  env.times = [2000]; // the first read, started at 0, ends at 2 s
  await answer(0, NAME_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 1 件，約 2 秒"); // the record landed, the next crop still waited

  await answer(1, AFFIX_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 2 件，待辨識 0 件");
  assert.deepEqual(listEl().children.map((item) => item.dataset.index), ["0", "1"]);
});

test("the waiting line estimates the queue as its length times the average read, and only once a read has landed", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }, { box: PANEL_C, stripes: 0.2 }]);
  await settleReads(1);
  await drained();
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 2 件"); // no read has finished: no number to multiply

  env.times = [3000, 3000, 7000, 7000, 7000]; // read 1 ends at 3 s, read 2 runs 3 s -> 7 s: the average is 3.5 s
  await answer(0, NAME_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 2 件，約 6 秒"); // 2 x 3.0 s

  await answer(1, AFFIX_TEXT);
  assert.equal(statusText(), "掃描中：已記錄 2 件，待辨識 1 件，約 4 秒"); // 1 x 3.5 s, rounded

  await answer(2, UNSURE_TEXT);
  await settle(() => listEl().children.length === 3, "the third record to land");
  assert.equal(statusText(), "掃描中：已記錄 3 件，待辨識 0 件"); // an empty queue has no estimate
});

test("停止掃描 releases the share, drops the ticker and states the final count", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);

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

test("the stop the panel hands back ends a running share like 停止掃描, and does nothing when no scan runs", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);

  env.scan.stop();

  assert.equal(statusText(), "已停止，共記錄 1 件");
  assert.equal(node("scan-stop").hidden, true);
  assert.equal(node("scan-start").disabled, false);
  assert.equal(env.stops, 1);
  env.scan.stop(); // already stopped: no second release
  assert.equal(env.stops, 1);
});

test("the player's own 停止分享 ends the run the same way, with no error in front of the count", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);

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

test("a read the engine refused shows 辨識失敗 in front of the live status, and the next crop clears it", async () => {
  setup();
  await startScan();
  // The second panel's last frame waits in the decoder, so the capture is still feeding frames when the first read
  // fails: that is what lets the next crop reach the engine in this same run (a stable tooltip re-enters the pump).
  env.holdFrames.add(400000);
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }]);
  await settleReads(1); // panel A's crop is at the engine and stays there
  env.ocr.pending[0].reject(new Error("engine exploded"));
  await settle(() => statusText().includes("辨識失敗"), "the failure to reach the status line");

  // Not statusText: a mid-scan failure must be visible now, in front of the live count.
  assert.equal(statusText(), "辨識失敗：engine exploded 掃描中：已記錄 0 件，待辨識 0 件");
  assert.deepEqual(listEl().children, []);

  releaseFrame();
  await settleReads(2);
  fireTick(); // the second's tick is what puts the waiting count on the status line
  // The failure stays up while the next read is in flight (that read has already left the queue): it is only retired
  // by a read that lands, not by one that starts.
  assert.equal(statusText(), "辨識失敗：engine exploded 掃描中：已記錄 0 件，待辨識 0 件");

  // The read that works is what retires the failure: it clears at the point the panel learns a later read landed.
  env.ocr.pending[1].resolve({ text: AFFIX_TEXT, tones: [] });
  await settle(() => listEl().children.length === 1, "the record of crop 1 to land");
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 0 件");
  assert.equal(listEl().children[0].dataset.name, "");
});

test("a long run of dark frames warns about a black capture, and a picture coming back drops the advice", async () => {
  const dark = (n, from = 0) => Array.from({ length: n }, (_, i) => darkFrame((from + i + 1) * 100000));

  // One dark frame short of the run the advice needs (BLACK_FRAMES = 30): 29 of them stay silent.
  assert.equal(await statusAfterFrames(dark(29)), "掃描中：已記錄 0 件，待辨識 0 件");

  // The 30th sets it, and it is composed in front of the live count.
  assert.equal(await statusAfterFrames(dark(30)), `${BLACK_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  // The black-screen advice outranks the slowdown one: slow ticks never replace it.
  fireTicks(3);
  assert.equal(statusText(), `${BLACK_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  // Frames with a picture on them are what clear it (the tick has no say here).
  const bright = [panelFrame(PANEL_A), panelFrame(PANEL_A)].map((img, i) => fakeFrame(img, (31 + i) * 100000));
  assert.equal(await statusAfterFrames([...dark(30), ...bright]), "掃描中：已記錄 0 件，待辨識 0 件");
});

test("a covered side panel says so, and the advice goes when the panel is visible again or the scan stops", async () => {
  setup();
  await startScan();
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件"); // visible: nothing to say

  env.visibility = "hidden"; // the game now covers Chrome
  fireTick();
  assert.equal(statusText(), `${HIDDEN_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  env.visibility = "visible";
  fireTick();
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  env.visibility = "hidden";
  fireTick();
  await node("scan-stop").fire("click");
  assert.equal(statusText(), "已停止，共記錄 0 件"); // nothing is being scanned any more, so nothing is slow
});

test("a covered panel is told once, and the black-picture advice still comes first", async () => {
  setup();
  await startScan();
  env.visibility = "hidden";
  await liveSecond(2); // slow as well: the cause (covered) is named, not both
  await liveSecond(2);
  await liveSecond(2);
  assert.equal(statusText(), `${HIDDEN_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);

  const dark = Array.from({ length: 30 }, () => darkFrame((env.stamp += 1_000_000)));
  env.frames.push(...dark);
  env.wake();
  await settle(() => env.frames.length === 0 && env.readers[0].idle, "30 dark frames");
  fireTick();
  assert.equal(statusText(), `${BLACK_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);
});

test("a rate that bounces around under five frames a second still advises the game beside Chrome, and a fast one drops it", async () => {
  setup();
  await startScan();
  const seconds = [7, 2, 1, 6, 4, 3, 8]; // the rate measured while the game covered Chrome
  for (const count of seconds.slice(0, 2)) await liveSecond(count);
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件", "two seconds are not a pattern");

  for (const count of seconds.slice(2)) await liveSecond(count);
  assert.equal(statusText(), `${SLOW_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`); // the last six average 4.0

  for (let i = 0; i < 3; i++) await liveSecond(12); // the picture recovered
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
});

test("seconds without a frame are a still picture: they never raise the slow advice and do not hide a slow stretch", async () => {
  setup();
  await startScan();
  fireTicks(10); // nothing moves on the shared window from the start
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  await liveSecond(12);
  await liveSecond(12);
  await liveSecond(12); // a sweep at a healthy rate ...
  fireTicks(10); // ... and then the picture stays still while the last tooltip is read
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");

  for (const count of [2, 0, 0, 1, 0, 3]) await liveSecond(count); // slow seconds with idle ones between them
  assert.equal(statusText(), `${SLOW_ADVICE} 掃描中：已記錄 0 件，待辨識 0 件`);
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

test("the stats line counts a panel hovered again and a read with the same text as 略過, and none of them as a record", async () => {
  setup();
  await startScan();
  // B's drawing again at another place is the same panel (one crop: refused, 略過 1); a read of the same text as
  // the first record is refused on its text (略過 2).
  deliver([{ box: PANEL_A }, { box: PANEL_B, stripes: 0.3 }, { box: PANEL_C, stripes: 0.3 }]);
  await settleCrops(3); // the panel cuts every stable box; the session then refuses the repeat
  await answer(0, NAME_TEXT);
  await answer(1, NAME_TEXT);

  fireTick();
  assert.equal(statsText(), "每秒畫面 6、偵測 6、略過 2、丟棄 0、平均辨識 0.0 秒");
  assert.equal(listEl().children.length, 1);
  assert.equal(env.ocr.reads.length, 2); // the third panel never reached the engine
});

// --- the two search buttons ------------------------------------------------------------------------------------------

test("the search buttons hand the live record to the injected handlers and start no query themselves", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, NAME_TEXT]);

  const [named, unnamed] = listEl().children;
  const [precise, fuzzy] = named.children[2].children;
  const reads = env.ocr.reads.length;

  await precise.fire("click");
  assert.equal(env.handlers.name.length, 1);
  assert.deepEqual(env.handlers.stats, []);
  const record = env.handlers.name[0];
  assertNamedSearchRecord(record);

  await fuzzy.fire("click");
  assert.equal(env.handlers.stats.length, 1);
  assert.equal(env.handlers.name.length, 1);
  assert.equal(env.handlers.stats[0], record); // the same object both times: a copy would fail this

  const [unnamedPrecise, unnamedFuzzy] = unnamed.children.at(-1).children; // after the 「輸入名稱」 box
  assert.equal(unnamedPrecise.disabled, true);
  await unnamedFuzzy.fire("click");
  assert.equal(env.handlers.stats.length, 2);
  assert.notEqual(env.handlers.stats[1], record);
  assertAffixSearchRecord(env.handlers.stats[1]);

  assert.equal(env.ocr.reads.length, reads); // pressing a search button read no crop
  assert.deepEqual(env.fetches, []); // and no query left the page
});

/** 精準搜尋 hands the record itself to onSearchName, with its own Date, not a rendering of it. */
function assertNamedSearchRecord(record) {
  assert.deepEqual(
    { name: record.name, zh: record.zh, kind: record.kind, base: record.base, text: record.text, conditions: record.conditions },
    { name: NAME_TEXT, zh: "蛛網紋束帶", kind: "item", base: null, text: NAME_TEXT, conditions: [] },
  );
  assert.ok(record.at instanceof REAL_DATE); // the record itself, with its own Date, not a rendering of it
}

/** 模糊搜尋 on the affix-only panel hands onSearchStats a record with no name and the 力量 condition. */
function assertAffixSearchRecord(record) {
  assert.deepEqual(
    { name: record.name, text: record.text, labels: record.conditions.map((c) => c.label) },
    { name: null, text: AFFIX_TEXT, labels: ["力量"] },
  );
}

// --- a read that is not sure: the player picks --------------------------------------------------------------------------

/** The `li` children of an unsure row: the name line, the 類型/詞綴 line, the names to pick, the two search buttons. */
const optionButtons = (item) => item.children[2].children;
const searchButtons = (item) => item.children.at(-1).children;

test("a read that is not sure is listed as 不確定 with its names as buttons and both searches disabled", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT]);

  const [item] = listEl().children;
  assert.deepEqual({ name: item.dataset.name, kind: item.dataset.kind, unsure: item.dataset.unsure }, {
    name: "",
    kind: "",
    unsure: "true",
  });
  assert.equal(item.children[0].children[0].textContent, "不確定");
  assert.equal(removeButton(item).getAttribute("aria-label"), "刪除這一筆：不確定");
  assert.deepEqual(optionButtons(item).map((b) => [b.textContent, b.dataset.kind, b.dataset.name]), [
    ["蛛網紋束帶（Arachnid Mesh）", "item", NAME_TEXT],
    ["Ring", "base", "Ring"],
  ]);
  assert.deepEqual(searchButtons(item).map((b) => [b.textContent, b.disabled]), [["精準搜尋", true], ["模糊搜尋", true]]);
  assert.equal(statusText(), "掃描中：已記錄 1 件，待辨識 0 件", "it counts as a record: the player still has to decide");
  assert.equal(node("scan-csv").disabled, false);
});

test("the same read is named by itself when its name line is printed in unique gold, and still asks when it is rare yellow", async () => {
  // The lettering colour of line 0 (the name line) comes from the engine with the text; a type line under a gold name
  // is a real unique, under a yellow one it may be a rare item whose random name is spelled like a catalogue name.
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], [[[198, 178, 120]]]);
  assert.deepEqual(
    { name: listEl().children[0].dataset.name, unsure: listEl().children[0].dataset.unsure },
    { name: NAME_TEXT, unsure: undefined },
  );
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], [[[248, 248, 100]]]);
  assert.deepEqual(
    { name: listEl().children[0].dataset.name, unsure: listEl().children[0].dataset.unsure },
    { name: "", unsure: "true" },
  );
});

test("an unsure record exports with an empty name and its text, until a name is picked", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT]);

  await node("scan-csv").fire("click");
  const csv = Buffer.from(await env.saved[0].blob.arrayBuffer()).toString("utf8");
  assert.equal(
    csv,
    "\uFEFF時間,名稱,中文名稱,類型,詞綴,辨識文字\r\n2026-10-12 12:34:56,,,—,,Arachnid Mesh Ring\r\n",
  );
});

test("picking a name names the record like an auto-picked one: searches enabled, the CSV exports the pick", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT]);
  assert.equal(listEl().children[0].dataset.name, "", "before the pick the record has no name");

  await optionButtons(listEl().children[0])[0].fire("click");

  const [item] = listEl().children;
  assert.deepEqual({ name: item.dataset.name, kind: item.dataset.kind, unsure: item.dataset.unsure }, {
    name: NAME_TEXT,
    kind: "item",
    unsure: undefined,
  });
  assert.equal(item.children[0].children[0].textContent, "蛛網紋束帶（Arachnid Mesh）");
  assert.equal(item.children[1].textContent, "12:34:56 · 暗金/套裝/符文之語");
  assert.equal(item.children.length, 3, "the names to pick are gone: name line, type line and the search buttons");
  assert.deepEqual(searchButtons(item).map((b) => b.disabled), [false, false]);
  assert.equal(removeButton(item).getAttribute("aria-label"), "刪除這一筆：Arachnid Mesh");

  await searchButtons(item)[0].fire("click");
  const record = env.handlers.name[0];
  assert.deepEqual(
    { name: record.name, zh: record.zh, kind: record.kind, base: record.base, text: record.text },
    { name: NAME_TEXT, zh: "蛛網紋束帶", kind: "item", base: "Ring", text: UNSURE_TEXT },
    "the same fields an auto-picked record has; its base is the read's own type line",
  );

  await node("scan-csv").fire("click");
  const csv = Buffer.from(await env.saved[0].blob.arrayBuffer()).toString("utf8");
  assert.equal(csv.split("\r\n")[1], "2026-10-12 12:34:56,Arachnid Mesh,蛛網紋束帶,暗金/套裝/符文之語,,Arachnid Mesh Ring");
});

test("picking the type name instead names the record as a base", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT]);

  await optionButtons(listEl().children[0])[1].fire("click");

  const [item] = listEl().children;
  assert.deepEqual({ name: item.dataset.name, kind: item.dataset.kind }, { name: "Ring", kind: "base" });
  assert.equal(item.children[1].textContent, "12:34:56 · 底材");
  assert.deepEqual(searchButtons(item).map((b) => b.disabled), [false, false]);
});

test("an unsure row can be deleted with its ✕, and nothing is exported for it afterwards", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT]);
  assert.equal(listEl().children[0].dataset.unsure, "true");

  await removeButton(listEl().children[0]).fire("click");

  assert.equal(listEl().children.length, 0);
  assert.equal(statusText(), "掃描中：已記錄 0 件，待辨識 0 件");
  assert.equal(node("scan-csv").disabled, true);
});

test("two unsure rows pick independently, each by its own record", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [UNSURE_TEXT, `${UNSURE_TEXT} 2`]);
  const [newest, older] = listEl().children;
  assert.equal(newest.dataset.unsure, "true");
  assert.equal(older.dataset.unsure, "true");

  await optionButtons(older)[1].fire("click"); // the older row, picked while the newer one waits

  const [stillNewest, nowOlder] = listEl().children;
  assert.equal(stillNewest.dataset.unsure, "true", "the other row is still asking");
  assert.deepEqual([nowOlder.dataset.name, nowOlder.dataset.kind], ["Ring", "base"]);
});

// --- possible names and the 「輸入名稱」 box ---------------------------------------------------------------------------------

const NAME_ZH = "蛛網紋束帶";
const nameBoxOf = (item) => item.children.find((child) => child.className === "name-box");
const inputOf = (item) => nameBoxOf(item).children[0];
const confirmOf = (item) => nameBoxOf(item).children[1];
const noteOf = (item) => nameBoxOf(item).children.find((child) => child.className === "muted small");

/** An unresolved row with no names to pick: the affix-only read of the other tests, in a fresh panel. */
async function unresolvedRow(configure = () => {}) {
  await scanPanels([{ box: PANEL_A }], [AFFIX_TEXT], [], configure);
  return listEl().children[0];
}

test("an unsure read offers the possible names the reader found, beyond its own candidates, each Chinese first", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], [], (ocr) => {
    ocr.extra = [{ kind: "item", name: NAME_TEXT, distance: 2, matched: "zz", size: 4, at: 2 }]; // a name the matcher alone missed
    ocr.extra[0].name = "Arachnid Mesh";
  });

  const [item] = listEl().children;
  assert.equal(env.ocr.possibles.length, 1, "the panel asked for the possible names of this read");
  assert.equal(item.dataset.unsure, "true");
  assert.deepEqual(optionButtons(item).map((b) => b.dataset.name), [NAME_TEXT, "Ring", NAME_TEXT]);
  assert.equal(item.children.some((child) => child.className === "options" && child.getAttribute("aria-label") === "可能是"), true);
});

test("a sure read asks for no possible names and keeps no options", async () => {
  await scanPanels([{ box: PANEL_A }], [NAME_TEXT]);
  assert.deepEqual(env.ocr.possibles, []);
  assert.equal(nameBoxOf(listEl().children[0]), undefined, "a named record has no box to type a name");
});

test("a record with no name shows the 「輸入名稱」 box under its type line, with the search buttons after it", async () => {
  const item = await unresolvedRow();

  assert.equal(item.dataset.unsure, undefined, "no names to pick: it is unresolved, not unsure");
  assert.equal(item.children[0].children[0].textContent, "沒認出名稱");
  assert.deepEqual(item.children.map((child) => child.className), ["line1", "line2", "name-box", "actions"]);
  assert.equal(inputOf(item).getAttribute("aria-label"), "輸入名稱");
  assert.equal(confirmOf(item).textContent, "確定");
  assert.equal(removeButton(item).getAttribute("aria-label"), "刪除這一筆：沒認出名稱");
});

test("a typed table name names the record like an auto-picked one: Chinese or English, searches, CSV, and the memory hears it", async () => {
  const item = await unresolvedRow((ocr) => {
    ocr.firstKeys = { [AFFIX_TEXT]: "27力量stn" };
  });

  inputOf(item).value = NAME_ZH;
  await inputOf(item).fire("input");
  await confirmOf(item).fire("click");

  const [named] = listEl().children;
  assert.deepEqual({ name: named.dataset.name, kind: named.dataset.kind, unsure: named.dataset.unsure }, { name: NAME_TEXT, kind: "item", unsure: undefined });
  assert.equal(named.children[0].children[0].textContent, `${NAME_ZH}（${NAME_TEXT}）`);
  assert.equal(nameBoxOf(named), undefined, "the box goes away once the record has a name");
  assert.deepEqual(named.children.at(-1).children.map((b) => b.disabled), [false, false]);
  assert.deepEqual(env.ocr.learned, [["27力量stn", NAME_TEXT]], "the reader's memory is told the read's first name line and the name");

  await named.children.at(-1).children[0].fire("click");
  assert.deepEqual(
    { name: env.handlers.name[0].name, zh: env.handlers.name[0].zh, kind: env.handlers.name[0].kind, conditions: env.handlers.name[0].conditions.map((c) => c.label) },
    { name: NAME_TEXT, zh: NAME_ZH, kind: "item", conditions: ["力量"] },
  );
  await node("scan-csv").fire("click");
  const csv = Buffer.from(await env.saved[0].blob.arrayBuffer()).toString("utf8");
  assert.equal(csv.split("\r\n")[1], `2026-10-12 12:34:56,${NAME_TEXT},${NAME_ZH},暗金/套裝/符文之語,力量,'+27 力量 (STN)`);
  assert.deepEqual(env.fetches, [], "and no query left the page");
});

test("a typed English name and Enter work too, and a base name makes a base record", async () => {
  const item = await unresolvedRow();

  inputOf(item).value = "ring";
  await inputOf(item).fire("keydown", { key: "Enter", defaultPrevented: false, preventDefault() {} });

  const [named] = listEl().children;
  assert.deepEqual([named.dataset.name, named.dataset.kind], ["Ring", "base"]);
});

test("a name the tables do not list leaves the record as it was and says so in plain Chinese", async () => {
  const item = await unresolvedRow();

  inputOf(item).value = "沒有這個東西";
  await confirmOf(item).fire("click");

  const [still] = listEl().children;
  assert.equal(still.dataset.name, "");
  assert.equal(noteOf(still).textContent, "對照表裡找不到「沒有這個東西」，請從建議選一個，或換個寫法");
  assert.deepEqual(env.ocr.learned, [], "nothing was remembered");
  inputOf(still).value = "";
  await confirmOf(still).fire("click");
  assert.equal(noteOf(listEl().children[0]).textContent, "請先輸入名稱");
});

test("a half-typed name survives the list being drawn again (here: another row deleted)", async () => {
  await scanPanels([{ box: PANEL_B, stripes: 0.3 }, { box: PANEL_A }], [AFFIX_TEXT, `${AFFIX_TEXT} 2`]);
  const [newer, older] = listEl().children;
  inputOf(older).value = "蛛網";
  await inputOf(older).fire("input");

  await removeButton(newer).fire("click"); // the list is drawn again without the newer row

  const [remaining] = listEl().children;
  assert.equal(inputOf(remaining).value, "蛛網", "what the player typed is still in the box");
});

test("the name suggestions of the name field are offered in the box too", async () => {
  const item = await unresolvedRow();

  inputOf(item).value = "arachnid";
  await inputOf(item).fire("input");

  const suggestions = nameBoxOf(item).children[2];
  assert.equal(suggestions.hidden, false);
  assert.equal(suggestions.children.length > 0, true);
});

test("picking a possible name tells the memory the text piece it matched, and the typed name of an unsure row uses the first option's piece", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], []);
  await optionButtons(listEl().children[0])[1].fire("click"); // Ring, matched "Ring"
  assert.deepEqual(env.ocr.learned, [["Ring", "Ring"]]);

  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], []);
  const item = listEl().children[0];
  inputOf(item).value = NAME_ZH; // none of the buttons: the player types
  await confirmOf(item).fire("click");
  assert.deepEqual(env.ocr.learned, [[NAME_TEXT, NAME_TEXT]], "keyed by the first possible name's text piece");
  assert.equal(listEl().children[0].dataset.name, NAME_TEXT);
});

test("a name the reader's memory promoted is labelled as chosen before, and the label stays on the picked button's name", async () => {
  await scanPanels([{ box: PANEL_A }], [UNSURE_TEXT], [], (ocr) => {
    const original = ocr.match;
    ocr.match = (text, tones) => original(text, tones).map((c, i) => (i === 0 ? { ...c, learned: 1 } : c));
  });

  const [first] = optionButtons(listEl().children[0]);
  assert.equal(first.textContent, `${NAME_ZH}（${NAME_TEXT}） · 你上次選過這個`);
  assert.equal(first.dataset.name, NAME_TEXT, "the value stays the English name");
});

test("the ✕ of an unresolved row deletes it with its half-typed name, and starts no query", async () => {
  const item = await unresolvedRow();
  inputOf(item).value = "半截";
  await inputOf(item).fire("input");

  await removeButton(item).fire("click");

  assert.equal(listEl().children.length, 0);
  assert.deepEqual(env.handlers, { name: [], stats: [] });
  assert.deepEqual(env.fetches, []);
});

test("typing a name into an unresolved row never starts a search by itself", async () => {
  const item = await unresolvedRow();
  inputOf(item).value = NAME_ZH;
  await confirmOf(item).fire("click");

  assert.deepEqual(env.handlers, { name: [], stats: [] }, "the player presses 精準搜尋 or 模糊搜尋 on their own");
  assert.deepEqual(env.fetches, []);
});

test("a held tooltip is cut out and read once however long it is held, while its frames keep changing", async () => {
  setup();
  await startScan();
  // The game keeps rendering under the tooltip: every frame is a little different, so the streak restarts over and
  // over. Before the held rule each restart cleared the "already cropped" flag, and the same hover became a crop,
  // a read and a record again.
  const frames = Array.from({ length: 24 }, (_, i) => fakeFrame(panelFrame(PANEL_A, { seed: 5000 + i }), (i + 1) * 100000));
  await feedLive(frames);

  await settleCrops(1);
  assert.equal(cropCanvas().calls.length, 1, "one crop for one held tooltip");
  await settleReads(1);
  await answer(0, NAME_TEXT);
  await settle(() => listEl().children.length === 1, "one record");
  assert.equal(env.ocr.reads.length, 1, "one read for one held tooltip");
  assert.equal(listEl().children.length, 1);
});

test("a different tooltip hovered right after a held one is still cut out and read", async () => {
  setup();
  await startScan();
  const held = Array.from({ length: 12 }, (_, i) => fakeFrame(panelFrame(PANEL_A, { seed: 5000 + i }), (i + 1) * 100000));
  await feedLive(held);
  await settleCrops(1);
  await settleReads(1);
  await answer(0, NAME_TEXT);
  await settle(() => listEl().children.length === 1, "the first record");

  const other = panelFrame(PANEL_B, { stripes: 0.3 });
  await feedLive([fakeFrame(other, 5_000_000), fakeFrame(other, 5_100_000)]);
  await settleCrops(2);
  await settleReads(2);
  await answer(1, AFFIX_TEXT);
  await settle(() => listEl().children.length === 2, "the second record");
  assert.equal(env.ocr.reads.length, 2);
});

test("a tooltip crop keeps the detection policy the model was tuned with: the scan never caps it", async () => {
  setup();
  await startScan();
  deliver([{ box: PANEL_A }]);
  await settleReads(1);

  assert.equal(env.ocr.readOptions[0].capDet, undefined, "no cap is asked for on a tooltip crop");
});

test("when findTooltip returns null on stable frames, fallback detection runs and rescues the tooltip into a record", async () => {
  setup();
  await startScan();
  // Frame with no dark panel (findTooltip returns null), but text boxes provided by det
  const nonPanelImg = noise(WIDTH, HEIGHT);
  env.ocr.boxes = [
    { x: 120, y: 80, width: 90, height: 16 },
    { x: 122, y: 104, width: 85, height: 16 },
    { x: 118, y: 128, width: 92, height: 16 },
    { x: 125, y: 152, width: 70, height: 16 },
  ];

  // Deliver 3 stable frames so frameStreak >= 2
  const frames = [
    fakeFrame(nonPanelImg, 100000),
    fakeFrame(nonPanelImg, 200000),
    fakeFrame(nonPanelImg, 300000),
  ];
  await feedFrames(frames);
  await settleReads(1);

  // The detector works in the frame it ran on: the box it hands over is scaled, and a pixel rectangle stays whole.
  const cropArgs = cropCanvas().calls[0];
  assert.ok(
    cropArgs.every((value) => Number.isInteger(value)),
    `a crop is a whole-pixel rectangle: ${cropArgs}`,
  );
  assert.equal(env.ocr.detectCalls.length, 1, "detectBoxes must be called once on stable frame");
  assert.equal(env.ocr.reads.length, 1, "the clustered box must be cropped and handed to OCR");

  await answer(0, NAME_TEXT);
  fireTick();

  assert.equal(listEl().children.length, 1);
  assert.ok(statsText().includes("、備援偵測 1 次、救回 1 件"), `stats line must show fallback stats: ${statsText()}`);
});

test("fallback detection respects the three-second rate limit and does not trigger repeatedly on continuous still frames", async () => {
  setup();
  await startScan();
  const nonPanelImg = noise(WIDTH, HEIGHT);
  env.ocr.boxes = [
    { x: 120, y: 80, width: 90, height: 16 },
    { x: 122, y: 104, width: 85, height: 16 },
    { x: 118, y: 128, width: 92, height: 16 },
    { x: 125, y: 152, width: 70, height: 16 },
  ];

  // Deliver frames: first fallback runs
  const batch1 = [fakeFrame(nonPanelImg, 100000), fakeFrame(nonPanelImg, 200000)];
  await feedFrames(batch1);
  await settleReads(1);
  assert.equal(env.ocr.detectCalls.length, 1);
  await answer(0, NAME_TEXT);

  // Deliver more frames immediately (within 3 seconds)
  const batch2 = [fakeFrame(nonPanelImg, 300000), fakeFrame(nonPanelImg, 400000)];
  await feedFrames(batch2);
  assert.equal(env.ocr.detectCalls.length, 1, "fallback must not run a second time within 3 seconds");
});

test("a fallback-only tooltip runs the fallback once per held picture, even while its frames keep changing", async () => {
  setup();
  await startScan();
  const base = noise(WIDTH, HEIGHT);
  env.ocr.boxes = [
    { x: 120, y: 80, width: 90, height: 16 },
    { x: 122, y: 104, width: 85, height: 16 },
    { x: 118, y: 128, width: 92, height: 16 },
    { x: 125, y: 152, width: 70, height: 16 },
  ];
  await feedLive([fakeFrame(base, 100000), fakeFrame(base, 200000)]);
  await settleReads(1);
  assert.equal(env.ocr.detectCalls.length, 1);
  await answer(0, NAME_TEXT);
  await settle(() => listEl().children.length === 1, "the rescued record");

  // 3.4 s later something else in the game has moved, far from the tooltip: the frame changed, the tooltip did not.
  const moved = cornerPatch(base, 1);
  await feedLive([fakeFrame(moved, 3_500_000), fakeFrame(moved, 3_600_000)]);
  assert.equal(env.ocr.detectCalls.length, 1, "the fallback is not run again for the same held tooltip");

  // ... and not even after the long backoff either: the run rescued the item, so this picture has had its det call.
  await feedLive([fakeFrame(moved, 21_100_000), fakeFrame(moved, 21_200_000)]);
  assert.equal(env.ocr.detectCalls.length, 1, "a rescued held picture is never hunted again");
});

test("a fallback run that rescued nothing holds off for the long backoff, not the three-second one", async () => {
  setup();
  await startScan();
  const base = noise(WIDTH, HEIGHT);
  env.ocr.boxes = [
    { x: 120, y: 80, width: 90, height: 16 },
    { x: 122, y: 104, width: 85, height: 16 },
    { x: 118, y: 128, width: 92, height: 16 },
    { x: 125, y: 152, width: 70, height: 16 },
  ];
  await feedLive([fakeFrame(base, 100000), fakeFrame(base, 200000)]);
  await settleReads(1);
  assert.equal(env.ocr.detectCalls.length, 1);
  await answer(0, UNREADABLE_TEXT);
  await settle(() => statsText().includes("略過 1"), "the unreadable read to be counted as 略過");

  // The same held picture 3.6 s later: the plain 3 s rule would run det again, and det cannot read an item it just
  // failed to read, so the run waits for the long backoff instead.
  await feedLive([fakeFrame(base, 3_700_000), fakeFrame(base, 3_800_000)]);
  assert.equal(env.ocr.detectCalls.length, 1, "an unreadable item is not re-detected on the three-second rule");

  // Past the long backoff it tries once more: the tooltip may only then have finished rendering.
  await feedLive([fakeFrame(base, 21_100_000), fakeFrame(base, 21_200_000)]);
  assert.equal(env.ocr.detectCalls.length, 2, "after the long backoff it tries again");
});

test("fallback detection does not run while a recognition is already in progress", async () => {
  setup();
  await startScan();
  const nonPanelImg = noise(WIDTH, HEIGHT);
  env.ocr.boxes = [
    { x: 120, y: 80, width: 90, height: 16 },
    { x: 122, y: 104, width: 85, height: 16 },
    { x: 118, y: 128, width: 92, height: 16 },
    { x: 125, y: 152, width: 70, height: 16 },
  ];

  // First deliver a normal panel so a read is pending/in progress
  deliver([{ box: PANEL_A }]);
  await settleReads(1);
  assert.equal(env.ocr.pending.length, 1); // read is in flight

  // While read is in flight, feed frames for which findTooltip returns null
  const frames = [fakeFrame(nonPanelImg, 500000), fakeFrame(nonPanelImg, 600000)];
  await feedFrames(frames);

  assert.equal(env.ocr.detectCalls.length, 0, "fallback must not run while OCR is in flight");
});
