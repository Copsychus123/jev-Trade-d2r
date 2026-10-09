import assert from "node:assert/strict";
import test from "node:test";

import { newTimeline, timed } from "../src/timeline.js";

const clock = (...times) => () => times.shift();

test("timed records stage, start and duration relative to the timeline origin, with details from the result", async () => {
  const session = { timeline: newTimeline(clock(100, 150, 400)) };
  const value = await timed(session, "open_tab", async () => ({ how: "complete" }), (r) => ({ how: r.how }));
  assert.deepEqual(value, { how: "complete" });
  assert.deepEqual(session.timeline.entries, [{ stage: "open_tab", start_ms: 50, ms: 250, how: "complete" }]);
});

test("a failure is recorded and rethrown unchanged; no timeline means the work just runs", async () => {
  const session = { timeline: newTimeline(clock(0, 10, 30)) };
  const boom = new TypeError("x");
  await assert.rejects(timed(session, "start_run", async () => { throw boom; }), (e) => e === boom);
  assert.deepEqual(session.timeline.entries, [{ stage: "start_run", start_ms: 10, ms: 20, error: "TypeError" }]);
  assert.equal(await timed({}, "x", async () => 7), 7);
  assert.equal(await timed(null, "x", async () => 8), 8);
});

test("a details callback that throws is caught: the query's result comes back and the entry has no details", async () => {
  const session = { timeline: newTimeline(clock(0, 10, 30)) };
  const value = await timed(
    session,
    "read_list",
    async () => ({ rows: 3 }),
    () => { throw new TypeError("details boom"); },
  );
  assert.deepEqual(value, { rows: 3 });
  assert.deepEqual(session.timeline.entries, [{ stage: "read_list", start_ms: 10, ms: 20 }]);
});
