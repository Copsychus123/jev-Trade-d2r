// The 學習紀錄 block of the settings screen: how many corrections the reader remembers (ocr/corrections.js), a way to
// clear them with one confirmation, and the remembered pairs with a ✕ each so a wrong one can be undone. Everything the
// player sees goes through textContent. Nothing here reads or writes the store itself: it asks the memory it is given.
import { $, element } from "./dom.js";
import { LEARNED_SURE } from "./ocr/match.js";
import { labelWithChinese } from "./traderie/lookup.js";

export const MAX_LISTED = 30; // the list shows the newest pairs; the rest are counted, not drawn

/** One sentence on how much is remembered, and how much of it is already sure. */
export function countLine(entries) {
  if (!entries.length) return "還沒有記住任何更正。";
  const sure = entries.filter((entry) => entry.count >= LEARNED_SURE).length;
  return `已記住 ${entries.length} 筆更正（其中 ${sure} 筆選過 ${LEARNED_SURE} 次以上，下次會自動填入）。`;
}

export function initLearningPanel({ corrections, getTables = () => null }) {
  const render = () => {
    const entries = corrections.list();
    $("learn-count").textContent = countLine(entries);
    $("learn-clear").hidden = !entries.length || !$("learn-confirm").hidden;
    if (!entries.length) $("learn-confirm").hidden = true;
    $("learn-details").hidden = !entries.length;
    const tables = getTables();
    const rows = entries.slice(0, MAX_LISTED).map((entry) => {
      const li = element("li");
      const text = element("span", {
        textContent: `讀到「${entry.key}」→ ${tables ? labelWithChinese(entry.name, tables) : entry.name}（選過 ${entry.count} 次）`,
      });
      const remove = element("button", { type: "button", className: "remove", textContent: "✕" });
      remove.setAttribute("aria-label", `刪除這筆學習：${entry.key}`);
      remove.addEventListener("click", () => corrections.forget(entry.key));
      li.append(text, remove);
      return li;
    });
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
    corrections.clear();
    render();
  });
  corrections.onChange(render);
  render();
  return { render };
}
