// The correction memory: what the player chose for a name line the reader could not name by itself, kept on this
// computer and used the next time the same text is read. Pure logic over an injected storage: no DOM, no chrome.* at
// import time (chromeStorage() reaches for it only when called), node-testable.
//
// What is remembered: the normalised name-line text the OCR produced (`key`, at most MAX_KEY characters, never the whole
// OCR text and never a picture) -> the English table name the player chose for it, its kind, how many times in a row
// they chose it and when it was last used. Only names the item tables list are stored (a Chinese or an English input
// is stored as its English name), so a typo or a stranger's name never enters.
//
// The rule (docs/design.md, "Possible names and the correction memory"): the second time the same text is read, the remembered name goes to the
// top of the asked list with a hint and the read still asks; after LEARNED_SURE (2, match.js) identical choices in a row it is
// sure and the field fills by itself; a different choice for the same text replaces the name and starts again at one.
// No fuzzy learning: only a text that normalises to exactly the same key finds its entry.
import { tableEntry } from "../traderie/lookup.js";
import { normalizeKey } from "./match.js";

export const STORE_KEY = "jevCorrections";
export const BASE_STORE_KEY = "jevBaseCorrections"; // the same memory, kept apart, for the base the affix search starts from
export const STORE_VERSION = 1;
export const MAX_ENTRIES = 500; // the least recently used entry goes when a new one would make it more
export const MAX_KEY = 40; // a name line is a name; a longer piece is a glued paragraph and is never learned
const MIN_KEY = 2;
export const MAX_COUNT = 99; // identical choices in a row are counted up to here
export const SAVE_DELAY_MS = 1500; // writes are batched: a burst of choices is one write
export const LEARNED_HINT = "你上次選過這個";

/** The `chrome.storage.local` side of one store: one key. Calls into `chrome` only when used. */
export function chromeStorage(storeKey = STORE_KEY) {
  return {
    get: async () => (await chrome.storage.local.get([storeKey]))[storeKey],
    set: (value) => chrome.storage.local.set({ [storeKey]: value }),
  };
}

/**
 * The stored value as a Map in oldest-first order; anything damaged, of another version, with a key outside
 * `minKey..maxKey` or that `decode` (wire value -> entry, or null when invalid) refuses is dropped.
 */
function parse(raw, { minKey, maxKey, decode }) {
  const map = new Map();
  if (!raw || typeof raw !== "object" || raw.v !== STORE_VERSION || !Array.isArray(raw.e)) return map;
  for (const item of raw.e) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const [key, value] = item;
    if (key.length < minKey || key.length > maxKey || !value || typeof value !== "object") continue;
    const entry = decode(value);
    if (entry) map.set(key, entry);
  }
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  return map;
}

/**
 * What the name memory and the affix-number memory (value-corrections.js) have in common: an LRU Map of entries kept in
 * one stored value, a batched write that never overwrites a store that could not be read, and change listeners.
 * `encode(entry)` / `decode(wire)` turn an entry into its stored shape and back (`decode` returns null for an invalid
 * one); `afterLoad()` runs once the stored entries are in, before the listeners are told.
 */
export function createMemoryStore({ storage, minKey, maxKey, encode, decode, afterLoad, now, delay, setTimer, clearTimer }) {
  let entries = new Map(); // key -> entry, oldest first (Map order is the LRU order)
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
      await storage.set({ v: STORE_VERSION, e: [...entries].map(([key, entry]) => [key, encode(entry)]) });
    } catch {
      dirty = true; // a failed write is not an error for the player: the next change (or flush) tries again
    }
  }

  function schedule({ silent = false } = {}) {
    dirty = true;
    if (!silent) changed();
    if (timer === null) timer = setTimer(write, delay);
  }

  /** Stores `value` under `key` as the newest entry; the least recently used one goes when that makes too many. */
  function put(key, value, options) {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    schedule(options);
  }

    return {
    get entries() {
      return entries;
    },
    get loaded() {
      return loaded;
    },
    get size() {
      return entries.size;
    },
    schedule,
    /** Reads the store once; never rejects. Without a readable store the memory starts empty and is never written. */
    load() {
      loading ??= (async () => {
        try {
          entries = parse(await storage.get(), { minKey, maxKey, decode });
        } catch {
          entries = new Map();
          writable = false;
        }
        loaded = true;
        afterLoad?.();
        changed();
      })();
      return loading;
    },
    /** Every remembered entry, most recently used first. */
    list() {
      return [...entries].reverse().map(([key, value]) => ({ key, ...value }));
    },
    put,
    /** `key`'s entry is in use: it becomes the newest, stamped with the current time. */
    touch(key, value) {
      put(key, { ...value, used: now() }, { silent: true }); // only the order changed: nothing on screen differs
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

export function createCorrections({ storage, only = null, now = Date.now, delay = SAVE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let tables = null;

  /** Drops every entry whose name the (new) tables do not list any more, and re-spells the rest the table's way. */
  function prune() {
    for (const [key, value] of store.entries) {
      const entry = tableEntry(value.name, tables);
      if (!entry) store.entries.delete(key);
      else Object.assign(value, { name: entry.name, kind: entry.kind });
    }
  }

  const store = createMemoryStore({
    storage,
    minKey: MIN_KEY,
    maxKey: MAX_KEY,
    encode: (v) => ({ n: v.name, k: v.kind, c: v.count, u: v.used }),
    decode: ({ n, k, c, u }) => {
      if (typeof n !== "string" || !n || n.length > 100 || (k !== "item" && k !== "base")) return null;
      if (!Number.isInteger(c) || c < 1 || c > MAX_COUNT || !Number.isFinite(u)) return null;
      return { name: n, kind: k, count: c, used: u };
    },
    afterLoad: () => {
      if (tables) prune();
    },
    now,
    delay,
    setTimer,
    clearTimer,
  });

  return {
    load: store.load,
    /** The item tables learning is checked against; entries the tables do not list are dropped. */
    attach(next) {
      tables = next;
      if (store.loaded) {
        const before = store.size;
        prune();
        if (store.size !== before) store.schedule();
      }
    },
    get size() {
      return store.size;
    },
    /** Every remembered pair, most recently used first. */
    list: store.list,
    /**
     * The player chose `rawName` (Chinese or English) for the name line `rawKey`. Returns the stored entry, or null when
     * nothing was stored: no tables yet, a name the tables do not list, or a key that is not a short name line.
     */
    learn(rawKey, rawName) {
      const key = normalizeKey(rawKey);
      const entry = tables ? tableEntry(rawName, tables) : null;
      if (!store.loaded || !entry || (only && entry.kind !== only) || key.length < MIN_KEY || key.length > MAX_KEY) return null;
      const previous = store.entries.get(key);
      const same = previous && previous.name === entry.name;
      const value = {
        name: entry.name,
        kind: entry.kind,
        count: same ? Math.min(MAX_COUNT, previous.count + 1) : 1, // a different choice for the same text starts again
        used: now(),
      };
      store.put(key, value);
      return { key, ...value };
    },
    /** The remembered choice for the best of these name-line keys (`nameKeys`): most repeated first, then reading order. */
    lookup(keys) {
      if (!store.loaded || !tables) return null;
      let best = null;
      for (const raw of keys) {
        const key = typeof raw === "string" ? raw : raw?.key;
        const value = store.entries.get(key);
        if (value && (!best || value.count > best.value.count)) best = { key, value, at: typeof raw === "string" ? 0 : (raw?.at ?? 0) };
      }
      if (!best) return null;
      store.touch(best.key, best.value);
      return { key: best.key, ...best.value, at: best.at };
    },
    forget: store.forget,
    clear: store.clear,
    flush: store.flush,
    onChange: store.onChange,
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
