// The "yellow / blue / white items" part of the form: base, quality and the list of affix conditions. The rules live in
// stats-form-state.js; this file only draws them. Screenshot text is untrusted: everything is written with textContent.
import { AFFIXES } from "./ocr/affix_dictionary.js";
import { parseAffixLines } from "./ocr/affixes.js";
import { $, element } from "./dom.js";
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

/** Title of every field whose value came from a screenshot: the player is asked to confirm it. */
const FROM_CAPTURE_TITLE = "從擷取讀到，請確認";

/**
 * One 最小/最大 number box of `condition`. Only the box that actually carries a captured number is marked: an empty
 * one came from nothing.
 */
function limitInput(condition, field, text, busy) {
  const captured = condition.fromCapture && condition[field] !== null && condition[field] !== "";
  const input = element("input", {
    type: "number",
    className: `affix-${field}${captured ? " from-capture" : ""}`,
    min: "0",
    step: "1",
    value: condition[field] ?? "",
    placeholder: text,
  });
  if (captured) input.title = FROM_CAPTURE_TITLE;
  input.setAttribute("aria-label", `${condition.label}${text}值`);
  input.disabled = busy;
  return input;
}

/** The capture mark is a question the player has not answered yet; editing the control answers it, so the mark goes. */
function clearCaptureMark(control) {
  control.classList.remove("from-capture");
  control.removeAttribute("title");
}

/**
 * The quality radios, built from QUALITIES: a quality added to stats.js always has a control here, with the same value
 * and label, so the two lists cannot drift apart. It reads no form state, so it lives outside the form.
 */
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

  buildQualityRadios(); // before the first render: every later pass reads the radios this fills in
  const qualityRadios = () => document.querySelectorAll('input[name="quality"]');

  function set(next) {
    form = next;
    render();
    onChange();
  }

  /** The 最小/最大 number inputs of a condition that has a range; a boolean condition has neither. */
  function limitFields(condition) {
    const limits = element("span", { className: "affix-limits" });
    for (const [field, text] of [["min", "最小"], ["max", "最大"]]) {
      limits.append(limitInput(condition, field, text, busy));
    }
    return limits;
  }

  function rowElement(condition) {
    const unavailable = form.unavailable.includes(condition.key);
    const li = element("li", { className: "affix" });
    li.dataset.key = condition.key;
    li.classList.toggle("unmapped", unavailable);
    li.classList.toggle("invalid", invalidKeys(form).includes(condition.key));

    const checkbox = element("input", { type: "checkbox", className: "affix-on", checked: condition.on });
    checkbox.disabled = busy || unavailable;
    const name = element("label", { className: "affix-name" });
    name.append(checkbox, element("span", { textContent: condition.label }));
    if (unavailable) name.append(element("small", { textContent: "（Traderie 沒有這個屬性）" }));
    li.append(name);

    if (condition.kind !== "bool") li.append(limitFields(condition));
    const remove = element("button", { type: "button", className: "affix-remove icon", textContent: "✕" });
    remove.setAttribute("aria-label", `移除${condition.label}`);
    remove.disabled = busy;
    li.append(remove);
    return li;
  }

  /** The condition list and the "add a condition" menu, both built from the form. */
  function renderConditions() {
    $("affix-list").replaceChildren(...form.conditions.map(rowElement));
    const empty = $("affix-empty");
    empty.textContent = EMPTY_LIST;
    empty.hidden = form.conditions.length > 0;

    const select = $("affix-select");
    select.replaceChildren(new Option("新增條件…", ""));
    for (const entry of availableToAdd(form, AFFIXES)) select.append(new Option(entry.zh, entry.key));
    select.disabled = busy;
    $("affix-fill").disabled = busy || !hasScreenshot;
  }

  /** The quality radios mirror the form's choice. */
  function renderQuality() {
    for (const radio of qualityRadios()) {
      radio.checked = radio.value === form.quality;
      radio.disabled = busy;
    }
  }

  /**
   * The base field mirrors the form. A base that came from a picture or a scan record is marked the same way a captured
   * number is: the player can see it was not their own typing, and editing it clears the mark.
   */
  function renderBase() {
    const base = $("stats-base");
    if (base.value !== form.base) base.value = form.base;
    const fromCapture = base.dataset.from === "ocr";
    base.classList.toggle("from-capture", fromCapture);
    if (fromCapture) base.title = FROM_CAPTURE_TITLE;
    else base.removeAttribute("title");
    base.disabled = busy;
  }

  function render() {
    renderConditions();
    renderQuality();
    renderBase();
  }

  // The list is redrawn on structural changes only; typing a number just updates the state and the invalid marks.
  function wireEvents() {
    const list = $("affix-list");
    list.addEventListener("change", (event) => {
      const key = event.target.closest("li")?.dataset.key;
      if (key && event.target.classList.contains("affix-on")) set(setOn(form, key, event.target.checked));
    });
    list.addEventListener("input", (event) => {
      const li = event.target.closest("li");
      const field = ["min", "max"].find((f) => event.target.classList.contains(`affix-${f}`));
      if (!li || !field) return;
      form = setLimit(form, li.dataset.key, field, event.target.value);
      li.classList.toggle("invalid", invalidKeys(form).includes(li.dataset.key));
      clearCaptureMark(event.target);
      onChange();
    });
    list.addEventListener("click", (event) => {
      const key = event.target.closest("li")?.dataset.key;
      if (key && event.target.closest(".affix-remove")) set(removeCondition(form, key));
    });
    $("affix-select").addEventListener("change", (event) => {
      const entry = AFFIXES.find((e) => e.key === event.target.value);
      if (entry) set(addCondition(form, entry));
    });
    $("stats-base").addEventListener("input", (event) => {
      form = setBase(form, event.target.value);
      event.target.dataset.from = "";
      clearCaptureMark(event.target);
      onChange();
    });
    for (const radio of qualityRadios()) {
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
