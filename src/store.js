// Encrypted local store (IndexedDB). Every record is AES-GCM encrypted with a key derived from the
// user's passphrase; only random ids are stored in the clear. Edits keep the previous version in a
// revisions store. Deletes are soft. Glucose is stored in one encrypted record per local day.
// Data never leaves the device: this module makes no network requests.

import { deriveKey, encryptJson, decryptJson, randomBytes, DEFAULT_ITERATIONS } from "./crypto.js";
import { localDateKey } from "./timeutil.js";
import { findImportOverlaps } from "./model.js";

const DB_VERSION = 1;
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("aborted")); });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join(""));

export class WrongPassphrase extends Error { constructor() { super("Wrong passphrase"); this.name = "WrongPassphrase"; } }

export class Store {
  constructor(dbName = "t1dlog") {
    this.dbName = dbName;
    this.db = null;
    this.key = null;
    this.records = new Map();       // id -> record (non-glucose)
    this.glucoseDays = new Map();   // 'g:YYYY-MM-DD' -> { id, readings: [...] }
  }

  async open() {
    if (this.db) return;
    const open = indexedDB.open(this.dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("meta");
      db.createObjectStore("records", { keyPath: "id" });
      db.createObjectStore("revisions", { keyPath: "rid", autoIncrement: true });
    };
    this.db = await req(open);
    this.db.onversionchange = () => { try { this.db.close(); } catch { /* already closed */ } this.db = null; };   // let a delete/upgrade proceed
  }

  get unlocked() { return !!this.key; }

  async isInitialised() {
    await this.open();
    return !!(await req(this.db.transaction("meta").objectStore("meta").get("salt")));
  }

  async create(passphrase, settings, { iterations = DEFAULT_ITERATIONS } = {}) {
    await this.open();
    if (await this.isInitialised()) throw new Error("Already initialised");
    const salt = randomBytes(16);
    this.key = await deriveKey(passphrase, salt, iterations);
    const check = await encryptJson(this.key, { ok: true }, "check");
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(salt, "salt");
    tx.objectStore("meta").put(iterations, "iterations");
    tx.objectStore("meta").put(check, "check");
    await done(tx);
    await this.put({ id: "settings", kind: "settings", ...settings });
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* best effort */ }
  }

  async unlock(passphrase) {
    await this.open();
    const m = this.db.transaction("meta").objectStore("meta");
    const [salt, iterations, check] = await Promise.all([req(m.get("salt")), req(m.get("iterations")), req(m.get("check"))]);
    if (!salt) throw new Error("Not initialised");
    const key = await deriveKey(passphrase, salt, iterations);
    try { await decryptJson(key, check.iv, check.ct, "check"); } catch { throw new WrongPassphrase(); }
    this.key = key;
    await this._loadAll();
  }

  lock() {
    this.key = null;
    this.records.clear();
    this.glucoseDays.clear();
  }

  async _loadAll() {
    this.records.clear();
    this.glucoseDays.clear();
    const rows = await req(this.db.transaction("records").objectStore("records").getAll());
    for (const row of rows) {
      const rec = await decryptJson(this.key, row.iv, row.ct, row.id);
      if (row.id.startsWith("g:")) this.glucoseDays.set(row.id, rec);
      else this.records.set(row.id, rec);
    }
  }

  _need() { if (!this.key) throw new Error("Store is locked"); }

  // --------------------------------------------------------------- records
  settings() { return this.records.get("settings"); }

  list(kind, { includeDeleted = false } = {}) {
    const out = [];
    for (const r of this.records.values()) if (r.kind === kind && (includeDeleted || !r.deleted)) out.push(r);
    return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }

  all({ includeDeleted = false } = {}) {
    return [...this.records.values()].filter((r) => r.kind !== "settings" && (includeDeleted || !r.deleted));
  }

  get(id) { return this.records.get(id); }

  /** Insert or update. Keeps the previous version in the revisions store. */
  async put(rec) {
    this._need();
    const now = Date.now();
    const existing = rec.id ? this.records.get(rec.id) : null;
    const next = { ...rec, id: rec.id || uuid(), createdAt: existing?.createdAt || rec.createdAt || now, updatedAt: now };
    const enc = await encryptJson(this.key, next, next.id);
    const tx = this.db.transaction(["records", "revisions"], "readwrite");
    if (existing) {
      const old = await req(tx.objectStore("records").get(next.id));
      if (old) tx.objectStore("revisions").add({ id: old.id, iv: old.iv, ct: old.ct, replacedAt: now });
    }
    tx.objectStore("records").put({ id: next.id, iv: enc.iv, ct: enc.ct });
    await done(tx);
    this.records.set(next.id, next);
    return next;
  }

  async remove(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    return this.put({ ...rec, deleted: true, deletedAt: Date.now() });
  }

  async restore(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const { deleted, deletedAt, ...rest } = rec;
    return this.put(rest);
  }

  // --------------------------------------------------------------- glucose
  glucoseBetween(fromMs, toMs) {
    const out = [];
    for (const day of this.glucoseDays.values()) {
      for (const r of day.readings) if (r.t >= fromMs && r.t < toMs) out.push(r);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  glucoseAll() { return this.glucoseBetween(-Infinity, Infinity); }

  /** Most recent stored reading (any kind) or null. */
  latestGlucose() {
    let best = null;
    for (const day of this.glucoseDays.values()) {
      const last = day.readings[day.readings.length - 1];
      if (last && (!best || last.t > best.t)) best = last;
    }
    return best;
  }

  // ---------------------------------------------------------------- import
  /**
   * Store the events from a parsed LibreView file. Idempotent: anything already stored is skipped.
   * All encryption happens before the single write transaction.
   */
  async importBatch(parsed, { tz, fileName = "" }) {
    this._need();
    const batchId = "batch:" + uuid();
    const now = Date.now();
    const counts = { newGlucose: 0, skippedGlucose: 0, newEvents: 0, skippedEvents: 0 };
    const touchedDays = new Map();
    const newRecords = [];
    const seenIds = new Set();

    const dayOf = (key) => {
      if (!touchedDays.has(key)) {
        const id = "g:" + key;
        const existing = this.glucoseDays.get(id);
        touchedDays.set(key, { id, readings: existing ? existing.readings.map((r) => ({ ...r })) : [] });
      }
      return touchedDays.get(key);
    };

    for (const e of parsed.events) {
      if (e.kind.startsWith("glucose_")) {
        const kind = e.kind.slice(8);                       // auto | scan | strip
        const day = dayOf(localDateKey(e.utcMs, tz));
        if (day.readings.some((r) => r.h === e.row_hash && r.kind === kind)) { counts.skippedGlucose++; continue; }
        const rd = { t: e.utcMs, mgdl: e.data.value_mgdl, kind, h: e.row_hash, b: batchId };
        if (e.data.value_mgdl === null) rd.txt = e.data.orig_value;
        day.readings.push(rd);
        counts.newGlucose++;
        continue;
      }
      const base = { t: e.utcMs, tzName: tz, source: "libre_app", confidence: "low", batchId, loggedAt: e.utcMs, flags: e.flags, srcRow: e.source_row };
      let rec;
      if (e.kind === "insulin") {
        rec = { ...base, id: `imp:${e.row_hash}:insulin:${e.data.role}${e.data.purpose}`, kind: "dose", role: e.data.role,
          units: e.data.units, purpose: e.data.purpose === "unspecified" ? "other" : e.data.purpose, markerOnly: e.data.marker_only };
      } else if (e.kind === "food") {
        rec = { ...base, id: `imp:${e.row_hash}:food`, kind: "meal", title: "Libre app food log", items: [],
          totals: { carb: e.data.carbs_g, protein: null, fat: null, fibre: null, sugar: null }, markerOnly: e.data.marker_only };
      } else if (e.kind === "note") {
        rec = { ...base, id: `imp:${e.row_hash}:note`, kind: "tag", tag: "note", payload: { text: e.data.text } };
      } else if (e.kind === "ketone") {
        rec = { ...base, id: `imp:${e.row_hash}:ketone`, kind: "tag", tag: "ketone", payload: { mmol: e.data.value_mmol_l } };
      } else continue;
      if (this.records.has(rec.id) || seenIds.has(rec.id)) { counts.skippedEvents++; continue; }
      seenIds.add(rec.id);
      newRecords.push(rec);
      counts.newEvents++;
    }

    const batch = { id: batchId, kind: "import_batch", t: now, fileName, fileHash: parsed.fileHash, tz,
      counts, dateRange: parsed.report.date_range_local, device: parsed.report.devices };
    const toWrite = [];
    for (const rec of [...newRecords, batch]) {
      const full = { ...rec, createdAt: now, updatedAt: now };
      const enc = await encryptJson(this.key, full, full.id);
      toWrite.push({ full, row: { id: full.id, iv: enc.iv, ct: enc.ct } });
    }
    const dayWrites = [];
    for (const day of touchedDays.values()) {
      day.readings.sort((a, b) => a.t - b.t);
      const enc = await encryptJson(this.key, day, day.id);
      dayWrites.push({ day, row: { id: day.id, iv: enc.iv, ct: enc.ct } });
    }
    const tx = this.db.transaction("records", "readwrite");
    for (const w of toWrite) tx.objectStore("records").put(w.row);
    for (const w of dayWrites) tx.objectStore("records").put(w.row);
    await done(tx);
    for (const w of toWrite) this.records.set(w.full.id, w.full);
    for (const w of dayWrites) this.glucoseDays.set(w.day.id, w.day);

    counts.overlaps = await this.applyOverlaps();
    return { batchId, ...counts };
  }

  /** Mark imported Libre-app logs that duplicate an in-app log (never deletes anything). */
  async applyOverlaps() {
    const pairs = findImportOverlaps([...this.records.values()]);
    for (const p of pairs) {
      const rec = this.records.get(p.importedId);
      if (rec && !rec.supersededBy) await this.put({ ...rec, supersededBy: p.appId });
    }
    return pairs.length;
  }

  async undoBatch(batchId) {
    this._need();
    const batch = this.records.get(batchId);
    if (!batch || batch.undoneAt) return false;
    const now = Date.now();
    const dayRows = [];
    for (const day of [...this.glucoseDays.values()]) {
      const kept = day.readings.filter((r) => r.b !== batchId);
      if (kept.length !== day.readings.length) {
        const next = { id: day.id, readings: kept };
        const enc = await encryptJson(this.key, next, day.id);
        dayRows.push({ next, row: { id: day.id, iv: enc.iv, ct: enc.ct }, empty: kept.length === 0 });
      }
    }
    const tx = this.db.transaction("records", "readwrite");
    for (const w of dayRows) w.empty ? tx.objectStore("records").delete(w.next.id) : tx.objectStore("records").put(w.row);
    await done(tx);
    for (const w of dayRows) w.empty ? this.glucoseDays.delete(w.next.id) : this.glucoseDays.set(w.next.id, w.next);
    for (const rec of [...this.records.values()]) if (rec.batchId === batchId && !rec.deleted) await this.remove(rec.id);
    await this.put({ ...this.records.get(batchId), undoneAt: now });
    return true;
  }

  // ------------------------------------------------------------ export/wipe
  /** Everything (or, with `since`, only what was added or changed after that time). */
  async exportAll({ since = null } = {}) {
    this._need();
    const revs = await req(this.db.transaction("revisions").objectStore("revisions").count());
    const changed = (r) => since === null || (r.updatedAt || 0) > since;
    const by = (k) => this.list(k, { includeDeleted: true }).filter(changed);
    const batchTime = new Map(this.list("import_batch", { includeDeleted: true }).map((b) => [b.id, b.createdAt || b.t]));
    const glucose = this.glucoseAll().filter((r) => since === null || (batchTime.get(r.b) || 0) > since);
    return {
      app: "t1dlog", format: 1, scope: since === null ? "full" : "since", since, exportedAt: new Date().toISOString(),
      settings: this.settings(), doses: by("dose"), meals: by("meal"), tags: by("tag"),
      savedMeals: by("saved_meal"), importBatches: by("import_batch"),
      glucose, revisionCount: revs,
    };
  }

  /**
   * Merge a backup (full or "since") into this store. Idempotent: restoring the same file twice changes nothing,
   * and an older copy never overwrites a newer one. Settings in the file are ignored.
   */
  async restoreBackup(obj, { tz } = {}) {
    this._need();
    if (!obj || obj.app !== "t1dlog" || obj.format !== 1) throw new Error("This file is not a T1D Log backup.");
    const zone = tz || this.settings()?.tz || "UTC";
    const KINDS = new Set(["dose", "meal", "tag", "saved_meal", "import_batch"]);
    const counts = { records: 0, skippedRecords: 0, glucose: 0, skippedGlucose: 0 };
    const writes = [];
    const incoming = [...(obj.doses || []), ...(obj.meals || []), ...(obj.tags || []), ...(obj.savedMeals || []), ...(obj.importBatches || [])];
    for (const rec of incoming) {
      const ok = rec && typeof rec.id === "string" && !rec.id.startsWith("g:") && rec.id !== "settings" && KINDS.has(rec.kind) &&
        (rec.kind === "saved_meal" || rec.kind === "import_batch" || Number.isFinite(rec.t));
      if (!ok) { counts.skippedRecords++; continue; }
      const ex = this.records.get(rec.id);
      if (ex && (rec.updatedAt || 0) <= (ex.updatedAt || 0)) { counts.skippedRecords++; continue; }
      writes.push({ rec, replacing: !!ex });
      counts.records++;
    }
    const days = new Map();
    for (const r of obj.glucose || []) {
      if (!r || !Number.isFinite(r.t) || typeof r.kind !== "string" || (r.mgdl !== null && !Number.isFinite(r.mgdl))) { counts.skippedGlucose++; continue; }
      const key = localDateKey(r.t, zone);
      if (!days.has(key)) {
        const id = "g:" + key, ex = this.glucoseDays.get(id);
        const readings = ex ? ex.readings.map((x) => ({ ...x })) : [];
        days.set(key, { id, readings, sigs: new Set(readings.map((x) => (x.h ? `${x.h}:${x.kind}` : `${x.t}:${x.kind}:${x.mgdl}`))) });
      }
      const day = days.get(key);
      const sig = r.h ? `${r.h}:${r.kind}` : `${r.t}:${r.kind}:${r.mgdl}`;
      if (day.sigs.has(sig)) { counts.skippedGlucose++; continue; }
      day.sigs.add(sig);
      const { t, mgdl, kind, h, b, txt } = r;
      day.readings.push({ t, mgdl, kind, ...(h ? { h } : {}), ...(b ? { b } : {}), ...(txt !== undefined ? { txt } : {}) });
      counts.glucose++;
    }
    const recRows = [];
    for (const w of writes) {
      const enc = await encryptJson(this.key, w.rec, w.rec.id);
      recRows.push({ rec: w.rec, replacing: w.replacing, row: { id: w.rec.id, iv: enc.iv, ct: enc.ct } });
    }
    const dayRows = [];
    for (const day of days.values()) {
      day.readings.sort((a, b) => a.t - b.t);
      const out = { id: day.id, readings: day.readings };
      const enc = await encryptJson(this.key, out, day.id);
      dayRows.push({ out, row: { id: day.id, iv: enc.iv, ct: enc.ct } });
    }
    const tx = this.db.transaction(["records", "revisions"], "readwrite");
    const os = tx.objectStore("records");
    for (const w of recRows) {
      if (w.replacing) {
        const old = await req(os.get(w.rec.id));
        if (old) tx.objectStore("revisions").add({ id: old.id, iv: old.iv, ct: old.ct, replacedAt: Date.now() });
      }
      os.put(w.row);
    }
    for (const w of dayRows) os.put(w.row);
    await done(tx);
    for (const w of recRows) this.records.set(w.rec.id, w.rec);
    for (const w of dayRows) this.glucoseDays.set(w.out.id, w.out);
    counts.overlaps = await this.applyOverlaps();
    return counts;
  }

  async wipe() {
    this.lock();
    if (this.db) { this.db.close(); this.db = null; }
    await new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(this.dbName);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res();
    });
  }
}
