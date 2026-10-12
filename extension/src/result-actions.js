// The buttons under the result tabs: open the site, download the CSV, copy the rows. They act on the rows the display
// filter keeps, in the same cells as the on-screen list, so the file and the clipboard cannot drift from what the
// player sees. `deps`: getMarket(), rowsOf(key) (the kept rows of a list), getItemName() and getActiveTab().
import { csvFileName, toCsv } from "./csv.js";
import { $ } from "./dom.js";
import { saveText } from "./download.js";
import { verificationSummary } from "./labels.js";
import { openable, viewConfigFor } from "./result-views.js";
import { toTsv } from "./tsv.js";

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

  /**
   * The rows an export of `key` sends: its view config and the kept rows, or null when it is refused (a failed check)
   * or there is nothing to send. The refusal sentence is shown.
   */
  function exportRows(key) {
    const blockedText = exportBlocked();
    if (blockedText) {
      blocked(blockedText);
      return null;
    }
    $("result-note").hidden = true;
    const rows = rowsOf(key);
    return rows.length ? { config: viewConfigFor(getMarket(), key), rows } : null;
  }

  /** Opens the page this table was read from, in a normal tab (the query window is already closed by then). */
  function openSite(key) {
    const url = getMarket()[key].url;
    if (openable(url)) chrome.tabs.create({ url });
  }

  /** The kept rows as the view's cell lists: the CSV file and the clipboard both send exactly these. */
  function exportCells({ config, rows }) {
    return rows.map(config.cells);
  }

  function download(key) {
    const target = exportRows(key);
    if (!target) return;
    const { config } = target;
    saveText(csvFileName(getItemName(), config.label), toCsv(config.head, exportCells(target)), "text/csv;charset=utf-8");
  }

  async function copy(key) {
    const target = exportRows(key);
    if (!target) return;
    const { config, rows } = target;
    let label;
    try {
      // Tab separated so a spreadsheet pastes it into columns.
      await navigator.clipboard.writeText(toTsv(config.head, exportCells(target)));
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
