import assert from "node:assert/strict";
import test from "node:test";

import { DETECT_WIDTH, boxHash, boxKey, downscale, findTooltip } from "../src/scan/tooltip.js";
import { keyDistance } from "../src/scan/session.js";
import { fill, noise } from "./support/images.mjs";

// A reproducible mid-grey noise background, exactly the kind scripts/data/scan_sim.html paints: values in 70..160, so
// the background is neither dark nor smooth and the detector must not bite on it.
// A dark panel with bright text lines 60 % of the panel wide, 4 px tall every 14 px: the clean case.
// `stripeOffset` slides the lines sideways so a test can move them inside a fixed panel.
function drawPanel(img, { x, y, width, height }, stripeOffset = 0) {
  fill(img, x, y, width, height, 20);
  const stripes = Math.round(width * 0.6);
  const left = x + Math.round((width - stripes) / 2) + stripeOffset;
  for (let sy = y + 2; sy < y + height; sy += 14) {
    const sh = Math.min(4, y + height - sy);
    if (sh > 0) fill(img, left, sy, stripes, sh, 200);
  }
}

// The same panel as the real screenshots render it: every glyph is antialiased, so a text line is broken into bright
// dashes with mid-grey between them and the rows just above and below the line are mid-grey too. A row through such a
// line then has no long dark-or-bright run at all (measured on the real screenshots: 12..37 px against the 48 px a run
// rule wants), which is exactly what the detector has to survive.
function drawAntialiasedPanel(img, { x, y, width, height }) {
  fill(img, x, y, width, height, 20);
  const stripes = Math.round(width * 0.6);
  const left = x + Math.round((width - stripes) / 2);
  // A line is 8 px tall here so that it is still ~4 px tall at DETECT_WIDTH, the size the real screenshots give.
  for (let sy = y + 4; sy < y + height; sy += 28) {
    fill(img, left, sy - 2, stripes, 2, 96); // the mid-grey halo above the line
    fill(img, left, sy + 8, stripes, 2, 96); // ... and below it
    for (let sx = left; sx < left + stripes; sx += 48) {
      const dash = Math.min(40, left + stripes - sx);
      if (dash > 0) fill(img, sx, sy, dash, 8, 200);
      if (dash < 48) fill(img, sx + dash, sy, 48 - dash, 8, 96); // the mid-grey between two glyphs
    }
  }
}

const PANEL = { x: 300, y: 120, width: 200, height: 260 }; // 960x540 frame -> 150,60 100x130 at DETECT_WIDTH
const WANT = { x: 150, y: 60, width: 100, height: 130 };

function composed(draw) {
  const img = noise(960, 540);
  draw(img, PANEL);
  return downscale(img, DETECT_WIDTH);
}

function assertPanel(box, want = WANT, note = "") {
  assert.ok(box, `expected a tooltip box ${note}`);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(box[key] - want[key]) <= 4, `${key}: ${box[key]} vs ${want[key]} ${note}`);
  }
}

test("a dark panel with bright text lines is found at the downscaled place", () => {
  const small = composed(drawPanel);
  assert.equal(small.width, 480);
  assertPanel(findTooltip(small));
});

test("a panel whose text lines are broken up by antialiasing is still found", () => {
  // Measured on scripts/data/image-14/15/17/18: the glyph edges are mid-grey, so rows through a text line give runs
  // of 12..37 px against the 48 px a "longest run" rule wants. The fixture is checked to be that broken, so this test
  // cannot quietly stop testing what it was written for.
  const small = composed(drawAntialiasedPanel);
  const longestRun = (y) => {
    let best = 0;
    let run = 0;
    for (let x = 0; x < small.width; x++) {
      const i = (y * small.width + x) * 4;
      const v = Math.max(small.data[i], small.data[i + 1], small.data[i + 2]);
      run = v <= 45 || v >= 120 ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  };
  // The old rule needed a long run in each of MIN_HEIGHT * height consecutive rows; count the best it could get.
  let streak = 0;
  let bestStreak = 0;
  for (let y = WANT.y; y < WANT.y + WANT.height; y++) {
    streak = longestRun(y) >= 48 ? streak + 1 : 0;
    if (streak > bestStreak) bestStreak = streak;
  }
  assert.ok(bestStreak < 16.2, `the fixture must be broken enough for the old run rule (best streak ${bestStreak} rows)`);
  assertPanel(findTooltip(small));
});

test("the same frame without the panel has no tooltip", () => {
  assert.equal(findTooltip(downscale(noise(960, 540), DETECT_WIDTH)), null);
});

test("a full-width black bar without bright pixels is not a tooltip", () => {
  const img = noise(960, 540);
  fill(img, 0, 240, 960, 60, 0);
  assert.equal(findTooltip(downscale(img, DETECT_WIDTH)), null);
});

test("a bright band with no dark pixels at all is not a tooltip", () => {
  const img = noise(960, 540);
  fill(img, 120, 200, 700, 200, 230); // light, and nothing dark anywhere: no panel, no tooltip
  assert.equal(findTooltip(downscale(img, DETECT_WIDTH)), null);
});

test("boxKey describes the panel's content, wherever the panel is shown", () => {
  // The same panel twice: different place in the frame, different backdrop, and the detector's box a pixel or two
  // off. The key has to come out the same, or the scanner records the same item once per position.
  const here = noise(960, 540);
  drawPanel(here, PANEL);
  const there = noise(960, 540);
  drawPanel(there, { ...PANEL, x: 700, y: 240 });
  const smallHere = downscale(here, DETECT_WIDTH);
  const smallThere = downscale(there, DETECT_WIDTH);
  const boxHere = findTooltip(smallHere);
  const boxThere = findTooltip(smallThere);
  assert.ok(boxHere && boxThere);

  const key = boxKey(smallHere, boxHere);
  assert.equal(key.length, 64);
  assert.match(key, /^[0-5]{64}$/);
  assert.equal(keyDistance(key, boxKey(smallThere, boxThere)) <= 8, true, "the same panel must not drift apart");
});

test("boxKey does not move when the detector's box does", () => {
  // Why this exists: the live run recorded the same panel twice because the detector's box moves a pixel or two with
  // the backdrop (and more after the capture encoder), and the key was sampled on a grid tied to that box -- measured
  // offline, a 3 px shift moved 7..15 of 64 cells, past any sane tolerance. The identity is the panel's own content
  // (its dark structure), so a box that is off, or too small, must give exactly the same key.
  const img = composed(drawPanel);
  const box = findTooltip(img);
  assert.ok(box);
  const key = boxKey(img, box);
  for (const off of [1, 2, 3, 5, 8, 12]) {
    assert.equal(keyDistance(key, boxKey(img, { ...box, x: box.x + off, y: box.y + off })), 0, `box shifted by ${off}`);
    assert.equal(
      keyDistance(key, boxKey(img, { ...box, x: box.x - off, y: box.y - off, width: box.width + 2 * off, height: box.height + 2 * off })),
      0,
      `box grown by ${off}`,
    );
  }
});

test("boxKey matches the same panel when the frame cuts its bottom off", () => {
  // The live run failed exactly here: the captured frame was 480x216 (the window showed 576 of the sim's 720 rows),
  // so the tall panel appeared 207 rows tall once and 159 rows tall the second time -- the same panel, minus whatever
  // ran off the bottom -- and a key sampled over all of it moved 15 of 64 cells, past the tolerance. The identity is
  // taken from the panel's top square, which every appearance of it shows, however much was cut off.
  const at = (height) => {
    const img = noise(960, 540);
    drawPanel(img, { x: 300, y: 120, width: 200, height });
    return downscale(img, DETECT_WIDTH);
  };
  const full = at(260); // 100x130 at DETECT_WIDTH
  const cut = at(220); // the same panel, its bottom 20 rows not in the frame
  const boxFull = findTooltip(full);
  const boxCut = findTooltip(cut);
  assert.ok(boxFull && boxCut);
  assert.ok(boxCut.height < boxFull.height, `the cut frame must be shorter (${boxCut.height} vs ${boxFull.height})`);

  const keyFull = boxKey(full, boxFull);
  const keyCut = boxKey(cut, boxCut);
  assert.equal(keyDistance(keyFull, keyCut), 0);
  // ... and the cut one is still not a free pass for some other panel
  const other = composed(drawAntialiasedPanel);
  assert.ok(keyDistance(keyFull, boxKey(other, findTooltip(other))) > 8);
});

test("boxKey separates panels whose content differs", () => {
  const plain = composed(drawPanel);
  const antialiased = composed(drawAntialiasedPanel);
  const keyPlain = boxKey(plain, findTooltip(plain));
  const keyOther = boxKey(antialiased, findTooltip(antialiased));
  assert.ok(keyDistance(keyPlain, keyOther) > 8, `${keyDistance(keyPlain, keyOther)} of 64 cells differ`);
});

test("boxHash is stable for identical frames and moves with the stripes", () => {
  const a = noise(960, 540);
  drawPanel(a, PANEL);
  const b = noise(960, 540);
  drawPanel(b, PANEL);
  const moved = noise(960, 540);
  drawPanel(moved, PANEL, 40); // the same panel, its lines slid 40 px sideways

  const hash = boxHash(a, PANEL);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[01]{64}$/);
  assert.ok(hash.includes("1"), "the hash must actually describe the panel");
  assert.equal(boxHash(b, PANEL), hash);
  assert.notEqual(boxHash(moved, PANEL), hash);
});

test("downscale returns the requested width with a proportional height", () => {
  const img = noise(960, 540);
  const small = downscale(img, DETECT_WIDTH);
  assert.equal(small.width, 480);
  assert.equal(small.height, 270);
  assert.equal(small.data.length, 480 * 270 * 4);
});

test("downscale averages a known 2x2 block to its mean", () => {
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  const values = [0, 100, 200, 255];
  values.forEach((v, i) => {
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  });

  const small = downscale(img, 1);
  assert.equal(small.width, 1);
  assert.equal(small.height, 1);
  assert.equal(small.data[0], 139); // round(555 / 4)
  assert.equal(small.data[3], 255);
});

test("downscale returns the source unchanged when the target is not smaller", () => {
  const img = noise(8, 4);
  assert.equal(downscale(img, 8), img);
  assert.equal(downscale(img, 12), img);
});
