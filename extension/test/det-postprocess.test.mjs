// The detector's geometry stage (DBPostProcess) had no fast guard: only the end-to-end accuracy gate
// (`scripts/ocr_e2e.py`, real Chrome plus the downloaded models) covered it, so a flood/box regression could only be
// seen after a several-minute run. These maps are synthetic and deterministic, so the shapes below need neither.
//
// The expectations are derived from the fixture instead of recorded by eye: the blobs are identical, they sit on a
// 110 x 260 grid, and the ported unclip step grows every box by the same offset, so the box size must be constant,
// the spacing must survive, and the order must stay raster.
import assert from "node:assert/strict";
import test from "node:test";

import { dbPostprocess } from "../src/ocr/ppocrlib.js";

const W = 736;
const H = 920;
const BLOB_W = 80;
const BLOB_H = 40;
const COL_STEP = 110;
const ROW_STEP = 260;

/** No text at all: one border-touching background blob, which is a hole rather than a box. */
const emptyMap = () => new Float32Array(W * H);

/** 18 solid 40x80 blobs in three rows of six, inside the frame. */
function blobsMap() {
  const prob = new Float32Array(W * H);
  for (let i = 0; i < 18; i += 1) {
    const x = 40 + (i % 6) * COL_STEP;
    const y = 60 + Math.floor(i / 6) * ROW_STEP;
    for (let dy = 0; dy < BLOB_H; dy += 1) {
      for (let dx = 0; dx < BLOB_W; dx += 1) prob[(y + dy) * W + x + dx] = 0.9;
    }
  }
  return prob;
}

const width = (quad) => Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
const height = (quad) => Math.hypot(quad[0][0] - quad[3][0], quad[0][1] - quad[3][1]);
const topLeft = (quad) => [Math.min(...quad.map(([x]) => x)), Math.min(...quad.map(([, y]) => y))];
/** The gaps between a sorted, de-duplicated coordinate list: the fixture's grid must survive the read. */
const gaps = (values) => {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  return sorted.slice(1).map((value, i) => value - sorted[i]);
};

test("a map with no text yields no boxes", () => {
  assert.deepEqual(dbPostprocess(emptyMap(), W, H, W, H), { boxes: [], scores: [] });
});

test("every blob becomes one box of the same size, inside the frame, with its own score", () => {
  const { boxes, scores } = dbPostprocess(blobsMap(), W, H, W, H);
  assert.equal(boxes.length, 18, "one box per blob");
  assert.equal(scores.length, 18);

  const sizes = new Set(boxes.map((quad) => `${Math.round(width(quad))}x${Math.round(height(quad))}`));
  assert.equal(sizes.size, 1, `identical blobs must give identical boxes, got ${[...sizes]}`);
  const [boxW, boxH] = [...sizes][0].split("x").map(Number);
  assert.ok(boxW > BLOB_W && boxH > BLOB_H, `the unclip step grows the box past ${BLOB_W}x${BLOB_H}`);

  for (const [i, quad] of boxes.entries()) {
    assert.equal(quad.length, 4, `box ${i} has four corners`);
    for (const [x, y] of quad) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `box ${i} corners are whole pixels`);
      assert.ok(x >= 0 && x < W && y >= 0 && y < H, `box ${i} corner (${x}, ${y}) is inside ${W}x${H}`);
    }
    assert.ok(Math.abs(scores[i] - 0.9) < 1e-6, `box ${i} scores the blob's probability, got ${scores[i]}`);
  }
});

test("the fixture's grid survives, and the boxes stay in raster order", () => {
  const { boxes } = dbPostprocess(blobsMap(), W, H, W, H);
  const corners = boxes.map(topLeft);
  assert.deepEqual(gaps(corners.map(([x]) => x)), [COL_STEP, COL_STEP, COL_STEP, COL_STEP, COL_STEP]);
  assert.deepEqual(gaps(corners.map(([, y]) => y)), [ROW_STEP, ROW_STEP]);
  for (let i = 1; i < corners.length; i += 1) {
    const [prevX, prevY] = corners[i - 1];
    const [x, y] = corners[i];
    assert.ok(prevY < y || (prevY === y && prevX < x), `box ${i} follows box ${i - 1} in raster order`);
  }
});

test("a map that is entirely text still yields its single blob, and a tiny map works", () => {
  assert.equal(dbPostprocess(new Float32Array(W * H).fill(0.9), W, H, W, H).boxes.length, 1);
  assert.equal(dbPostprocess(new Float32Array(64).fill(0.9), 8, 8, 8, 8).boxes.length, 1);
});
