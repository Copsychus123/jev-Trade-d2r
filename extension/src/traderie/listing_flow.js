// 「TR交易」: putting one scanned item on Traderie. The fourth program-side navigation and the only one that writes to
// the site. On the player's explicit 上架 press:
//
//   1. open the product page in the program's own tab and check it for a challenge page (like the affix search)
//   2. read the item's own record (its id, type and property list) and the ids of the runes the price names
//   3. check that the site would not demand a captcha token for this player (it is never solved here)
//   4. build the body from the confirmed form (traderie/listing.js) and POST listings/create exactly once -- the
//      timeline entry is written before the request, so a tab that dies mid-request still leaves its trace
//   5. read the player's own listings and look for the new one (independent of the create reply)
//
// Nothing here is retried and no model is asked: every field comes from the OCR conditions the player confirmed, the
// saved listing defaults and what the player typed.
import { productUrlFor } from "./lookup.js";
import { detectGuard } from "./site.js";
import { openDetails, timed } from "../timeline.js";
import {
  DETAILS_PATH,
  GAMES_PATH,
  LISTING_CREATE_PATH,
  USER_PATH,
  buildListingBody,
  captchaRequired,
  itemPath,
  listedInOwn,
  missingRequired,
  newestOwnListingId,
  listingBlocker,
  listingIdFrom,
  listingProperties,
  listingReason,
  listingUrl,
  normalizeItemInfo,
  ownListingsPath,
  priceItems,
  profileListingsUrl,
} from "./listing.js";

export const UNCONFIRMED_REASON = "上架請求送出後沒有收到回覆，請到 Traderie 的 My Listings 確認有沒有上架成功";
export const UNVERIFIED_NOTE = "已送出，但在你的掛單清單裡還沒看到，請到 Traderie 確認";

const fetchJson = (tab, scripts, path) => tab.evaluate(`${scripts.fetchJson}(${JSON.stringify(path)})`, { awaitPromise: true });

/** The result of a run that posted nothing (or failed): no listing id, no link, nothing verified. */
const notPosted = (outcome, reason = "") => ({ outcome, reason, listingId: null, listingUrl: null, verified: false });

/** The product's slug for a rune name, from the shipped table; null when the table has no such rune. */
const runeSlug = (name, tables) => tables?.products?.find((p) => p.category === "runes" && p.name === name)?.slug ?? null;

/**
 * The Traderie item id of every rune the price names, by rune name (none when the listing accepts offers instead).
 * Resolves with `{ runeIds }`, or `{ refusal }` for the first rune with no record.
 */
async function fetchRuneIds({ form, tables, tab, scripts }) {
  const runeIds = {};
  if (form.makeOffer) return { runeIds };
  for (const name of new Set(form.prices.map((g) => g.rune).filter(Boolean))) {
    const slug = runeSlug(name, tables);
    const info = slug ? normalizeItemInfo(await fetchJson(tab, scripts, itemPath(slug))) : null;
    if (!info) return { refusal: `找不到符文「${name}」的 Traderie 資料` };
    runeIds[name] = info.id;
  }
  return { runeIds };
}

/**
 * The independent check after a create: the player's own listings, looking for the new one. Never throws: the listing
 * was posted, only the check could not run. Resolves with `{ verified, profileUrl, listingId }`; a create reply with no
 * id still gets its link, from the newest own listing of this item.
 */
async function verifyOwnListing({ tab, scripts, itemId, listingId }) {
  let verified = false;
  let profileUrl = null;
  try {
    const me = await fetchJson(tab, scripts, USER_PATH);
    const userId = me?.body?.user?.id;
    if (userId != null) {
      profileUrl = profileListingsUrl(userId);
      const own = await fetchJson(tab, scripts, ownListingsPath(userId));
      verified = listedInOwn(own, itemId, listingId);
      if (!listingId && verified) listingId = newestOwnListingId(own, itemId);
    }
  } catch {
    verified = false;
  }
  return { verified, profileUrl, listingId };
}

/** A create that was sent but not answered clearly: it may exist, so the player is sent to their own listings. */
async function unconfirmed(tab, scripts, itemId) {
  const { profileUrl } = await verifyOwnListing({ tab, scripts, itemId, listingId: null });
  return { ...notPosted("failed", UNCONFIRMED_REASON), unconfirmed: true, profileUrl };
}

/**
 * Resolves with `{ outcome, reason, listingId, listingUrl, verified, unavailable }`: "posted" (the create answered
 * 2xx; `verified` says whether the own-listings read showed it), "guard" (challenge page), "refused" (nothing was
 * posted: a blocker, a missing record, a captcha requirement) or "failed" (the request was sent, or could not be,
 * and the answer was not a success). `session.tab` is closed in every case.
 */
export async function postListing({ form, tables, openTab, scripts, session, onStatus = () => {}, onSend = () => {}, beforePost = null }) {
  const early = listingBlocker(form, undefined);
  if (early) return notPosted("refused", early);
  try {
    onStatus("開啟商品頁…");
    session.tab = await timed(session, "open_tab", () => openTab(productUrlFor(form.product)), openDetails);
    const page = await timed(session, "read_product", () => session.tab.readSettledPage(500, 8000), (p) => ({ settled: p?.settled ?? null }));
    if (await detectGuard(page, session.tab)) return notPosted("guard");

    onStatus("讀取物品資料…");
    const itemReply = await timed(session, "read_item", () => fetchJson(session.tab, scripts, itemPath(form.product.slug)), (r) => ({ status: r?.status ?? null }));
    const itemInfo = normalizeItemInfo(itemReply);
    if (!itemInfo) return notPosted("refused", `Traderie 沒有這件物品的資料（HTTP ${itemReply?.status ?? "沒有回應"}）`);
    const { runeIds, refusal } = await fetchRuneIds({ form, tables, tab: session.tab, scripts });
    if (refusal) return notPosted("refused", refusal);
    const blocker = listingBlocker(form, itemInfo);
    if (blocker) return notPosted("refused", blocker);

    const [games, details] = await Promise.all([fetchJson(session.tab, scripts, GAMES_PATH), fetchJson(session.tab, scripts, DETAILS_PATH)]);
    if (captchaRequired(games, details)) return notPosted("refused", "Traderie 要求驗證碼，無法代為上架");

    const { properties, unavailable } = listingProperties(form, itemInfo);
    // Nothing the player ticked or the site requires may be missing from a listing that cannot be undone.
    if (unavailable.length) {
      const names = form.conditions.filter((c) => unavailable.includes(c.key)).map((c) => c.label);
      return { ...notPosted("refused", `這件物品在 Traderie 沒有這些屬性欄位：${names.join("、")}（請取消勾選）`), unavailable };
    }
    const lacking = missingRequired(itemInfo, properties);
    if (lacking.length) return notPosted("refused", `Traderie 要求這些欄位，但表單沒有填：${lacking.join("、")}`);
    const body = buildListingBody({ itemInfo, form, properties, items: priceItems(form, runeIds) });

    // The invite use is counted here, after every check that can refuse the listing and right before the request: a
    // challenge page, a missing record or a captcha costs nothing. A used-up or refused code stops the post.
    if (beforePost) {
      try {
        await beforePost();
      } catch (error) {
        return notPosted("refused", error?.message || String(error));
      }
    }
    onStatus("送出掛單…");
    // Logged before the request, so a panel closed mid-request still leaves what was about to be sent.
    session.timeline?.entries.push({ stage: "post_listing_sent", start_ms: Math.round(session.timeline.now() - session.timeline.origin) });
    session.listing = { body, unavailable }; // set only once the request is about to leave: non-null means it was sent
    onSend(body);
    let reply;
    try {
      reply = await timed(
        session,
        "post_listing",
        () => session.tab.evaluate(`${scripts.postForm}(${JSON.stringify(LISTING_CREATE_PATH)}, ${JSON.stringify(JSON.stringify(body))})`, { awaitPromise: true }),
        (r) => ({ status: r?.status ?? null }),
      );
    } catch {
      return unconfirmed(session.tab, scripts, body.item);
    }
    // A gateway error or an empty answer may still have created the listing: say so instead of offering a re-list.
    if (!reply || reply.status >= 500) return unconfirmed(session.tab, scripts, body.item);
    const reason = listingReason(reply);
    if (reason) return notPosted("failed", reason);

    onStatus("確認掛單清單…");
    const { verified, profileUrl, listingId } = await verifyOwnListing({ tab: session.tab, scripts, itemId: body.item, listingId: listingIdFrom(reply) });
    return { outcome: "posted", reason: verified ? "" : UNVERIFIED_NOTE, listingId, listingUrl: listingId ? listingUrl(listingId) : null, profileUrl, verified, unavailable };
  } finally {
    if (session.tab) await session.tab.close().catch(() => {});
    session.tab = null;
  }
}
