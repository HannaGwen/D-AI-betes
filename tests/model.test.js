import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/model.js";
import * as T from "../src/timeutil.js";

const MIN = 60000;

test("pre-bolus gap sign: positive when dose before meal", () => {
  assert.equal(M.preBolusGapMin(0, 15 * MIN), 15);
  assert.equal(M.preBolusGapMin(10 * MIN, 0), -10);
});

test("dose link window: -30 to +20 minutes, rapid only, not deleted", () => {
  const meal = 100 * MIN;
  const d = (id, off, role = "rapid", extra = {}) => ({ id, role, t: meal + off * MIN, ...extra });
  const hits = M.suggestDoseLinks(meal, [d("a", -30), d("b", 20), d("c", -31), d("d", 21), d("e", 0, "long"), d("f", 0, "rapid", { deleted: true })]);
  assert.deepEqual(hits.map((x) => x.id), ["a", "b"]);
});

test("meal totals add macros and flag missing carbs/protein/fat", () => {
  const t = M.mealTotals([{ carb: 30, protein: 5, fat: 2 }, { carb: 10.5, protein: 1, fat: 0.4, fibre: 3 }]);
  assert.deepEqual([t.carb, t.protein, t.fat, t.fibre, t.incomplete], [40.5, 6, 2.4, 3, false]);
  assert.equal(M.mealTotals([{ carb: 5, protein: null, fat: 1 }]).incomplete, true);
});

test("dose confidence levels", () => {
  const t = 1e9;
  assert.equal(M.doseConfidence({ occurredAt: t, loggedAt: t + 3 * MIN, source: "app" }), "high");
  assert.equal(M.doseConfidence({ occurredAt: t, loggedAt: t + 60 * MIN, source: "app" }), "medium");
  assert.equal(M.doseConfidence({ occurredAt: t, loggedAt: t + 30 * 60 * MIN, source: "app" }), "low");
  assert.equal(M.doseConfidence({ occurredAt: t, loggedAt: t, source: "libre_app" }), "low");
});

test("dose validation respects pen increment", () => {
  assert.deepEqual(M.validateDose({ units: 4.5, role: "rapid", t: 1 }, 0.5), []);
  assert.ok(M.validateDose({ units: 4.3, role: "rapid", t: 1 }, 0.5).length);
  assert.ok(M.validateDose({ units: 0, role: "rapid", t: 1 }).length);
  assert.ok(M.validateDose({ units: 150, role: "rapid", t: 1 }).length);
  assert.ok(M.validateDose({ units: 4, role: "x", t: 1 }).length);
});

test("glucose unit conversion round trip and formatting", () => {
  assert.equal(M.formatGlucose(99.1, "mmol/L"), "5.5");
  assert.equal(M.formatGlucose(99.1, "mg/dL"), "99");
  assert.equal(M.formatGlucose(null, "mg/dL"), "—");
  assert.ok(Math.abs(M.toMgdl(M.fromMgdl(120, "mmol/L"), "mmol/L") - 120) < 1e-9);
});

test("overlaps: same kind within 10 min (dose also needs same role)", () => {
  const recs = [
    { id: "a", kind: "dose", role: "rapid", t: 0, source: "app" },
    { id: "i1", kind: "dose", role: "rapid", t: 9 * MIN, source: "libre_app" },
    { id: "i2", kind: "dose", role: "long", t: 1 * MIN, source: "libre_app" },
    { id: "i3", kind: "dose", role: "rapid", t: 11 * MIN, source: "libre_app" },
    { id: "m", kind: "meal", t: 0, source: "app" },
    { id: "im", kind: "meal", t: -5 * MIN, source: "libre_app" },
  ];
  const pairs = M.findImportOverlaps(recs);
  assert.deepEqual(pairs.map((p) => p.importedId).sort(), ["i1", "im"]);
});

test("gaps from real timestamps", () => {
  const r = [0, 15, 31, 46, 169].map((m, i) => ({ t: m * MIN, mgdl: 100 + i, kind: "auto" }));
  const g = M.glucoseGaps(r);
  assert.equal(g.length, 1);
  assert.equal(g[0].minutes, 123);
});

test("possible unlogged dose: needs a rise and no rapid dose nearby", () => {
  const rd = (m, v) => ({ t: m * MIN, mgdl: v, kind: "auto" });
  const readings = [rd(0, 100), rd(15, 120), rd(30, 150), rd(45, 170), rd(60, 175)];
  assert.equal(M.possibleUnloggedDose(readings, []).length, 1);
  assert.equal(M.possibleUnloggedDose(readings, [{ role: "rapid", t: -20 * MIN }]).length, 0);
  assert.equal(M.possibleUnloggedDose(readings, [{ role: "long", t: -20 * MIN }]).length, 1);
  assert.equal(M.possibleUnloggedDose([rd(0, 100), rd(15, 110), rd(30, 120)], []).length, 0);
});

test("describeFormat names day/month order", () => {
  assert.match(M.describeFormat("%d-%m-%Y %H:%M"), /^Day first/);
  assert.match(M.describeFormat("%m-%d-%Y %I:%M %p"), /^Month first.*12-hour/);
});

test("time helpers: London summer/winter offsets and input round trip", () => {
  assert.equal(T.offsetMinutesAt(Date.UTC(2023, 5, 15, 12), "Europe/London"), 60);
  assert.equal(T.offsetMinutesAt(Date.UTC(2023, 0, 15, 12), "Europe/London"), 0);
  const utc = T.fromInputValue("2023-06-15T12:00", "Europe/London");
  assert.equal(new Date(utc).toISOString(), "2023-06-15T11:00:00.000Z");
  assert.equal(T.toInputValue(utc, "Europe/London"), "2023-06-15T12:00");
  assert.equal(T.localDateKey(Date.UTC(2023, 5, 15, 23, 30), "Europe/London"), "2023-06-16");
  assert.equal(T.addDays("2023-03-01", -1), "2023-02-28");
  const start = T.dayStartUtc("2023-03-26", "Europe/London"), end = T.dayStartUtc("2023-03-27", "Europe/London");
  assert.equal((end - start) / 3600000, 23);                 // spring-forward day is 23 hours long
});
