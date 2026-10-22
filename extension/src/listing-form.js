// The TR交易 screen's form: what a scan record becomes on the way to Traderie. DOM only; the form's logic (what it
// starts from, what blocks it, what is sent) lives in traderie/listing.js. Every value shown is page- or OCR-derived
// text, so it is written with textContent. A number the reader filled in is marked as coming from the capture (dashed
// border, the same mark the affix form uses); editing the control clears the mark.
import { $, clearCaptureMark, element } from "./dom.js";
import { AFFIXES } from "./ocr/affix_dictionary.js";
import { LISTING_FIELDS } from "./listing-defaults.js";
import { guardProblem } from "./run-outcome.js";
import { MAX_PRICE_GROUPS, RARITY_OPTIONS, addListingCondition, emptyListingForm, listingBlocker, runeProducts } from "./traderie/listing.js";
import { labelWithChinese } from "./traderie/lookup.js";

const FROM_CAPTURE_TITLE = "從擷取讀到，請確認";
const FROM_LEARNED_TITLE = "照你上次改的數字";
const UNAVAILABLE_NOTE = "Traderie 這件物品沒有這個欄位";
const CATEGORY_LABEL = { uniques: "暗金", sets: "套裝", runewords: "符文之語", base: "底材", misc: "其他", runes: "符文" };

function fillSelect(select, options, blankLabel = null) {
  select.replaceChildren();
  if (blankLabel !== null) select.append(new Option(blankLabel, ""));
  for (const { value, label } of options) select.append(new Option(label, value));
}

/**
 * `getTables()` gives the indexed item tables (with `products`), `getDefaults()` the saved listing defaults, and
 * `onChange()` is called after every edit so the owner can re-judge the 上架 button. Returns
 * `{ load(record), get(), setBusy(busy), showResult(result), reset() }`.
 */
export function initListingForm({ getTables, getDefaults, onChange, getBlock = () => "" }) {
  let form = null;
  let busy = false;
  let posted = false; // a post was attempted on this form: 上架 stays off until load() runs again
  let runes = [];

  /** A ✕ button; `busy` is read when the row is drawn. */
  function removeButton(className, ariaLabel) {
    const button = element("button", { type: "button", className, textContent: "✕" });
    button.setAttribute("aria-label", ariaLabel);
    button.disabled = busy;
    return button;
  }

  function drawItem() {
    const tables = getTables();
    const name = form.record?.name ?? "";
    const category = form.product ? (CATEGORY_LABEL[form.product.category] ?? form.product.category) : "不在物品表裡";
    $("listing-item").textContent = `${labelWithChinese(name, tables)} · ${category}`;
  }

  function drawRarity() {
    const row = $("listing-rarity-row");
    row.hidden = form.rarity === null;
    if (form.rarity === null) return;
    const select = $("listing-rarity");
    fillSelect(select, RARITY_OPTIONS, "請選擇");
    select.value = form.rarity;
    clearCaptureMark(select);
    if (form.rarityFromCapture) {
      select.classList.add("from-capture");
      select.title = FROM_CAPTURE_TITLE;
    }
    select.disabled = busy;
  }

  /** The number box of a ranged condition; marked as read from the capture, or as the player's earlier correction. */
  function valueInput(condition) {
    const filled = condition.value !== null && condition.value !== "";
    const captured = condition.fromCapture && filled;
    const learned = condition.learned && filled && Number(condition.value) === condition.readValue;
    const input = element("input", {
      type: "number",
      className: `affix-value${captured ? " from-capture" : ""}${learned ? " from-learned" : ""}`,
      min: "0",
      step: "1",
      value: condition.value ?? "",
    });
    input.setAttribute("aria-label", `${condition.label}數值`);
    if (captured) input.title = FROM_CAPTURE_TITLE;
    if (learned) input.title = FROM_LEARNED_TITLE;
    input.disabled = busy || condition.available === false;
    input.addEventListener("input", () => {
      condition.value = input.value === "" ? null : input.value;
      condition.fromCapture = false;
      clearCaptureMark(input);
      onChange();
    });
    return input;
  }

  function affixRow(condition) {
    const li = element("li", { className: `affix${condition.available === false ? " unmapped" : ""}` });
    const label = element("label");
    const on = element("input", { type: "checkbox", className: "affix-on", checked: condition.on });
    on.disabled = busy || condition.available === false;
    on.addEventListener("change", () => {
      condition.on = on.checked;
      onChange();
    });
    label.append(on, document.createTextNode(` ${condition.label}`));
    li.append(label);
    if (condition.kind !== "bool") li.append(valueInput(condition));
    if (condition.available === false) li.append(element("span", { className: "muted small", textContent: UNAVAILABLE_NOTE }));
    if (condition.added) {
      // A row the player added by hand can be taken off again; a row the reader found is unticked instead.
      const remove = removeButton("affix-remove icon", `移除${condition.label}`);
      remove.addEventListener("click", () => {
        form.conditions.splice(form.conditions.indexOf(condition), 1);
        drawAffixes();
        onChange();
      });
      li.append(remove);
    }
    return li;
  }

  function drawAffixes() {
    $("listing-affixes").replaceChildren(...form.conditions.map(affixRow));
    const select = $("listing-affix-select");
    select.replaceChildren(new Option("新增上架屬性…", ""));
    for (const entry of AFFIXES) {
      if (!form.conditions.some((c) => c.key === entry.key)) select.append(new Option(`${entry.zh}（${entry.en}）`, entry.key));
    }
    select.value = "";
    select.disabled = busy;
  }

  function groupRow(group, index) {
    const row = element("div", { className: "row price-group" });
    const select = element("select", { className: "rune" });
    select.setAttribute("aria-label", `第 ${index + 1} 組符文`);
    fillSelect(select, runes, "請選符文");
    select.value = group.rune;
    select.disabled = busy || form.makeOffer;
    select.addEventListener("change", () => {
      group.rune = select.value;
      onChange();
    });
    const qty = element("input", { type: "number", className: "qty", min: "1", step: "1", value: group.quantity });
    qty.setAttribute("aria-label", `第 ${index + 1} 組數量`);
    qty.disabled = busy || form.makeOffer;
    qty.addEventListener("input", () => {
      group.quantity = qty.value;
      onChange();
    });
    row.append(select, qty);
    if (index > 0) {
      const remove = removeButton("remove", `刪除第 ${index + 1} 組`);
      remove.addEventListener("click", () => {
        form.prices.splice(index, 1);
        drawPrices();
        onChange();
      });
      row.append(remove);
    }
    return row;
  }

  function drawPrices() {
    $("listing-groups").replaceChildren(...form.prices.map(groupRow));
    $("listing-group-add").hidden = form.prices.length >= MAX_PRICE_GROUPS || form.makeOffer;
    $("listing-group-add").disabled = busy;
    const offer = $("listing-make-offer");
    offer.checked = form.makeOffer;
    offer.disabled = busy;
  }

  function drawEnvSummary() {
    const shown = LISTING_FIELDS.map(({ key, options }) => options.find((o) => o.value === form.env[key])?.label ?? form.env[key]);
    $("listing-env-summary").textContent = shown.join(" · ");
  }

  function drawEnv() {
    for (const { key, options } of LISTING_FIELDS) {
      const select = $(`listing-env-${key}`);
      fillSelect(select, options);
      select.value = form.env[key];
      select.disabled = busy;
    }
    drawEnvSummary();
    const amount = $("listing-amount");
    amount.value = form.amount;
    amount.disabled = busy;
  }

  function drawButtons() {
    const blocker = form ? getBlock() || listingBlocker(form) : "沒有要上架的紀錄";
    $("listing-post").disabled = busy || posted || Boolean(blocker);
    $("listing-why").textContent = blocker;
    $("listing-why").hidden = !blocker;
  }

  function draw() {
    drawItem();
    drawRarity();
    drawAffixes();
    drawPrices();
    drawEnv();
    drawButtons();
  }

  // The fixed controls are wired once; each reads the current form when it fires, and does nothing while there is none.
  const wire = (id, type, apply) =>
    $(id).addEventListener(type, () => {
      if (form) apply($(id));
    });
  wire("listing-affix-select", "change", (select) => {
    const entry = AFFIXES.find((e) => e.key === select.value);
    if (!entry || !addListingCondition(form, entry)) return;
    drawAffixes();
    onChange();
  });
  wire("listing-group-add", "click", () => {
    if (form.prices.length >= MAX_PRICE_GROUPS) return;
    form.prices.push({ rune: "", quantity: 1 });
    drawPrices();
    onChange();
  });
  wire("listing-make-offer", "change", (offer) => {
    form.makeOffer = offer.checked;
    drawPrices();
    onChange();
  });
  wire("listing-rarity", "change", (select) => {
    form.rarity = select.value;
    clearCaptureMark(select);
    onChange();
  });
  for (const { key } of LISTING_FIELDS) {
    wire(`listing-env-${key}`, "change", (select) => {
      form.env[key] = select.value;
      drawEnvSummary();
      onChange();
    });
  }
  wire("listing-amount", "input", (amount) => {
    form.amount = amount.value;
    onChange();
  });

  function resetResult() {
    $("listing-status").textContent = "";
    delete $("listing-status").dataset.tone;
    $("listing-profile-link").hidden = true;
    $("listing-profile-link").href = "#";
    $("listing-open-site").hidden = true;
  }

  return {
    /** A fresh form for `record`: the OCR's lines ticked and marked, the saved defaults in the selects. */
    load(record) {
      const tables = getTables();
      runes = runeProducts(tables).map((r, at) => ({ value: r.name, label: `#${at + 1} ${labelWithChinese(r.name, tables)}` }));
      form = emptyListingForm(record, tables, getDefaults());
      posted = false;
      busy = false;
      resetResult();
      draw();
    },
    get: () => form,
    /** Whether 上架 may run now: a form, no post attempted on it yet, nothing blocking it. */
    canPost: () => Boolean(form) && !busy && !posted && !getBlock() && !listingBlocker(form),
    /** Locks every control while the post runs. */
    setBusy(next) {
      busy = next;
      if (form) draw();
    },
    /** What the post came to: the status line, the link to the listing, the way to the site for a refusal. */
    showResult({ outcome, reason, profileUrl, verified, unavailable = [], unconfirmed = false }) {
      // Only a request that was sent (posted, or failed after sending) locks the form; a refusal or a challenge page sent
      // nothing, so the player can fix the form and press 上架 again without losing their edits.
      posted = outcome === "posted" || outcome === "failed";
      for (const key of unavailable) {
        const condition = form?.conditions.find((c) => c.key === key);
        if (condition) Object.assign(condition, { available: false, on: false }); // greyed and left out of the listing
      }
      if (form) draw();
      const status = $("listing-status");
      if (outcome === "posted") status.textContent = verified ? "已上架：" : reason;
      else if (outcome === "guard") status.textContent = guardProblem().message;
      else status.textContent = reason;
      status.dataset.tone = outcome === "posted" ? (verified ? "ok" : "warn") : "bad";
      // Offered whenever the post went through: the player's own listings page, even when the new listing's id is unknown.
      const profile = $("listing-profile-link");
      profile.hidden = !(outcome === "posted" || unconfirmed) || !profileUrl;
      profile.href = profileUrl || "#";
      profile.textContent = profileUrl ? profileUrl.replace("https://", "") : "";
      $("listing-open-site").hidden = outcome === "posted" || unconfirmed;
    },
    /** Returns the 上架 button to its judged state after an edit. */
    update: () => {
      if (form) drawButtons();
    },
    reset() {
      form = null;
      posted = false;
      resetResult();
    },
  };
}
