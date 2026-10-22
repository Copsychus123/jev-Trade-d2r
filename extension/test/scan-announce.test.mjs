import assert from "node:assert/strict";
import test from "node:test";

import { ANNOUNCE_TEXT, announceRecognized } from "../src/scan/announce.js";

class Utterance {
  constructor(text) {
    this.text = text;
  }
}

test("announcing speaks 成功識別 in Traditional Chinese and drops a phrase still queued", () => {
  const calls = [];
  const synth = { cancel: () => calls.push("cancel"), speak: (u) => calls.push(["speak", u.text, u.lang]) };
  assert.equal(announceRecognized(synth, Utterance), true);
  assert.deepEqual(calls, ["cancel", ["speak", ANNOUNCE_TEXT, "zh-TW"]]);
});

test("a browser with no speech engine, or one that throws, stays silent and never throws", () => {
  assert.equal(announceRecognized(undefined, Utterance), false);
  assert.equal(announceRecognized({ cancel() {}, speak() {} }, undefined), false);
  const broken = { cancel() {}, speak() { throw new Error("no voice"); } };
  assert.equal(announceRecognized(broken, Utterance), false);
});
