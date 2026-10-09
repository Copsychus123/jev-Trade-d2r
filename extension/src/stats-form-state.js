// What the second search form holds and the rules for changing it. No DOM and no chrome.*: it is also tested under node.
// A form is { conditions, quality, base, unavailable }:
//   conditions    [{ key, label, kind, line, min, max, on }] in the order shown
//   quality       "any" | "rare" | "magic" | "normal"
//   base          the item type text ("Ring"), may be empty
//   unavailable   dictionary keys Traderie has no property for: shown, but cannot be switched on
import { MAX_CONDITIONS } from "./traderie/stats.js";

export const EMPTY_LIST = "（還沒有條件）";

export const emptyStatsForm = () => ({
  conditions: [],
  quality: "any",
  base: "",
  unavailable: [],
});

export const onCount = (form) => form.conditions.filter((c) => c.on).length;

const change = (form, key, update) => ({
  ...form,
  conditions: form.conditions.map((c) => (c.key === key ? { ...c, ...update(c) } : c)),
});

/**
 * The conditions read from a screenshot (parseAffixLines) replace the list. The tick marks the attributes the reader
 * recognised. With `carryValues` the numbers the reader read are filled in as well and marked `fromCapture`, so the
 * form can say where they came from; the player still edits them and still presses start. Without it every read row
 * starts with `min`/`max` null, which is what this reader has always done.
 * A condition the player had switched on keeps their own numbers, whatever the new reading says, and stays in the list
 * even when the screenshot no longer shows it. Every read condition is switched on in reading order; ones Traderie has
 * no property for and those past the limit stay off.
 */
export function fillFromScreenshot(form, parsed, unavailable = form.unavailable, { carryValues = false } = {}) {
  const chosen = new Map(form.conditions.filter((c) => c.on).map((c) => [c.key, c]));
  const read = parsed.conditions.map(
    (c) =>
      chosen.get(c.key) ?? {
        key: c.key,
        label: c.label,
        kind: c.kind,
        line: c.line,
        min: carryValues ? c.min ?? null : null,
        max: carryValues ? c.max ?? null : null,
        fromCapture: carryValues && c.min !== null,
        on: false,
      },
  );
  const kept = [...chosen.values()].filter((c) => !parsed.conditions.some((p) => p.key === c.key));
  let next = { ...form, conditions: [...read, ...kept], unavailable };
  for (const c of parsed.conditions) {
    if (!chosen.has(c.key)) next = setOn(next, c.key, true);
  }
  return next;
}

/** A new, empty, switched-off row for a dictionary entry the player picked by hand. */
export function addCondition(form, entry) {
  if (form.conditions.some((c) => c.key === entry.key)) return form;
  const row = { key: entry.key, label: entry.zh, kind: entry.kind, line: "", min: null, max: null, on: false };
  return { ...form, conditions: [...form.conditions, row] };
}

export function removeCondition(form, key) {
  return { ...form, conditions: form.conditions.filter((c) => c.key !== key) };
}

/** Switches a condition on or off. Refused (form unchanged) for a key Traderie has no property for, or past the limit. */
export function setOn(form, key, on, maxConditions = MAX_CONDITIONS) {
  const row = form.conditions.find((c) => c.key === key);
  if (!row || row.on === on) return form;
  if (!on) return change(form, key, () => ({ on: false }));
  if (form.unavailable.includes(key)) return form;
  if (onCount(form) >= maxConditions) return form;
  return change(form, key, () => ({ on: true }));
}

/** field is "min" or "max"; an empty or invalid entry means no limit. Editing a value clears its from-capture mark. */
export function setLimit(form, key, field, value) {
  const number = value === "" || value === null || value === undefined ? null : Number(value);
  const limit = number !== null && Number.isFinite(number) && number >= 0 ? number : null;
  return change(form, key, () =>
    field === "min" ? { min: limit, fromCapture: false } : { max: limit, fromCapture: false },
  );
}

export const setQuality = (form, quality) => ({ ...form, quality });
export const setBase = (form, base) => ({ ...form, base });

/** Keys whose upper limit is below the lower one. */
export const invalidKeys = (form) =>
  form.conditions.filter((c) => c.min !== null && c.max !== null && c.max < c.min).map((c) => c.key);

export const NEED_SOMETHING = "請輸入底材名稱";
export const FIX_LIMITS = "有條件的最大值小於最小值，請修正標紅的條件";
export const NEED_VALUES = "有勾選的條件還沒填數值：";

/**
 * "" when the form can be searched, otherwise what the player has to do first: fix a max below its min, give every
 * ticked non-bool condition at least one value (0 counts), then name a base. A bool condition needs no number, and
 * ticking nothing at all stays legal, so a base-only search still works.
 */
export function startBlocker(form) {
  if (invalidKeys(form).length) return FIX_LIMITS;
  const blank = form.conditions.filter((c) => c.on && c.kind !== "bool" && c.min === null && c.max === null);
  if (blank.length) return NEED_VALUES + blank.map((c) => c.label).join("、");
  const base = form.base.trim();
  if (!base) return NEED_SOMETHING;
  return "";
}

/** The dictionary entries not yet in the list, for the "add a condition" menu. */
export const availableToAdd = (form, dictionary) => dictionary.filter((e) => !form.conditions.some((c) => c.key === e.key));
