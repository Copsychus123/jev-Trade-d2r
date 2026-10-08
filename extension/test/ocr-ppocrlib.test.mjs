import assert from "node:assert/strict";
import test from "node:test";

import {
  OcrPipeline,
  buildCharacterList,
  imageDataToBgr,
  resizeLinear,
  dbPostprocess,
  sortedBoxes,
  getRotateCropImage,
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
