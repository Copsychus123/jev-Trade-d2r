// DOM drawing helpers for the side panel. Page text is untrusted: every value is written with textContent, never
// innerHTML. The data (cells, rows, steps) is worked out elsewhere; nothing here decides what is true.
import { $, element } from "./dom.js";
import { LAYER_LABELS, progressSteps, verificationSummary } from "./labels.js";
import { listingRow, recentRow, statsRow } from "./rows.js";
import {
  RECENT_COLUMNS,
  STATS_COLUMNS,
  TRADING_COLUMNS,
  recentCells,
  statsCells,
  tradingCells,
} from "./traderie/controller.js";

export const clock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";

function drawTwoLine(list, first, second, details) {
  const li = element("li");
  const top = element("div", { className: "line1" });
  top.append(element("strong", { textContent: first }), element("span", { className: "side", textContent: second }));
  li.append(top);
  if (details.length) li.append(element("div", { className: "line2", textContent: details.join(" · ") }));
  list.append(li);
}

/** Two-line rows of the stats search: the item and its price next to the seller, then the small grey details. */
export function drawStatsListings(list, rows) {
  for (const row of rows) {
    const { title, price, seller, details } = statsRow(STATS_COLUMNS, statsCells(row));
    drawTwoLine(list, `${title} ・ ${price}`, seller, details);
  }
}

/** Two-line rows: price and seller, then the small grey details. */
export function drawListings(list, rows) {
  for (const row of rows) {
    // The same cells as CSV and copy, so the three cannot drift.
    const { price, seller, details } = listingRow(TRADING_COLUMNS, tradingCells(row));
    drawTwoLine(list, price, seller, details);
  }
}

/** Two-line rows: the item and its price, then time and environment. */
export function drawRecent(list, rows) {
  for (const row of rows) {
    const { title, price, details } = recentRow(RECENT_COLUMNS, recentCells(row));
    drawTwoLine(list, title, price, details);
  }
}

/** The trust line (checked: how it was found and when) or the expandable list of what did not pass. */
export function drawTrust(market) {
  const summary = verificationSummary(market.verification);
  const ok = summary.kind === "ok";
  const warn = summary.kind === "warn";
  const trust = $("trust");
  trust.dataset.kind = summary.kind;
  trust.dataset.layer = market.lookup?.layer ?? ""; // how the product was found (the end-to-end checks read it)
  const line = $("trust-line");
  line.hidden = !ok;
  $("trust-more").hidden = !warn;
  line.textContent = ok
    ? [`✔ ${summary.headline}`, LAYER_LABELS[market.lookup?.layer], clock(market.verification.observed_at)]
        .filter(Boolean)
        .join(" · ")
    : "";
  $("trust-head").textContent = warn ? `⚠ ${summary.headline} ›` : "";
  $("trust-reasons").replaceChildren(...summary.reasons.map((reason) => element("li", { textContent: reason })));
}

/** Each step's mark and its screen-reader name in one table: a new state cannot reach one of them and not the other. */
const STEP_STATES = {
  done: { mark: "✔", name: "完成" },
  active: { mark: "●", name: "進行中" },
  pending: { mark: "○", name: "還沒開始" },
  failed: { mark: "✖", name: "失敗" },
};

/** The four steps of a query, and the current status line under them. */
export function drawProgress({ market, phase, running, statusText }) {
  $("steps").replaceChildren(
    ...progressSteps({ market, phase, running }).map((step) => {
      const state = STEP_STATES[step.state];
      const mark = element("span", { className: "mark", textContent: state.mark });
      mark.setAttribute("aria-hidden", "true");
      const li = element("li");
      li.dataset.state = step.state;
      li.append(mark, element("span", { textContent: step.label }), element("span", { className: "sr", textContent: `（${state.name}）` }));
      if (step.detail) li.append(element("small", { textContent: step.detail }));
      return li;
    }),
  );
  $("progress-status").textContent = statusText;
}
