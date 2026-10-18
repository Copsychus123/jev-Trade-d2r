import assert from "node:assert/strict";
import test from "node:test";
import { clusterAndPad } from "../src/scan/fallback.js";

test("a cluster of vertically adjacent and horizontally overlapping text lines is merged into one panel box", () => {
  const boxes = [
    { x: 120, y: 50, width: 90, height: 16 },
    { x: 122, y: 72, width: 85, height: 16 },
    { x: 118, y: 94, width: 92, height: 16 },
    { x: 125, y: 116, width: 70, height: 16 },
  ];
  const box = clusterAndPad(boxes, 720, 540);
  assert.ok(box, "a box must be returned for 4 regular lines");
  assert.ok(box.x <= 118, "box left must be padded beyond the leftmost line");
  assert.ok(box.y <= 50, "box top must be padded beyond the topmost line");
  assert.ok(box.x + box.width >= 122 + 85, "box right must be padded beyond the rightmost line");
  assert.ok(box.y + box.height >= 116 + 16, "box bottom must be padded beyond the bottom line");
});

test("boxes separated by a large vertical gap form distinct clusters and the larger one wins", () => {
  const topCluster = [
    { x: 100, y: 30, width: 80, height: 12 },
    { x: 102, y: 46, width: 75, height: 12 },
    { x: 100, y: 62, width: 78, height: 12 },
    { x: 105, y: 78, width: 70, height: 12 },
  ];
  const bottomCluster = [
    { x: 100, y: 250, width: 80, height: 12 },
    { x: 102, y: 266, width: 75, height: 12 },
  ];
  const box = clusterAndPad([...topCluster, ...bottomCluster], 720, 540);
  assert.ok(box);
  assert.ok(box.y < 120, "the box must contain the top cluster");
  assert.ok(box.y + box.height < 200, "the box must not span across the gap to the bottom cluster");
});

test("an empty box list or fewer than three lines returns null without throwing", () => {
  assert.equal(clusterAndPad([], 720, 540), null);
  assert.equal(clusterAndPad(null, 720, 540), null);
  const twoLines = [
    { x: 100, y: 50, width: 80, height: 14 },
    { x: 105, y: 70, width: 75, height: 14 },
  ];
  assert.equal(clusterAndPad(twoLines, 720, 540), null);
});

test("real text boxes from image-11 cluster and pad to at least 90 percent ground truth coverage", () => {
  // Real detection boxes on image-11.png at 720x405 frame (gt: x=334.8, y=30.8, w=97.1, h=89.3)
  const boxes = [
    { x: 338, y: 36, width: 88, height: 9 },
    { x: 345, y: 47, width: 72, height: 9 },
    { x: 348, y: 58, width: 66, height: 9 },
    { x: 346, y: 69, width: 70, height: 9 },
    { x: 342, y: 80, width: 78, height: 9 },
    { x: 340, y: 91, width: 82, height: 9 },
    { x: 344, y: 101, width: 74, height: 9 },
    { x: 345, y: 111, width: 72, height: 9 },
  ];
  const gt = { x: 334.8, y: 30.8, width: 97.1, height: 89.3 };
  const box = clusterAndPad(boxes, 720, 405);
  assert.ok(box);
  const ix = Math.max(0, Math.min(box.x + box.width, gt.x + gt.width) - Math.max(box.x, gt.x));
  const iy = Math.max(0, Math.min(box.y + box.height, gt.y + gt.height) - Math.max(box.y, gt.y));
  const cov = (ix * iy) / (gt.width * gt.height);
  assert.ok(cov >= 0.90, `coverage ${cov.toFixed(2)} must be >= 0.90`);
});

test("real text boxes from image-13 cluster and pad to at least 90 percent ground truth coverage", () => {
  // Real detection boxes on image-13.png at 720x405 frame (gt: x=276.3, y=125.2, w=168.5, h=151.3)
  const boxes = [
    { x: 310, y: 130, width: 100, height: 14 },
    { x: 285, y: 150, width: 150, height: 14 },
    { x: 288, y: 170, width: 145, height: 14 },
    { x: 290, y: 190, width: 140, height: 14 },
    { x: 285, y: 210, width: 150, height: 14 },
    { x: 288, y: 230, width: 145, height: 14 },
    { x: 292, y: 250, width: 135, height: 14 },
  ];
  const gt = { x: 276.3, y: 125.2, width: 168.5, height: 151.3 };
  const box = clusterAndPad(boxes, 720, 405);
  assert.ok(box);
  const ix = Math.max(0, Math.min(box.x + box.width, gt.x + gt.width) - Math.max(box.x, gt.x));
  const iy = Math.max(0, Math.min(box.y + box.height, gt.y + gt.height) - Math.max(box.y, gt.y));
  const cov = (ix * iy) / (gt.width * gt.height);
  assert.ok(cov >= 0.90, `coverage ${cov.toFixed(2)} must be >= 0.90`);
});
