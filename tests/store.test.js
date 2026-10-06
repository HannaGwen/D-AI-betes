import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, WrongPassphrase } from "../src/store.js";
import { parseLibreView } from "../src/libreview.js";
import { deriveKey, encryptJson, decryptJson, randomBytes } from "../src/crypto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", n)));
const FAST = { iterations: 1000 };
let n = 0;
const fresh = () => new Store("test-db-" + n++);

test("create, lock, wrong passphrase, unlock", async () => {
  const s = fresh();
  assert.equal(await s.isInitialised(), false);
  await s.create("correct horse battery", { glucoseUnit: "mmol/L", tz: "Europe/London" }, FAST);
  assert.equal(s.unlocked, true);
  s.lock();
  assert.equal(s.unlocked, false);
  await assert.rejects(() => s.unlock("wrong"), WrongPassphrase);
  await s.unlock("correct horse battery");
  assert.equal(s.settings().glucoseUnit, "mmol/L");
});

test("locked store refuses to read or write", async () => {
  const s = fresh();
  await s.create("pass phrase 123", { tz: "UTC" }, FAST);
  s.lock();
  await assert.rejects(() => s.put({ kind: "dose", t: 1, units: 1, role: "rapid" }), /locked/);
  assert.equal(s.list("dose").length, 0);
});

test("stored rows are ciphertext only (no plaintext, only id/iv/ct)", async () => {
  const s = fresh();
  await s.create("another long passphrase", { tz: "UTC" }, FAST);
  const secret = "ZZ-SECRET-NOTE-ZZ";
  await s.put({ kind: "tag", tag: "note", t: 5, payload: { text: secret } });
  const db = await new Promise((res) => { const r = indexedDB.open(s.dbName); r.onsuccess = () => res(r.result); });
  const rows = await new Promise((res) => { const q = db.transaction("records").objectStore("records").getAll(); q.onsuccess = () => res(q.result); });
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["ct", "id", "iv"]);
    const blob = Buffer.from(row.ct).toString("latin1") + row.id;
    assert.ok(!blob.includes(secret));
  }
  db.close();
});

test("ciphertext is bound to its record id (swap fails)", async () => {
  const key = await deriveKey("pw", randomBytes(16), 1000);
  const { iv, ct } = await encryptJson(key, { a: 1 }, "id-1");
  assert.deepEqual(await decryptJson(key, iv, ct, "id-1"), { a: 1 });
  await assert.rejects(() => decryptJson(key, iv, ct, "id-2"));
});

test("edits keep revisions; delete is soft and restorable", async () => {
  const s = fresh();
  await s.create("passphrase for tests", { tz: "UTC" }, FAST);
  const d = await s.put({ kind: "dose", role: "rapid", units: 4, t: 1000, source: "app" });
  await s.put({ ...d, units: 5 });
  assert.equal(s.get(d.id).units, 5);
  assert.equal((await s.exportAll()).revisionCount, 1);
  await s.remove(d.id);
  assert.equal(s.list("dose").length, 0);
  assert.equal(s.list("dose", { includeDeleted: true }).length, 1);
  await s.restore(d.id);
  assert.equal(s.list("dose").length, 1);
  assert.equal(s.get(d.id).deleted, undefined);
});

test("data survives lock/unlock and a fresh Store instance", async () => {
  const s = fresh();
  await s.create("persistence passphrase", { tz: "UTC" }, FAST);
  await s.put({ kind: "meal", t: 42, title: "Toast", items: [], totals: { carb: 30 }, source: "app" });
  const again = new Store(s.dbName);
  await again.unlock("persistence passphrase");
  assert.equal(again.list("meal")[0].title, "Toast");
});

test("import is idempotent and overlapping files add only new rows", async () => {
  const s = fresh();
  await s.create("import passphrase ok", { tz: "America/New_York" }, FAST);
  const p = parseLibreView(fixture("us_basic.csv"), { tz: "America/New_York" });
  const r1 = await s.importBatch(p, { tz: "America/New_York", fileName: "a.csv" });
  assert.equal(r1.newGlucose, 13);          // 11 auto + 1 scan + 1 strip
  assert.equal(r1.newEvents, 4);            // 2 insulin + 1 food + 1 note
  const nonBatch = () => s.all().filter((r) => r.kind !== "import_batch").length;
  const glucoseBefore = s.glucoseAll().length, eventsBefore = nonBatch();
  assert.equal(eventsBefore, 4);
  const r2 = await s.importBatch(p, { tz: "America/New_York", fileName: "a-again.csv" });
  assert.equal(r2.newGlucose, 0);
  assert.equal(r2.newEvents, 0);
  assert.equal(r2.skippedGlucose, 13);
  assert.equal(r2.skippedEvents, 4);
  assert.equal(s.glucoseAll().length, glucoseBefore);
  assert.equal(nonBatch(), eventsBefore);                    // no duplicate records created
  // overlapping file: shifts the same readings, only genuinely new rows are added
  const extra = new TextEncoder().encode(new TextDecoder().decode(fixture("us_basic.csv")) +
    "FreeStyle LibreLink,SER-1,07-16-2021 09:00 AM,0,118,,,,,,,,,,,,,,\n");
  const r3 = await s.importBatch(parseLibreView(extra, { tz: "America/New_York" }), { tz: "America/New_York", fileName: "longer.csv" });
  assert.equal(r3.newGlucose, 1);
  assert.equal(r3.newEvents, 0);
});

test("undo removes exactly that batch", async () => {
  const s = fresh();
  await s.create("undo passphrase here", { tz: "America/New_York" }, FAST);
  const a = await s.importBatch(parseLibreView(fixture("us_basic.csv"), { tz: "America/New_York" }), { tz: "America/New_York", fileName: "a" });
  const b = await s.importBatch(parseLibreView(fixture("libre3_name.csv"), { tz: "America/New_York" }), { tz: "America/New_York", fileName: "b" });
  assert.equal(b.newGlucose, 2);
  const total = s.glucoseAll().length;
  assert.equal(await s.undoBatch(b.batchId), true);
  assert.equal(s.glucoseAll().length, total - 2);
  assert.equal(s.get(b.batchId).undoneAt > 0, true);
  assert.equal(s.list("dose").length, 2);                      // batch a's doses untouched
  assert.equal(await s.undoBatch(b.batchId), false);          // already undone
  assert.ok(a.batchId);
});

test("imported Libre-app logs near in-app logs are flagged, not deleted", async () => {
  const s = fresh();
  await s.create("overlap passphrase here", { tz: "America/New_York" }, FAST);
  const p = parseLibreView(fixture("us_basic.csv"), { tz: "America/New_York" });
  const rapid = p.events.find((e) => e.kind === "insulin" && e.data.role === "rapid");
  await s.put({ kind: "dose", role: "rapid", units: 6, t: rapid.utcMs + 4 * 60000, source: "app", confidence: "high" });
  const r = await s.importBatch(p, { tz: "America/New_York", fileName: "a" });
  assert.equal(r.overlaps, 1);
  const imported = s.list("dose").find((d) => d.source === "libre_app" && d.role === "rapid");
  assert.ok(imported.supersededBy);
  assert.equal(s.list("dose").length, 3);                    // nothing removed
});

test("export is complete and wipe removes the database", async () => {
  const s = fresh();
  await s.create("export passphrase here", { tz: "UTC" }, FAST);
  await s.importBatch(parseLibreView(fixture("uk_mmol.csv"), { tz: "Europe/London" }), { tz: "Europe/London", fileName: "uk" });
  const out = await s.exportAll();
  assert.equal(out.glucose.length, 13);
  assert.ok(out.importBatches.length === 1);
  assert.ok(!JSON.stringify(out).includes("export passphrase here"));
  const name = s.dbName;
  await s.wipe();
  const s2 = new Store(name);
  assert.equal(await s2.isInitialised(), false);
});
