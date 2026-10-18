// The correction memory: what the player chose for a name line the reader could not name by itself, kept on this
// computer and used the next time the same text is read. Pure logic over an injected storage: no DOM, no chrome.* at
// import time (chromeStorage() reaches for it only when called), node-testable.
//
// What is remembered: the normalised name-line text the OCR produced (`key`, at most MAX_KEY characters, never the whole
// OCR text and never a picture) -> the English table name the player chose for it, its kind, how many times in a row
// they chose it and when it was last used. Only names the item tables list are stored (a Chinese or an English input
// is stored as its English name), so a typo or a stranger's name never enters.
//
// The rule (docs/design.md, "Correction memory"): the second time the same text is read, the remembered name goes to the
// top of the asked list with a hint and the read still asks; after LEARNED_SURE (2, match.js) identical choices in a row it is
// sure and the field fills by itself; a different choice for the same text replaces the name and starts again at one.
// No fuzzy learning: only a text that normalises to exactly the same key finds its entry.
import { tableEntry } from "../traderie/lookup.js";
import { normalizeKey } from "./match.js";

export const STORE_KEY = "jevCorrections";
export const STORE_VERSION = 1;
export const MAX_ENTRIES = 500; // the least recently used entry goes when a new one would make it more
export const MAX_KEY = 40; // a name line is a name; a longer piece is a glued paragraph and is never learned
const MIN_KEY = 2;
const MAX_COUNT = 99;
export const SAVE_DELAY_MS = 1500; // writes are batched: a burst of choices is one write
export const LEARNED_HINT = "你上次選過這個";

/** The `chrome.storage.local` side of the store: one key. Calls into `chrome` only when used. */
export function chromeStorage() {
  return {
    get: async () => (await chrome.storage.local.get([STORE_KEY]))[STORE_KEY],
    set: (value) => chrome.storage.local.set({ [STORE_KEY]: value }),
  };
}

/** The stored value as a Map in oldest-first order; anything damaged, of another version or too long is dropped. */
function parse(raw) {
  const map = new Map();
  if (!raw || typeof raw !== "object" || raw.v !== STORE_VERSION || !Array.isArray(raw.e)) return map;
  for (const item of raw.e) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const [key, value] = item;
    if (key.length < MIN_KEY || key.length > MAX_KEY || !value || typeof value !== "object") continue;
    const { n, k, c, u } = value;
    if (typeof n !== "string" || !n || n.length > 100 || (k !== "item" && k !== "base")) continue;
    if (!Number.isInteger(c) || c < 1 || c > MAX_COUNT || !Number.isFinite(u)) continue;
    map.set(key, { name: n, kind: k, count: c, used: u });
  }
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  return map;
}

export function createCorrections({ storage, now = Date.now, delay = SAVE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let entries = new Map(); // key -> { name, kind, count, used }, oldest first (Map order is the LRU order)
  let tables = null;
  let loaded = false;
  let writable = true; // false after a read of the store failed: never overwrite what could not be read
  let dirty = false;
  let timer = null;
  let loading = null;
  const listeners = new Set();

  const changed = () => {
    for (const listener of listeners) listener();
  };

  async function write() {
    timer = null;
    if (!dirty || !writable) return;
    dirty = false;
    try {
      await storage.set({ v: STORE_VERSION, e: [...entries].map(([key, v]) => [key, { n: v.name, k: v.kind, c: v.count, u: v.used }]) });
    } catch {
      dirty = true; // a failed write is not an error for the player: the next change (or flush) tries again
    }
  }

  function schedule({ silent = false } = {}) {
    dirty = true;
    if (!silent) changed();
    if (timer === null) timer = setTimer(write, delay);
  }

  /** Drops every entry whose name the (new) tables do not list any more, and re-spells the rest the table's way. */
  function prune() {
    for (const [key, value] of entries) {
      const entry = tableEntry(value.name, tables);
      if (!entry) entries.delete(key);
      else Object.assign(value, { name: entry.name, kind: entry.kind });
    }
  }

  /** Reads the store once; never rejects. Without a readable store the memory starts empty and is never written. */
  function load() {
    loading ??= (async () => {
      try {
        entries = parse(await storage.get());
      } catch {
        entries = new Map();
        writable = false;
      }
      loaded = true;
      if (tables) prune();
      changed();
    })();
    return loading;
  }

  return {
    load,
    /** The item tables learning is checked against; entries the tables do not list are dropped. */
    attach(next) {
      tables = next;
      if (loaded) {
        const before = entries.size;
        prune();
        if (entries.size !== before) schedule();
      }
    },
    get size() {
      return entries.size;
    },
    /** Every remembered pair, most recently used first. */
    list() {
      return [...entries].reverse().map(([key, value]) => ({ key, ...value }));
    },
    /**
     * The player chose `rawName` (Chinese or English) for the name line `rawKey`. Returns the stored entry, or null when
     * nothing was stored: no tables yet, a name the tables do not list, or a key that is not a short name line.
     */
    learn(rawKey, rawName) {
      const key = normalizeKey(rawKey);
      const entry = tables ? tableEntry(rawName, tables) : null;
      if (!loaded || !entry || key.length < MIN_KEY || key.length > MAX_KEY) return null;
      const previous = entries.get(key);
      const same = previous && previous.name === entry.name;
      const value = {
        name: entry.name,
        kind: entry.kind,
        count: same ? Math.min(MAX_COUNT, previous.count + 1) : 1, // a different choice for the same text starts again
        used: now(),
      };
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      schedule();
      return { key, ...value };
    },
    /** The remembered choice for the best of these name-line keys (`nameKeys`): most repeated first, then reading order. */
    lookup(keys) {
      if (!loaded || !tables) return null;
      let best = null;
      for (const raw of keys) {
        const key = typeof raw === "string" ? raw : raw?.key;
        const value = entries.get(key);
        if (value && (!best || value.count > best.value.count)) best = { key, value, at: typeof raw === "string" ? 0 : (raw?.at ?? 0) };
      }
      if (!best) return null;
      entries.delete(best.key); // it is in use: the newest end of the LRU order
      entries.set(best.key, { ...best.value, used: now() });
      schedule({ silent: true }); // only the order changed: nothing on screen differs
      return { key: best.key, ...best.value, at: best.at };
    },
    forget(key) {
      if (!entries.delete(key)) return false;
      schedule();
      return true;
    },
    clear() {
      if (!entries.size) return false;
      entries = new Map();
      schedule();
      return true;
    },
    /** Writes now what is waiting for the timer (the panel calls it when it is closed). */
    async flush() {
      if (timer !== null) clearTimer(timer);
      await write();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The candidates of a read with the player's remembered choice for its text applied: `hit` is `lookup()`'s answer (or
 * null). The remembered name goes first, carrying how often it was chosen (`learned`); when it is not the matcher's own
 * first name it is also marked `promoted`, which decideCandidates reads (one choice asks again, LEARNED_SURE choices
 * make it sure). A name the matcher did not list at all is added as a candidate of its own.
 */
export function applyLearned(candidates, hit) {
  if (!hit) return candidates;
  const at = candidates.findIndex((c) => c.name === hit.name);
  if (at === 0) return [{ ...candidates[0], learned: hit.count }, ...candidates.slice(1)];
  const base =
    at > 0
      ? candidates[at]
      : { kind: hit.kind, name: hit.name, distance: 0, score: -1, matched: hit.key, size: hit.name.length, at: hit.at ?? 0 };
  const rest = candidates.filter((_, i) => i !== at);
  return [{ ...base, learned: hit.count, promoted: true }, ...rest];
}
