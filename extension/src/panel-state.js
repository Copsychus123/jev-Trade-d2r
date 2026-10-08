// Which screen the side panel shows. No DOM or chrome.* here: it is also tested under node.
//
//   choose   asks which kind of item to search (no search kind chosen yet)
//   scan     records items from a shared game window (no query)
//   welcome  no invite code yet           settings  the settings screen (replaces the main area)
//   ready    the query form               running   a query is running
//   done     finished, data was read      problem   stopped by a problem, the banner says what to do
//   stopped  the player pressed stop

export const VIEWS = ["choose", "scan", "welcome", "settings", "ready", "running", "done", "problem", "stopped"];

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

export const SECTION_NAMES = [...new Set(Object.values(SECTIONS).flat())];

/** `after` is how the last query ended ("done", "problem", "stopped") or null when the form is up. */
export function deriveView({ settingsOpen, hasInvite, running, after, mode }) {
  if (settingsOpen) return "settings";
  if (!hasInvite) return "welcome";
  if (running) return "running";
  return after ?? (mode === "scan" ? "scan" : mode ? "ready" : "choose");
}

/** The sections to show in `view`; the results only once at least one table has rows. */
export function visibleSections(view, hasRows) {
  const shown = new Set(SECTIONS[view]);
  if (!hasRows) shown.delete("results");
  return shown;
}
