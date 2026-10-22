// Which screen the side panel shows. No DOM or chrome.* here: it is also tested under node.
//
//   scan     the home screen: records items from a shared game window (no query)
//   listing  puts one scan record on Traderie (TR交易; no query, no Jev)
//   welcome  no invite code yet           settings  the settings screen (replaces the main area)
//   ready    the query form               running   a query is running
//   done     finished, data was read      problem   stopped by a problem, the banner says what to do
//   stopped  the player pressed stop

const SECTIONS = {
  scan: ["scan"],
  listing: ["listing"],
  welcome: ["welcome"],
  settings: ["settings"],
  ready: ["form", "run", "results"],
  running: ["summary", "run", "progress", "notes", "results"],
  done: ["summary", "requery", "trust", "notes", "results"],
  problem: ["summary", "requery", "notes", "results"],
  stopped: ["summary", "requery", "stopped", "notes", "results"],
};

/** The screens, in the order `SECTIONS` declares them, so the list cannot drift from the section map. */
export const VIEWS = Object.keys(SECTIONS);

export const SECTION_NAMES = [...new Set(Object.values(SECTIONS).flat())];

/** `after` is how the last query ended ("done", "problem", "stopped") or null when the form is up. */
export function deriveView({ settingsOpen, hasInvite, running, after, mode }) {
  if (settingsOpen) return "settings";
  if (!hasInvite) return "welcome";
  if (running) return "running";
  if (after != null) return after;
  if (mode === "listing") return "listing";
  if (mode === "scan" || !mode) return "scan";
  return "ready";
}

/** The sections to show in `view`; the results only once at least one table has rows. */
export function visibleSections(view, hasRows) {
  const shown = new Set(SECTIONS[view]);
  if (!hasRows) shown.delete("results");
  return shown;
}

/**
 * The label of the affix-search button on a result screen, or "" for none. Only for a query that started from a scan
 * record (its affix lines are still in `source.record`) on a screen that shows the "start over" buttons. After a failed
 * name search it is the way out for an item the player has just hovered; after an affix search (which ran with the base
 * only) it is how the read affix lines narrow the list; a finished name search has nothing to hand over. `ended` is how
 * the run ended, `mode` the search kind that ran.
 */
export function affixHandoff(shown, source, ended, mode) {
  if (!shown.has("requery") || source?.kind !== "scan" || !source.record) return "";
  if (mode === "stats") return "加詞綴條件縮小範圍";
  return ended === "done" ? "" : "用詞綴找同類";
}
