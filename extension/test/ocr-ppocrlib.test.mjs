import assert from "node:assert/strict";
import test from "node:test";

import {
  OcrPipeline,
  buildCharacterList,
  detLimitFor,
  imageDataToBgr,
  resizeLinear,
  dbPostprocess,
  sortedBoxes,
  getRotateCropImage,
  inkTone,
} from "../src/ocr/ppocrlib.js";

test("buildCharacterList adds blank and space and drops one trailing newline", () => {
  const expected = ["blank", "a", "b", " "];
  assert.deepEqual(buildCharacterList("a\nb\n"), expected);
  assert.deepEqual(buildCharacterList("a\nb"), expected);
});

test("imageDataToBgr keeps the pixel order and drops alpha", () => {
  const bgr = imageDataToBgr({ data: new Uint8ClampedArray([10, 20, 30, 255]), width: 1, height: 1 });
  assert.deepEqual([...bgr.data], [30, 20, 10]); // R,G,B,A -> B,G,R
  assert.equal(bgr.w, 1);
  assert.equal(bgr.h, 1);
});

test("resizeLinear follows OpenCV's half-pixel convention", () => {
  // 2x2 grey image (each value on all three channels), enlarged to 4x4.
  const gray = [0, 100, 200, 255];
  const data = new Uint8Array(12);
  gray.forEach((v, i) => data.fill(v, i * 3, i * 3 + 3));
  const out = resizeLinear({ data, w: 2, h: 2 }, 4, 4);
  // Hand-computed from cv2.resize INTER_LINEAR with the half-pixel rule.
  const expected = [
    [0, 25, 75, 100],
    [50, 72, 117, 139],
    [150, 167, 200, 216],
    [200, 214, 241, 255],
  ];
  assert.equal(out.w, 4);
  assert.equal(out.h, 4);
  expected.forEach((row, y) =>
    row.forEach((v, x) => {
      for (let c = 0; c < 3; c += 1) assert.equal(out.data[(y * 4 + x) * 3 + c], v, `pixel (${x},${y}) channel ${c}`);
    }),
  );
});

test("a read that asked to cap detection does so only for a large picture, and never for a small one", () => {
  assert.equal(detLimitFor(2400, 1800, true).limit_type, "max", "a phone photo is detected on a capped copy");
  assert.equal(detLimitFor(2400, 1800, true).limit_side_len, 736);
  assert.equal(detLimitFor(2400, 1800, false), null, "a read that did not ask keeps the model's own policy");
  assert.equal(detLimitFor(1200, 800, true), null, "a screenshot is small: its detection stays as measured");
  assert.equal(detLimitFor(1500, 900, true), null, "the boundary itself is small");
});

test("dbPostprocess returns one inflated box for a filled probability rectangle", () => {
  const mapW = 8;
  const mapH = 8;
  const prob = new Float32Array(mapW * mapH);
  for (let y = 2; y <= 5; y += 1) for (let x = 2; x <= 5; x += 1) prob[y * mapW + x] = 0.9;
  const { boxes, scores } = dbPostprocess(prob, mapW, mapH, 8, 8);
  assert.equal(boxes.length, 1);
  assert.ok(scores[0] > 0.5);
  // The 4x4 block (after the 2x2 dilate) inflates by area*unclip_ratio/perimeter = 16*1.6/16 = 1.6 on each side,
  // so the rectangle spans -0.6 .. 6.6 before being clamped to the 0..7 pixel grid.
  const expected = [[-0.6, -0.6], [6.6, -0.6], [6.6, 6.6], [-0.6, 6.6]];
  boxes[0].forEach(([x, y], i) => {
    assert.ok(Math.abs(x - expected[i][0]) <= 1, `corner ${i} x (${x} vs ${expected[i][0]})`);
    assert.ok(Math.abs(y - expected[i][1]) <= 1, `corner ${i} y (${y} vs ${expected[i][1]})`);
  });
});

test("sortedBoxes orders by y band then x", () => {
  const box = (x, y) => [[x, y], [x + 5, y], [x + 5, y + 5], [x, y + 5]];
  const a = box(50, 0);
  const b = box(10, 5);
  const c = box(0, 20);
  assert.deepEqual(sortedBoxes([a, b, c]), [b, a, c]);
});

test("getRotateCropImage swaps sides when the crop is at least 1.5x taller than wide", () => {
  const img = { data: new Uint8Array(40 * 40 * 3), w: 40, h: 40 };
  const points = [[0, 0], [10, 0], [10, 40], [0, 40]];
  const out = getRotateCropImage(img, points);
  assert.equal(out.w, 40);
  assert.equal(out.h, 10);
  assert.equal(out.data.length, 40 * 10 * 3);
});

test("getRotateCropImage keeps every channel of a tall crop through the counter-clockwise rotation", () => {
  // A 4x4 source whose channels are distinct per pixel: an axis-aligned quad makes the warp a lossless copy, so the
  // rotated output must be exactly the crop's pixels re-ordered (a wrong index would drop them all and leave a blank
  // crop, and a copy that wrote only the first channel would leave a colourless one — both are what a vertical text
  // line would then be read from). All three channels are asserted, not just red.
  const src = { data: new Uint8Array(4 * 4 * 3), w: 4, h: 4 };
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const at = (y * 4 + x) * 3;
      src.data[at] = y * 4 + x + 1; // red: a unique value per pixel
      src.data[at + 1] = 100 + y * 4 + x; // green and blue too, so a dropped channel cannot pass
      src.data[at + 2] = 200 - (y * 4 + x);
    }
  }
  const out = getRotateCropImage(src, [[1, 0], [3, 0], [3, 4], [1, 4]]);
  assert.equal(out.w, 4);
  assert.equal(out.h, 2);
  const pixels = [];
  for (let i = 0; i < out.data.length; i += 3) pixels.push([out.data[i], out.data[i + 1], out.data[i + 2]]);
  // The crop is source columns 1..2 (crop[y][0] = src[y][1]); np.rot90 sends crop[y][x] to out[x][w - 1 - y].
  const expected = [];
  for (let ny = 0; ny < 2; ny++) {
    for (let nx = 0; nx < 4; nx++) {
      const red = nx * 4 + 3 - ny;
      expected.push([red, 100 + red - 1, 201 - red]);
    }
  }
  assert.deepEqual(pixels, expected);
});

test("detect feeds the session a tensor whose sides are rounded to a multiple of 32", () => {
  // The det input grows so its shorter side reaches CFG.det.limit_side_len (736, limit_type "min") and then both sides
  // are rounded to a multiple of 32 (upstream reduce_max_side/increase_min_side). Nothing else in the suite observes
  // the resize geometry: without this, dropping the rounding would only show up as a slow accuracy drift.
  const fed = [];
  const session = {
    inputNames: ["x"],
    outputNames: ["y"],
    run: async (feed) => {
      fed.push(feed.x.dims);
      const [n, , h, w] = feed.x.dims;
      return { y: { data: new Float32Array(n * h * w), dims: [n, 1, h, w] } };
    },
  };
  const ort = {
    Tensor: class {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
  };
  const pipeline = new OcrPipeline(ort, { det: session, cls: null, rec: null }, []);
  const img = { data: new Uint8Array(100 * 173 * 3), w: 173, h: 100 };

  return pipeline.detect(img).then(() => {
    // 100 is the shorter side: 736/100 = 7.36, so 173 * 7.36 = 1273.28 -> 1273, rounded up to 1280 (40 * 32).
    assert.deepEqual(fed, [[1, 3, 736, 1280]]);
  });
});

test("ctcDecode drops repeats and blanks and averages the kept probabilities", () => {
  const pipeline = new OcrPipeline(null, null, ["blank", "a", "b", " "]);
  const T = 4;
  const C = 4;
  const logits = new Float32Array(T * C);
  logits[0 * C + 1] = 0.8; // a
  logits[1 * C + 1] = 0.6; // a again -> dropped as a repeat
  logits[2 * C + 0] = 0.9; // blank -> dropped
  logits[3 * C + 2] = 0.4; // b
  assert.deepEqual(pipeline.ctcDecode(logits, 0, T, C), { text: "ab", score: 0.6 });
});

// --- the lettering colour of a line (inkTone), which the matcher reads as the item's quality ---------------------------

/** A BGR crop of `w` x `h` whose pixel at column x is `colourAt(x)` ([r, g, b]) on every row, with a dark top row. */
function stripe(w, h, colourAt) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colourAt(x);
      data.set([b, g, r], (y * w + x) * 3);
    }
  }
  return { data, w, h };
}
const BACKGROUND = [18, 18, 20];

test("inkTone is the colour of the lettering, not of the dark tooltip behind it", () => {
  // Ten columns of gold lettering among dark ones: the dark pixels are most of the crop, and none of them counts.
  const crop = stripe(100, 12, (x) => (x % 10 < 3 ? [198, 178, 120] : BACKGROUND));
  assert.deepEqual(inkTone(crop), [198, 178, 120]);
});

test("inkTone reads only the front of the line: a name stands first and a tag in another colour follows it", () => {
  // 蜘蛛之網[120ED] shape: the first 40% is the name (cream), the rest is the roll tag (blue here).
  const crop = stripe(100, 12, (x) => (x < 40 ? [253, 249, 187] : [100, 150, 255]));
  assert.deepEqual(inkTone(crop), [253, 249, 187]);
});

test("inkTone leaves red pixels out unless the whole line is red", () => {
  // A red bracket among the first columns must not drag the cream name's colour toward salmon.
  const named = stripe(100, 12, (x) => (x < 4 ? [255, 100, 100] : x < 40 ? [253, 249, 187] : BACKGROUND));
  assert.deepEqual(inkTone(named), [253, 249, 187]);
  const red = stripe(100, 12, (x) => (x < 40 ? [255, 100, 100] : BACKGROUND));
  assert.deepEqual(inkTone(red), [255, 100, 100]);
});

test("inkTone has nothing to say about an empty crop", () => {
  assert.equal(inkTone({ data: new Uint8Array(0), w: 0, h: 0 }), null);
});

test("each recognized line keeps the colour of its own crop, and a line dropped for its score takes its colour along", async () => {
  // Three boxes on a 300x100 picture: gold, blue and green lettering. The middle line is recognised with a score under
  // the 0.5 floor, so it is dropped; the two that stay must keep their own colours, in order.
  const w = 300;
  const h = 100;
  const data = new Uint8Array(w * h * 3);
  const paint = (x0, colour) => {
    for (let y = 10; y < 90; y++) for (let x = x0; x < x0 + 80; x++) data.set([colour[2], colour[1], colour[0]], (y * w + x) * 3);
  };
  paint(10, [198, 178, 120]);
  paint(110, [133, 133, 246]);
  paint(210, [0, 251, 0]);
  const box = (x0) => [[x0, 10], [x0 + 80, 10], [x0 + 80, 90], [x0, 90]];
  const pipeline = new OcrPipeline(null, null, []);
  pipeline.detect = async () => [box(10), box(110), box(210)];
  pipeline.classify = async (crops) => crops;
  pipeline.recognize = async () => [
    { text: "甲", score: 0.9 },
    { text: "乙", score: 0.2 },
    { text: "丙", score: 0.9 },
  ];
  const { lines } = await pipeline.recognizeImage({ data, w, h });
  assert.deepEqual(lines.map((line) => [line.text, line.tone]), [["甲", [198, 178, 120]], ["丙", [0, 251, 0]]]);
});
