// Per-stage timing of one query, for measurement only: recording never changes what the query does.
// A session without a timeline (tests, older callers) just runs the work.

/** A fresh timeline whose clock starts now (the start click). */
export const newTimeline = (now = () => performance.now()) => ({ origin: now(), now, entries: [] });

/** What Tab.open measured (navigate, settle, visibility), for the timeline entry of an open. */
export const openDetails = (tab) => tab?.openTiming ?? {};

/** Adds one entry ({ stage, start_ms, ms, ...extra }) to the session's timeline, if it has one. */
function mark(session, stage, startedAt, extra = {}) {
  const timeline = session?.timeline;
  if (!timeline) return;
  const end = timeline.now();
  timeline.entries.push({
    stage,
    start_ms: Math.round(startedAt - timeline.origin),
    ms: Math.round(end - startedAt),
    ...extra,
  });
}

/**
 * Runs `fn` and records how long it took. `extra` is an object, or a function of the result giving one. A failure is
 * recorded too (with `error`) and then thrown unchanged.
 */
export async function timed(session, stage, fn, extra = {}) {
  const timeline = session?.timeline;
  if (!timeline) return fn();
  const startedAt = timeline.now();
  let result;
  try {
    result = await fn();
  } catch (error) {
    mark(session, stage, startedAt, { error: error?.name || "Error" });
    throw error;
  }
  let details = {};
  try {
    details = (typeof extra === "function" ? extra(result) : extra) ?? {};
  } catch {
    details = {}; // measurement must never break the query
  }
  mark(session, stage, startedAt, details);
  return result;
}
