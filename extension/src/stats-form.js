// The "yellow / blue / white items" part of the form: base, quality and the list of affix conditions. The rules live in
// stats-form-state.js; this file only draws them. Screenshot text is untrusted: everything is written with textContent.
import { AFFIXES } from "./ocr/affix_dictionary.js";
import { parseAffixLines } from "./ocr/affixes.js";
import {
  addCondition,
  availableToAdd,
  startBlocker,
  emptyStatsForm,
  EMPTY_LIST,
  fillFromScreenshot,
  invalidKeys,
  removeCondition,
  setBase,
  setLimit,
  setOn,
  setQuality,
} from "./stats-form-state.js";
import { QUALITIES, unmappedKeys } from "./traderie/stats.js";

const $ = (id) => document.getElementById(id);
const element = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/**
 * `getProperties()` gives Traderie's property list of an earlier query (or null before the first one): with it a
 * condition Traderie has no property for is greyed out as soon as the screenshot is read. `onChange` is called after
 * every change so the page can enable or disable the start button.
 */
export function initStatsForm({ getProperties, onChange }) {
  let form = emptyStatsForm();
  let busy = false;
  let hasScreenshot = false;
  let screenshotText = "";

  // The quality radios are built from QUALITIES: a quality added to stats.js always has a control here, with the same
  // value and label, so the two lists cannot drift apart.
  function buildQualityRadios() {
    for (const quality of QUALITIES) {
      const label = element("label");
      label.append(
        element("input", { type: "radio", name: "quality", value: quality.key }),
        element("span", { textContent: quality.label }),
      );
      $("quality-group").append(label);
    }
  }
  buildQualityRadios();

  function set(next) {
    form = next;
    render();
    onChange();
  }

  /** The 最小/最大 number inputs of a condition that has a range; a boolean condition has neither. */
  function limitFields(condition) {
    const limits = element("span", { className: "affix-limits" });
    for (const [field, text] of [["min", "最小"], ["max", "最大"]]) {
      // Only the box that actually carries a captured number is marked: an empty one came from nothing.
      const captured = condition.fromCapture && condition[field] !== null && condition[field] !== "";
      const input = element("input", {
        type: "number",
        className: `affix-${field}${captured ? " from-capture" : ""}`,
        min: "0",
        step: "1",
        value: condition[field] ?? "",
        placeholder: text,
      });
      if (captured) input.title = "從擷取讀到，請確認";
      input.setAttribute("aria-label", `${condition.label}${text}值`);
      input.disabled = busy;
      limits.append(input);
    }
    return limits;
  }

  function rowElement(condition) {
    const unavailable = form.unavailable.includes(condition.key);
    const li = element("li", { className: "affix" });
    li.dataset.key = condition.key;
    li.classList.toggle("unmapped", unavailable);
    li.classList.toggle("invalid", invalidKeys(form).includes(condition.key));

    const on = element("input", { type: "checkbox", className: "affix-on", checked: condition.on });
    on.disabled = busy || unavailable;
    const name = element("label", { className: "affix-name" });
    name.append(on, element("span", { textContent: condition.label }));
    if (unavailable) name.append(element("small", { textContent: "（Traderie 沒有這個屬性）" }));
    li.append(name);

    if (condition.kind !== "bool") li.append(limitFields(condition));
    const remove = element("button", { type: "button", className: "affix-remove icon", textContent: "✕" });
    remove.setAttribute("aria-label", `移除${condition.label}`);
    remove.disabled = busy;
    li.append(remove);
    return li;
  }

  function render() {
    $("affix-list").replaceChildren(...form.conditions.map(rowElement));
    $("affix-empty").textContent = EMPTY_LIST;
    $("affix-empty").hidden = form.conditions.length > 0;

    const select = $("affix-select");
    select.replaceChildren(new Option("新增條件…", ""));
    for (const entry of availableToAdd(form, AFFIXES)) select.append(new Option(entry.zh, entry.key));
    select.disabled = busy;
    $("affix-fill").disabled = busy || !hasScreenshot;
    for (const radio of document.querySelectorAll('input[name="quality"]')) {
      radio.checked = radio.value === form.quality;
      radio.disabled = busy;
    }
    if ($("stats-base").value !== form.base) $("stats-base").value = form.base;
    $("stats-base").disabled = busy;
  }

  // The list is redrawn on structural changes only; typing a number just updates the state and the invalid marks.
  function wireEvents() {
    $("affix-list").addEventListener("change", (event) => {
      const key = event.target.closest("li")?.dataset.key;
      if (key && event.target.classList.contains("affix-on")) set(setOn(form, key, event.target.checked));
    });
    $("affix-list").addEventListener("input", (event) => {
      const li = event.target.closest("li");
      const field = ["min", "max"].find((f) => event.target.classList.contains(`affix-${f}`));
      if (!li || !field) return;
      form = setLimit(form, li.dataset.key, field, event.target.value);
      li.classList.toggle("invalid", invalidKeys(form).includes(li.dataset.key));
      onChange();
    });
    $("affix-list").addEventListener("click", (event) => {
      const key = event.target.closest("li")?.dataset.key;
      if (key && event.target.closest(".affix-remove")) set(removeCondition(form, key));
    });
    $("affix-select").addEventListener("change", (event) => {
      const entry = AFFIXES.find((e) => e.key === event.target.value);
      if (entry) set(addCondition(form, entry));
    });
    $("stats-base").addEventListener("input", (event) => {
      form = setBase(form, event.target.value);
      $("stats-base").dataset.from = "";
      onChange();
    });
    for (const radio of document.querySelectorAll('input[name="quality"]')) {
      radio.addEventListener("change", () => set(setQuality(form, radio.value)));
    }
    $("affix-fill").addEventListener("click", () => fillFromText(screenshotText, { carryValues: true }));
  }

  async function fillFromText(text, options) {
    screenshotText = text;
    hasScreenshot = Boolean(text);
    const properties = await getProperties();
    set(
      fillFromScreenshot(
        form,
        parseAffixLines(text),
        properties ? unmappedKeys(properties) : form.unavailable,
        options,
      ),
    );
  }

  wireEvents();
  render();
  return {
    get: () => form,
    startBlocker: () => startBlocker(form),
    fillFromText,
    /** A new picture: the old reading no longer belongs to it. */
    forgetScreenshot() {
      screenshotText = "";
      hasScreenshot = false;
      render();
    },
    /** Text read from a picture, kept so the "fill from screenshot" button can use it later. */
    rememberScreenshot(text) {
      screenshotText = text;
      hasScreenshot = Boolean(text);
      render();
    },
    /** The base typed or read from a picture; a typed one is never replaced by a later reading. */
    setBaseFromScreenshot(name) {
      const input = $("stats-base");
      if (input.value.trim() && input.dataset.from !== "ocr") return;
      input.dataset.from = "ocr";
      set(setBase(form, name));
    },
    /** Traderie has no property for these keys: they are greyed out and switched off. */
    markUnavailable(keys) {
      const unavailable = [...new Set([...form.unavailable, ...keys])];
      set({ ...form, unavailable, conditions: form.conditions.map((c) => (keys.includes(c.key) ? { ...c, on: false } : c)) });
    },
    setBusy(value) {
      if (busy === value) return;
      busy = value;
      render();
    },
  };
}
