// The affix-number memory: the number the player typed over one the reader filled in for an affix line, kept on this
// computer and used the next time the same line is read. Pure logic over an injected storage (the same shape as
// corrections.js, whose createMemoryStore it shares, so the settings screen treats the memories alike): no DOM, no
// chrome.* at import time.
//
// What is remembered: the normalised text of the affix line (`key`, at most MAX_LINE characters, never the whole OCR
// text and never a picture) + the affix dictionary key it was read as (`affix`) -> the corrected `min`, how many times
// in a row the player corrected this line to this number, and when it was last used. A number is the player's own
// entry (unlike a click on a list), so one correction is enough: the next read of the same line fills it. No fuzzy
// learning: only a line that normalises to exactly the same key, read as the same affix, finds its entry.
import { MAX_COUNT, MAX_ENTRIES, SAVE_DELAY_MS, STORE_VERSION, createMemoryStore } from "./corrections.js";
import { normalizeKey } from "./match.js";

export { MAX_ENTRIES, SAVE_DELAY_MS, STORE_VERSION };
export const VALUE_STORE_KEY = "jevValueCorrections";
export const MAX_LINE = 60; // an affix line is longer than a name; a longer piece is a glued paragraph and is never learned
const MIN_LINE = 2;
const MAX_VALUE = 999999;

const validValue = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_VALUE;

export function createValueCorrections({ storage, now = Date.now, delay = SAVE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // line key -> { affix, min, count, used }
  const store = createMemoryStore({
    storage,
    minKey: MIN_LINE,
    maxKey: MAX_LINE,
    encode: (v) => ({ k: v.affix, m: v.min, c: v.count, u: v.used }),
    decode: ({ k, m, c, u }) => {
      if (typeof k !== "string" || !k || k.length > 60 || !validValue(m)) return null;
      if (!Number.isInteger(c) || c < 1 || c > MAX_COUNT || !Number.isFinite(u)) return null;
      return { affix: k, min: m, count: c, used: u };
    },
    now,
    delay,
    setTimer,
    clearTimer,
  });

  return {
    load: store.load,
    get size() {
      return store.size;
    },
    /** Every remembered correction, most recently used first. */
    list: store.list,
    /**
     * The player changed the number of the affix line `line` (read as the dictionary key `affixKey`) to `min`. Returns the
     * stored entry, or null: the store could not be read, the line is not a short line, or `min` is not a whole number
     * from 0 to 999999.
     */
    learn(line, affixKey, min) {
      const key = normalizeKey(line ?? "");
      if (!store.loaded || !affixKey || typeof affixKey !== "string" || !validValue(min)) return null;
      if (key.length < MIN_LINE || key.length > MAX_LINE) return null;
      const previous = store.entries.get(key);
      const same = previous && previous.affix === affixKey && previous.min === min;
      const value = { affix: affixKey, min, count: same ? Math.min(MAX_COUNT, previous.count + 1) : 1, used: now() };
      store.put(key, value);
      return { key, ...value };
    },
    /** The remembered number for this line, only when it was read as the same affix; the hit becomes the newest. */
    lookup(line, affixKey) {
      if (!store.loaded) return null;
      const key = normalizeKey(line ?? "");
      const value = store.entries.get(key);
      if (!value || value.affix !== affixKey) return null;
      store.touch(key, value);
      return { key, ...value };
    },
    forget: store.forget,
    clear: store.clear,
    flush: store.flush,
    onChange: store.onChange,
  };
}

/**
 * The conditions of a read with the player's remembered numbers applied: every non-bool condition whose line the
 * memory knows (read as the same affix) gets the remembered `min`, `confident: true` and `learned: true`; the rest pass
 * through unchanged. A null memory changes nothing.
 */
export function applyValues(conditions, memory) {
  if (!memory) return conditions;
  return conditions.map((c) => {
    if (c.kind === "bool" || !c.line) return c;
    const hit = memory.lookup(c.line, c.key);
    return hit ? { ...c, min: hit.min, confident: true, learned: true } : c;
  });
}
