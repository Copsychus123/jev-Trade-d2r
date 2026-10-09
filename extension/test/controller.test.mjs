import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  STATS_COLUMNS,
  TRADING_COLUMNS,
  advance,
  matchesItem,
  newMarket,
  readStatsView,
  readView,
  statsCells,
  step,
  verifyStats,
  verifyViews,
} from "../src/traderie/controller.js";
import { AbortedError, StalePage, TimeoutError } from "../src/errors.js";
import { parseTradingTxt } from "../src/traderie/parsing.js";
import { TRADERIE_D2R_URL } from "../src/traderie/site.js";

const homeStats = readFileSync(new URL("../../tests/fixtures/home_stats.txt", import.meta.url), "utf8");

const RECENT_URL = `${TRADERIE_D2R_URL}/product/harlequin-crest/recent`;

class FakeTab {
  constructor(url, text, { more = false } = {}) {
    this.page = { url, title: "Harlequin Crest", text, settled: true };
    this.more = more;
  }

  async readSettledPage() {
    return this.page;
  }

  async evaluate(expression) {
    return expression.includes("load more") ? this.more : false;
  }
}

const lines = (...items) => items.join("\n");

test("recent view with a trade lacking its time line is FAILED as inconsistent", async () => {
  const text = lines(
    "Harlequin Crest",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune",
  );
  const result = await readView(new FakeTab(RECENT_URL, text), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /不一致/);
});

test("recent view keeps every entry when page and table agree", async () => {
  const text = lines(
    "Harlequin Crest",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Um Rune", "39 分鐘前",
    "They Give", "1 X Harlequin Crest", "I Give", "1 X Mal Rune", "44 分鐘前",
  );
  const result = await readView(new FakeTab(RECENT_URL, text, { more: true }), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "PASSED");
  assert.deepEqual(result.rows.map((r) => r.price), ["1 X Um Rune", "1 X Mal Rune"]);
  assert.equal(result.has_more, true);
});

test("trading read on a recent URL fails with 不是掛單頁", async () => {
  const result = await readView(new FakeTab(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "trading");
  assert.equal(result.status, "FAILED");
  assert.match(result.reason, /不是掛單頁/);
});

test("a good trading and recent pair verifies", () => {
  const view = (url) => ({ status: "PASSED", reason: null, url, title: "Harlequin Crest", text: "Harlequin Crest" });
  const market = newMarket();
  market.trading = view(`${TRADERIE_D2R_URL}/product/a`);
  market.recent_trades = view(`${TRADERIE_D2R_URL}/product/a/recent`);
  const result = verifyViews("Harlequin Crest", market);
  assert.equal(result.passed, true);
  assert.equal(result.product_url, `${TRADERIE_D2R_URL}/product/a`);
});

const TRADING_URL = `${TRADERIE_D2R_URL}/product/harlequin-crest`;

test("an empty market is PASSED with no rows only when the page itself says so", async () => {
  const empty = await readView(
    new FakeTab(TRADING_URL, lines("Harlequin Crest", "There are no listings")), "Harlequin Crest", "trading");
  assert.deepEqual([empty.status, empty.rows.length], ["PASSED", 0]);
  const silent = await readView(new FakeTab(TRADING_URL, "Harlequin Crest"), "Harlequin Crest", "trading");
  assert.equal(silent.status, "FAILED");

  const none = await readView(
    new FakeTab(RECENT_URL, lines("Harlequin Crest", "There are no offers")), "Harlequin Crest", "recent_trades");
  assert.deepEqual([none.status, none.rows.length], ["PASSED", 0]);
  const unknown = await readView(new FakeTab(RECENT_URL, "Harlequin Crest"), "Harlequin Crest", "recent_trades");
  assert.equal(unknown.status, "FAILED");
});

test("a sign-in wall on the trades page is still BLOCKED even when an empty message is also present", async () => {
  const text = lines("Harlequin Crest", "Please sign in to view offers", "There are no offers");
  const result = await readView(new FakeTab(RECENT_URL, text), "Harlequin Crest", "recent_trades");
  assert.equal(result.status, "BLOCKED");
});

test("a short item name does not match inside other words", () => {
  assert.equal(matchesItem("Um", "Ber Rune number of offers"), false);
  assert.equal(matchesItem("Ist", "Soul Drainer - Traderie listing history"), false);
  assert.equal(matchesItem("Ist", "Ist Rune - Traderie"), true);
  assert.equal(matchesItem("Harlequin Crest", "Harlequin Crest (Shako) - Traderie"), true);
});

// The landing check in finder.js already used this name rule (lookup.js normalizeName); matchesItem must agree, or a
// table hit whose title differs only by an accent or an apostrophe is thrown away and the run falls back to search.
test("a table hit matches a title that differs only by an accent, an apostrophe or a leading the", () => {
  assert.equal(matchesItem("Tal Rasha's Adjudication", "Tal Rashas Adjudication - Diablo II: Resurrected"), true);
  assert.equal(matchesItem("Andariel's Visage", "Andariels Visage - Diablo II: Resurrected"), true);
  assert.equal(matchesItem("Nokozan Relic", "Nokozán Rélíc - Diablo II: Resurrected"), true);
  assert.equal(matchesItem("Stone of Jordan", "The Stone of Jordan - Diablo II: Resurrected"), true);
});

test("a title that is genuinely a different item still does not match", () => {
  assert.equal(matchesItem("Harlequin Crest", "Shako - Diablo II: Resurrected"), false);
  assert.equal(matchesItem("Tal Rasha's Adjudication", "Tal Rasha's Guardianship - Diablo II: Resurrected"), false);
});

const SENT = `${TRADERIE_D2R_URL}?prop_520Min=10&prop_Rarity=rare`;
const FAST = { waitMs: 0 }; // do not really wait between the repeated reads

class HomeTab extends FakeTab {
  constructor(url, text, options) {
    super(url, text, options);
    this.page.title = "Diablo II: Resurrected (D2R) Items Database and Value List | Traderie";
  }
}

test("stats view: the saved home page gives one row per listing and says the filters stayed in the address", async () => {
  const result = await readStatsView(new HomeTab(SENT, homeStats, { more: true }), SENT);
  const markers = homeStats.split("\n").filter((l) => ["Trading For", "Make an Offer"].includes(l.trim())).length;
  assert.equal(result.status, "PASSED");
  assert.equal(result.rows.length, markers);
  assert.equal(result.url_kept, true);
  assert.equal(result.has_more, true);
  assert.ok(result.rows.every((row) => row.item_name && row.seller));
});

test("stats view: a page that dropped a filter from its address is read but not trusted as filtered", async () => {
  const result = await readStatsView(new HomeTab(`${TRADERIE_D2R_URL}?prop_520Min=10`, homeStats), SENT);
  assert.equal(result.status, "PASSED");
  assert.equal(result.url_kept, false);
});

test("stats view: anywhere but the home page is the wrong view", async () => {
  const result = await readStatsView(new FakeTab(`${TRADERIE_D2R_URL}/product/ring`, homeStats), SENT);
  assert.deepEqual([result.status, result.reason_code], ["FAILED", "wrong_view"]);
});

test("stats view: nothing matching is an answer only when the site says so; placeholders alone are a list that did not load", async () => {
  const sidebar = ["Marketplace", "Stats", "Active Filters", "+X% Faster Cast Rate", "Apply FiltersClear Filters"];
  const said = await readStatsView(new HomeTab(SENT, lines(...sidebar, "There are no listings")), SENT);
  assert.deepEqual([said.status, said.reason_code, said.rows.length], ["PASSED", "empty", 0]);
  const skeleton = await readStatsView(new HomeTab(SENT, lines(...sidebar, "\u200c", "\u200c", "\u200c")), SENT, FAST);
  assert.deepEqual([skeleton.status, skeleton.reason_code], ["FAILED", "no_rows"]);
  const bare = await readStatsView(new HomeTab(SENT, "Marketplace"), SENT, FAST);
  assert.deepEqual([bare.status, bare.reason_code], ["FAILED", "no_rows"]);
});

test("stats view: a challenge page is BLOCKED, and fewer rows than listing markers is a mismatch", async () => {
  const blocked = await readStatsView(new FakeTab(SENT, "Please complete the CAPTCHA"), SENT);
  assert.equal(blocked.status, "BLOCKED");
  const short = await readStatsView(new HomeTab(SENT, `${homeStats}\nTrading For`), SENT, FAST);
  assert.deepEqual([short.status, short.reason_code], ["FAILED", "row_mismatch"]);
});

test("stats rows put the item first, then the same cells as the trading table", () => {
  assert.deepEqual(STATS_COLUMNS, ["物品", ...TRADING_COLUMNS]);
  const row = { item_name: "Ring", seller: "a", ask: "1 X Um Rune", platform: "PC", mode: "Softcore" };
  const cells = statsCells(row);
  assert.equal(cells.length, STATS_COLUMNS.length);
  assert.deepEqual([cells[0], cells[1], cells[2]], ["Ring", "a", "1 X Um Rune"]);
});

const statsMarket = (overrides = {}, lookup = {}) => {
  const market = newMarket();
  market.mode = "stats";
  market.lookup = { mode: "stats", conditions: [{ type: "number", name: "+{{value}}% Faster Cast Rate" }], ...lookup };
  market.trading = {
    status: "PASSED", reason: null, url: SENT, url_kept: true, text: "Active Filters\n+X% Faster Cast Rate\n",
    rows: [{ affixes: ["+8% Faster Cast Rate"] }], ...overrides,
  };
  return market;
};

test("stats verification passes when the page is home, kept the filters, shows them and was read", () => {
  const result = verifyStats(statsMarket());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failed_checks, []);
});

test("stats verification names each way it can fail", () => {
  assert.deepEqual(verifyStats(statsMarket({ url_kept: false })).failed_checks, ["filters_in_url"]);
  assert.deepEqual(verifyStats(statsMarket({ text: "no filter here" })).failed_checks, ["filters_shown"]);
  assert.deepEqual(verifyStats(statsMarket({ url: `${TRADERIE_D2R_URL}/product/ring` })).failed_checks, ["home_page"]);
  const blocked = verifyStats(statsMarket({ status: "BLOCKED", reason: "網站阻擋" }));
  assert.deepEqual(blocked.failed_checks, ["trading_rows_ok", "not_blocked"]);
  assert.equal(blocked.view_reasons.trading, "網站阻擋");
  const unfiltered = verifyStats(statsMarket({ rows: [{ affixes: ["+8% Faster Cast Rate"] }, { affixes: ["+18 To Mana"] }] }));
  assert.deepEqual(unfiltered.failed_checks, ["rows_match_filters"]);
  assert.match(unfiltered.view_reasons.trading, /1 筆掛單沒有你設定的條件.*沒有套用篩選/u);
  // a quality or type filter alone has no number to look for on the page
  assert.equal(verifyStats(statsMarket({ text: "x" }, { conditions: [] })).passed, true);
});


test("stats view: cards that are drawn a moment after the text settled are read on a later try", async () => {
  const tab = new HomeTab(SENT, "Marketplace\nApply FiltersClear Filters\n\u200c\n\u200c");
  let reads = 0;
  const read = tab.readSettledPage.bind(tab);
  tab.readSettledPage = async () => {
    reads += 1;
    if (reads === 3) tab.page.text = homeStats;
    return read();
  };
  const result = await readStatsView(tab, SENT, FAST);
  assert.equal(result.status, "PASSED");
  assert.equal(reads, 3);
  assert.ok(result.rows.length > 0);
});

test("stats view: cards without the filter labels yet are read again until the sidebar shows them", async () => {
  const label = "+X% Faster Cast Rate";
  const withoutLabel = homeStats.replaceAll(label, "");
  const tab = new HomeTab(SENT, withoutLabel);
  let reads = 0;
  const read = tab.readSettledPage.bind(tab);
  tab.readSettledPage = async () => {
    reads += 1;
    tab.page.text = reads >= 3 ? homeStats : withoutLabel;
    return read();
  };
  const result = await readStatsView(tab, SENT, { ...FAST, expectText: [label] });
  assert.equal(reads, 3);
  assert.ok(result.text.includes(label));
  // a label that never comes: the last read stands (the checks then report it), after exactly `attempts` reads
  let never = 0;
  const stuck = new HomeTab(SENT, withoutLabel);
  const readStuck = stuck.readSettledPage.bind(stuck);
  stuck.readSettledPage = async () => {
    never += 1;
    return readStuck();
  };
  const last = await readStatsView(stuck, SENT, { ...FAST, attempts: 4, expectText: [label] });
  assert.equal(never, 4);
  assert.equal(last.status, "PASSED");
});

test("stats view: rows read from a page with no count marker are no_anchor, not a passing read", async () => {
  // every listing card is present, but the page shows no "Trading For"/"Make an Offer" line to check them against
  const noMarkers = homeStats
    .split(/\r?\n/u)
    .filter((line) => !["Trading For", "Make an Offer"].includes(line.trim()))
    .join("\n");
  const result = await readStatsView(new HomeTab(SENT, noMarkers), SENT, { ...FAST, attempts: 1 });
  assert.ok(parseTradingTxt(noMarkers, { itemName: null }).length > 0); // the page does yield rows
  assert.deepEqual([result.status, result.reason_code], ["FAILED", "no_anchor"]);
  assert.match(result.reason, /筆數標記/u);
});

class ScrollThrowingTab extends FakeTab {
  async evaluate(expression) {
    if (expression.includes("scrollTo")) throw new StalePage("page navigated during evaluation");
    return super.evaluate(expression);
  }
}

const handoffAgent = (tab) => {
  const commands = [];
  return {
    state: { awaiting_handoff: true },
    tab,
    commands,
    command: async (name) => {
      commands.push(name);
    },
  };
};

test("a cosmetic scroll that raises StalePage does not lose the Phase-B handoff", async () => {
  const tab = new ScrollThrowingTab(TRADING_URL, lines("Harlequin Crest", "There are no listings"));
  const agent = handoffAgent(tab);
  await advance(agent, "Harlequin Crest", newMarket());
  assert.ok(agent.commands.includes("handoff"));
});

test("a scroll failure that is not StalePage still aborts the advance", async () => {
  const tab = new FakeTab(TRADING_URL, "Harlequin Crest");
  tab.evaluate = async (expression) => {
    if (expression.includes("scrollTo")) throw new Error("boom");
    return false;
  };
  const agent = handoffAgent(tab);
  await assert.rejects(() => advance(agent, "Harlequin Crest", newMarket()), /boom/u);
  assert.equal(agent.commands.includes("handoff"), false);
});

test("a blocked run gets its verification written, but an already-verified market is left alone", async () => {
  const blocked = handoffAgent(new FakeTab(TRADING_URL, "Please complete the CAPTCHA"));
  blocked.state = { status: "blocked", awaiting_handoff: false };
  const market = newMarket();
  market.trading = { status: "BLOCKED", reason: "網站阻擋：ACME challenge" };
  await advance(blocked, "Harlequin Crest", market);
  assert.ok(market.verification);
  assert.equal(market.verification.checks.not_blocked, false);
  assert.equal(market.verification.view_reasons.trading, "網站阻擋：ACME challenge");

  const seen = { passed: true };
  const again = handoffAgent(new FakeTab(TRADING_URL, "anything"));
  again.state = { status: "blocked", awaiting_handoff: false };
  const kept = newMarket();
  kept.verification = seen;
  await advance(again, "Harlequin Crest", kept);
  assert.equal(kept.verification, seen);
});

test("a page that never settles is an unsettled FAILED read; any other read error is rethrown", async () => {
  const timedOut = new FakeTab(TRADING_URL, "Harlequin Crest");
  timedOut.readSettledPage = async () => {
    throw new TimeoutError("never settled");
  };
  const result = await readView(timedOut, "Harlequin Crest", "trading");
  assert.deepEqual([result.status, result.reason_code, result.settled], ["FAILED", "unsettled", false]);
  assert.match(result.reason, /頁面一直沒有載入完成/u);

  const stale = new FakeTab(TRADING_URL, "Harlequin Crest");
  stale.readSettledPage = async () => {
    throw new StalePage();
  };
  const staleResult = await readView(stale, "Harlequin Crest", "trading");
  assert.deepEqual([staleResult.status, staleResult.reason_code], ["FAILED", "unsettled"]);

  const broken = new FakeTab(TRADING_URL, "Harlequin Crest");
  broken.readSettledPage = async () => {
    throw new Error("cdp socket died");
  };
  await assert.rejects(() => readView(broken, "Harlequin Crest", "trading"), /cdp socket died/u);
});

test("a product page whose title is a different item is FAILED as wrong_item", async () => {
  const result = await readView(new FakeTab(TRADING_URL, "Stone of Jordan"), "Stone of Jordan", "trading");
  assert.deepEqual([result.status, result.reason_code], ["FAILED", "wrong_item"]);
  assert.match(result.reason, /不是 Stone of Jordan 的商品頁/u);
});

test("a tick that throws runs the controller work once more and reports the tick's own error", async () => {
  const commands = [];
  const agent = {
    state: { awaiting_handoff: true },
    tab: new FakeTab(TRADING_URL, lines("Harlequin Crest", "There are no listings")),
    command: async (name) => {
      commands.push(name);
      if (name === "tick") throw new Error("tick-boom");
    },
  };
  await assert.rejects(() => step(agent, "Harlequin Crest", newMarket()), /tick-boom/u);
  assert.deepEqual(commands, ["handoff", "tick", "handoff"]);
});

test("an AbortedError from the tick does not run the controller work again", async () => {
  const commands = [];
  const agent = {
    state: { awaiting_handoff: true },
    tab: new FakeTab(TRADING_URL, lines("Harlequin Crest", "There are no listings")),
    command: async (name) => {
      commands.push(name);
      if (name === "tick") throw new AbortedError();
    },
  };
  await assert.rejects(() => step(agent, "Harlequin Crest", newMarket()), /查詢已停止/u);
  assert.deepEqual(commands, ["handoff", "tick"]);
});
