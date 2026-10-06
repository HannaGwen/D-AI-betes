// End-to-end UI smoke test in jsdom: real app code, fake IndexedDB, real WebCrypto.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", n)));

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',
  { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.FileReader = window.FileReader;
let netCalls = 0;
globalThis.fetch = () => { netCalls++; throw new Error("network is not allowed"); };

const { start } = await import("../src/app.js");
const { Store } = await import("../src/store.js");

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);
const btnStarting = (text) => $$("button").find((b) => b.textContent.trim().startsWith(text));
const has = (text) => document.body.textContent.includes(text);
const ev = (type) => new window.Event(type, { bubbles: true });
const setVal = (el, v) => { el.value = v; el.dispatchEvent(ev("input")); el.dispatchEvent(ev("change")); };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label = "condition") => { for (let i = 0; i < 300; i++) { if (fn()) return; await tick(); } throw new Error("timeout waiting for " + label); };
const labelInput = (label) => { const l = $$("label").find((x) => x.textContent.trim().startsWith(label)); return l && document.getElementById(l.getAttribute("for")); };

const PASS = "correct horse staple";
let clock = Date.UTC(2023, 5, 15, 11, 30);          // 12:30 in London
let store, app;

test("setup creates an encrypted log", async () => {
  store = new Store("ui-test-db");
  app = await start({ root: $("#app"), store, iterations: 1000, now: () => clock });
  await until(() => has("Set up your log"), "setup screen");
  const passInputs = $$('input[type="password"]');
  setVal(passInputs[0], PASS); setVal(passInputs[1], PASS);
  setVal(labelInput("Time zone"), "Europe/London");
  $('.check input[type="checkbox"]').checked = true;
  byText("button", "Create encrypted log").click();
  await until(() => $(".tabs"), "main screen");
  assert.ok(store.unlocked);
  assert.equal(store.settings().tz, "Europe/London");
  assert.ok(has("Nothing logged for this day."));
});

test("setup validation: short or mismatched passphrase is rejected", async () => {
  const s2 = new Store("ui-test-db-2");
  const root2 = document.createElement("div"); document.body.append(root2);
  await start({ root: root2, store: s2, iterations: 1000, now: () => clock });
  const q = (sel) => [...root2.querySelectorAll(sel)];
  const inputs = q('input[type="password"]');
  setVal(inputs[0], "short"); setVal(inputs[1], "short");
  [...root2.querySelectorAll("button")].find((b) => b.textContent === "Create encrypted log").click();
  await until(() => root2.textContent.includes("at least 8 characters"), "short passphrase error");
  assert.equal(s2.unlocked, false);
  root2.remove();
});

test("log a rapid dose in a few steps", async () => {
  byText(".tab", "Dose").click();
  assert.ok(has("Log a dose"));
  const timeInput = $('input[type="datetime-local"]');
  assert.equal(timeInput.value, "2023-06-15T12:30");           // defaults to 'now' in the profile time zone
  setVal($('input[type="number"]'), "6");
  byText("button", "Save dose").click();
  await until(() => store.list("dose").length === 1, "dose saved");
  const d = store.list("dose")[0];
  assert.equal(d.units, 6); assert.equal(d.role, "rapid"); assert.equal(d.confidence, "high"); assert.equal(d.source, "app");
  await until(() => has("Rapid 6 u"), "timeline shows dose");
});

test("invalid dose is rejected with a message", async () => {
  byText(".tab", "Dose").click();
  setVal($('input[type="number"]'), "4.3");                    // not a multiple of the 0.5 pen increment
  byText("button", "Save dose").click();
  await until(() => has("multiple of 0.5"), "validation message");
  assert.equal(store.list("dose").length, 1);
  byText("button", "Cancel").click();
});

test("log a meal; nearby rapid dose is linked automatically", async () => {
  byText(".tab", "Meal").click();
  assert.ok(has("Log a meal"));
  assert.ok(has("rapid 6 u"));                                  // candidate dose listed
  setVal(labelInput("Food"), "Toast");
  setVal(labelInput("Carbs (g)"), "30"); setVal(labelInput("Protein (g)"), "6"); setVal(labelInput("Fat (g)"), "5");
  byText("button", "Add item").click();
  await until(() => has("Total: carbs 30 g"), "totals");
  setVal(labelInput("Carbs I used for my dose"), "35");
  byText("button", "Save meal").click();
  await until(() => store.list("meal").length === 1, "meal saved");
  const m = store.list("meal")[0];
  assert.equal(m.totals.carb, 30); assert.equal(m.carbsUsedForDosing, 35); assert.equal(m.confidence, "high");
  await until(() => store.list("dose")[0].mealId === m.id, "dose linked to meal");
  await until(() => has("at meal start"), "gap text");
  assert.ok(has("35 g used for dose"));
});

test("meal needs at least one item", async () => {
  byText(".tab", "Meal").click();
  byText("button", "Save meal").click();
  await until(() => has("Add at least one item."), "message");
  assert.equal(store.list("meal").length, 1);
  byText("button", "Cancel").click();
});

test("add an exercise tag", async () => {
  byText(".tab", "Tag").click();
  setVal(labelInput("Duration (minutes)"), "45");
  byText("button", "Save tag").click();
  await until(() => store.list("tag").length === 1, "tag saved");
  assert.equal(store.list("tag")[0].durationMin, 45);
  await until(() => has("Exercise"), "timeline shows tag");
});

async function chooseFile(name, bytes) {
  const input = $('input[type="file"]');
  Object.defineProperty(input, "files", { value: [{ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }], configurable: true });
  input.dispatchEvent(ev("change"));
}

test("import a LibreView CSV with a pre-import report", async () => {
  byText(".tab", "More").click();
  btnStarting("Import Libre data").click();
  await chooseFile("us_basic.csv", fixture("us_basic.csv"));
  await until(() => has("Check before importing"), "report");
  assert.ok(has("median 15 min"));
  assert.ok(has("account name in the file was not read or stored"));
  assert.ok(!has("Test Persona"));
  byText("button", "Import this file").click();
  await until(() => store.glucoseAll().length >= 13, "glucose stored");
  await until(() => has("Previous imports"), "batch list");
  const before = store.glucoseAll().length;
  // importing the same file again adds nothing
  await chooseFile("us_basic.csv", fixture("us_basic.csv"));
  await until(() => has("Check before importing"), "report again");
  byText("button", "Import this file").click();
  await until(() => store.list("import_batch").length === 2, "second batch");
  assert.equal(store.glucoseAll().length, before);
});

test("ambiguous dates ask the user instead of guessing", async () => {
  byText(".tab", "More").click();
  btnStarting("Import Libre data").click();
  await chooseFile("ambiguous_error.csv", fixture("ambiguous_error.csv"));
  await until(() => has("Which date order does this file use?"), "ambiguity prompt");
  byText("button", "Use this").click();
  await until(() => has("Check before importing"), "report after choice");
  assert.ok(has("user supplied"));
});

test("timeline shows imported history with a not-for-treatment banner", async () => {
  clock = Date.UTC(2021, 6, 14, 20, 0);                         // 14 Jul 2021, evening
  app.S.day = null; byText(".tab", "Timeline").click();
  assert.ok(has("Not for treatment decisions"));
});

test("auto-lock when the app was away longer than the setting, then unlock", async () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(ev("visibilitychange"));
  clock += 6 * 60000;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(ev("visibilitychange"));
  await until(() => has("Locked. Enter your passphrase."), "locked screen");
  assert.equal(store.unlocked, false);
  assert.equal(store.list("dose").length, 0);                   // nothing readable while locked
  assert.equal(store.glucoseAll().length, 0);
  setVal($('input[type="password"]'), "wrong passphrase");
  byText("button", "Unlock").click();
  await until(() => has("not correct"), "wrong passphrase message");
  setVal($('input[type="password"]'), PASS);
  byText("button", "Unlock").click();
  await until(() => $(".tabs"), "main again");
  assert.equal(store.list("dose").filter((d) => d.source === "app").length, 1);       // my own dose is back
  assert.equal(store.list("dose").filter((d) => d.source === "libre_app").length, 2);  // plus 2 imported from the Libre file
});

test("settings save persists", async () => {
  byText(".tab", "More").click();
  btnStarting("Settings").click();
  await until(() => has("Auto-lock"), "settings screen");
  setVal(labelInput("Glucose units"), "mg/dL");
  byText("button", "Save settings").click();
  await until(() => store.settings().glucoseUnit === "mg/dL", "settings saved");
  assert.equal(store.settings().lockMinutes, 5);
});

test("delete everything wipes the database", async () => {
  byText(".tab", "More").click();
  btnStarting("Backup, export and delete").click();
  await until(() => has("Delete everything"), "data screen");
  byText("button", "Delete all data").click();
  await until(() => has("Type DELETE to confirm."), "needs confirmation");
  setVal($('input[placeholder="Type DELETE"]'), "DELETE");
  byText("button", "Delete all data").click();
  await until(() => has("Set up your log"), "back to setup");
  assert.equal(await new Store("ui-test-db").isInitialised(), false);
});

test("the app never made a network request", () => {
  assert.equal(netCalls, 0);
});
