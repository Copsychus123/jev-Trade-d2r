// Which screen the side panel shows. No DOM or chrome.* here: it is also tested under node.
//
//   choose   asks which kind of item to search (no search kind chosen yet)
//   scan     records items from a shared game window (no query)
//   welcome  no invite code yet           settings  the settings screen (replaces the main area)
//   ready    the query form               running   a query is running
//   done     finished, data was read      problem   stopped by a problem, the banner says what to do
//   stopped  the player pressed stop

const SECTIONS = {
  choose: ["choose", "results"],
  scan: ["scan"],
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
  if (mode === "scan") return "scan";
  if (mode) return "ready";
  return "choose";
}

/** The sections to show in `view`; the results only once at least one table has rows. */
export function visibleSections(view, hasRows) {
  const shown = new Set(SECTIONS[view]);
  if (!hasRows) shown.delete("results");
  return shown;
}

/**
 * Whether to offer the affix search for the item a query came from: only when that query started from a scan record
 * (its affixes are still in `source.record`), the screen shows the "start over" affordances, and the run did not finish
 * with its answer already (`ended` is how it ended). It is the way out of a failed name search for an item the player
 * has just hovered; a finished search has nothing to hand over.
 */
export function affixHandoff(shown, source, ended) {
  return shown.has("requery") && ended !== "done" && source?.kind === "scan" && Boolean(source.record);
}
