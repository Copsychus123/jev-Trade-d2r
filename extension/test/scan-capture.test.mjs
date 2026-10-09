// The shared game window: which frames arrive, and what happens to the share when a step fails.
//
// MediaStreamTrackProcessor is the whole point of this module (a timer or requestVideoFrameCallback stops or throttles
// when the game covers Chrome), so these cases drive the real code with a stand-in processor, stream and reader.

import assert from "node:assert/strict";
import test from "node:test";

import { startCapture } from "../src/scan/capture.js";

class FakeTrack {
  constructor() {
    this.stops = 0;
    this.listeners = new Map();
  }

  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }

  fire(name) {
    this.listeners.get(name)?.();
  }

  stop() {
    this.stops += 1;
  }
}

class FakeFrame {
  constructor(id) {
    this.id = id;
    this.closes = 0;
  }

  close() {
    this.closes += 1;
  }
}

function fakeReader(frames) {
  const queue = [...frames];
  return {
    cancelled: 0,
    read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true }),
    cancel: async function cancel() {
      this.cancelled += 1;
    },
  };
}

/** Installs the two globals startCapture reaches for, and returns the pieces a case asserts on. */
function environment({ frames = [], getDisplayMedia, readerFor } = {}) {
  const track = new FakeTrack();
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const reader = fakeReader(frames);
  // `navigator` is a read-only accessor on globalThis in current Node, so it needs defining, not assigning.
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getDisplayMedia: getDisplayMedia ?? (async () => stream) } },
    configurable: true,
    writable: true,
  });
  globalThis.MediaStreamTrackProcessor = function processor() {
    if (readerFor === "throw") throw new Error("no processor here");
    return { readable: { getReader: () => (readerFor ? readerFor() : reader) } };
  };
  return { track, stream, reader };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the dialog asks for one window at 15 fps and every frame is handed over and closed", async () => {
  const asked = [];
  const frames = [new FakeFrame(1), new FakeFrame(2)];
  const { reader } = environment({
    frames,
    getDisplayMedia: async (options) => {
      asked.push(options);
      return { getVideoTracks: () => [new FakeTrack()], getTracks: () => [new FakeTrack()] };
    },
  });
  const seen = [];
  await startCapture(async (frame) => seen.push(frame.id));
  await tick();
  await tick();

  assert.deepEqual(asked, [
    { video: { displaySurface: "window", frameRate: { ideal: 15, max: 15 } }, audio: false, selfBrowserSurface: "exclude" },
  ]);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(frames.map((frame) => frame.closes), [1, 1]);
  assert.equal(reader.cancelled, 0);
});

test("a dialog the player cancels returns null, any other failure is thrown", async () => {
  environment({ getDisplayMedia: async () => { const error = new Error("cancelled"); error.name = "NotAllowedError"; throw error; } });
  assert.equal(await startCapture(async () => {}), null);

  environment({ getDisplayMedia: async () => { throw new Error("no display"); } });
  await assert.rejects(() => startCapture(async () => {}), /no display/);
});

test("a frame is closed even when the callback throws, and the failure reaches onEnded", async () => {
  const frame = new FakeFrame(1);
  environment({ frames: [frame] });
  const endings = [];
  await startCapture(async () => { throw new Error("bad frame"); }, (error) => endings.push(error));
  await tick();
  await tick();
  assert.equal(frame.closes, 1);
  assert.equal(endings.length, 1);
  assert.match(String(endings[0]), /bad frame/);
});

test("without a processor the share is stopped instead of left running", async () => {
  const { track } = environment({ readerFor: "throw" });
  await assert.rejects(() => startCapture(async () => {}), /no processor here/);
  assert.equal(track.stops, 1, "the game window must stop being shared");
});

test("the player's own stop-sharing ends the capture with no argument", async () => {
  const { track } = environment();
  const endings = [];
  const capture = await startCapture(async () => {}, (error) => endings.push(error));
  track.fire("ended");
  assert.deepEqual(endings, [undefined]);
  capture.stop();
});

test("stop cancels the reader and stops every track", async () => {
  const { track, reader } = environment({ frames: [new FakeFrame(1), new FakeFrame(2)] });
  const capture = await startCapture(async () => {});
  capture.stop();
  await tick();
  assert.equal(reader.cancelled, 1);
  assert.equal(track.stops, 1);
});
