// The 學習紀錄 block of the settings screen: how many corrections are remembered (the item names in ocr/corrections.js,
// the bases of the affix search in a second store of the same kind, the affix numbers in ocr/value-corrections.js), a way
// to clear them with one confirmation, and the remembered pairs with a ✕ each so a wrong one can be undone. Everything
// the player sees goes through textContent. Nothing here reads or writes a store itself: it asks the memories it is given.
import { $, element } from "./dom.js";
import { LEARNED_SURE } from "./ocr/match.js";
import { labelWithChinese } from "./traderie/lookup.js";

export const MAX_LISTED = 30; // the list shows the newest pairs; the rest are counted, not drawn

/**
 * One sentence on how much is remembered, and how much of it is already sure. A name or a base is sure after
 * LEARNED_SURE identical choices; a number fills the next read after one correction. Empty groups are left out.
 */
export function countLine({ names = [], bases = [], values = [] } = {}) {
  const total = names.length + bases.length + values.length;
  if (!total) return "還沒有記住任何更正。";
  const sure = (entries) => entries.filter((entry) => entry.count >= LEARNED_SURE).length;
  const parts = [];
  if (names.length) parts.push(`名稱 ${names.length} 筆（其中 ${sure(names)} 筆選過 ${LEARNED_SURE} 次以上，下次會自動填入）`);
  if (bases.length) parts.push(`底材 ${bases.length} 筆（其中 ${sure(bases)} 筆改過 ${LEARNED_SURE} 次以上，下次會直接用）`);
  if (values.length) parts.push(`數值 ${values.length} 筆（下次直接填）`);
  return `已記住 ${total} 筆更正：${parts.join("、")}。`;
}

export function initLearningPanel({ corrections, baseCorrections = null, valueCorrections = null, getTables = () => null }) {
  const sources = [
    [corrections, "name"],
    [baseCorrections, "base"],
    [valueCorrections, "value"],
  ].filter(([memory]) => memory);
  const memories = sources.map(([memory]) => memory);

  /** Every remembered pair of the three memories as one list, newest use first (ties keep each memory's own order). */
  const merged = () =>
    sources
      .flatMap(([memory, type]) => memory.list().map((entry) => ({ ...entry, type, memory })))
      .sort((a, b) => b.used - a.used);

  const sentence = (entry, tables) => {
    if (entry.type === "value") return `讀到「${entry.key}」→ 數值 ${entry.min}（改過 ${entry.count} 次）`;
    const name = tables ? labelWithChinese(entry.name, tables) : entry.name;
    if (entry.type === "base") return `讀到「${entry.key}」→ 底材 ${name}（改過 ${entry.count} 次）`;
    return `讀到「${entry.key}」→ ${name}（選過 ${entry.count} 次）`;
  };

  /** One remembered pair with the ✕ that makes its memory forget it. */
  const rowElement = (entry, tables) => {
    const li = element("li");
    const remove = element("button", { type: "button", className: "remove", textContent: "✕" });
    remove.setAttribute("aria-label", `刪除這筆學習：${entry.key}`);
    remove.addEventListener("click", () => entry.memory.forget(entry.key));
    li.append(element("span", { textContent: sentence(entry, tables) }), remove);
    return li;
  };

  const render = () => {
    const entries = merged();
    const ofType = (type) => entries.filter((entry) => entry.type === type);
    $("learn-count").textContent = countLine({ names: ofType("name"), bases: ofType("base"), values: ofType("value") });
    $("learn-clear").hidden = !entries.length || !$("learn-confirm").hidden;
    if (!entries.length) $("learn-confirm").hidden = true;
    $("learn-details").hidden = !entries.length;
    const tables = getTables();
    const rows = entries.slice(0, MAX_LISTED).map((entry) => rowElement(entry, tables));
    if (entries.length > MAX_LISTED) {
      rows.push(element("li", { className: "muted small", textContent: `還有 ${entries.length - MAX_LISTED} 筆沒有列出。` }));
    }
    $("learn-list").replaceChildren(...rows);
  };

  $("learn-clear").addEventListener("click", () => {
    $("learn-confirm").hidden = false;
    render();
  });
  $("learn-clear-no").addEventListener("click", () => {
    $("learn-confirm").hidden = true;
    render();
  });
  $("learn-clear-yes").addEventListener("click", () => {
    $("learn-confirm").hidden = true;
    for (const memory of memories) memory.clear();
    render();
  });
  for (const memory of memories) memory.onChange(render);
  render();
  return { render };
}
