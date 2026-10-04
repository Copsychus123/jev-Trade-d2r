// Port of core/jev_ultrafast/traderie/site.py (URL scope, load-more rules, challenge guard).
export const TRADERIE_D2R_URL = "https://www.traderie.com/diablo2resurrected";
export const TRADERIE_HOSTS = new Set(["traderie.com", "www.traderie.com"]);
export const LOAD_MORE_LIMIT = 2;
export const MAX_LOAD_MORE = 5;
export const LOAD_MORE_LABEL = "Load More";
export const CHALLENGE_FRAMES =
  'iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],' +
  'iframe[src*="google.com/recaptcha/api2/anchor"],iframe[src*="google.com/recaptcha/api2/bframe"]';

const PRODUCT_PATH =
  /^\/diablo2resurrected\/product\/(?<slug>[^/?#]+)(?:\/(?<section>buying|recent|wiki|recipes))?\/?$/u;
const SEARCH_PATH = /^\/diablo2resurrected\/(?:search|products)\/?$/u;
const ROOT_PATH = "/diablo2resurrected";
const LOGIN_REASON = "需要登入：請先在這個 Chrome 登入 Traderie 再重新開始";

// Same netloc/path split as Python's urllib.parse.urlparse.
function urlparse(url) {
  const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)/u.exec(url || "");
  return { netloc: m[1] ?? "", path: m[2] };
}

export function cleanItemName(itemName) {
  const item = String(itemName).replace(/\s+/gu, " ").trim();
  if (!item) throw new Error("Supply a Traderie item name");
  return item;
}

export function validateLoadMore(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LOAD_MORE) {
    throw new Error(`載入更多次數必須是 0 到 ${MAX_LOAD_MORE} 的整數`);
  }
  return value;
}

export function phaseFinishRule(loadMore) {
  return loadMore ? [LOAD_MORE_LABEL, loadMore] : null;
}

export function productRootUrl(url) {
  const { netloc, path } = urlparse(url);
  if (!TRADERIE_HOSTS.has(netloc)) return null;
  const match = PRODUCT_PATH.exec(path);
  if (!match) return null;
  return `${TRADERIE_D2R_URL}/product/${match.groups.slug}`;
}

export function traderieScopeReason(url) {
  const parsed = urlparse(url);
  const host = parsed.netloc.toLowerCase();
  if (!TRADERIE_HOSTS.has(host)) return `離開 Traderie：${host || "(unknown host)"}`;

  const path = parsed.path || "/";
  if (path.includes("/login") || path.includes("/signup")) return LOGIN_REASON;
  if (path.replace(/\/+$/u, "") === ROOT_PATH) return null;
  if (PRODUCT_PATH.test(path) || SEARCH_PATH.test(path)) return null;
  return `超出 Traderie D2R 範圍：${path}`;
}

export async function detectGuard(page, tab) {
  const reason = traderieScopeReason(page.url);
  if (reason) return reason;
  const text = (page.text ?? "").toLowerCase();
  if ((page.title ?? "").toLowerCase().includes("just a moment") || text.includes("verify you are human") ||
      text.includes("captcha")) {
    return "防護頁/驗證碼";
  }
  if (await tab.evaluate(`!!document.querySelector(${JSON.stringify(CHALLENGE_FRAMES)})`)) {
    return "防護頁/驗證碼";
  }
  return null;
}
