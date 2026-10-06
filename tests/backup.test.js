import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { parseLibreView } from "../src/libreview.js";
import { encryptBackup, decryptBackup, isEncryptedBackup, BadBackupPassphrase } from "../src/crypto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", n)));
const FAST = { iterations: 1000 };
const TZ = "America/New_York";
let n = 0;
const fresh = async (pass = "pass phrase one", tz = TZ) => { const s = new Store("bk-" + n++); await s.create(pass, { tz, glucoseUnit: "mmol/L" }, FAST); return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function populate(s) {
  await s.put({ kind: "dose", role: "rapid", units: 6, t: Date.UTC(2021, 6, 14, 16, 0), source: "app", confidence: "high" });
  await s.put({ kind: "meal", t: Date.UTC(2021, 6, 14, 16, 5), title: "Pasta, light", items: [{ name: "pasta", carb: 60 }], totals: { carb: 60 }, carbsUsedForDosing: 55, source: "app" });
  await s.put({ kind: "tag", tag: "exercise", t: Date.UTC(2021, 6, 14, 17, 0), durationMin: 30, payload: { type: "aerobic" }, source: "app" });
  await s.put({ kind: "saved_meal", name: "Usual lunch", items: [{ name: "sandwich", carb: 40 }] });
  await s.importBatch(parseLibreView(fixture("us_basic.csv"), { tz: TZ }), { tz: TZ, fileName: "a.csv" });
}
const snapshot = (s) => ({
  doses: s.list("dose").map((d) => [d.id, d.units, d.t]).sort(), meals: s.list("meal").map((m) => [m.id, m.title, m.totals?.carb]).sort(),
  tags: s.list("tag").map((t) => [t.id, t.tag]).sort(), saved: s.list("saved_meal").map((m) => [m.id, m.name]).sort(),
  glucose: s.glucoseAll().map((g) => [g.t, g.mgdl, g.kind]),
});

test("encrypted backup envelope round-trips and hides content", async () => {
  const secret = { note: "ZZ-SECRET-ZZ", glucose: [1, 2, 3] };
  const env = await encryptBackup("backup pass 123", secret, 1000);
  assert.ok(isEncryptedBackup(env));
  assert.ok(!JSON.stringify(env).includes("ZZ-SECRET-ZZ"));
  assert.deepEqual(await decryptBackup("backup pass 123", env), secret);
  await assert.rejects(() => decryptBackup("wrong pass 123", env), BadBackupPassphrase);
  await assert.rejects(() => decryptBackup("backup pass 123", { ...env, iterations: 1 }), /unusual settings/);
  await assert.rejects(() => decryptBackup("backup pass 123", { app: "other" }), /not an encrypted/);
});

test("full backup restores into a brand-new log with a different passphrase", async () => {
  const a = await fresh("original passphrase 1");
  await populate(a);
  const env = await encryptBackup("backup pass 123", await a.exportAll(), 1000);
  const b = await fresh("a completely different one");
  const plain = await decryptBackup("backup pass 123", env);
  const c = await b.restoreBackup(plain);
  assert.equal(c.records >= 5, true);
  assert.deepEqual(snapshot(b), snapshot(a));
  assert.equal(b.settings().glucoseUnit, "mmol/L");                                  // own settings untouched
  const again = await b.restoreBackup(plain);                                          // idempotent
  assert.equal(again.records, 0); assert.equal(again.glucose, 0);
  assert.deepEqual(snapshot(b), snapshot(a));
});

test("'new entries only' backup contains just what changed since, and merges on top of a full one", async () => {
  const a = await fresh();
  await populate(a);
  const full = await a.exportAll();
  await sleep(10);
  const since = Date.now();
  await sleep(10);
  const extraDose = await a.put({ kind: "dose", role: "long", units: 14, t: Date.UTC(2021, 6, 14, 22, 0), source: "app" });
  const meal = a.list("meal")[0];
  await a.put({ ...meal, title: "Pasta (edited)" });
  await a.importBatch(parseLibreView(fixture("libre3_name.csv"), { tz: TZ }), { tz: TZ, fileName: "b.csv" });
  const delta = await a.exportAll({ since });
  assert.equal(delta.scope, "since");
  assert.deepEqual(delta.doses.map((d) => d.id), [extraDose.id]);
  assert.deepEqual(delta.meals.map((m) => m.title), ["Pasta (edited)"]);
  assert.equal(delta.tags.length, 0);
  assert.equal(delta.glucose.length, 2);
  const b = await fresh("other passphrase here");
  await b.restoreBackup(full);
  await b.restoreBackup(delta);
  assert.deepEqual(snapshot(b), snapshot(a));
  assert.equal(b.list("meal")[0].title, "Pasta (edited)");
});

test("an older copy never overwrites a newer one; a newer copy replaces and keeps a revision", async () => {
  const a = await fresh();
  const d = await a.put({ kind: "dose", role: "rapid", units: 4, t: 1000, source: "app" });
  const older = await a.exportAll();
  await sleep(5);
  await a.put({ ...d, units: 5 });
  const c1 = await a.restoreBackup(older);
  assert.equal(c1.records, 0);
  assert.equal(a.get(d.id).units, 5);
  const b = await fresh("another passphrase ok");
  await b.restoreBackup(older);
  const newer = await a.exportAll();
  const before = (await b.exportAll()).revisionCount;
  await b.restoreBackup(newer);
  assert.equal(b.get(d.id).units, 5);
  assert.equal((await b.exportAll()).revisionCount, before + 1);
});

test("invalid or malicious backups are rejected or skipped", async () => {
  const s = await fresh();
  await assert.rejects(() => s.restoreBackup({ app: "other", format: 1 }), /not a T1D Log backup/);
  await assert.rejects(() => s.restoreBackup(null), /not a T1D Log backup/);
  const bad = { app: "t1dlog", format: 1, doses: [{ id: "g:2023-01-01", kind: "dose", t: 1 }, { id: "settings", kind: "dose", t: 1 }, { id: "x", kind: "settings", t: 1 },
    { id: "y", kind: "dose", t: "NaN" }, { id: "ok1", kind: "dose", role: "rapid", units: 3, t: 5, updatedAt: 1 }],
  glucose: [{ t: "x", kind: "auto" }, { t: 1, mgdl: 100 }, { t: 2, mgdl: "abc", kind: "auto" }, { t: 3, mgdl: 90, kind: "auto" }] };
  const c = await s.restoreBackup(bad);
  assert.equal(c.records, 1); assert.equal(c.skippedRecords, 4);
  assert.equal(c.glucose, 1); assert.equal(c.skippedGlucose, 3);
  assert.equal(s.settings().glucoseUnit, "mmol/L");
  assert.equal(s.glucoseDays.has("g:2023-01-01"), false);
});

test("decrypt tool opens a backup on a computer; wrong passphrase fails", async () => {
  const a = await fresh();
  await populate(a);
  const env = await encryptBackup("tool pass 12345", await a.exportAll(), 1000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t1d-")), "backup.json");
  fs.writeFileSync(file, JSON.stringify(env));
  const tool = path.join(here, "..", "tools", "decrypt-backup.mjs");
  const out = JSON.parse(execFileSync("node", [tool, file], { env: { ...process.env, T1D_BACKUP_PASSPHRASE: "tool pass 12345" } }).toString());
  assert.equal(out.app, "t1dlog"); assert.equal(out.doses.length, 3);   // 1 logged + 2 from the Libre file
  assert.throws(() => execFileSync("node", [tool, file], { env: { ...process.env, T1D_BACKUP_PASSPHRASE: "nope nope nope" }, stdio: "pipe" }));
  fs.rmSync(file);
});
