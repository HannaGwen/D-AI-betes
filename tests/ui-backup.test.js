// UI flow: restore a backup through the real screen.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.FileReader = window.FileReader;
const { start } = await import("../src/app.js");
const { Store } = await import("../src/store.js");
const { encryptBackup } = await import("../src/crypto.js");

const $$ = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);
const btnStarting = (t) => $$("button").find((b) => b.textContent.trim().startsWith(t));
const has = (t) => document.body.textContent.includes(t);
const ev = (t) => new window.Event(t, { bubbles: true });
const setVal = (el, v) => { el.value = v; el.dispatchEvent(ev("input")); el.dispatchEvent(ev("change")); };
const tick = () => new Promise((r) => setTimeout(r, 15));
const until = async (fn, label) => { for (let i = 0; i < 300; i++) { if (fn()) return; await tick(); } throw new Error("timeout: " + label); };
const pickFile = (input, text) => Object.defineProperty(input, "files", { configurable: true, value: [{ name: "b.json", arrayBuffer: async () => { const b = new TextEncoder().encode(text); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }] });

test("restore from an encrypted backup through the screen", async () => {
  // a source log produces the backup
  const src = new Store("ui-bk-src"); await src.create("source passphrase 1", { tz: "Europe/London", glucoseUnit: "mmol/L" }, { iterations: 1000 });
  await src.put({ kind: "dose", role: "rapid", units: 7, t: Date.UTC(2023, 5, 15, 10, 0), source: "app" });
  await src.put({ kind: "meal", t: Date.UTC(2023, 5, 15, 10, 5), title: "Breakfast", items: [{ name: "oats", carb: 40 }], totals: { carb: 40 }, source: "app" });
  const env = JSON.stringify(await encryptBackup("the backup pass", await src.exportAll(), 1000));

  // a fresh log on the "new phone"
  const store = new Store("ui-bk-dest");
  await start({ root: document.getElementById("app"), store, iterations: 1000, now: () => Date.UTC(2023, 5, 15, 12, 0) });
  await until(() => has("Set up your log"), "setup");
  assert.ok(has("Restoring from a backup?"));
  const pw = $$('input[type="password"]');
  setVal(pw[0], "new phone passphrase"); setVal(pw[1], "new phone passphrase");
  document.querySelector('.check input[type="checkbox"]').checked = true;
  byText("button", "Create encrypted log").click();
  await until(() => document.querySelector(".tabs"), "main screen");

  byText(".tab", "More").click();
  btnStarting("Backup, export and delete").click();
  await until(() => has("Restore from a backup"), "backup screen");
  await until(() => has("No backup yet."), "pending text");

  // no file chosen yet
  byText("button", "Check backup file").click();
  await until(() => has("Choose a backup file first."), "no-file message");

  // wrong passphrase
  pickFile(document.querySelector('input[aria-label="Backup file"]'), env);
  setVal(document.querySelector('input[aria-label="Passphrase for the backup file"]'), "not the passphrase");
  byText("button", "Check backup file").click();
  await until(() => has("does not open this backup"), "wrong passphrase message");
  assert.equal(store.list("dose").length, 0);

  // right passphrase: summary, then restore
  setVal(document.querySelector('input[aria-label="Passphrase for the backup file"]'), "the backup pass");
  byText("button", "Check backup file").click();
  await until(() => has("Backup contents"), "summary");
  assert.ok(has("Full backup"));
  assert.ok(has("1 doses, 1 meals"));
  byText("button", "Restore").click();
  await until(() => store.list("dose").length === 1, "restored dose");
  assert.equal(store.list("dose")[0].units, 7);
  assert.equal(store.list("meal")[0].title, "Breakfast");
  assert.ok(has("Restored 2 entries"));
  assert.notEqual(store.settings().tz, "Europe/London");        // the file's settings were ignored; the new log keeps its own
});

test("a file that is not a backup is rejected with a clear message", async () => {
  const store = new Store("ui-bk-dest");
  // continue on the same screen
  pickFile(document.querySelector('input[aria-label="Backup file"]'), JSON.stringify({ hello: "world" }));
  byText("button", "Check backup file").click();
  await until(() => has("This file is not a T1D Log backup."), "rejection");
  assert.ok(store);
});

test("backup requires a passphrase of at least 8 characters", async () => {
  byText("button", "Back up everything").click();
  await until(() => has("at least 8 characters. You will need it to restore"), "passphrase rule");
});
