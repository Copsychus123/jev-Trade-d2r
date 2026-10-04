import assert from "node:assert/strict";
import test from "node:test";

import { binarize, chooseScale, closeGaps, makeImage, preprocess, resize, toGray } from "../src/ocr/preprocess.js";

function solid(width, height, [r, g, b]) {
  const img = makeImage(width, height);
  for (let i = 0; i < img.data.length; i += 4) img.data.set([r, g, b, 255], i);
  return img;
}

const pixel = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

test("enlarging keeps hard edges (nearest neighbour) and shrinking averages", () => {
  const two = makeImage(2, 1);
  two.data.set([0, 0, 0, 255, 200, 100, 50, 255]);
  const big = resize(two, 3);
  assert.deepEqual([big.width, big.height], [6, 3]);
  assert.deepEqual(pixel(big, 2, 0), [0, 0, 0]);
  assert.deepEqual(pixel(big, 3, 2), [200, 100, 50]);
  const small = resize(big, 1 / 3);
  assert.deepEqual(pixel(small, 1, 0), [200, 100, 50]);
});

test("grey keeps coloured text bright (brightest channel), not dark", () => {
  const blue = solid(1, 1, [20, 20, 255]);
  assert.equal(toGray(blue).data[0], 255);
});

test("light text on a dark picture becomes black text on white", () => {
  const img = solid(10, 10, [10, 10, 10]);
  for (let x = 2; x < 5; x += 1) img.data.set([240, 240, 240, 255], (5 * 10 + x) * 4);
  const bw = binarize(toGray(img));
  assert.deepEqual(pixel(bw, 3, 5), [0, 0, 0]);
  assert.deepEqual(pixel(bw, 8, 8), [255, 255, 255]);
});

test("closing fills a one-pixel gap inside a stroke but leaves separate strokes apart", () => {
  const bw = solid(12, 3, [255, 255, 255]);
  for (const x of [1, 2, 3, 5, 6, 7]) bw.data.set([0, 0, 0, 255], (1 * 12 + x) * 4); // gap at x = 4
  const closed = closeGaps(bw);
  assert.deepEqual(pixel(closed, 4, 1), [0, 0, 0]);
  assert.deepEqual(pixel(closed, 10, 1), [255, 255, 255]);
});

test("the scale brings a picture to about 1600 px wide within sane limits", () => {
  assert.equal(chooseScale(300), 3);
  assert.equal(chooseScale(800), 2);
  assert.ok(chooseScale(2160) < 1 && chooseScale(2160) > 0.7);
  assert.equal(chooseScale(10000), 0.4);
  const out = preprocess(solid(100, 50, [9, 9, 9]), { scale: 2 });
  assert.deepEqual([out.width, out.height], [200, 100]);
});
