import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseTradingTxt } from "../src/traderie/parsing.js";
import {
  COMMON_PRESET,
  EMPTY_FILTERS,
  FILTER_FIELDS,
  FILTER_OPTION_LABELS,
  applyFilters,
  describeFilters,
  filtersActive,
  normalizeFilters,
} from "../src/filters.js";

test("FILTER_FIELDS has the expected structure", () => {
  assert.equal(FILTER_FIELDS.length, 4);
  assert.equal(FILTER_FIELDS[0].key, "platform");
  assert.equal(FILTER_FIELDS[0].label, "平台");
  assert.equal(FILTER_FIELDS[1].key, "mode");
  assert.equal(FILTER_FIELDS[1].label, "模式");
  assert.equal(FILTER_FIELDS[2].key, "ladder");
  assert.equal(FILTER_FIELDS[2].label, "天梯");
  assert.equal(FILTER_FIELDS[3].key, "game_version");
  assert.equal(FILTER_FIELDS[3].label, "遊戲版本");
});

test("FILTER_OPTION_LABELS includes all options with proper labels", () => {
  for (const field of FILTER_FIELDS) {
    for (const option of field.options) {
      assert.ok(
        option in FILTER_OPTION_LABELS,
        `Option "${option}" for field "${field.key}" missing from FILTER_OPTION_LABELS`,
      );
    }
  }
});

test("game version labels use Traditional Chinese suffixes", () => {
  assert.equal(FILTER_OPTION_LABELS["Reign of the Warlock"], "Reign of the Warlock（新版）");
  assert.equal(FILTER_OPTION_LABELS["Lord of Destruction"], "Lord of Destruction（舊版）");
});

test("PlayStation option has correct capitalization", () => {
  assert.equal(FILTER_OPTION_LABELS.Playstation, "PlayStation");
});

test("EMPTY_FILTERS has all fields as empty strings", () => {
  assert.deepEqual(EMPTY_FILTERS, {
    platform: "",
    mode: "",
    ladder: "",
    game_version: "",
  });
});

test("COMMON_PRESET has expected default values", () => {
  assert.deepEqual(COMMON_PRESET, {
    platform: "PC",
    mode: "Softcore",
    ladder: "Ladder",
    game_version: "",
  });
});

test("normalizeFilters returns all four keys with empty strings for garbage input", () => {
  assert.deepEqual(normalizeFilters(null), EMPTY_FILTERS);
  assert.deepEqual(normalizeFilters(undefined), EMPTY_FILTERS);
  assert.deepEqual(normalizeFilters({}), EMPTY_FILTERS);
  assert.deepEqual(normalizeFilters("invalid"), EMPTY_FILTERS);
  assert.deepEqual(normalizeFilters(123), EMPTY_FILTERS);
});

test("normalizeFilters preserves valid values", () => {
  const input = { platform: "PC", mode: "Softcore", ladder: "Ladder", game_version: "" };
  assert.deepEqual(normalizeFilters(input), input);
});

test("normalizeFilters sanitizes invalid option values to empty strings", () => {
  const input = { platform: "invalid", mode: "Softcore", ladder: "Ladder", game_version: "" };
  assert.deepEqual(normalizeFilters(input), { platform: "", mode: "Softcore", ladder: "Ladder", game_version: "" });
});

test("normalizeFilters handles missing keys", () => {
  const input = { platform: "PC" };
  assert.deepEqual(normalizeFilters(input), {
    platform: "PC",
    mode: "",
    ladder: "",
    game_version: "",
  });
});

test("normalizeFilters converts non-string values to empty", () => {
  const input = { platform: 123, mode: null, ladder: undefined, game_version: ["array"] };
  assert.deepEqual(normalizeFilters(input), EMPTY_FILTERS);
});

test("normalizeFilters never mutates input", () => {
  const input = { platform: "PC", mode: "Softcore", ladder: "Ladder", game_version: "" };
  const copy = { ...input };
  normalizeFilters(input);
  assert.deepEqual(input, copy);
});

test("filtersActive returns false when all filters are empty", () => {
  assert.equal(filtersActive(EMPTY_FILTERS), false);
  assert.equal(filtersActive({ platform: "", mode: "", ladder: "", game_version: "" }), false);
});

test("filtersActive returns true when any filter is non-empty", () => {
  assert.equal(filtersActive({ ...EMPTY_FILTERS, platform: "PC" }), true);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, mode: "Softcore" }), true);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, ladder: "Ladder" }), true);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, game_version: "Reign of the Warlock" }), true);
});

test("applyFilters returns all rows when no filters are active", () => {
  const rows = [{ platform: "PC", mode: "Softcore" }, { platform: "Xbox", mode: "Hardcore" }];
  const result = applyFilters(rows, EMPTY_FILTERS);
  assert.equal(result.rows.length, 2);
  assert.equal(result.hidden, 0);
  assert.equal(result.unknown, 0);
  assert.equal(result.rows[0], rows[0]);
  assert.equal(result.rows[1], rows[1]);
});

test("applyFilters preserves original row objects (no copies)", () => {
  const rows = [{ platform: "PC" }, { platform: "Xbox" }];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.strictEqual(result.rows[0], rows[0]);
});

test("applyFilters preserves original row order", () => {
  const rows = [{ id: 1, platform: "PC" }, { id: 2, platform: "PC" }, { id: 3, platform: "Xbox" }];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    [1, 2],
  );
});

test("applyFilters filters by single field", () => {
  const rows = [
    { platform: "PC", mode: "Softcore" },
    { platform: "Xbox", mode: "Softcore" },
    { platform: "PC", mode: "Hardcore" },
  ];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.equal(result.rows.length, 2);
  assert.equal(result.hidden, 1);
});

test("applyFilters filters with multiple fields (AND logic)", () => {
  const rows = [
    { platform: "PC", mode: "Softcore", ladder: "Ladder" },
    { platform: "PC", mode: "Hardcore", ladder: "Ladder" },
    { platform: "Xbox", mode: "Softcore", ladder: "Ladder" },
    { platform: "PC", mode: "Softcore", ladder: "Non Ladder" },
  ];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC", mode: "Softcore" });
  assert.equal(result.rows.length, 2);
  assert.equal(result.hidden, 2);
});

test("applyFilters counts hidden rows correctly", () => {
  const rows = [
    { platform: "PC" },
    { platform: "Xbox" },
    { platform: "Switch" },
  ];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.equal(result.hidden, 2);
});

test("applyFilters counts unknown (missing field values) separately from mismatches", () => {
  const rows = [
    { platform: "PC", mode: "Softcore" },
    { platform: null, mode: "Softcore" },
    { platform: "", mode: "Softcore" },
    { platform: "Xbox", mode: "Softcore" },
  ];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.hidden, 3);
  assert.equal(result.unknown, 2); // null and empty string rows
});

test("applyFilters mismatch takes precedence over unknown", () => {
  const rows = [
    { platform: "PC", mode: "Softcore" },
    { platform: null, mode: "Hardcore" }, // Missing platform, but mode is wrong
    { platform: "", mode: "Softcore" }, // Missing platform, mode matches
  ];
  const result = applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC", mode: "Softcore" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.hidden, 2);
  assert.equal(result.unknown, 1); // Only the second row (mode mismatch doesn't count as unknown)
});

test("applyFilters does not mutate input rows array", () => {
  const rows = [{ platform: "PC" }, { platform: "Xbox" }];
  const copy = [...rows];
  applyFilters(rows, { ...EMPTY_FILTERS, platform: "PC" });
  assert.deepEqual(rows, copy);
});

test("applyFilters handles empty rows array", () => {
  const result = applyFilters([], { ...EMPTY_FILTERS, platform: "PC" });
  assert.equal(result.rows.length, 0);
  assert.equal(result.hidden, 0);
  assert.equal(result.unknown, 0);
});

test("describeFilters returns empty string when no filters active", () => {
  assert.equal(describeFilters(EMPTY_FILTERS), "");
});

test("describeFilters shows single active filter", () => {
  assert.equal(describeFilters({ ...EMPTY_FILTERS, platform: "PC" }), "PC");
});

test("describeFilters joins multiple active filters with ' · ' in field order", () => {
  const result = describeFilters({ ...EMPTY_FILTERS, platform: "PC", mode: "Softcore" });
  assert.equal(result, "PC · Softcore");
});

test("describeFilters uses FILTER_OPTION_LABELS for display", () => {
  const result = describeFilters({ ...EMPTY_FILTERS, platform: "Playstation", game_version: "Reign of the Warlock" });
  assert.equal(result, "PlayStation · Reign of the Warlock（新版）");
});

test("describeFilters maintains FILTER_FIELDS order", () => {
  const result = describeFilters({
    platform: "PC",
    mode: "Softcore",
    ladder: "Ladder",
    game_version: "Reign of the Warlock",
  });
  assert.equal(result, "PC · Softcore · Ladder · Reign of the Warlock（新版）");
});

test("all FILTER_FIELDS options are valid values from the real trading parser", () => {
  // This test verifies that the options we define can actually be produced by the parser
  const fixtureDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(fixtureDir, "../../tests/fixtures/trading_harlequin_crest.txt");
  const fixtureText = readFileSync(fixturePath, "utf8");

  const rows = parseTradingTxt(fixtureText, { itemName: "Harlequin Crest" });

  const collectedValues = {
    platform: new Set(),
    mode: new Set(),
    ladder: new Set(),
    game_version: new Set(),
  };

  for (const row of rows) {
    if (row.platform) collectedValues.platform.add(row.platform);
    if (row.mode) collectedValues.mode.add(row.mode);
    if (row.ladder) collectedValues.ladder.add(row.ladder);
    if (row.game_version) collectedValues.game_version.add(row.game_version);
  }

  // Every value found in the parsed rows should be among the field's options
  for (const field of FILTER_FIELDS) {
    for (const value of collectedValues[field.key]) {
      assert.ok(
        field.options.includes(value),
        `Parser produced value "${value}" for field "${field.key}" but it's not in the options: ${field.options.join(", ")}`,
      );
    }
  }
});
