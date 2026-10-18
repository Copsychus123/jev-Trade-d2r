import assert from "node:assert/strict";
import test from "node:test";

import { isFixedName, toneQuality } from "../src/ocr/tone.js";
import { toTraditional } from "../src/ocr/simplified.js";

// The tones below are the lettering colours measured on the truth pictures (docs/design.md, 2026-10-13 run).

test("unique gold is gold, whether the capture prints it tan or as a paler cream, and set green is green", () => {
  assert.equal(toneQuality([198, 178, 120]), "gold"); // image-8 Rainbow Facet, image-2 Smoke (runeword)
  assert.equal(toneQuality([192, 172, 112]), "gold"); // image-34 Defender's Fire
  assert.equal(toneQuality([253, 250, 187]), "gold"); // image-17 Alma Negra, the cream captures
  assert.equal(toneQuality([235, 233, 174]), "gold"); // IMG_0340, a phone photo of Mara's Kaleidoscope
  assert.equal(toneQuality([0, 251, 0]), "green"); // image-1 Griswold's Honor (set)
});

test("rare yellow is not gold even when it is pale, and magic blue and white are neither", () => {
  assert.equal(toneQuality([248, 248, 100]), "yellow"); // image-42 a rare circlet
  assert.equal(toneQuality([253, 253, 149]), "yellow"); // image-11
  assert.equal(toneQuality([246, 247, 157]), "yellow"); // image-35 (phone photo): the palest rare of the corpus
  assert.equal(toneQuality([242, 221, 86]), null); // image-37 a rare amulet: yellow-orange, no band
  assert.equal(toneQuality([133, 133, 246]), "blue"); // image-20 a magic ring
  assert.equal(toneQuality([250, 250, 250]), "white");
  assert.equal(toneQuality([242, 238, 222]), "white"); // image-46: a gold name washed out by a phone photo
});

test("the gold band edge separates a cream unique at saturation 0.27 from a rare yellow at 0.36, with the edge at 0.31", () => {
  assert.equal(toneQuality([253, 248, 185]), "gold"); // 0.269
  assert.equal(toneQuality([250, 250, 160]), "yellow"); // 0.360
  assert.equal(toneQuality([253, 250, 177]), "gold"); // 0.300, just under the edge
  assert.equal(toneQuality([253, 250, 172]), "yellow"); // 0.320, just over it
});

test("a missing, dark or broken tone is no quality", () => {
  assert.equal(toneQuality(null), null);
  assert.equal(toneQuality(undefined), null);
  assert.equal(toneQuality([]), null);
  assert.equal(toneQuality([100, 90, 60]), null); // too dark to be lettering
  assert.equal(toneQuality([255, NaN, 0]), null);
  assert.equal(toneQuality([255, 168, 0]), null); // crafted orange is not a fixed name either
});

test("only gold and green are the colour of a name the table lists", () => {
  assert.deepEqual(["gold", "green", "yellow", "blue", "white", null].map(isFixedName), [true, true, false, false, false, false]);
});

test("the simplified glyphs the engine prints are turned back; a character that is traditional text too is left alone", () => {
  assert.equal(toTraditional("盗贼皇冠"), "盜賊皇冠");
  assert.equal(toTraditional("殺手护盔"), "殺手護盔");
  assert.equal(toTraditional("阿尔发头盔"), "阿爾發頭盔");
  assert.equal(toTraditional("里"), "里", "里 is a character of some table name already, so it is not rewritten");
  assert.equal(toTraditional("珠寶 Ring 3"), "珠寶 Ring 3");
  assert.equal(toTraditional(""), "");
});
