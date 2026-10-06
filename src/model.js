// Pure rules and helpers: no storage, no DOM. Everything here is unit tested.

export const MMOL = 18.0182;
export const LINK_BEFORE_MIN = 30;   // starting proposal; tune on real data
export const LINK_AFTER_MIN = 20;    // starting proposal; tune on real data
export const OVERLAP_MIN = 10;       // Libre-app log vs in-app log duplicate window

export const toMgdl = (v, unit) => (unit === "mmol/L" ? v * MMOL : v);
export const fromMgdl = (mg, unit) => (unit === "mmol/L" ? mg / MMOL : mg);
export function formatGlucose(mg, unit) {
  if (mg === null || mg === undefined) return "—";
  return unit === "mmol/L" ? fromMgdl(mg, unit).toFixed(1) : String(Math.round(mg));
}

/** Minutes between dose and meal start. Positive = dose was BEFORE the meal. */
export const preBolusGapMin = (doseT, mealT) => Math.round((mealT - doseT) / 60000);

/** Rapid doses close enough to a meal start to suggest linking. */
export function suggestDoseLinks(mealT, doses) {
  return doses.filter((d) => !d.deleted && d.role === "rapid" && d.t >= mealT - LINK_BEFORE_MIN * 60000 &&
    d.t <= mealT + LINK_AFTER_MIN * 60000);
}

const NUTRIENTS = ["carb", "protein", "fat", "fibre", "sugar"];

/** Sum item macros. Items with a missing value contribute 0 and mark the total as incomplete. */
export function mealTotals(items) {
  const totals = { carb: 0, protein: 0, fat: 0, fibre: 0, sugar: 0, incomplete: false };
  for (const it of items) {
    for (const n of NUTRIENTS) {
      const v = it[n];
      if (v === null || v === undefined || Number.isNaN(v)) { if (n !== "sugar" && n !== "fibre") totals.incomplete = true; }
      else totals[n] += v;
    }
  }
  for (const n of NUTRIENTS) totals[n] = Math.round(totals[n] * 10) / 10;
  return totals;
}

/** high: logged within 5 min; medium: same day; low: later or imported. */
export function doseConfidence({ occurredAt, loggedAt, source }) {
  if (source && source !== "app") return "low";
  const lag = (loggedAt - occurredAt) / 60000;
  if (lag <= 5) return "high";
  if (lag <= 24 * 60) return "medium";
  return "low";
}

export function validateDose(d, increment = 0.5) {
  const errs = [];
  if (!(d.units > 0)) errs.push("Units must be more than 0.");
  if (d.units > 100) errs.push("Units look too high. Check the entry.");
  if (d.units && Math.abs(d.units / increment - Math.round(d.units / increment)) > 1e-6) {
    errs.push(`Units must be a multiple of ${increment}.`);
  }
  if (!["rapid", "long"].includes(d.role)) errs.push("Choose rapid or long-acting.");
  if (!Number.isFinite(d.t)) errs.push("Time is not valid.");
  return errs;
}

/** Pairs of (libre_app event, in-app event) of the same kind within the window: probable duplicates. */
export function findImportOverlaps(records, windowMin = OVERLAP_MIN) {
  const live = records.filter((r) => !r.deleted);
  const kinds = ["dose", "meal"];
  const pairs = [];
  for (const kind of kinds) {
    const app = live.filter((r) => r.kind === kind && r.source === "app");
    const imp = live.filter((r) => r.kind === kind && r.source === "libre_app" && !r.supersededBy);
    for (const i of imp) {
      const hit = app.find((a) => Math.abs(a.t - i.t) <= windowMin * 60000 && (kind === "meal" || a.role === i.role));
      if (hit) pairs.push({ kind, importedId: i.id, appId: hit.id });
    }
  }
  return pairs;
}

/** Gaps longer than thresholdMin in a sorted list of readings. */
export function glucoseGaps(readings, thresholdMin = 30) {
  const auto = readings.filter((r) => r.kind === "auto" && r.mgdl !== null).sort((a, b) => a.t - b.t);
  const gaps = [];
  for (let i = 1; i < auto.length; i++) {
    const mins = (auto[i].t - auto[i - 1].t) / 60000;
    if (mins > thresholdMin) gaps.push({ from: auto[i - 1].t, to: auto[i].t, minutes: Math.round(mins) });
  }
  return gaps;
}

/**
 * Log-completeness prompt (descriptive, never advice): periods where glucose rose by at least riseMgdl within
 * windowMin and no rapid dose was logged between (start - lookbackMin) and the end of the rise.
 * Thresholds are placeholders to be tuned on real data. Off by default in the UI.
 */
export function possibleUnloggedDose(readings, doses, { riseMgdl = 54, windowMin = 60, lookbackMin = 90 } = {}) {
  const auto = readings.filter((r) => r.kind === "auto" && r.mgdl !== null).sort((a, b) => a.t - b.t);
  const rapid = doses.filter((d) => !d.deleted && d.role === "rapid");
  const out = [];
  let skipUntil = -Infinity;
  for (let i = 0; i < auto.length; i++) {
    if (auto[i].t < skipUntil) continue;
    for (let j = i + 1; j < auto.length && auto[j].t - auto[i].t <= windowMin * 60000; j++) {
      if (auto[j].mgdl - auto[i].mgdl >= riseMgdl) {
        const covered = rapid.some((d) => d.t >= auto[i].t - lookbackMin * 60000 && d.t <= auto[j].t);
        if (!covered) out.push({ from: auto[i].t, to: auto[j].t, riseMgdl: Math.round(auto[j].mgdl - auto[i].mgdl) });
        skipUntil = auto[j].t;
        break;
      }
    }
  }
  return out;
}

/** Human description of a strptime format for the ambiguity chooser. */
export function describeFormat(fmt) {
  const order = fmt.indexOf("%d") < fmt.indexOf("%m") ? "Day first" : "Month first";
  const clock = fmt.includes("%p") ? "12-hour clock" : "24-hour clock";
  return `${order} (${fmt.replace(/%/g, "")}), ${clock}`;
}
