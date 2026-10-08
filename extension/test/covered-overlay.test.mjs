import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// covered_overlay.js is one arrow function the extension injects into the page (`Tab.overlayCover`, extension/src/cdp.js):
// the agent measures whether the failed target's centre sits under a full-viewport fixed overlay. The script reads
// `window`, `document`, `getComputedStyle`, `innerWidth` and `innerHeight` only as bare names, so rebuilding it with
// `new Function` and passing fakes keeps the page's globals — and ours — out of this file.
const SOURCE = readFileSync(new URL("../../src/jev_ultrafast/covered_overlay.js", import.meta.url), "utf8");
const BUILD = new Function(
  "window",
  "document",
  "getComputedStyle",
  "innerWidth",
  "innerHeight",
  "return (" + SOURCE + ");",
);

const VIEWPORT = { width: 1000, height: 800 };
const FULL = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
const TARGET = { x: 100, y: 100, width: 200, height: 100 }; // centre (200, 150), inside the viewport
const NODE_KEY = "n1";

/** A fake element: a box, the `position` its computed style reports, its parent, and the elements it contains. */
function element(rect, { position = "static", parent = null, contains = [], connected = true } = {}) {
  const el = {
    isConnected: connected,
    parentElement: parent,
    position,
    getBoundingClientRect: () => rect,
    contains: (other) => other === el || contains.includes(other),
  };
  return el;
}

/** Run the page script with the target node in `window.__jevFast.nodes` and one `elementFromPoint` answer. */
function overlayCovers(node, hit) {
  const fakeWindow = { __jevFast: { nodes: new Map([[NODE_KEY, node]]) } };
  const fakeDocument = { elementFromPoint: () => hit };
  const fakeStyle = (el) => ({ position: el.position });
  return BUILD(fakeWindow, fakeDocument, fakeStyle, VIEWPORT.width, VIEWPORT.height)({ node: NODE_KEY });
}

test("a target whose centre sits under a fixed full-screen box is covered", () => {
  const cover = element(FULL, { position: "fixed" });
  const backdrop = element(FULL, { parent: cover });
  assert.equal(overlayCovers(element(TARGET), backdrop), true);
});

test("a target hit by itself or by its own descendant is not covered", () => {
  const target = element(TARGET);
  assert.equal(overlayCovers(target, target), false);
  const inner = element({ x: 150, y: 120, width: 20, height: 20 });
  const outer = element(TARGET, { contains: [inner] });
  assert.equal(overlayCovers(outer, inner), false);
});

test("a covering box that is positioned but not fixed does not count", () => {
  const positioned = element(FULL, { position: "relative" });
  const backdrop = element(FULL, { parent: positioned });
  assert.equal(overlayCovers(element(TARGET), backdrop), false);
  // No positioned ancestor at all: the walk runs off the top of the tree and reports nothing.
  const unpositioned = element(FULL);
  assert.equal(overlayCovers(element(TARGET), element(FULL, { parent: unpositioned })), false);
});

test("a fixed box covering less than 90 % of the viewport does not count", () => {
  const half = element({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height / 2 }, { position: "fixed" });
  const backdrop = element({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height / 2 }, { parent: half });
  assert.equal(overlayCovers(element(TARGET), backdrop), false);
});

test("a disconnected target node is never reported as covered", () => {
  const cover = element(FULL, { position: "fixed" });
  const backdrop = element(FULL, { parent: cover });
  assert.equal(overlayCovers(element(TARGET, { connected: false }), backdrop), false);
});
