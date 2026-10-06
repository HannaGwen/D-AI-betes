// Parity tests: the JavaScript importer must reproduce the Python reference's golden outputs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseLibreView, AmbiguousDateFormat, ParseError } from "../src/libreview.js";
import { sha256Hex, sha256Bytes } from "../src/sha256.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures"), GOLD = path.join(here, "golden");
const manifest = JSON.parse(fs.readFileSync(path.join(GOLD, "manifest.json"), "utf8"));
const roundtrip = (x) => JSON.parse(JSON.stringify(x));

test("sha256 matches node crypto (various lengths)", () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 5000]) {
    const bytes = crypto.randomBytes(n);
    assert.equal(sha256Bytes(bytes), crypto.createHash("sha256").update(bytes).digest("hex"), `len ${n}`);
  }
  assert.equal(sha256Hex("héllo\x1fwörld"), crypto.createHash("sha256").update("héllo\x1fwörld", "utf8").digest("hex"));
});

for (const entry of manifest) {
  test(`golden parity: ${entry.name}`, () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, entry.file)));
    const golden = JSON.parse(fs.readFileSync(path.join(GOLD, `${entry.name}.json`), "utf8"));
    const opts = { tz: entry.tz, dateFormat: entry.date_format || undefined };
    if (entry.expect === "error") return assert.throws(() => parseLibreView(bytes, opts), ParseError);
    if (entry.expect === "ambiguous") {
      try { parseLibreView(bytes, opts); assert.fail("expected AmbiguousDateFormat"); }
      catch (e) { assert.ok(e instanceof AmbiguousDateFormat); assert.deepEqual(e.candidates, golden.candidates); }
      return;
    }
    const res = parseLibreView(bytes, opts);
    assert.equal(res.fileHash, golden.file_hash);
    assert.deepStrictEqual(roundtrip(res.report), golden.report);
    const events = res.events.map((e) => roundtrip({
      kind: e.kind, local: e.local, utc: e.utc, source_row: e.source_row, row_hash: e.row_hash,
      device: e.device, serial: e.serial, flags: e.flags, data: e.data,
    }));
    assert.deepStrictEqual(events, golden.events);
  });
}

test("account name and date of birth never appear in output", () => {
  for (const name of ["us_basic", "provider"]) {
    const res = parseLibreView(new Uint8Array(fs.readFileSync(path.join(FIX, `${name}.csv`))), { tz: "America/New_York" });
    const blob = JSON.stringify(res);
    assert.ok(!blob.includes("Test Persona"));
    assert.ok(!blob.includes("1/1/1980"));
  }
});

test("re-parsing the same bytes is deterministic", () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, "us_basic.csv")));
  const a = parseLibreView(bytes, { tz: "America/New_York" }), b = parseLibreView(bytes, { tz: "America/New_York" });
  assert.deepStrictEqual(a.events.map((e) => e.row_hash), b.events.map((e) => e.row_hash));
});

// Optional: public sample (set LIBREVIEW_SAMPLE). Never commit real exports.
test("public sample matches independent counts", { skip: !process.env.LIBREVIEW_SAMPLE }, () => {
  const res = parseLibreView(new Uint8Array(fs.readFileSync(process.env.LIBREVIEW_SAMPLE)), { tz: "America/New_York" });
  const r = res.report;
  assert.deepStrictEqual(r.record_type_counts, { 0: 3562, 1: 317, 5: 3, 6: 102 });
  assert.equal(r.events_by_kind.glucose_auto, 3562);
  assert.equal(r.empty_rows_discarded, 99);
  assert.equal(r.gaps_over_30_min.count, 41);
  assert.equal(r.auto_reading_interval_minutes.median, 15);
});
