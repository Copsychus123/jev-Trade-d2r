import assert from "node:assert/strict";
import test from "node:test";

import { toCsv } from "../../src/jev_ultrafast/static/csv.js";
import {
  KEY_TOLERANCE,
  MAX_QUEUE,
  RECORD_HEAD,
  baseCandidate,
  createScanSession,
  isUnsure,
  keyDistance,
  normalizeText,
  recordCells,
} from "../src/scan/session.js";
import { boxKey, downscale, findTooltip } from "../src/scan/tooltip.js";
import { fill, noise } from "./support/images.mjs";

const WIDTH = 480;
const HEIGHT = 270;

/** The dark panel body both frame builders start from; returns the centred text column (its left edge and width). */
function panelBody(img, { x, y, width, height }, stripes = 0.6) {
  fill(img, x, y, width, height, 20);
  const span = Math.round(width * stripes);
  return { left: x + Math.round((width - span) / 2), span };
}

// `stripes` says how much of the panel the text lines cover, so two calls can build two different-looking panels.
function frame(box, stripes = 0.6) {
  const img = noise(WIDTH, HEIGHT);
  if (!box) return img;
  const { left, span } = panelBody(img, box, stripes);
  const { y, height } = box;
  for (let sy = y + 2; sy < y + height; sy += 14) {
    const sh = Math.min(4, y + height - sy);
    if (sh > 0) fill(img, left, sy, span, sh, 200);
  }
  return img;
}

// The same panel drawn the way the real screenshots render it: antialiased text lines (bright dashes with mid-grey
// between the glyphs and a mid-grey halo above and below). `box` is in a 960x540 frame, and the frame is downscaled
// like the panel does it, so both the noise and the text reach the detector at the same scale as the real thing.
// `stripes` sets how wide the text lines are and `dashShift` slides the glyph dashes sideways, i.e. the same panel
// rendered a few pixels off (the kind of shift an encoder leaves behind).
function realisticFrame(box, { stripes = 0.6, dashShift = 0, seed = 12345 } = {}) {
  const img = noise(960, 540, { seed });
  const { left, span } = panelBody(img, box, stripes);
  const { y, height } = box;
  for (let sy = y + 4; sy < y + height; sy += 28) {
    fill(img, left, sy - 2, span, 2, 96);
    fill(img, left, sy + 8, span, 2, 96);
    for (let sx = left; sx < left + span; sx += 48) {
      const dash = Math.min(40, left + span - sx);
      if (dash > 0) fill(img, sx + dashShift, sy, dash, 8, 200);
      if (dash < 48) fill(img, sx + dash + dashShift, sy, 48 - dash, 8, 96);
    }
  }
  return downscale(img, 480);
}

// What scan-panel.js does for one stable box: feed the frame (twice, STABLE_FRAMES), offer the panel's key, and fill
// the job the session handed out with the crop.
function appearance(session, img) {
  session.feed(img);
  const hit = session.feed(img);
  if (!hit) return null;
  const job = session.accept(boxKey(img, hit.box));
  if (!job) return false;
  session.fill(job, { img });
  return true;
}

const BOX_A = { x: 150, y: 60, width: 100, height: 130 };
const BOX_B = { x: 250, y: 60, width: 100, height: 130 };

const record = (over = {}) => ({
  at: new Date(2026, 9, 6, 12, 34, 56),
  name: "Arachnid Mesh",
  zh: "蛛網紋束帶",
  kind: "item",
  conditions: [],
  text: "Spiderweb Sash",
  ...over,
});

test("a box comes back on the frame that first satisfies STABLE_FRAMES, never twice in a row", () => {
  const session = createScanSession();
  const img = frame(BOX_A);
  assert.equal(session.feed(img), null);
  const hit = session.feed(img);
  assert.ok(hit);
  // findTooltip returns the panel's own content box, which covers the rectangle drawn here within a few pixels
  // (the background next to the panel is mid-grey, so a column or row of it can come along). The session's promise
  // is that this frame's box comes back once, not that the detector's edges are the drawn ones.
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(hit.box[key] - BOX_A[key]) <= 12, `${key}: ${hit.box[key]} vs ${BOX_A[key]}`);
  }
  assert.equal(session.feed(img), null);
  assert.equal(session.feed(img), null);
  assert.equal(session.stats.frames, 4);
  assert.ok(session.stats.detected >= 3);
});

test("a changed box restarts the count, and the next stay crops once more", () => {
  const session = createScanSession();
  const panelA = frame(BOX_A);
  const panelB = frame(BOX_B);
  assert.equal(session.feed(panelA), null);
  assert.equal(session.feed(panelB), null);
  assert.ok(session.feed(panelB));

  assert.equal(session.feed(frame(null)), null);
  assert.equal(session.feed(panelA), null);
  assert.ok(session.feed(panelA));
});

test("accept refuses a crop key it has already queued", () => {
  const session = createScanSession();
  assert.ok(session.accept("deadbeef"));
  assert.equal(session.accept("deadbeef"), null);
  assert.ok(session.accept("cafebabe"));
});

// How many pixels of the 4-px ring the padded crop would carry around the panel differ between the two frames
// (PAD = 4 in scan-panel.js). The panel's own content is identical; this ring is what a byte identity would see.
function ringDiff(a, boxA, b, boxB) {
  const ring = (img, box) => {
    const out = [];
    for (let y = box.y - 4; y < box.y + box.height + 4; y++) {
      for (let x = box.x - 4; x < box.x + box.width + 4; x++) {
        const insidePanel = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
        if (insidePanel) continue;
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const pixel = (y * img.width + x) * 4;
        out.push(Math.max(img.data[pixel], img.data[pixel + 1], img.data[pixel + 2]));
      }
    }
    return out;
  };
  const ringA = ring(a, boxA);
  const ringB = ring(b, boxB);
  let differing = 0;
  for (let i = 0; i < Math.min(ringA.length, ringB.length); i++) {
    if (ringA[i] !== ringB[i]) differing += 1;
  }
  return differing;
}

test("the same panel shown at a second place is one crop, not two", () => {
  // The sim (and the game) shows one panel at different spots over different backdrops; the detector's box moves a
  // pixel or two with the backdrop, and the pixels around the panel differ. The identity is the panel's content, so
  // the second appearance must be refused -- this is the case the live run failed with 7 records instead of 4.
  const session = createScanSession();
  const at = (x) => realisticFrame({ x, y: 120, width: 200, height: 260 });
  const first = at(300);
  const second = at(500); // the same drawing, another place on the same noise
  const boxA = findTooltip(first);
  const boxB = findTooltip(second);
  assert.ok(boxA && boxB, "the panel must be found at both places");
  assert.ok(ringDiff(first, boxA, second, boxB) > 0, "the backdrop must differ, or this test proves nothing");
  assert.ok(keyDistance(boxKey(first, boxA), boxKey(second, boxB)) <= KEY_TOLERANCE * 64, "the panel's own key must survive the move");

  assert.equal(appearance(session, first), true);
  assert.equal(appearance(session, second), false);
  assert.equal(session.queue.length, 1);
});

test("accept tolerates a small drift of the same panel, but not a different one", () => {
  // The gap the reviewer found: the two appearances above come out bit-identical (distance 0), so nothing pinned the
  // tolerance itself -- reverting accept() to exact equality left every test green. This second appearance is the
  // same panel with its text dashes slid a few pixels, which lands strictly inside the band, so this is the test that
  // fails on exact equality.
  const session = createScanSession();
  const box = { x: 300, y: 120, width: 200, height: 260 };
  const first = realisticFrame(box);
  const drifted = realisticFrame(box, { dashShift: 6 }); // the same panel, its glyphs a few pixels off
  const other = realisticFrame(box, { stripes: 0.3 }); // a different panel
  const keyFirst = boxKey(first, findTooltip(first));
  const keyDrifted = boxKey(drifted, findTooltip(drifted));
  const keyOther = boxKey(other, findTooltip(other));
  const band = KEY_TOLERANCE * 64;

  const drift = keyDistance(keyFirst, keyDrifted);
  assert.ok(drift >= 1, `the drift must be real, not a copy (${drift} cells)`);
  assert.ok(drift <= band, `the drift must stay inside the tolerance (${drift} > ${band} cells)`);
  assert.ok(keyDistance(keyFirst, keyOther) > band, "the control must be outside the tolerance");
  assert.ok(keyDistance(keyDrifted, keyOther) > band, "the control must be outside the tolerance of the drifted key too");

  assert.equal(appearance(session, first), true);
  // The same panel a few cells off is the picture already held, so it is not even offered a second time...
  assert.equal(appearance(session, drifted), null);
  assert.equal(session.accept(keyDrifted), null); // ... and accept would still refuse it
  assert.equal(appearance(session, other), true); // ... and the tolerance is not a free pass
  assert.equal(session.queue.length, 2);
});

test("two panels whose content differs stay two crops", () => {
  const session = createScanSession();
  const at = (stripes) => realisticFrame({ x: 300, y: 120, width: 200, height: 260 }, { stripes });
  const one = at(0.6);
  const other = at(0.3); // a different panel
  const boxOne = findTooltip(one);
  const boxOther = findTooltip(other);
  assert.ok(keyDistance(boxKey(one, boxOne), boxKey(other, boxOther)) > KEY_TOLERANCE * 64, "different panels must be far apart");

  assert.equal(appearance(session, one), true);
  assert.equal(appearance(session, other), true);
  assert.equal(session.queue.length, 2);
});

test("tooltips from the failures page are accepted rather than refused as duplicates", () => {
  const session = createScanSession();
  // Simulated fallback crops with fractional coordinates from 480/720 downscaling (image-13, 41, 43, 49):
  const boxes = [
    { x: 162.67, y: 9.33, width: 176, height: 159.33 },
    { x: 41.33, y: 40.67, width: 72.67, height: 88 },
    { x: 178, y: 34.67, width: 171.33, height: 165.33 },
    { x: 72, y: 50, width: 213.33, height: 207.33 },
  ];
  const frames = [
    realisticFrame({ x: 300, y: 120, width: 200, height: 260 }, { stripes: 0.2 }),
    realisticFrame({ x: 300, y: 120, width: 200, height: 260 }, { stripes: 0.4 }),
    realisticFrame({ x: 300, y: 120, width: 200, height: 260 }, { stripes: 0.6 }),
    realisticFrame({ x: 300, y: 120, width: 200, height: 260 }, { stripes: 0.8 }),
  ];
  for (let i = 0; i < frames.length; i++) {
    const key = boxKey(frames[i], boxes[i]);
    assert.equal(key.includes("NaN"), false);
    assert.ok(session.accept(key), `item ${i} must be accepted rather than refused as duplicate`);
  }
  assert.equal(session.stats.skipped, 0);
});

// --- one held picture is one crop, and one item is one record ---------------------------------------------------------

test("a held tooltip is cropped once however long it is held, even while its frames keep changing", () => {
  // The game keeps rendering behind the panel, so what the capture delivers changes from one frame to the next (here:
  // the backdrop's own noise). Every change restarts the streak, and before the held rule that also cleared the
  // "already handed out" flag, so one hover became a fresh crop every couple of frames.
  const session = createScanSession();
  const held = Array.from({ length: 40 }, (_, i) => realisticFrame(BOX_A, { seed: 8000 + (i >> 1) }));
  const hits = held.map((img) => session.feed(img)).filter(Boolean);

  assert.equal(hits.length, 1, `one crop for one held tooltip, got ${hits.length}`);
  assert.ok(session.stats.detected > 30, "the tooltip must really be in most frames");
  assert.ok(session.accept(hits[0].key)); // and the crop it hands out is a new one the panel may queue
  assert.equal(session.accept(hits[0].key), null); // ... exactly once
});

test("a tooltip that moved by a few pixels while it is held is still the same held picture", () => {
  // A hand on the mouse is never perfectly still: the detector's box moves a pixel or two and the panel's pixels are
  // re-encoded with it. That is one held picture, not a new one.
  const session = createScanSession();
  const held = Array.from({ length: 30 }, (_, i) => realisticFrame(BOX_A, { dashShift: i % 3, seed: 8000 + i }));
  const hits = held.map((img) => session.feed(img)).filter(Boolean);

  assert.equal(hits.length, 1, `one crop for one held tooltip, got ${hits.length}`);
});

test("a different tooltip hovered right after a held one is still cropped", () => {
  const session = createScanSession();
  for (let i = 0; i < 30; i++) session.feed(realisticFrame(BOX_A, { seed: 8000 + (i >> 1) }));
  const other = realisticFrame(BOX_A, { stripes: 0.3 }); // a different panel where the first one was
  assert.equal(session.feed(other), null);
  const hit = session.feed(other);
  assert.ok(hit, "a different tooltip must still be cropped");
  assert.ok(session.accept(hit.key));
});

test("removing a record lets the same held tooltip be cropped and recorded again without the tooltip closing", () => {
  const session = createScanSession();
  const img = frame(BOX_A);
  assert.equal(session.feed(img), null);
  const hit = session.feed(img);
  assert.ok(hit);
  assert.ok(session.fill(session.accept(hit.key), { img }));
  const job = session.take();
  assert.equal(session.addRecord(record({ key: job.key }), job.generation), true);
  for (let i = 0; i < 5; i++) assert.equal(session.feed(img), null, "held: no second crop");

  assert.equal(session.removeRecord(session.records[0].id), true);
  const again = session.feed(img); // the tooltip never closed: the player deleted the row and looked at it again
  assert.ok(again, "the removed item must be croppable again");
  assert.ok(session.accept(again.key));
  assert.equal(session.addRecord(record({ key: again.key }), job.generation), true);
});

// Two reads of the SAME tooltip and the two DIFFERENT items whose reads look most alike, taken from the stored
// evidence: artifacts/diag-scan/results/t1-sanity.json (the two jobs of image-18.png, which a real sweep recorded
// twice: 0.689 alike) and artifacts/ocr-e2e/report.json (image-35.png against image-41.png, the closest pair of
// different items in the earlier 54-picture corpus: 0.449 alike).
const REREAD_A = `維爾登戈的心結
心結就是它物理系標配
140€Def/40VIT/13RCP/120STA/15DR
秘銀腰帶精
防禦:139
腰帶空間：+12格
耐久度(DUR):12/16
需要力量：106
需要等級:63
+10%打攀恢復(FHR)`;
const REREAD_B = `維爾登戈的心結
心結就是它物理系標配
140CDef/40VIT/13RCP/120STA/15DR
秘銀腰帶精
SES
防禦:139
腰帶空間:+12格
耐久度(DUR):12/16
需要力量:106
需要等級:63
+10%打擊恢复(FHR)
+112%防禦強化(€Def)
+39體能(VIT)`;
const OTHER_ITEM_A = `出售價格：8337
兇殘之箍
戒指[R]
需要等級：65
+10%施法速度(FCR)
擊中竊取8%生命(LL)
冰寒抗性(CR)+26%
火焰抗性(FR)+25%
傷害降低(DR)1
Shift +左鍵點擊以裝備
Ctrl + 左键點擊以販售
按住 Shift 鍵進行比較`;
const OTHER_ITEM_B = `瘟疫之圈
戒指[R]
需要等級：60
+10% 施法速度(FCR)
+111 準確率(AR)
+36 生命(Life)
冰寒抗性(CR)+11%
電擊抗性(LR)+17%
火焰抗性(FR)+11%
毒素抗性(PR)+11%
Shift+左鍵點擊以裝備
Ctrl+左键點擊以丢下
按住Shift 鍵進行比較`;

test("the same item read again from a second place is one record, not two", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: REREAD_A })), true);
  assert.equal(session.addRecord(record({ text: REREAD_B })), false, "the same tooltip, read a second time");
  assert.equal(session.records.length, 1);
  assert.equal(session.stats.skipped, 1);
  assert.equal(session.stats.read, 2); // it was still read: only the record is refused
});

test("two different items whose reads look most alike stay two records", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ name: "Ring", zh: "戒指", text: OTHER_ITEM_A })), true);
  assert.equal(session.addRecord(record({ name: "Ring", zh: "戒指", text: OTHER_ITEM_B })), true);
  assert.equal(session.records.length, 2);
});

test("a read that is too short to compare is judged by its own text, not by similarity", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: "Ring" })), true);
  assert.equal(session.addRecord(record({ text: "Ring" })), false, "an identical short read is still the same read");
  assert.equal(session.addRecord(record({ text: "Coronet" })), true, "a different short read is its own item");
  assert.equal(session.records.length, 2);
});

test("accept refuses once the queue is full and counts the drop", () => {
  const session = createScanSession();
  for (let i = 0; i < MAX_QUEUE; i++) session.queue.push({ blob: i, key: null });
  assert.equal(session.stats.queued, MAX_QUEUE);
  assert.equal(session.accept("fresh"), null);
  assert.equal(session.stats.dropped, 1);

  session.queue.pop();
  assert.ok(session.accept("fresh"));
});

test("a panel seen again is refused by its key and counted as 略過, not as 丟棄", () => {
  const session = createScanSession();
  assert.ok(session.accept("A".repeat(64)));
  assert.equal(session.accept("A".repeat(64)), null);
  assert.equal(session.accept("A".repeat(60) + "BBBB"), null); // 4 of 64 cells off: still the same panel
  assert.equal(session.stats.skipped, 2);
  assert.equal(session.stats.dropped, 0);
  assert.equal(session.queue.length, 1); // accept queues the job itself, and the panel fills it in when the crop is encoded
});

test("a full queue counts a panel it already knows as 略過 and a new one as 丟棄", () => {
  const session = createScanSession();
  assert.ok(session.accept("A".repeat(64)));
  for (let i = 0; i < MAX_QUEUE; i++) session.queue.push({ blob: i, key: null });
  assert.equal(session.accept("A".repeat(64)), null); // a duplicate stays a duplicate even when the queue is full
  assert.equal(session.accept("Z".repeat(64)), null); // a new panel the full queue could not take
  assert.deepEqual([session.stats.skipped, session.stats.dropped], [1, 1]);
});
test("accept refuses a key that matches an already-recorded record key and skips it", () => {
  const session = createScanSession();
  const keyA = "B".repeat(64);
  const job = session.accept(keyA);
  assert.ok(job);
  session.fill(job, { blob: 1 });
  const taken = session.take();
  session.addRecord({ ...record(), key: taken.key });
  assert.equal(session.accept(keyA), null, "refuses re-queueing an already recorded crop key");
  assert.equal(session.stats.skipped, 1);
});

// --- the job object: a crop's key, time and picture travel together ----------------------------------------------------

test("a crop whose encode failed is dropped and the next crop keeps its own key", () => {
  // The panel accepts a crop and then awaits the browser's PNG encode, which can fail (a covered panel makes it slow,
  // and it throws). Before the jobs were one object the failed crop left its key behind, so every crop queued after it
  // was read with the previous crop's key and timestamp.
  const session = createScanSession();
  const failed = session.accept("C".repeat(64));
  assert.ok(failed);
  session.drop(failed); // the encode threw

  const next = session.accept("D".repeat(64));
  assert.ok(next);
  session.fill(next, "blob of D");
  const job = session.take();
  assert.deepEqual([job.key, job.blob], ["D".repeat(64), "blob of D"]);
});

test("a crop whose encode failed can be cropped again", () => {
  // The key is forgotten with the crop: otherwise the item could never be recorded again, because the panel identifies
  // a panel it has already cropped by that key.
  const session = createScanSession();
  session.drop(session.accept("E".repeat(64)));
  const again = session.accept("E".repeat(64));
  assert.ok(again);
  assert.equal(session.stats.dropped, 1);
});

test("a dropped crop leaves the queue and counts as 丟棄", () => {
  const session = createScanSession();
  const job = session.accept("F".repeat(64));
  assert.equal(session.stats.queued, 1);
  session.drop(job);
  assert.deepEqual([session.stats.queued, session.stats.dropped], [0, 1]);
});

test("dropping a crop the player already cleared neither forgets a newer crop of the same panel nor counts a 丟棄", () => {
  // The encode of a crop is still in flight when 清除紀錄 runs and the same tooltip is hovered again: the new crop
  // holds the same key. The old encode then fails. Its drop must not take the new crop's key with it.
  const session = createScanSession();
  const old = session.accept("G".repeat(64));
  session.clear();
  const fresh = session.accept("G".repeat(64));
  assert.ok(fresh, "after a clear the same panel is a new crop");

  session.drop(old); // the cleared crop's encode fails now

  assert.equal(session.stats.dropped, 0, "a crop the clear already took is not counted as dropped on top");
  assert.equal(session.accept("G".repeat(64)), null, "the fresh crop's key is still remembered");
  session.fill(fresh, "blob");
  assert.equal(session.take().key, "G".repeat(64), "and the fresh crop is still queued");
});

test("take steps over a crop that is still being encoded and keeps the order of the ready ones", () => {
  const session = createScanSession();
  const first = session.accept("1".repeat(64), 10);
  const second = session.accept("2".repeat(64), 20);
  const third = session.accept("3".repeat(64), 30);
  assert.equal(session.take(), null, "nothing is ready while every crop is still being encoded");

  session.fill(third, "blob of third"); // the last crop wins the race to be encoded ...
  session.fill(first, "blob of first");
  const one = session.take();
  assert.deepEqual(
    [one.key, one.blob, one.queuedAt],
    ["1".repeat(64), "blob of first", 10],
    "... and the ready crops keep their order",
  );
  const three = session.take();
  assert.deepEqual([three.key, three.blob], ["3".repeat(64), "blob of third"]);
  assert.equal(session.take(), null, "the middle crop is still being encoded, so it is not read yet");

  session.fill(second, "blob of second");
  assert.equal(session.take().blob, "blob of second");
  assert.equal(session.stats.queued, 0);
});
test("a read whose text was already recorded is counted as 略過 and makes no second record", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record()), true);
  assert.equal(session.addRecord(record()), false);
  assert.equal(session.addRecord(record({ text: "  Spiderweb \t Sash \n" })), false);
  assert.equal(session.stats.skipped, 2);
  assert.equal(session.stats.read, 3);
  assert.equal(session.records.length, 1);
});

test("a read from a cleared run is neither a record nor counted as 略過", () => {
  const session = createScanSession();
  const { generation } = (session.queue.push({ blob: 1 }), session.take());
  session.clear();
  assert.equal(session.addRecord(record(), generation), false);
  assert.deepEqual([session.stats.skipped, session.stats.read], [0, 0]);
});

test("addRecord refuses the same text differing only in whitespace", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record()), true);
  assert.equal(session.addRecord(record({ text: "  Spiderweb \t Sash \n" })), false);
  assert.equal(session.records.length, 1);
  assert.equal(session.stats.read, 2);
});

test("baseCandidate picks the first base candidate and ignores the item ones", () => {
  assert.equal(
    baseCandidate([
      { kind: "item", name: "Arachnid Mesh" },
      { kind: "base", name: "Spiderweb Sash" },
    ]),
    "Spiderweb Sash",
  );
  assert.equal(baseCandidate([{ kind: "item", name: "Arachnid Mesh" }]), null);
  assert.equal(baseCandidate([]), null);
});

test("addRecord keeps the base candidate read alongside the item, and null when there was none", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ base: "Spiderweb Sash" })), true);
  assert.equal(session.records[0].base, "Spiderweb Sash");
  assert.equal(session.addRecord(record({ text: "another panel", base: undefined })), true);
  assert.equal(session.records[0].base, null);
});

test("addRecord refuses a record with neither a name nor conditions", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ name: null, conditions: [], text: "backpack panel" })), false);
  assert.equal(session.stats.skipped, 1);
  assert.equal(session.records.length, 0);
  assert.equal(session.addRecord(record({ name: null, conditions: [{ label: "+2 全技能" }] })), true);
});

test("normalizeText removes every whitespace character", () => {
  assert.equal(normalizeText(" Alma \t Negra\n"), "AlmaNegra");
  assert.equal(normalizeText(null), "");
});

test("recordCells puts each field in its own column, tells the kinds apart and lists every condition", () => {
  const cells = recordCells(record({ conditions: [{ label: "+1 Skills" }, { label: "+20% Speed" }] }));
  assert.equal(cells.length, RECORD_HEAD.length, "one cell per header column");
  const [time, name, zh, type, affixes, text] = cells;
  assert.deepEqual([time, name, zh, text], ["2026-10-06 12:34:56", "Arachnid Mesh", "蛛網紋束帶", "Spiderweb Sash"]);
  assert.ok(affixes.includes("+1 Skills") && affixes.includes("+20% Speed"), "every condition is listed");
  assert.ok(affixes.indexOf("+1 Skills") < affixes.indexOf("+20% Speed"), "in the order they were read");
  const types = [type, recordCells(record({ kind: "base" }))[3], recordCells(record({ kind: null, name: null, conditions: [{ label: "x" }] }))[3]];
  assert.ok(types.every((label) => label !== ""), "no kind is an empty cell");
  assert.equal(new Set(types).size, 3, "an item, a base and a record with no kind have three different labels");
});

test("a cell starting with = survives recordCells and gets its apostrophe from toCsv", () => {
  const cells = recordCells(record({ name: null, kind: null, text: "=SUM(1)" }));
  assert.equal(cells[5], "=SUM(1)");

  const csv = toCsv(RECORD_HEAD, [cells]);
  assert.ok(csv.includes("'=SUM(1)"), csv);
  assert.ok(csv.startsWith(`\uFEFF${RECORD_HEAD.join(",")}`));
});

test("clear drops the records and forgets the seen text, keys and detector, so the same panel records again", () => {
  // The player-visible point of 清除紀錄 is starting over: after it, the very same panel/text must be read again.
  // So this asserts the memory is gone, not merely that an array is empty.
  const session = createScanSession();
  const img = frame(BOX_A);

  assert.equal(appearance(session, img), true); // one stable crop queued
  assert.equal(session.addRecord(record()), true); // ... and its text recorded
  assert.ok(session.accept("deadbeef")); // ... and one standalone key remembered
  assert.equal(session.records.length, 1);

  session.clear();

  assert.deepEqual(session.records, []); // the records are dropped ...
  assert.equal(session.addRecord(record()), true); // ... and the same text is recorded again
  assert.ok(session.accept("deadbeef")); // ... and the same key is queued again
  assert.equal(appearance(session, img), true); // ... and the same stable panel crops once more (detector reset)
});

test("clear drops the crops still waiting for OCR", () => {
  // 待辨識 N 件 is on the screen, so "clear" that leaves work pending would be a visible lie - and the panel's pump
  // would go on to record those crops after the player asked for a clean list.
  const session = createScanSession();
  session.queue.push({ blob: "waiting 1" }, { blob: "waiting 2" });
  assert.equal(session.stats.queued, 2);

  session.clear();

  assert.equal(session.stats.queued, 0);
  assert.equal(session.take(), null);
});

test("a crop taken before clear does not come back as a record", () => {
  const session = createScanSession();
  session.queue.push({ blob: "taken before the click" });
  const crop = session.take(); // the pump took it ...
  assert.equal(session.addRecord(record()), true); // ... and an earlier read is on the list

  session.clear(); // the player clears while the OCR of that crop is still running

  assert.equal(session.addRecord(record(), crop.generation), false); // the finished read is refused
  assert.deepEqual(session.records, []);
  session.queue.push({ blob: "captured after the click" });
  const fresh = session.take(); // a crop captured after the clear is a record like any other
  assert.equal(session.addRecord(record(), fresh.generation), true);
  assert.equal(session.records.length, 1);
});

// --- removeRecord: the ✕ on one row ---------------------------------------------------------------------------------

const three = () => {
  const session = createScanSession();
  for (const name of ["First", "Second", "Third"]) session.addRecord(record({ name, text: `text of ${name}` }));
  return session; // newest first: Third, Second, First
};

test("removing one of three records keeps the other two in their order", () => {
  const session = three();
  const second = session.records.find((r) => r.name === "Second");

  assert.equal(session.removeRecord(second.id), true);

  assert.deepEqual(session.records.map((r) => r.name), ["Third", "First"]);
});

test("removing the last record leaves an empty list", () => {
  const session = createScanSession();
  session.addRecord(record());

  assert.equal(session.removeRecord(session.records[0].id), true);

  assert.deepEqual(session.records, []);
});

test("an id that is not in the list is a no-op", () => {
  const session = three();
  const [{ id }] = session.records;
  session.removeRecord(id);

  assert.equal(session.removeRecord(id), false); // already gone
  assert.equal(session.removeRecord(9999), false);
  assert.equal(session.removeRecord(undefined), false);
  assert.equal(session.records.length, 2);
});

test("a removed item is recorded again when its text is read again, and one still on the list is not", () => {
  const session = three();
  const first = session.records.find((r) => r.name === "First");
  session.removeRecord(first.id);

  assert.equal(session.addRecord(record({ name: "First", text: "text of First" })), true); // hidden memory forgotten
  assert.equal(session.addRecord(record({ name: "Second", text: "text of Second" })), false); // still listed
  assert.deepEqual(session.records.map((r) => r.name), ["First", "Third", "Second"]);
});

test("a removed item's panel is cropped again when hovered again, through the crop key", () => {
  const session = createScanSession();
  const img = frame(BOX_A);
  assert.equal(appearance(session, img), true);
  const job = session.take();
  session.addRecord(record({ key: job.key }), job.generation);
  session.feed(frame(null)); // the tooltip goes away, as it does between two hovers
  assert.equal(appearance(session, img), false); // while the record is listed the same panel is refused

  session.removeRecord(session.records[0].id);
  session.feed(frame(null));

  assert.equal(appearance(session, img), true); // the memory of the crop went with the record
});

test("an id is never reused, so a stale row cannot delete a newer record after 清除紀錄", () => {
  const session = createScanSession();
  session.addRecord(record());
  const oldId = session.records[0].id;
  session.clear();
  session.addRecord(record());

  assert.notEqual(session.records[0].id, oldId);
  assert.equal(session.removeRecord(oldId), false);
  assert.equal(session.records.length, 1);
});

// --- a record whose read was not sure: it keeps its candidates until the player picks one -------------------------

const unsure = (over = {}) =>
  record({
    name: null,
    zh: "",
    kind: null,
    base: "Ring",
    options: [
      { kind: "item", name: "Arachnid Mesh", zh: "蛛網紋束帶", label: "蛛網紋束帶（Arachnid Mesh）" },
      { kind: "base", name: "Ring", zh: "戒指", label: "戒指（Ring）" },
    ],
    text: "Arachnid Mesh Ring",
    ...over,
  });

test("an unsure record is kept without a name or an affix line, and exports an empty name and its text", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(unsure()), true);

  const [kept] = session.records;
  assert.equal(isUnsure(kept), true);
  assert.equal(kept.options.length, 2);
  assert.deepEqual(recordCells(kept).slice(1), ["", "", "—", "", "Arachnid Mesh Ring"]);
  assert.equal(session.stats.skipped, 0, "it is not an unreadable panel");
});

test("a record with no name and no candidates to pick is still refused", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(unsure({ options: [] })), false);
  assert.equal(session.stats.skipped, 1);
});

test("resolveRecord names the record from the picked option and leaves the rest of the read as it was", () => {
  const session = createScanSession();
  session.addRecord(unsure({ conditions: [{ label: "+2 全技能" }] }));
  const [{ id }] = session.records;

  assert.equal(session.resolveRecord(id, 1), true);

  const [done] = session.records;
  assert.equal(isUnsure(done), false);
  assert.deepEqual(
    { name: done.name, zh: done.zh, kind: done.kind, base: done.base, options: done.options, text: done.text },
    { name: "Ring", zh: "戒指", kind: "base", base: "Ring", options: [], text: "Arachnid Mesh Ring" },
  );
  assert.deepEqual(done.conditions.map((c) => c.label), ["+2 全技能"]);
  const [pickedName, pickedZh, pickedType] = recordCells(done).slice(1, 4);
  assert.deepEqual([pickedName, pickedZh], ["Ring", "戒指"], "the CSV now carries the pick");
  assert.equal(pickedType, recordCells(record({ kind: "base" }))[3], "and its kind");
});

test("resolveRecord changes nothing for an unknown id, a bad index or a record that is already named", () => {
  const session = createScanSession();
  session.addRecord(unsure());
  session.addRecord(record({ text: "a named one" }));
  const [named, pending] = session.records;

  assert.equal(session.resolveRecord(9999, 0), false);
  assert.equal(session.resolveRecord(pending.id, 2), false);
  assert.equal(session.resolveRecord(pending.id, -1), false);
  assert.equal(session.resolveRecord(named.id, 0), false);
  assert.deepEqual([named.name, pending.name, pending.options.length], ["Arachnid Mesh", null, 2]);

  assert.equal(session.resolveRecord(pending.id, 0), true);
  assert.equal(session.resolveRecord(pending.id, 1), false, "a second pick cannot rename it");
  assert.equal(pending.name, "Arachnid Mesh");
});

test("an unsure record counts as one item: its text is not recorded twice, before or after the pick", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(unsure()), true);
  assert.equal(session.addRecord(unsure({ text: "  Arachnid Mesh \n Ring " })), false);

  session.resolveRecord(session.records[0].id, 0);
  assert.equal(session.addRecord(unsure()), false);
  assert.equal(session.records.length, 1);
});

test("removing an unsure record forgets its text and crop key, like any record", () => {
  const session = createScanSession();
  const img = frame(BOX_A);
  assert.equal(appearance(session, img), true);
  const job = session.take();
  session.addRecord(unsure({ key: job.key }), job.generation);
  session.feed(frame(null));
  assert.equal(appearance(session, img), false);

  assert.equal(session.removeRecord(session.records[0].id), true);
  session.feed(frame(null));

  assert.equal(appearance(session, img), true);
  assert.equal(session.addRecord(unsure()), true);
});

test("nameRecord names a record that nothing could name, from a typed table name, exactly as a picked option does", () => {
  const session = createScanSession();
  session.addRecord(record({ name: null, kind: null, zh: "", text: "no name here", conditions: [{ label: "+2 全技能" }] }));
  const [{ id }] = session.records;
  assert.equal(isUnsure(session.records[0]), false, "no options: it is unresolved, not unsure");

  assert.equal(session.nameRecord(id, { name: "Arachnid Mesh", kind: "item", zh: "蜘蛛之網" }), true);

  const [done] = session.records;
  assert.deepEqual({ name: done.name, zh: done.zh, kind: done.kind, options: done.options }, { name: "Arachnid Mesh", zh: "蜘蛛之網", kind: "item", options: [] });
  const [namedName, namedZh, namedType] = recordCells(done).slice(1, 4);
  assert.deepEqual([namedName, namedZh], ["Arachnid Mesh", "蜘蛛之網"], "the CSV carries it");
  assert.equal(namedType, recordCells(record())[3], "and its kind");
});

test("nameRecord also names an unsure record without its options, and refuses a named record, an unknown id and an empty choice", () => {
  const session = createScanSession();
  session.addRecord(unsure());
  session.addRecord(record({ text: "a named one" }));
  const [named, pending] = session.records;

  assert.equal(session.nameRecord(9999, { name: "Ring", kind: "base" }), false);
  assert.equal(session.nameRecord(named.id, { name: "Ring", kind: "base" }), false, "a named record is never renamed");
  assert.equal(session.nameRecord(pending.id, { name: "", kind: "base" }), false);
  assert.equal(session.nameRecord(pending.id, { name: "Ring" }), false, "a name needs its kind");
  assert.equal(session.nameRecord(pending.id), false);
  assert.equal(pending.name, null);

  assert.equal(session.nameRecord(pending.id, { name: "Ring", kind: "base", zh: "戒指" }), true);
  assert.deepEqual([pending.name, pending.kind, pending.options], ["Ring", "base", []]);
  assert.equal(session.nameRecord(pending.id, { name: "Arachnid Mesh", kind: "item" }), false, "a second naming cannot rename it");
});

test("a record keeps the first name line of its read, for the correction memory", () => {
  const session = createScanSession();
  session.addRecord(unsure({ firstKey: "arachnid mesh ring" }));
  session.addRecord(record({ text: "another" }));

  assert.deepEqual(session.records.map((r) => r.firstKey), ["", "arachnid mesh ring"]);
});
test("a job taken from the queue carries the stamp taken at accept time", () => {
  const session = createScanSession();
  const stamp = 12345.67;
  const queued = session.accept("key1".padEnd(64, "0"), stamp);
  assert.ok(queued);
  session.fill(queued, "blob1");

  const job = session.take();
  assert.ok(job);
  assert.equal(job.queuedAt, stamp);
});

test("two jobs queued back to back have waits that differ on a fake clock", () => {
  const session = createScanSession();
  let fakeNow = 1000;
  // Job 1 accepted at t=1000
  const first = session.accept("key1".padEnd(64, "1"), fakeNow);
  assert.ok(first);
  session.fill(first, "job1");

  // Clock advances to t=1050
  fakeNow = 1050;
  // Job 2 accepted at t=1050
  const second = session.accept("key2".padEnd(64, "2"), fakeNow);
  assert.ok(second);
  session.fill(second, "job2");

  // Job 1 taken and processed at t=1200
  fakeNow = 1200;
  const job1 = session.take();
  const wait1 = fakeNow - job1.queuedAt; // 1200 - 1000 = 200 ms

  // Job 2 taken and processed after job 1 finishes at t=1900
  fakeNow = 1900;
  const job2 = session.take();
  const wait2 = fakeNow - job2.queuedAt; // 1900 - 1050 = 850 ms

  assert.equal(wait1, 200);
  assert.equal(wait2, 850);
  assert.ok(wait2 > wait1, "the second job's wait is larger because it waited behind the first");
});

test("finishRecord completes a record the head made: whole text, affix lines, a name the head could not give, the base", () => {
  const session = createScanSession();
  const option = { kind: "item", name: "Ring", zh: "", label: "Ring", matched: "", learned: 0 };
  assert.equal(session.addRecord(record({ name: null, options: [option], text: "Rin" })), true);
  const { id } = session.records[0];
  const done = session.finishRecord(id, {
    text: "Ring\n+27 力量",
    conditions: [{ key: "str", label: "力量" }],
    name: "Ring",
    kind: "item",
    base: "Ring",
  });
  assert.equal(done, true);
  const [kept] = session.records;
  assert.deepEqual([kept.name, kept.options, kept.text, kept.base, kept.conditions.length], ["Ring", [], "Ring\n+27 力量", "Ring", 1]);
});

test("a record keeps the name-line colour it was added with, and finishRecord replaces it with the whole read's", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: "head", quality: "yellow" })), true);
  const { id } = session.records[0];
  assert.equal(session.records[0].quality, "yellow");
  assert.equal(session.finishRecord(id, { text: "head\n+27 力量", conditions: [] }), true);
  assert.equal(session.records[0].quality, "yellow", "a whole read with no colour keeps the head's");
  assert.equal(session.finishRecord(id, { text: "head\n+27 力量", conditions: [], quality: "blue" }), true);
  assert.equal(session.records[0].quality, "blue");
  session.addRecord(record({ text: "other" }));
  assert.equal(session.records[0].quality, null);
});

test("finishRecord takes off a provisional record whose whole text is an item already listed, and counts it 略過", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: REREAD_A })), true);
  assert.equal(session.addRecord(record({ text: "Spiderweb" })), true, "the head alone looks new");
  const { id } = session.records[0];
  assert.equal(session.finishRecord(id, { text: REREAD_B, conditions: [] }), false);
  assert.equal(session.records.length, 1);
  assert.equal(session.records[0].text, REREAD_A);
  assert.equal(session.stats.skipped, 1);
});

test("finishRecord for a record that is gone (deleted or cleared meanwhile) changes nothing", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: "Spiderweb" })), true);
  const { id } = session.records[0];
  session.removeRecord(id);
  assert.equal(session.finishRecord(id, { text: REREAD_A, conditions: [] }), false);
  assert.deepEqual(session.records, []);
});

test("finishRecord lets a sure name in the whole text replace the head's name, and keeps the head's name when the whole text names nothing", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ name: "The Redeemer", zh: "懺悔者", text: "head one", base: "Mace" })), true);
  const { id } = session.records[0];
  session.finishRecord(id, { text: "whole one", conditions: [], name: "Ars Dul'Mephistos", kind: "item", zh: "", base: "Occult Tome" });
  const [kept] = session.records;
  assert.deepEqual([kept.name, kept.zh, kept.base], ["Ars Dul'Mephistos", "", "Occult Tome"]);

  session.finishRecord(id, { text: "whole two", conditions: [] });
  assert.equal(session.records[0].name, "Ars Dul'Mephistos", "a whole text that names nothing changes no name");
});

test("finishRecord turns a record the head named back into a question when the whole text is not sure", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ name: "The Redeemer", zh: "懺悔者", text: "head" })), true);
  const { id } = session.records[0];
  const options = [
    { kind: "item", name: "The Redeemer", zh: "懺悔者", label: "The Redeemer", matched: "", learned: 0 },
    { kind: "item", name: "Ars Dul'Mephistos", zh: "", label: "Ars Dul'Mephistos", matched: "", learned: 0 },
  ];
  session.finishRecord(id, { text: "whole", conditions: [], options });
  const [kept] = session.records;
  assert.deepEqual([kept.name, kept.kind, kept.options.length], [null, null, 2]);
  assert.equal(isUnsure(kept), true);
});

test("finishRecord keeps a name the player picked on the provisional record, and still takes the whole text and affix lines", () => {
  const session = createScanSession();
  const options = [
    { kind: "item", name: "The Redeemer", zh: "懺悔者", label: "The Redeemer", matched: "", learned: 0 },
    { kind: "item", name: "Ars Dul'Mephistos", zh: "", label: "Ars", matched: "", learned: 0 },
  ];
  assert.equal(session.addRecord(record({ name: null, options, text: "head" })), true);
  const { id } = session.records[0];
  assert.equal(session.resolveRecord(id, 1), true);
  session.finishRecord(id, { text: "whole", conditions: [{ key: "str", label: "力量" }], name: "Ring", kind: "item" });
  session.finishRecord(id, { text: "whole two", conditions: [], options });
  const [kept] = session.records;
  assert.deepEqual([kept.name, kept.options.length, kept.text], ["Ars Dul'Mephistos", 0, "whole two"]);
});

test("a record keeps the key its base is remembered under and how often it was corrected; the whole read's remembered base wins over the head's own", () => {
  const session = createScanSession();
  assert.equal(session.addRecord(record({ text: "head", base: "Ring", baseKey: "ring" })), true);
  const { id } = session.records[0];
  assert.deepEqual([session.records[0].baseKey, session.records[0].baseLearned], ["ring", 0]);

  assert.equal(session.finishRecord(id, { text: "head\n+27 力量", conditions: [], base: "Sacred Ring", baseKey: "ring", baseLearned: 2 }), true);
  assert.deepEqual([session.records[0].base, session.records[0].baseKey, session.records[0].baseLearned], ["Sacred Ring", "ring", 2]);

  assert.equal(session.finishRecord(id, { text: "head\n+27 力量", conditions: [], base: "Ring", baseKey: "ring", baseLearned: 0 }), true);
  assert.equal(session.records[0].base, "Sacred Ring", "a read that knows nothing of the correction does not undo it");
});

test("a read that keeps failing on a tooltip that stays open is retried after a fresh stable run, not on every frame", () => {
  const session = createScanSession();
  const img = frame(BOX_A);
  assert.equal(appearance(session, img), true);
  const taken = session.take();
  session.forgetKey(taken.key, taken.generation); // the read threw
  assert.equal(session.feed(img), null, "the very next frame of the same still tooltip does not crop again");
  assert.ok(session.feed(img), "a fresh stable run does");
});

test("a crop whose read failed before it made a record is forgotten, so the same tooltip can be cropped again", () => {
  const session = createScanSession();
  const key = "0123".repeat(16);
  const job = session.accept(key);
  session.fill(job, "blob");
  const taken = session.take();
  assert.equal(session.accept(key), null, "while it is seen, the same panel is refused");

  session.forgetKey(taken.key, taken.generation);
  assert.ok(session.accept(key), "after a failed read it may be cropped again");

  // A key that a record carries is not forgotten (the head already made that record), nor one of a cleared run.
  const kept = session.take();
  session.fill(session.accept("3210".repeat(16)), "b2");
  const second = session.take();
  session.addRecord(record({ text: "kept", key: second.key }));
  session.forgetKey(second.key, second.generation);
  assert.equal(session.accept("3210".repeat(16)), null);
  assert.ok(kept === null || kept);
});
