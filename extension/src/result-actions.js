// The buttons under the result tabs: open the site, download the CSV, copy the rows. They act on the rows the display
// filter keeps, in the same cells as the on-screen list, so the file and the clipboard cannot drift from what the
// player sees. `deps`: getMarket(), rowsOf(key) (the kept rows of a list), getItemName() and getActiveTab().
import { csvFileName, toCsv } from "./csv.js";
import { saveText } from "./download.js";
import { verificationSummary } from "./labels.js";
import { openable, viewConfigFor } from "./result-views.js";
import { toTsv } from "./tsv.js";

const $ = (id) => document.getElementById(id);

export function createResultActions({ getMarket, rowsOf, getItemName, getActiveTab }) {
  let copyTimer = null;

  function resetCopyLabel() {
    clearTimeout(copyTimer);
    $("result-copy").textContent = "複製";
    $("result-note").hidden = true;
  }

  /**
   * The sentence an export is refused with, or null to go ahead. Only a verification that ran and failed blocks
   * (the same rule as the Python save_report); with no verification at all nothing was ever checked, so the export is
   * allowed exactly as before and the player is never locked out of their own data.
   */
  function exportBlocked() {
    const verification = getMarket().verification;
    if (!verification || verification.passed) return null;
    const { reasons, headline } = verificationSummary(verification);
    return reasons.length ? `${headline}：${reasons.join("；")}` : headline;
  }

  function blocked(blockedText) {
    $("result-note").textContent = blockedText;
    $("result-note").hidden = false;
  }

  /** Opens the page this table was read from, in a normal tab (the query window is already closed by then). */
  function openSite(key) {
    const url = getMarket()[key].url;
    if (openable(url)) chrome.tabs.create({ url });
  }

  function download(key) {
    const blockedText = exportBlocked();
    if (blockedText) return blocked(blockedText);
    $("result-note").hidden = true;
    const config = viewConfigFor(getMarket(), key);
    const rows = rowsOf(key);
    if (!rows.length) return;
    saveText(csvFileName(getItemName(), config.label), toCsv(config.head, rows.map(config.cells)), "text/csv;charset=utf-8");
  }

  async function copy(key) {
    const blockedText = exportBlocked();
    if (blockedText) return blocked(blockedText);
    $("result-note").hidden = true;
    const config = viewConfigFor(getMarket(), key);
    const rows = rowsOf(key);
    if (!rows.length) return;
    let label;
    try {
      // Tab separated so a spreadsheet pastes it into columns.
      await navigator.clipboard.writeText(toTsv(config.head, rows.map(config.cells)));
      label = `已複製 ${rows.length} 筆`;
    } catch {
      label = "複製失敗";
    }
    if (getActiveTab() !== key) return; // the player switched tabs while copying: the feedback would be for the other tab
    $("result-copy").textContent = label;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(resetCopyLabel, 1500);
  }

  return { openSite, download, copy, resetCopyLabel };
}
