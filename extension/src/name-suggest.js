// Autocomplete combobox for the item name field (name search). Pure DOM helpers: no chrome.*, no I/O.
import { suggestNames } from "./traderie/lookup.js";

/**
 * Sets up the name input as an ARIA combobox that shows suggestions from the item tables.
 * `getTables()` returns the indexed tables (or null before they load).
 * The list element must be the `<ul id="item-suggest">` sibling placed after the input.
 */
export function initNameSuggest({ input, list, getTables }) {
  let active = -1;
  let items = [];

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);

  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "名稱建議");

  function close() {
    active = -1;
    items = [];
    list.hidden = true;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }

  function select(index) {
    if (index < 0 || index >= items.length) return;
    input.value = items[index].label;
    input.setAttribute("aria-activedescendant", `${list.id}-${index}`);
    close();
  }

  function render() {
    list.replaceChildren();
    if (!items.length) {
      close();
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const li = document.createElement("li");
      li.id = `${list.id}-${i}`;
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      li.setAttribute("aria-selected", "false");
      const span = document.createElement("span");
      span.textContent = items[i].label;
      li.append(span);
      if (items[i].hint) {
        const hint = document.createElement("span");
        hint.classList.add("suggest-hint");
        hint.textContent = items[i].hint;
        li.append(hint);
      }
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        select(i);
      });
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function move(delta) {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    for (let i = 0; i < items.length; i++) {
      list.children[i].setAttribute("aria-selected", String(i === active));
    }
    input.setAttribute("aria-activedescendant", active >= 0 ? `${list.id}-${active}` : "");
  }

  input.addEventListener("input", () => {
    const tables = getTables();
    if (!tables) { close(); return; }
    items = suggestNames(input.value, tables);
    active = -1;
    render();
  });

  input.addEventListener("keydown", (event) => {
    if (!items.length) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
        if (active >= 0) {
          event.preventDefault();
          select(active);
        }
        break;
      case "Escape":
        close();
        break;
    }
  });

  input.addEventListener("blur", () => {
    // Small delay so a mousedown on the list fires before close.
    setTimeout(close, 100);
  });
}