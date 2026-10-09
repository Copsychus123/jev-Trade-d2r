import assert from "node:assert/strict";
import test from "node:test";

import { toCsv } from "../../src/jev_ultrafast/static/csv.js";
import {
  KEY_TOLERANCE,
  MAX_QUEUE,
  RECORD_HEAD,
  baseCandidate,
  createScanSession,
  keyDistance,
  normalizeText,
  recordCells,
} from "../src/scan/session.js";
import { boxKey, downscale, findTooltip } from "../src/scan/tooltip.js";

const WIDTH = 480;
const HEIGHT = 270;

function noise(width = WIDTH, height = HEIGHT, { seed = 12345 } = {}) {
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

// `stripes` says how much of the panel the text lines cover, so two calls can build two different-looking panels.
function frame(box, stripes = 0.6) {
  const img = noise();
  if (!box) return img;
  const { x, y, width, height } = box;
  fill(img, x, y, width, height, 20);
  const span = Math.round(width * stripes);
  const left = x + Math.round((width - span) / 2);
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
function realisticFrame(box, { stripes = 0.6, dashShift = 0 } = {}) {
  const img = noise(960, 540);
  const { x, y, width, height } = box;
  fill(img, x, y, width, height, 20);
  const span = Math.round(width * stripes);
  const left = x + Math.round((width - span) / 2);
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

// What scan-panel.js does for one stable box: feed the frame (twice, STABLE_FRAMES), offer the panel's key, and push
// the crop when it is accepted.
function appearance(session, img) {
  session.feed(img);
  const hit = session.feed(img);
  if (!hit) return null;
  if (!session.accept(boxKey(img, hit.box))) return false;
  session.queue.push({ img });
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
  const a = frame(BOX_A);
  const b = frame(BOX_B);
  assert.equal(session.feed(a), null);
  assert.equal(session.feed(b), null);
  assert.ok(session.feed(b));

  assert.equal(session.feed(frame(null)), null);
  assert.equal(session.feed(a), null);
  assert.ok(session.feed(a));
});

test("accept refuses a crop key it has already queued", () => {
  const session = createScanSession();
  assert.equal(session.accept("deadbeef"), true);
  assert.equal(session.accept("deadbeef"), false);
  assert.equal(session.accept("cafebabe"), true);
});

// How many pixels of the 4-px ring the padded crop would carry around the panel differ between the two frames
// (PAD = 4 in scan-panel.js). The panel's own content is identical; this ring is what a byte identity would see.
function ringDiff(a, boxA, b, boxB) {
  const ring = (img, box) => {
    const out = [];
    for (let y = box.y - 4; y < box.y + box.height + 4; y++) {
      for (let x = box.x - 4; x < box.x + box.width + 4; x++) {
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const i = (y * img.width + x) * 4;
        out.push(Math.max(img.data[i], img.data[i + 1], img.data[i + 2]));
      }
    }
    return out;
  };
  const ra = ring(a, boxA);
  const rb = ring(b, boxB);
  let n = 0;
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) if (ra[i] !== rb[i]) n += 1;
  return n;
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
  assert.equal(appearance(session, drifted), false); // the same panel a few cells off: still one crop
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

test("accept refuses once the queue is full and counts the drop", () => {
  const session = createScanSession();
  for (let i = 0; i < MAX_QUEUE; i++) session.queue.push({ blob: i });
  assert.equal(session.stats.queued, MAX_QUEUE);
  assert.equal(session.accept("fresh"), false);
  assert.equal(session.stats.dropped, 1);

  session.queue.pop();
  assert.equal(session.accept("fresh"), true);
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

test("recordCells maps kinds to their 類型 label and joins conditions with 、", () => {
  assert.deepEqual(RECORD_HEAD, ["時間", "名稱", "中文名稱", "類型", "詞綴", "辨識文字"]);
  assert.deepEqual(
    recordCells(
      record({ conditions: [{ label: "+1 全技能" }, { label: "+20% 攻速" }] }),
    ),
    ["2026-10-06 12:34:56", "Arachnid Mesh", "蛛網紋束帶", "暗金/套裝/符文之語", "+1 全技能、+20% 攻速", "Spiderweb Sash"],
  );
  assert.equal(recordCells(record({ kind: "base" }))[3], "底材");
  assert.equal(recordCells(record({ kind: null, name: null, conditions: [{ label: "x" }] }))[3], "—");
});

test("a cell starting with = survives recordCells and gets its apostrophe from toCsv", () => {
  const cells = recordCells(record({ name: null, kind: null, text: "=SUM(1)" }));
  assert.equal(cells[5], "=SUM(1)");

  const csv = toCsv(RECORD_HEAD, [cells]);
  assert.ok(csv.includes("'=SUM(1)"), csv);
  assert.ok(csv.startsWith("\uFEFF時間,名稱"));
});

test("clear drops the records and forgets the seen text, keys and detector, so the same panel records again", () => {
  // The player-visible point of 清除紀錄 is starting over: after it, the very same panel/text must be read again.
  // So this asserts the memory is gone, not merely that an array is empty.
  const session = createScanSession();
  const img = frame(BOX_A);

  assert.equal(appearance(session, img), true); // one stable crop queued
  assert.equal(session.addRecord(record()), true); // ... and its text recorded
  assert.equal(session.accept("deadbeef"), true); // ... and one standalone key remembered
  assert.equal(session.records.length, 1);

  session.clear();

  assert.deepEqual(session.records, []); // the records are dropped ...
  assert.equal(session.addRecord(record()), true); // ... and the same text is recorded again
  assert.equal(session.accept("deadbeef"), true); // ... and the same key is queued again
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
