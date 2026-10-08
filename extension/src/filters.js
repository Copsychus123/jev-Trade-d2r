// Filter logic for rows (trading listings and recent trades). No DOM or chrome.* here: it is also tested under node.

export const FILTER_FIELDS = [
  {
    key: "platform",
    label: "平台",
    options: ["PC", "Playstation", "Xbox", "Switch"],
  },
  {
    key: "mode",
    label: "模式",
    options: ["Softcore", "Hardcore"],
  },
  {
    key: "ladder",
    label: "天梯",
    options: ["Ladder", "Non Ladder"],
  },
  {
    key: "game_version",
    label: "遊戲版本",
    options: ["Reign of the Warlock", "Lord of Destruction", "Classic (Base Game)"],
  },
];

export const FILTER_OPTION_LABELS = {
  PC: "PC",
  Playstation: "PlayStation",
  Xbox: "Xbox",
  Switch: "Switch",
  Softcore: "Softcore",
  Hardcore: "Hardcore",
  Ladder: "Ladder",
  "Non Ladder": "Non Ladder",
  "Reign of the Warlock": "Reign of the Warlock（新版）",
  "Lord of Destruction": "Lord of Destruction（舊版）",
  "Classic (Base Game)": "Classic（原版）",
};

export const EMPTY_FILTERS = {
  platform: "",
  mode: "",
  ladder: "",
  game_version: "",
};

export const COMMON_PRESET = {
  platform: "PC",
  mode: "Softcore",
  ladder: "Ladder",
  game_version: "",
};

/**
 * Normalize filter values to safe state.
 * Returns a fresh object with exactly the four keys; any key missing, non-string or not one of that
 * field's options becomes "" (so stale/corrupt chrome.storage content is safe).
 * Never mutates input.
 */
export function normalizeFilters(value) {
  const result = { ...EMPTY_FILTERS };

  if (typeof value !== "object" || value === null) return result;

  for (const { key, options } of FILTER_FIELDS) {
    const val = value[key];
    if (typeof val === "string" && options.includes(val)) result[key] = val;
  }

  return result;
}

/**
 * Check if any filter field is active (non-empty).
 */
export function filtersActive(filters) {
  return Object.values(filters).some((v) => v !== "");
}

/**
 * Apply filters to rows.
 * Returns { rows, hidden, unknown }.
 * - rows: the kept rows in original order (same row objects, not copies)
 * - hidden: rows.length - kept.length
 * - unknown: number of hidden rows that were hidden only because an active field's value was missing
 *   (no active field had a different non-empty value). A mismatch takes precedence over unknown.
 * Does not mutate input rows/array.
 */
export function applyFilters(rows, filters) {
  if (!filtersActive(filters)) {
    return { rows, hidden: 0, unknown: 0 };
  }

  const activeFields = Object.keys(filters).filter((field) => filters[field] !== "");
  const keptRows = [];
  let unknown = 0;

  for (const row of rows) {
    let hasMismatch = false;
    let hasMissing = false;

    for (const field of activeFields) {
      const rowValue = row[field];
      if (rowValue === filters[field]) continue;
      if (rowValue === null || rowValue === undefined || rowValue === "") {
        hasMissing = true;
      } else {
        hasMismatch = true;
        break;
      }
    }

    if (hasMismatch) continue;
    if (hasMissing) unknown += 1;
    else keptRows.push(row);
  }

  return {
    rows: keptRows,
    hidden: rows.length - keptRows.length,
    unknown,
  };
}

/**
 * Describe filters as a short string of active choices joined by " · "
 * using FILTER_OPTION_LABELS values without the field label.
 * Returns "" when none active.
 */
export function describeFilters(filters) {
  const descriptions = [];

  for (const field of FILTER_FIELDS) {
    const key = field.key;
    if (filters[key] !== "") {
      const label = FILTER_OPTION_LABELS[filters[key]];
      descriptions.push(label || filters[key]);
    }
  }

  return descriptions.join(" · ");
}
