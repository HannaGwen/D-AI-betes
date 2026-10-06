// The demo preview runs the real app on synthetic data; check it comes up sensibly and offline.
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
let net = 0; globalThis.fetch = () => { net++; throw new Error("no network"); };
const { mountDemo } = await import("../preview/demo.js");
const has = (t) => document.body.textContent.includes(t);

test("demo shows sample timeline with doses, meals, tag and glucose", async () => {
  const now = Date.UTC(2023, 5, 15, 20, 30);                       // 21:30 in London
  const { store } = await mountDemo(document.getElementById("app"), { now: () => now, tz: "Europe/London" });
  assert.ok(store.glucoseAll().length > 150);                      // two days of 15-minute readings
  assert.ok(has("Rapid 6 u") && has("Porridge with banana") && has("Pasta bolognese"));
  assert.ok(has("min before meal"));
  assert.ok(has("Not for treatment decisions"));
  assert.ok(!has("Not added to your Home Screen"));               // hint suppressed in the demo
  assert.equal(store.list("tag").length, 1);
  assert.equal(store.list("saved_meal").length, 1);
  const gaps = store.glucoseAll().filter((r) => r.kind === "auto");
  assert.ok(gaps.every((r) => r.mgdl >= 57 && r.mgdl <= 290));    // plausible synthetic range
  assert.equal(net, 0);
});

test("re-mounting the demo does not duplicate data", async () => {
  const now = Date.UTC(2023, 5, 15, 20, 30);
  const { store } = await mountDemo(document.getElementById("app"), { now: () => now, tz: "Europe/London" });
  assert.equal(store.list("dose").filter((d) => d.role === "rapid").length, 6);   // 3 meals x 2 days
});
