// Port of src/jev_ultrafast/traderie/site.py (URL scope, load-more rules, challenge guard).
export const TRADERIE_D2R_URL = "https://www.traderie.com/diablo2resurrected";

// One of these ends the "what they want" part of a listing. The card split in parsing.js and the controller's
// line-counting cross-check both use this list, so it lives with the site vocabulary (as it does in site.py).
export const TRADING_MARKERS = ["Trading For", "Make an Offer"];
// The challenge guard compares these markers against already lower-cased page text; lower them once instead.
const TRADING_MARKERS_LOWER = TRADING_MARKERS.map((marker) => marker.toLowerCase());
const TRADERIE_HOSTS = new Set(["traderie.com", "www.traderie.com"]);
export const MAX_LOAD_MORE = 5;
const LOAD_MORE_LABEL = "Load More";
const CHALLENGE_FRAMES =
  'iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],' +
  'iframe[src*="google.com/recaptcha/api2/anchor"],iframe[src*="google.com/recaptcha/api2/bframe"]';

const PRODUCT_PATH =
  /^\/diablo2resurrected\/product\/(?<slug>[^/?#]+)(?:\/(?<section>buying|recent|wiki|recipes))?\/?$/u;
const SEARCH_PATH = /^\/diablo2resurrected\/(?:search|products)\/?$/u;
const ROOT_PATH = "/diablo2resurrected";
const LOGIN_REASON = "需要登入：請先在這個 Chrome 登入 Traderie 再重新開始";
const CHALLENGE_REASON = "防護頁/驗證碼";

// Same netloc/path split as Python's urllib.parse.urlparse.
const URL_PARTS = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)/u;

function urlparse(url) {
  const m = URL_PARTS.exec(url || "");
  return { netloc: m[1] ?? "", path: m[2] };
}

export function phaseFinishRule(loadMore) {
  return loadMore ? [LOAD_MORE_LABEL, loadMore] : null;
}

const isTraderie = (host) => TRADERIE_HOSTS.has(host.toLowerCase());

export function isTraderieHost(url) {
  return isTraderie(urlparse(url).netloc);
}

function productMatch(url) {
  const { netloc, path } = urlparse(url);
  return isTraderie(netloc) ? PRODUCT_PATH.exec(path) : null;
}

/** The product page address of a slug: the one place the product URL template is written. */
export const productUrl = (slug) => `${TRADERIE_D2R_URL}/product/${slug}`;

export function productRootUrl(url) {
  const match = productMatch(url);
  return match ? productUrl(match.groups.slug) : null;
}

// null for the product's own (Trading) page, else "recent" | "buying" | "wiki" | "recipes"; also null when the URL is
// not a product page at all, so check productRootUrl first.
export function productSection(url) {
  const match = productMatch(url);
  return match ? (match.groups.section ?? null) : null;
}

export function traderieScopeReason(url) {
  const parsed = urlparse(url);
  const host = parsed.netloc.toLowerCase();
  if (!isTraderie(host)) return `離開 Traderie：${host || "(unknown host)"}`;

  const path = parsed.path || "/";
  if (path.includes("/login") || path.includes("/signup")) return LOGIN_REASON;
  if (path.replace(/\/+$/u, "") === ROOT_PATH) return null;
  if (PRODUCT_PATH.test(path) || SEARCH_PATH.test(path)) return null;
  return `超出 Traderie D2R 範圍：${path}`;
}

// A challenge page has almost no text and no listings of its own. The extension's page text comes from the snapshot,
// which covers only the visible viewport (src/jev_ultrafast/snapshot.js), so a normal product page's text can still
// be short enough to hold Traderie's own changelog line "Fixed captcha bugs" (measured: 1998 chars of viewport text
// on a logged-in Harlequin Crest page). The bare word therefore only counts when the page also looks like a challenge
// rather than a content page: text under the limit and none of the listing markers.
const CHALLENGE_TEXT_MAX = 3000;

const hasListingMarkers = (low) => TRADING_MARKERS_LOWER.some((marker) => low.includes(marker));

export async function detectGuard(page, tab) {
  const reason = traderieScopeReason(page.url);
  if (reason) return reason;
  const text = (page.text ?? "").toLowerCase();
  const challengeWord = text.includes("captcha") && text.length < CHALLENGE_TEXT_MAX && !hasListingMarkers(text);
  if ((page.title ?? "").toLowerCase().includes("just a moment") || text.includes("verify you are human") ||
      challengeWord) {
    return CHALLENGE_REASON;
  }
  // Positive evidence, and the only probe that can still see a challenge whose text is long or carries markers. Kept
  // last because it costs a CDP round-trip while the text checks are local, and because it can fail; the order cannot
  // change which pages are guarded, since every branch returns the same reason.
  if (await tab.evaluate(`!!document.querySelector(${JSON.stringify(CHALLENGE_FRAMES)})`)) {
    return CHALLENGE_REASON;
  }
  return null;
}
