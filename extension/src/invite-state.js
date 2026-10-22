// The invite code and everything derived from it: the saved code (chrome.storage.local) and the pending one (typed,
// not accepted by the backend yet, memory only), the quota numbers tagged with the code they belong to, the reason that
// switches the three paid features off (a refused code, a used-up quota), the backend call that counts one use, and the
// DOM that shows all of it (the quota line, the settings screen's invite area, the scan screen's block line). The panel
// reads the state through the returned object and passes in what it needs (render, banner reset, focus); this module
// never imports sidepanel.js.
import { inviteStatus, startRun } from "./api.js";
import { API_BASE } from "./config.js";
import { $ } from "./dom.js";

// The last quota is kept with the code it belongs to, so a reopened panel still shows it; the settings screen
// refreshes it from the backend (`refreshQuota`), which counts nothing.
const QUOTA_KEY = "quota";
/** The chrome.storage.local keys `load` reads: the panel asks storage for them together with its own. */
export const INVITE_STORAGE_KEYS = ["invite", QUOTA_KEY];
const REFUSAL_RECHECK_MS = 15 * 60 * 1000; // the server's wrong-guess window

const mask = (code) => (code ? `${"•".repeat(8)}${code.length > 8 ? code.slice(-4) : ""}` : "（還沒有邀請碼）");
/** The one format the quota is shown in, in the header and in the settings: 已用 28/100. */
const quotaText = (q) => `已用 ${q.used}/${q.limit}`;
/** A refusal that is about the code itself (invalid, expired, used up); the wrong-guess throttle is only temporary. */
const refusesCode = (error) =>
  error?.status === 401 || (error?.status === 429 && error.code !== "too_many_failures");

/**
 * `render()` redraws the panel, `isRunning()` says a query runs (its settings are locked), `onBlockChange()` is called
 * when the block reason changed (the scan list and the listing form re-judge their buttons), `forgetBanner()` drops the
 * problem banner and `focusEntry()` puts the cursor where typing starts.
 */
export function createInviteState({ render, isRunning, onBlockChange, forgetBanner, focusEntry }) {
  let savedInvite = ""; // in chrome.storage.local
  let pendingInvite = ""; // typed but not accepted by the backend yet: kept in memory only
  let editingInvite = false;
  let quota = null; // { used, limit, invite } from the last accepted start
  // `inviteProblem` belongs to the code that was refused: another code (typed on the welcome screen, or a pending one
  // that failed while a saved one is fine) is never blocked by it.
  let inviteProblem = null; // { invite, message }
  let knownRefused = false; // the stored quota record says this saved code was refused
  let quotaNote = ""; // why the last refresh gave no number (a refused code says so; no network says it is unreachable)
  let shownBlock = null;

  const current = () => pendingInvite || savedInvite;
  // The numbers are tagged with the code they belong to, so a pending code that is refused (or replaced) never wipes or
  // borrows the saved code's numbers.
  const quotaNow = () => (quota?.invite === current() ? quota : null);

  // Why no query, search or listing can start: the backend refused the code (said in its words), or the known quota is
  // all used. All three cost one use, so they are switched off together instead of failing after the press.
  function blockReason() {
    if (!current()) return "";
    if (inviteProblem?.invite === current()) return inviteProblem.message;
    const now = quotaNow();
    return now && now.used >= now.limit ? `這組邀請碼的 ${now.limit} 次查詢已用完` : "";
  }

  /** Marks `invite` (default: the code in use) as refused when `error` is a refusal of the code itself. */
  function blockIfRefused(error, message, invite = current()) {
    if (refusesCode(error)) inviteProblem = { invite, message };
  }

  // `invite` is the code the numbers are for, taken when they were asked for (the current one may have changed since).
  function setQuota(next, invite = current()) {
    if (invite !== current()) return; // an answer for a code that is no longer the one in use
    quota = next ? { ...next, invite } : null;
    if (!next) return;
    if (inviteProblem?.invite === invite) inviteProblem = null; // the backend accepted it just now
    chrome.storage.local.set({ [QUOTA_KEY]: { ...next, invite } }).catch?.(() => {});
  }

  // The backend has accepted the code (the run started): only now is it worth keeping.
  async function remember(invite) {
    if (invite !== savedInvite) {
      await chrome.storage.local.set({ invite });
      savedInvite = invite;
    }
    if (pendingInvite === invite) pendingInvite = ""; // another code typed meanwhile stays pending
  }

  /**
   * The backend call that `findAndRead`, the affix flow and the listing start with: the invite belongs to the whole
   * query, and only a run the backend accepted updates the quota and is worth remembering.
   */
  function startRequest(invite = current()) {
    return async (args) => {
      const run = await startRun(API_BASE, { invite, ...args });
      setQuota({ used: run.used, limit: run.limit }, invite);
      await remember(invite);
      return run;
    };
  }

  async function refreshQuota() {
    const invite = current();
    if (!invite) return;
    try {
      const { used, limit } = await inviteStatus(API_BASE, { invite });
      if (invite !== current()) return; // the player changed the code meanwhile: this answer is not theirs
      quotaNote = "";
      setQuota({ used, limit }, invite);
    } catch (error) {
      if (invite !== current()) return;
      // A cached number (if any) stays. The server's own words for a refused code or a throttle; otherwise "unreachable".
      quotaNote = error?.status === 401 || error?.status === 429 ? error.message : "暫時讀不到剩餘次數";
      if (refusesCode(error)) {
        blockIfRefused(error, error.message, invite);
        chrome.storage.local.set({ [QUOTA_KEY]: { invite, refused: error.message, at: Date.now() } }).catch?.(() => {});
      }
    }
    render();
  }

  /** The code and quota record storage held when the panel opened (`saved` is the result of the panel's one `get`). */
  function load(saved) {
    savedInvite = saved.invite || "";
    const kept = saved[QUOTA_KEY];
    if (kept?.invite !== savedInvite) return;
    if (Number.isInteger(kept.limit)) quota = { used: kept.used, limit: kept.limit, invite: savedInvite };
    // A refusal seen within the throttle window is not asked again on this open (each ask of a dead code counts as a
    // wrong guess); an older one is, so a code the admin fixed meanwhile recovers by itself.
    if (kept.refused) {
      inviteProblem = { invite: savedInvite, message: kept.refused };
      knownRefused = Date.now() - (kept.at ?? 0) < REFUSAL_RECHECK_MS;
    }
  }

  /** Free (counts nothing) and tells a used-up code before the player presses anything; see `knownRefused`. */
  function refreshOnOpen() {
    if (!knownRefused) refreshQuota();
  }

  /** The new code is only held in memory until the next query succeeds (see `remember`). */
  function setPending(code) {
    pendingInvite = code;
    quotaNote = "";
    refreshQuota(); // a code refused earlier (and since fixed by the admin) is asked again, not trusted as dead
  }

  /** The scan screen's block line; the scan list and the listing form hear about a changed reason. */
  function renderBlock() {
    const reason = blockReason();
    $("scan-block").textContent = reason;
    $("scan-block").hidden = !reason;
    if (reason === shownBlock) return;
    shownBlock = reason;
    onBlockChange();
  }

  /** The quota line under the name field: used up while a query runs or has just ended, remaining before that. */
  function renderQuota() {
    const known = quotaNow() ? quotaText(quotaNow()) : "已用 —";
    $("quota").textContent = current() ? known : "";
  }

  /** The invite area of the settings screen, and every settings control that a running query locks. */
  function renderInvite() {
    const running = isRunning();
    for (const id of ["settings-open", "invite-change", "invite-new", "invite-new-ok", "welcome-invite", "welcome-go"]) {
      $(id).disabled = running;
    }
    $("invite-masked").textContent = mask(current());
    $("invite-edit").hidden = !editingInvite;
    $("invite-change").hidden = editingInvite;
    $("invite-note").textContent = "新的邀請碼要等下一次查詢成功，才會儲存。";
    $("invite-note").hidden = !pendingInvite;
    // Remaining first: it is the number the player came for. Known once a query has started (the backend reports it).
    $("invite-quota").textContent = !current()
      ? ""
      : quotaNow()
        ? quotaText(quotaNow())
        : quotaNote || "正在讀取剩餘次數…";
    $("invite-quota").hidden = !current();
  }

  /** The welcome screen's code box and the settings screen's change-code form. */
  function wire(on) {
    $("part-welcome").addEventListener("submit", (event) => {
      event.preventDefault();
      const code = $("welcome-invite").value.trim();
      if (!code) {
        $("welcome-invite").focus();
        return;
      }
      forgetBanner();
      setPending(code);
      $("welcome-invite").value = "";
      render();
      focusEntry();
    });
    $("invite-edit").addEventListener("submit", (event) => {
      event.preventDefault();
      const code = $("invite-new").value.trim();
      if (code) setPending(code);
      $("invite-new").value = "";
      editingInvite = false;
      render();
    });
    on("invite-change", () => {
      editingInvite = true;
      render();
      $("invite-new").focus();
    });
  }

  return {
    current,
    hasSaved: () => Boolean(savedInvite),
    blockReason,
    blockIfRefused,
    /** A failed query's pending code is dropped (a throttle does not block the code, a refusal does: see `blockIfRefused`). */
    clearPending: () => {
      pendingInvite = "";
    },
    /** Leaves the change-code form (the settings screen opens or closes). */
    stopEditing: () => {
      editingInvite = false;
    },
    startRequest,
    refreshQuota,
    refreshOnOpen,
    load,
    renderBlock,
    renderQuota,
    renderInvite,
    wire,
  };
}
