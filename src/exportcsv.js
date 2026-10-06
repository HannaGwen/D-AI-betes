// CSV builders for the Phase 0b notebooks. Pure functions, unit tested.
import { fromMgdl } from "./model.js";
import { isoUtc, utcToLocalParts } from "./timeutil.js";

const needsQuote = /[",\n\r;]/;
const cell = (v) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (columns, rows) =>
  [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";

const localStr = (t, tz) => {
  const p = utcToLocalParts(t, tz), z = (n) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`;
};

export function buildCsvs(exp, tz) {
  const glucose = exp.glucose.map((g) => ({ utc: isoUtc(g.t), local: localStr(g.t, tz), mgdl: g.mgdl,
    mmol: g.mgdl === null ? null : Number(fromMgdl(g.mgdl, "mmol/L").toFixed(2)), kind: g.kind, batch: g.b, raw_text: g.txt }));
  const doses = exp.doses.map((d) => ({ id: d.id, utc: isoUtc(d.t), local: localStr(d.t, tz), role: d.role, units: d.units,
    purpose: d.purpose, meal_id: d.mealId, source: d.source, confidence: d.confidence, superseded_by: d.supersededBy,
    insulin: d.insulin, site: d.site, notes: d.notes, deleted: d.deleted ? 1 : 0 }));
  const meals = exp.meals.map((m) => ({ id: m.id, utc: isoUtc(m.t), local: localStr(m.t, tz), title: m.title,
    carb_g: m.totals?.carb, protein_g: m.totals?.protein, fat_g: m.totals?.fat, fibre_g: m.totals?.fibre, sugar_g: m.totals?.sugar,
    carbs_used_for_dosing_g: m.carbsUsedForDosing, confidence: m.confidence, source: m.source, items: m.items,
    superseded_by: m.supersededBy, deleted: m.deleted ? 1 : 0 }));
  const tags = exp.tags.map((t) => ({ id: t.id, utc: isoUtc(t.t), local: localStr(t.t, tz), tag: t.tag, duration_min: t.durationMin,
    details: t.payload, source: t.source, deleted: t.deleted ? 1 : 0 }));
  return {
    "glucose.csv": toCsv(["utc", "local", "mgdl", "mmol", "kind", "batch", "raw_text"], glucose),
    "doses.csv": toCsv(["id", "utc", "local", "role", "units", "purpose", "meal_id", "source", "confidence", "superseded_by", "insulin", "site", "notes", "deleted"], doses),
    "meals.csv": toCsv(["id", "utc", "local", "title", "carb_g", "protein_g", "fat_g", "fibre_g", "sugar_g", "carbs_used_for_dosing_g", "confidence", "source", "items", "superseded_by", "deleted"], meals),
    "tags.csv": toCsv(["id", "utc", "local", "tag", "duration_min", "details", "source", "deleted"], tags),
  };
}
