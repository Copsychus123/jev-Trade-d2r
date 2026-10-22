import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LISTING, LISTING_FIELDS, normalizeListingDefaults, propertyValue } from "../src/listing-defaults.js";

test("missing or damaged storage gives the defaults", () => {
  assert.deepEqual(normalizeListingDefaults(undefined), DEFAULT_LISTING);
  assert.deepEqual(normalizeListingDefaults("PC"), DEFAULT_LISTING);
  assert.deepEqual(normalizeListingDefaults({ platform: 3, mode: null }), DEFAULT_LISTING);
});

test("a value outside a field's options falls back to that field's default; the others are kept", () => {
  const saved = { platform: "xbox", mode: "Softcore", ladder: "nonladder", version: "classic (base game)", extra: 1 };
  assert.deepEqual(normalizeListingDefaults(saved), {
    platform: "xbox",
    mode: "softcore",
    ladder: "nonladder",
    version: "classic (base game)",
  });
  assert.equal(Object.hasOwn(normalizeListingDefaults(saved), "extra"), false);
  assert.deepEqual(saved.mode, "Softcore", "the input is never changed");
});

test("every field's default is one of its own options, and Ladder is sent as a bool", () => {
  for (const { key, options } of LISTING_FIELDS) assert.ok(options.some((o) => o.value === DEFAULT_LISTING[key]), key);
  assert.equal(propertyValue("ladder", "ladder"), true);
  assert.equal(propertyValue("ladder", "nonladder"), false);
  assert.equal(propertyValue("mode", "hardcore"), "hardcore");
});
