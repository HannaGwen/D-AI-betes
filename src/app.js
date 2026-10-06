// App screens and behaviour. Local-only: this module makes no network requests.
// It is a logging and review tool: it never gives treatment advice or doses.

import { h, clear, numOrNull, field, option } from "./dom.js";
import { Store, WrongPassphrase } from "./store.js";
import { encryptBackup, decryptBackup, isEncryptedBackup, BadBackupPassphrase } from "./crypto.js";
import { parseLibreView, ParseError, AmbiguousDateFormat } from "./libreview.js";
import {
  toMgdl, fromMgdl, formatGlucose, preBolusGapMin, suggestDoseLinks, mealTotals, doseConfidence,
  validateDose, glucoseGaps, possibleUnloggedDose, describeFormat, LINK_BEFORE_MIN, LINK_AFTER_MIN,
} from "./model.js";
import {
  localDateKey, dayStartUtc, addDays, utcToLocalParts, toInputValue, fromInputValue, deviceTimeZone,
} from "./timeutil.js";
import { drawDayChart } from "./chart.js";
import { buildCsvs } from "./exportcsv.js";

export const APP_VERSION = "0.2.1";
const z2 = (n) => String(n).padStart(2, "0");
const MIN = 60000;

const DEFAULTS = {
  glucoseUnit: "mmol/L", tz: "Europe/London", rapidName: "", longName: "", increment: 0.5,
  targetLowMgdl: 70, targetHighMgdl: 180, lockMinutes: 5, flagUnlogged: false,
};

const TAG_KINDS = [
  ["exercise", "Exercise"], ["alcohol", "Alcohol"], ["illness", "Illness"], ["stress", "Stress event"],
  ["hypo_treatment", "Hypo treatment (carbs taken)"], ["sensor_change", "Sensor change"],
  ["period", "Period start"], ["ketone", "Ketone reading"], ["note", "Note"],
];
const TAG_LABEL = Object.fromEntries(TAG_KINDS);
const METHODS = [["weighed", "Weighed", "high"], ["label", "From label", "high"], ["estimated", "Estimated", "medium"], ["guess", "Guess", "low"]];
const CONF_RANK = { low: 0, medium: 1, high: 2 };

export async function start({ root, store, iterations, now = () => Date.now(), hideInstallHint = false }) {
  const S = { screen: "boot", tab: "timeline", sub: null, edit: null, day: null, hiddenAt: null, imp: null, error: "" };

  const settings = () => ({ ...DEFAULTS, ...(store.settings() || {}) });
  const tz = () => settings().tz;
  const unit = () => settings().glucoseUnit;
  const todayKey = () => localDateKey(now(), tz());
  const fmtHM = (t) => { const p = utcToLocalParts(t, tz()); return `${z2(p.h)}:${z2(p.mi)}`; };
  const fmtDT = (t) => `${localDateKey(t, tz())} ${fmtHM(t)}`;
  const fmtNum = (n) => (n === null || n === undefined ? "?" : String(Math.round(n * 10) / 10));
  const schedule = (fn) => ((typeof window !== "undefined" && window.requestAnimationFrame) ? window.requestAnimationFrame(fn) : setTimeout(fn, 0));

  // ------------------------------------------------------------ plumbing
  function render() {
    clear(root);
    if (S.screen === "boot") root.append(h("p", { class: "center muted" }, "Loading…"));
    else if (S.screen === "setup") root.append(setupView());
    else if (S.screen === "unlock") root.append(unlockView());
    else root.append(mainView());
  }

  function go(tab, { sub = null, edit = null } = {}) {
    S.tab = tab; S.sub = sub; S.edit = edit;
    render();
    if (typeof window !== "undefined" && window.scrollTo) { try { window.scrollTo(0, 0); } catch { /* ignore */ } }
  }

  let toastEl = null;
  function toast(msg, undo) {
    if (toastEl) toastEl.remove();
    toastEl = h("div", { class: "toast", role: "status" }, h("span", {}, msg),
      undo ? h("button", { class: "linkbtn", onclick: async () => { toastEl.remove(); await undo(); } }, "Undo") : null);
    root.append(toastEl);
    const t = setTimeout(() => { if (toastEl) toastEl.remove(); }, 7000);
    if (t.unref) t.unref();
  }

  function lock() {
    store.lock();
    S.screen = "unlock"; S.error = ""; S.imp = null; S.edit = null;
    render();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") S.hiddenAt = now();
      else if (S.hiddenAt !== null && store.unlocked) {
        const away = (now() - S.hiddenAt) / MIN;
        S.hiddenAt = null;
        if (away >= settings().lockMinutes) lock();
      }
    });
  }

  const isStandalone = () => {
    try { return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)); }
    catch { return false; }
  };

  async function saveFile(name, mime, text) {
    const file = typeof File !== "undefined" ? new File([text], name, { type: mime }) : null;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ----------------------------------------------------------- setup/unlock
  function setupView() {
    const s = { ...DEFAULTS, tz: deviceTimeZone() };
    const pass1 = h("input", { type: "password", autocomplete: "new-password", minlength: 8 });
    const pass2 = h("input", { type: "password", autocomplete: "new-password" });
    const unitSel = h("select", {}, option("mmol/L", "mmol/L (UK)", true), option("mg/dL", "mg/dL"));
    const tzIn = h("input", { type: "text", value: s.tz });
    const rapid = h("input", { type: "text", placeholder: "e.g. the name on your pen" });
    const long = h("input", { type: "text", placeholder: "e.g. the name on your pen" });
    const inc = h("select", {}, option("0.5", "0.5 units", true), option("1", "1 unit"));
    const ack = h("input", { type: "checkbox" });
    const err = h("p", { class: "error", role: "alert" });
    const btn = h("button", { class: "btn primary", type: "button" }, "Create encrypted log");
    btn.addEventListener("click", async () => {
      err.textContent = "";
      if (pass1.value.length < 8) return void (err.textContent = "Use a passphrase of at least 8 characters.");
      if (pass1.value !== pass2.value) return void (err.textContent = "The passphrases do not match.");
      if (!ack.checked) return void (err.textContent = "Please confirm the box about what this app is not.");
      try { Intl.DateTimeFormat("en-GB", { timeZone: tzIn.value.trim() }); } catch { return void (err.textContent = "Time zone not recognised (example: Europe/London)."); }
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        await store.create(pass1.value, { ...DEFAULTS, glucoseUnit: unitSel.value, tz: tzIn.value.trim(), rapidName: rapid.value.trim(),
          longName: long.value.trim(), increment: Number(inc.value), disclaimerAcceptedAt: now() }, iterations ? { iterations } : undefined);
        S.screen = "main"; S.tab = "timeline"; render();
      } catch (e) { err.textContent = "Could not create the log: " + e.message; btn.disabled = false; btn.textContent = "Create encrypted log"; }
    });
    return h("div", { class: "app narrow" },
      h("h1", {}, "Set up your log"),
      h("p", { class: "muted" }, "Everything you enter stays on this phone, encrypted with a passphrase only you know. If you forget it, the data cannot be recovered."),
      h("p", { class: "muted small" }, "Restoring from a backup? Create your log first, then use More → Backup, export and delete → Restore."),
      field("Passphrase", pass1, "At least 8 characters. A few random words is good."), field("Repeat passphrase", pass2),
      field("Glucose units", unitSel), field("Time zone", tzIn, "Used to read the times in your Libre files."),
      field("Rapid-acting insulin (name)", rapid), field("Long-acting insulin (name)", long), field("Pen increment", inc),
      h("div", { class: "card warn" },
        h("strong", {}, "What this app is not"),
        h("p", {}, "It is a personal logbook and review tool. It is not a medical device, it never tells you how much insulin to take, and it does not replace your Libre alarms or your care team.")),
      h("label", { class: "check" }, ack, " I understand."), err, btn);
  }

  function unlockView() {
    const pass = h("input", { type: "password", autocomplete: "current-password", autofocus: true });
    const err = h("p", { class: "error", role: "alert" }, S.error);
    const btn = h("button", { class: "btn primary", type: "button" }, "Unlock");
    const attempt = async () => {
      btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
      try { await store.unlock(pass.value); S.screen = "main"; S.tab = "timeline"; render(); }
      catch (e) {
        err.textContent = e instanceof WrongPassphrase ? "That passphrase is not correct." : "Could not unlock: " + e.message;
        btn.disabled = false; btn.textContent = "Unlock"; pass.value = "";
      }
    };
    btn.addEventListener("click", attempt);
    pass.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
    return h("div", { class: "app narrow" }, h("h1", {}, "T1D Log"), h("p", { class: "muted" }, "Locked. Enter your passphrase."), field("Passphrase", pass), err, btn);
  }

  // ------------------------------------------------------------------ main
  function mainView() {
    let body;
    if (S.tab === "timeline") body = timelineView();
    else if (S.tab === "dose") body = doseForm(S.edit && S.edit.kind === "dose" ? S.edit.rec : null);
    else if (S.tab === "meal") body = mealForm(S.edit && S.edit.kind === "meal" ? S.edit.rec : null);
    else if (S.tab === "tag") body = tagForm(S.edit && S.edit.kind === "tag" ? S.edit.rec : null);
    else body = moreView();
    const tabs = [["timeline", "Timeline"], ["dose", "Dose"], ["meal", "Meal"], ["tag", "Tag"], ["more", "More"]];
    return h("div", { class: "app" },
      h("header", { class: "top" }, h("strong", {}, "T1D Log"), h("button", { class: "linkbtn", onclick: lock, "aria-label": "Lock now" }, "Lock")),
      h("main", { id: "view" }, body),
      h("nav", { class: "tabs", "aria-label": "Main" }, tabs.map(([k, label]) =>
        h("button", { class: "tab" + (S.tab === k ? " active" : ""), "aria-current": S.tab === k ? "page" : null,
          onclick: () => go(k) }, label))));
  }

  // -------------------------------------------------------------- timeline
  function recordsForDay(dayKey) {
    const start = dayStartUtc(dayKey, tz()), end = dayStartUtc(addDays(dayKey, 1), tz());
    const inRange = (r) => r.t >= start && r.t < end;
    return { start, end, doses: store.list("dose").filter(inRange), meals: store.list("meal").filter(inRange), tags: store.list("tag").filter(inRange) };
  }

  const mealOf = (dose) => (dose.mealId ? store.get(dose.mealId) : null);
  const dosesOf = (meal) => store.list("dose").filter((d) => d.mealId === meal.id);

  function doseText(d) {
    const bits = [`${fmtHM(d.t)}`, `${d.role === "rapid" ? "Rapid" : "Long"} ${d.markerOnly ? "(units not recorded)" : fmtNum(d.units) + " u"}`];
    if (d.role === "rapid" && d.purpose) bits.push(d.purpose);
    const m = mealOf(d);
    if (m && !m.deleted) {
      const g = preBolusGapMin(d.t, m.t);
      bits.push(g > 0 ? `${g} min before meal` : g === 0 ? "at meal start" : `${-g} min after meal start`);
    }
    if (d.source === "libre_app") bits.push(d.supersededBy ? "Libre app log (duplicate of an in-app log)" : "from Libre app");
    return bits.join(" · ");
  }
  function mealText(m) {
    const bits = [fmtHM(m.t), m.title || "Meal"];
    if (m.totals && m.totals.carb !== null && m.totals.carb !== undefined) bits.push(`${fmtNum(m.totals.carb)} g carbs`);
    if (m.carbsUsedForDosing !== null && m.carbsUsedForDosing !== undefined) bits.push(`${fmtNum(m.carbsUsedForDosing)} g used for dose`);
    if (m.source === "libre_app") bits.push(m.supersededBy ? "Libre app log (duplicate of an in-app log)" : "from Libre app");
    return bits.join(" · ");
  }
  function tagText(t) {
    const bits = [fmtHM(t.t), TAG_LABEL[t.tag] || t.tag];
    const p = t.payload || {};
    if (t.tag === "exercise") bits.push([p.type, t.durationMin ? t.durationMin + " min" : null, p.fasted ? "fasted" : null].filter(Boolean).join(", "));
    else if (t.tag === "alcohol" && p.drinks) bits.push(`${p.drinks} drinks`);
    else if (t.tag === "hypo_treatment" && p.carbs_g !== null && p.carbs_g !== undefined) bits.push(`${fmtNum(p.carbs_g)} g carbs`);
    else if (t.tag === "ketone" && (p.mmol ?? null) !== null) bits.push(`${p.mmol} mmol/L`);
    else if (p.text) bits.push(p.text);
    return bits.filter(Boolean).join(" · ");
  }

  function timelineView() {
    const day = S.day || todayKey();
    const { start, end, doses, meals, tags } = recordsForDay(day);
    const readings = store.glucoseBetween(start, end);
    const s = settings();
    const canvas = h("canvas", { class: "chart", width: 340, height: 220, role: "img", "aria-label": `Glucose history for ${day}` });
    schedule(() => {
      const cs = typeof getComputedStyle !== "undefined" ? getComputedStyle(document.documentElement) : null;
      const col = (n, d) => (cs && cs.getPropertyValue(n).trim()) || d;
      drawDayChart(canvas, { readings, doses, meals, tags, startMs: start, endMs: end, unit: unit(), lowMgdl: s.targetLowMgdl, highMgdl: s.targetHighMgdl,
        colors: { bg: col("--card", "#fff"), text: col("--muted", "#4a5560"), grid: col("--line", "#d9dee3") } });
    });
    const latest = store.latestGlucose();
    const age = latest ? Math.round((now() - latest.t) / 60000) : null;
    const ageText = age === null ? "No glucose history imported yet." :
      `Latest imported reading: ${fmtDT(latest.t)} (${age < 120 ? age + " min" : Math.round(age / 60) + " h"} ago).`;
    const vals = readings.filter((r) => r.mgdl !== null).map((r) => r.mgdl);
    const stats = vals.length
      ? `${vals.length} readings · lowest ${formatGlucose(Math.min(...vals), unit())} · highest ${formatGlucose(Math.max(...vals), unit())} · average ${formatGlucose(vals.reduce((a, b) => a + b, 0) / vals.length, unit())} ${unit()}`
      : "No readings for this day.";

    const rows = [
      ...doses.map((r) => ({ r, kind: "dose", text: doseText(r) })),
      ...meals.map((r) => ({ r, kind: "meal", text: mealText(r) })),
      ...tags.map((r) => ({ r, kind: "tag", text: tagText(r) })),
    ].sort((a, b) => a.r.t - b.r.t);

    return h("div", {},
      !isStandalone() && !hideInstallHint ? h("div", { class: "card warn small" }, "Not added to your Home Screen yet. Safari can delete a website's stored data after 7 days without use; Home Screen apps are treated differently. In Safari: Share → Add to Home Screen, then open it from there.") : null,
      h("div", { class: "daynav" },
        h("button", { class: "btn", onclick: () => { S.day = addDays(day, -1); render(); }, "aria-label": "Previous day" }, "‹"),
        h("strong", {}, day === todayKey() ? `Today · ${day}` : day),
        h("button", { class: "btn", disabled: day >= todayKey(), onclick: () => { S.day = addDays(day, 1); render(); }, "aria-label": "Next day" }, "›")),
      h("div", { class: "card" }, canvas,
        h("p", { class: "legend small" }, "Line: Libre history · ○ scans · ▲ rapid/long doses · ● meals · ■ tags")),
      h("p", { class: "banner" }, ageText + " History only. Not for treatment decisions: use your Libre app."),
      h("p", { class: "small muted" }, stats),
      h("div", { class: "quick" },
        h("button", { class: "btn primary", onclick: () => go("dose") }, "+ Dose"),
        h("button", { class: "btn primary", onclick: () => go("meal") }, "+ Meal"),
        h("button", { class: "btn", onclick: () => go("tag") }, "+ Tag")),
      rows.length ? h("ul", { class: "list" }, rows.map(({ r, kind, text }) =>
        h("li", { class: r.supersededBy ? "dim" : "" },
          h("button", { class: "rowbtn", onclick: () => go(kind, { edit: { kind, rec: r } }) }, text)))) : h("p", { class: "muted" }, "Nothing logged for this day."));
  }

  // ------------------------------------------------------------- time input
  function timeControl(initialMs, onChange) {
    const input = h("input", { type: "datetime-local", value: toInputValue(initialMs, tz()) });
    input.addEventListener("input", () => onChange && onChange());
    input.addEventListener("change", () => onChange && onChange());
    const chips = [["Now", 0], ["5 min ago", 5], ["10 min ago", 10], ["15 min ago", 15], ["30 min ago", 30]].map(([label, m]) =>
      h("button", { class: "chip", type: "button", onclick: () => { input.value = toInputValue(now() - m * MIN, tz()); onChange && onChange(); } }, label));
    return { input, el: h("div", { class: "field" }, h("label", {}, "Time"), h("div", { class: "chips" }, chips), input),
      get ms() { return fromInputValue(input.value, tz()); } };
  }

  // ------------------------------------------------------------------ dose
  function doseForm(existing) {
    const s = settings();
    let role = existing ? existing.role : "rapid";
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Insulin type" });
    const units = h("input", { type: "number", inputmode: "decimal", step: String(s.increment), min: "0", value: existing ? String(existing.units ?? "") : "", "aria-label": "Units" });
    const stepBtn = (dir) => h("button", { class: "btn stepper", type: "button", "aria-label": dir > 0 ? "More units" : "Fewer units",
      onclick: () => { const v = numOrNull(units.value) ?? 0; units.value = String(Math.max(0, Math.round((v + dir * s.increment) * 100) / 100)); } }, dir > 0 ? "+" : "−");
    const purpose = h("select", {}, option("meal", "For a meal", !existing || existing.purpose === "meal"), option("correction", "Correction", existing?.purpose === "correction"), option("other", "Other", existing?.purpose === "other"));
    const purposeField = field("Purpose", purpose);
    const site = h("select", {}, option("", "—", !existing?.site), ...["abdomen", "thigh", "arm", "buttock", "other"].map((x) => option(x, x, existing?.site === x)));
    const notes = h("input", { type: "text", value: existing?.notes || "" });
    const err = h("p", { class: "error", role: "alert" });
    const linkSel = h("select", {});
    const linkField = field("Linked meal", linkSel, `Meals within ${LINK_AFTER_MIN} min before to ${LINK_BEFORE_MIN} min after this dose.`);
    const time = timeControl(existing ? existing.t : now(), refreshLink);

    function refreshSeg() {
      clear(seg);
      for (const [k, label] of [["rapid", "Rapid-acting"], ["long", "Long-acting"]]) {
        seg.append(h("button", { class: "segbtn" + (role === k ? " active" : ""), type: "button", "aria-pressed": String(role === k),
          onclick: () => { role = k; refreshSeg(); refreshLink(); } }, label));
      }
      purposeField.hidden = role !== "rapid";
      linkField.hidden = role !== "rapid";
    }
    function refreshLink() {
      const t = time.ms;
      clear(linkSel);
      linkSel.append(option("", "None", !existing?.mealId));
      if (role !== "rapid" || t === null) return;
      const cands = store.list("meal").filter((m) => m.t - t >= -LINK_AFTER_MIN * MIN && m.t - t <= LINK_BEFORE_MIN * MIN || m.id === existing?.mealId);
      for (const m of cands) {
        const g = preBolusGapMin(t, m.t);
        linkSel.append(option(m.id, `${fmtHM(m.t)} ${m.title || "Meal"} (${g >= 0 ? g + " min before" : -g + " min after"})`, m.id === existing?.mealId));
      }
      if (!existing && cands.length && !linkSel.value) linkSel.value = cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0].id;
    }
    refreshSeg(); refreshLink();

    const lastOf = () => store.list("dose").filter((d) => d.role === role && d.units).slice(-1)[0];
    const repeat = h("button", { class: "chip", type: "button", onclick: () => { const l = lastOf(); if (l) units.value = String(l.units); } }, "Repeat last units");

    const save = h("button", { class: "btn primary", type: "button" }, existing ? "Save changes" : "Save dose");
    save.addEventListener("click", async () => {
      err.textContent = "";
      const t = time.ms, u = numOrNull(units.value);
      const loggedAt = existing ? existing.loggedAt || now() : now();
      const rec = { ...(existing || {}), kind: "dose", role, units: u, t, tzName: tz(), source: existing?.source || "app",
        purpose: role === "rapid" ? purpose.value : "basal", insulin: role === "rapid" ? s.rapidName : s.longName,
        site: site.value || undefined, notes: notes.value.trim() || undefined, loggedAt,
        mealId: role === "rapid" && linkSel.value ? linkSel.value : undefined };
      rec.confidence = doseConfidence({ occurredAt: t, loggedAt, source: rec.source });
      const errs = validateDose(rec, s.increment);
      if (errs.length) { err.textContent = errs.join(" "); return; }
      const saved = await store.put(rec);
      S.edit = null; S.tab = "timeline"; S.day = localDateKey(t, tz()); render();
      toast(`Saved ${role === "rapid" ? "rapid" : "long-acting"} ${fmtNum(u)} u at ${fmtHM(t)}`, existing ? null : () => store.remove(saved.id).then(render));
    });
    const del = existing ? h("button", { class: "btn danger", type: "button", onclick: async () => {
      await store.remove(existing.id); S.edit = null; S.tab = "timeline"; render(); toast("Dose deleted", () => store.restore(existing.id).then(render));
    } }, "Delete") : null;

    return h("div", {}, h("h2", {}, existing ? "Edit dose" : "Log a dose"), seg,
      h("div", { class: "field" }, h("label", {}, "Units"), h("div", { class: "stepwrap" }, stepBtn(-1), units, stepBtn(1)), h("div", { class: "chips" }, repeat)),
      time.el, purposeField, linkField, field("Injection site (optional)", site), field("Notes (optional)", notes), err,
      h("div", { class: "actions" }, save, del, h("button", { class: "btn", type: "button", onclick: () => go("timeline") }, "Cancel")));
  }

  // ------------------------------------------------------------------ meal
  function mealForm(existing) {
    const items = existing ? existing.items.map((i) => ({ ...i })) : [];
    const title = h("input", { type: "text", value: existing?.title || "", placeholder: "e.g. Lunch (optional)" });
    const usedForDose = h("input", { type: "number", inputmode: "decimal", step: "1", min: "0", value: existing?.carbsUsedForDosing ?? "" });
    const err = h("p", { class: "error", role: "alert" });
    const itemsEl = h("ul", { class: "list" });
    const totalsEl = h("p", { class: "totals" });
    const linkEl = h("div", {});
    const tplCheck = h("input", { type: "checkbox" });
    const tplName = h("input", { type: "text", placeholder: "Template name" });
    let linkChecks = [];
    const time = timeControl(existing ? existing.t : now(), refreshLinks);

    function refreshItems() {
      clear(itemsEl);
      items.forEach((it, i) => itemsEl.append(h("li", {},
        h("span", {}, `${it.name}${it.grams ? " · " + it.grams + " g" : ""} · carbs ${fmtNum(it.carb)} g` +
          (it.protein !== null && it.protein !== undefined ? ` · P ${fmtNum(it.protein)}` : "") + (it.fat !== null && it.fat !== undefined ? ` · F ${fmtNum(it.fat)}` : "") + ` · ${it.method}`),
        h("button", { class: "linkbtn", type: "button", onclick: () => { items.splice(i, 1); refreshItems(); } }, "Remove"))));
      const t = mealTotals(items);
      totalsEl.textContent = items.length ? `Total: carbs ${fmtNum(t.carb)} g · protein ${fmtNum(t.protein)} g · fat ${fmtNum(t.fat)} g · fibre ${fmtNum(t.fibre)} g · sugars ${fmtNum(t.sugar)} g${t.incomplete ? " (some values missing)" : ""}` : "No items yet.";
    }
    function refreshLinks() {
      const t = time.ms;
      clear(linkEl); linkChecks = [];
      if (t === null) return;
      const cands = new Map();
      for (const d of suggestDoseLinks(t, store.list("dose"))) cands.set(d.id, d);
      if (existing) for (const d of dosesOf(existing)) cands.set(d.id, d);
      if (!cands.size) { linkEl.append(h("p", { class: "muted small" }, "No rapid doses logged near this time.")); return; }
      for (const d of [...cands.values()].sort((a, b) => a.t - b.t)) {
        const g = preBolusGapMin(d.t, t);
        const cb = h("input", { type: "checkbox", checked: existing ? d.mealId === existing.id : !d.mealId });
        linkChecks.push([d, cb]);
        linkEl.append(h("label", { class: "check" }, cb, ` ${fmtHM(d.t)} rapid ${fmtNum(d.units)} u (${g >= 0 ? g + " min before" : -g + " min after"} meal start)`));
      }
    }

    // add-item mini form
    const iName = h("input", { type: "text", placeholder: "Food name" });
    const num = (ph) => h("input", { type: "number", inputmode: "decimal", step: "0.1", min: "0", placeholder: ph });
    const iGrams = num("grams"), iCarb = num("carbs g"), iProt = num("protein g"), iFat = num("fat g"), iFib = num("fibre g"), iSug = num("sugars g");
    const iMethod = h("select", {}, METHODS.map(([k, label], i) => option(k, label, i === 1)));
    const addErr = h("p", { class: "error", role: "alert" });
    const addBtn = h("button", { class: "btn", type: "button" }, "Add item");
    addBtn.addEventListener("click", () => {
      addErr.textContent = "";
      const carb = numOrNull(iCarb.value);
      if (!iName.value.trim()) return void (addErr.textContent = "Give the food a name.");
      if (carb === null) return void (addErr.textContent = "Enter the carbs (use 0 if none).");
      const method = iMethod.value;
      items.push({ name: iName.value.trim(), grams: numOrNull(iGrams.value), carb, protein: numOrNull(iProt.value), fat: numOrNull(iFat.value),
        fibre: numOrNull(iFib.value), sugar: numOrNull(iSug.value), method, source: "manual", confidence: METHODS.find((m) => m[0] === method)[2] });
      for (const i of [iName, iGrams, iCarb, iProt, iFat, iFib, iSug]) i.value = "";
      refreshItems();
    });

    const saved = store.list("saved_meal");
    const savedSel = h("select", {}, option("", saved.length ? "Choose a saved meal…" : "No saved meals yet", true), saved.map((m) => option(m.id, m.name)));
    savedSel.addEventListener("change", () => {
      const m = store.get(savedSel.value);
      if (m) { items.push(...m.items.map((i) => ({ ...i }))); if (!title.value) title.value = m.name; refreshItems(); }
      savedSel.value = "";
    });

    const save = h("button", { class: "btn primary", type: "button" }, existing ? "Save changes" : "Save meal");
    save.addEventListener("click", async () => {
      err.textContent = "";
      const t = time.ms;
      if (t === null) return void (err.textContent = "Time is not valid.");
      if (!items.length) return void (err.textContent = "Add at least one item.");
      if (tplCheck.checked && !tplName.value.trim()) return void (err.textContent = "Name the template or untick it.");
      const confidence = items.reduce((m, i) => (CONF_RANK[i.confidence] < CONF_RANK[m] ? i.confidence : m), "high");
      const rec = { ...(existing || {}), kind: "meal", t, tzName: tz(), title: title.value.trim() || undefined, items, totals: mealTotals(items),
        carbsUsedForDosing: numOrNull(usedForDose.value), confidence, source: existing?.source || "app", loggedAt: existing?.loggedAt || now() };
      const meal = await store.put(rec);
      for (const [d, cb] of linkChecks) {
        if (cb.checked && d.mealId !== meal.id) await store.put({ ...d, mealId: meal.id });
        else if (!cb.checked && d.mealId === meal.id) await store.put({ ...d, mealId: undefined });
      }
      if (tplCheck.checked) await store.put({ kind: "saved_meal", name: tplName.value.trim(), items: items.map((i) => ({ ...i })) });
      S.edit = null; S.tab = "timeline"; S.day = localDateKey(t, tz()); render();
      toast(`Saved meal at ${fmtHM(t)}: ${fmtNum(meal.totals.carb)} g carbs`, existing ? null : () => store.remove(meal.id).then(render));
    });
    const del = existing ? h("button", { class: "btn danger", type: "button", onclick: async () => {
      await store.remove(existing.id); S.edit = null; S.tab = "timeline"; render(); toast("Meal deleted", () => store.restore(existing.id).then(render));
    } }, "Delete") : null;

    refreshItems(); refreshLinks();
    return h("div", {}, h("h2", {}, existing ? "Edit meal" : "Log a meal"), time.el, field("Title", title),
      field("Saved meal", savedSel),
      h("h3", {}, "Items"), itemsEl, totalsEl,
      h("details", { class: "card", open: items.length === 0 }, h("summary", {}, "Add an item"),
        field("Food", iName), h("div", { class: "grid2" }, field("Grams", iGrams), field("Carbs (g)", iCarb), field("Protein (g)", iProt), field("Fat (g)", iFat), field("Fibre (g)", iFib), field("Sugars (g)", iSug)),
        field("How was it measured?", iMethod), addErr, addBtn),
      field("Carbs I used for my dose (g, optional)", usedForDose, "Kept separately from the item total, so differences can be reviewed later."),
      h("h3", {}, "Link doses"), linkEl,
      h("label", { class: "check" }, tplCheck, " Save as a template"), tplName, err,
      h("div", { class: "actions" }, save, del, h("button", { class: "btn", type: "button", onclick: () => go("timeline") }, "Cancel")));
  }

  // ------------------------------------------------------------------- tag
  function tagForm(existing) {
    let kind = existing ? existing.tag : "exercise";
    const p0 = existing?.payload || {};
    const kindSel = h("select", {}, TAG_KINDS.map(([k, l]) => option(k, l, k === kind)));
    const fieldsEl = h("div", {});
    const err = h("p", { class: "error", role: "alert" });
    const time = timeControl(existing ? existing.t : now());
    let get = () => ({ payload: {} });

    function buildFields() {
      clear(fieldsEl);
      if (kind === "exercise") {
        const type = h("select", {}, ["aerobic", "interval", "resistance", "other"].map((x) => option(x, x, p0.type === x)));
        const dur = h("input", { type: "number", inputmode: "numeric", min: "1", value: existing?.durationMin ?? "" });
        const inten = h("select", {}, ["1", "2", "3", "4", "5"].map((x) => option(x, x + (x === "1" ? " (easy)" : x === "5" ? " (very hard)" : ""), String(p0.intensity ?? 3) === x)));
        const fed = h("select", {}, option("fed", "Fed", !p0.fasted), option("fasted", "Fasted", !!p0.fasted));
        fieldsEl.append(field("Type", type), field("Duration (minutes)", dur), field("Intensity", inten), field("Fed or fasted", fed));
        get = () => {
          const d = numOrNull(dur.value);
          if (!d || d <= 0) throw new Error("Enter the duration in minutes.");
          return { payload: { type: type.value, intensity: Number(inten.value), fasted: fed.value === "fasted" }, durationMin: d };
        };
      } else if (kind === "alcohol") {
        const drinks = h("input", { type: "number", inputmode: "decimal", min: "0", step: "0.5", value: p0.drinks ?? "" });
        fieldsEl.append(field("Approximate drinks", drinks));
        get = () => ({ payload: { drinks: numOrNull(drinks.value) } });
      } else if (kind === "hypo_treatment") {
        const g = h("input", { type: "number", inputmode: "decimal", min: "0", value: p0.carbs_g ?? "" });
        fieldsEl.append(field("Carbs taken (g)", g));
        get = () => { const v = numOrNull(g.value); if (v === null) throw new Error("Enter the carbs taken."); return { payload: { carbs_g: v } }; };
      } else if (kind === "ketone") {
        const k = h("input", { type: "number", inputmode: "decimal", step: "0.1", min: "0", value: p0.mmol ?? "" });
        fieldsEl.append(field("Ketones (mmol/L)", k));
        get = () => { const v = numOrNull(k.value); if (v === null) throw new Error("Enter the ketone reading."); return { payload: { mmol: v } }; };
      } else if (kind === "stress") {
        const lvl = h("select", {}, ["1", "2", "3", "4", "5"].map((x) => option(x, x, String(p0.level ?? 3) === x)));
        const txt = h("input", { type: "text", value: p0.text || "" });
        fieldsEl.append(field("Level (1 low – 5 high)", lvl), field("What happened (optional)", txt));
        get = () => ({ payload: { level: Number(lvl.value), text: txt.value.trim() || undefined } });
      } else if (kind === "sensor_change" || kind === "period") {
        const txt = h("input", { type: "text", value: p0.text || "", placeholder: kind === "sensor_change" ? "Serial or note (optional)" : "Note (optional)" });
        fieldsEl.append(field("Note", txt));
        get = () => ({ payload: { text: txt.value.trim() || undefined } });
      } else {
        const txt = h("input", { type: "text", value: p0.text || "" });
        fieldsEl.append(field(kind === "illness" ? "What is going on" : "Note", txt));
        get = () => { const v = txt.value.trim(); if (kind === "note" && !v) throw new Error("Write a note."); return { payload: { text: v || undefined } }; };
      }
    }
    kindSel.addEventListener("change", () => { kind = kindSel.value; buildFields(); });
    buildFields();

    const save = h("button", { class: "btn primary", type: "button" }, existing ? "Save changes" : "Save tag");
    save.addEventListener("click", async () => {
      err.textContent = "";
      const t = time.ms;
      if (t === null) return void (err.textContent = "Time is not valid.");
      let extra;
      try { extra = get(); } catch (e) { return void (err.textContent = e.message); }
      const rec = { ...(existing || {}), kind: "tag", tag: kind, t, tzName: tz(), source: existing?.source || "app", payload: extra.payload, durationMin: extra.durationMin };
      const saved = await store.put(rec);
      S.edit = null; S.tab = "timeline"; S.day = localDateKey(t, tz()); render();
      toast(`Saved ${TAG_LABEL[kind]}`, existing ? null : () => store.remove(saved.id).then(render));
    });
    const del = existing ? h("button", { class: "btn danger", type: "button", onclick: async () => {
      await store.remove(existing.id); S.edit = null; S.tab = "timeline"; render(); toast("Tag deleted", () => store.restore(existing.id).then(render));
    } }, "Delete") : null;
    return h("div", {}, h("h2", {}, existing ? "Edit tag" : "Add a tag"), field("Type", kindSel), time.el, fieldsEl, err,
      h("div", { class: "actions" }, save, del, h("button", { class: "btn", type: "button", onclick: () => go("timeline") }, "Cancel")));
  }

  // ------------------------------------------------------------------ more
  function moreView() {
    if (S.sub === "import") return importView();
    if (S.sub === "quality") return qualityView();
    if (S.sub === "data") return dataView();
    if (S.sub === "settings") return settingsView();
    if (S.sub === "about") return aboutView();
    const item = (sub, title, desc) => h("li", {}, h("button", { class: "rowbtn", onclick: () => go("more", { sub }) }, h("strong", {}, title), h("br"), h("span", { class: "muted small" }, desc)));
    return h("div", {}, h("h2", {}, "More"),
      h("ul", { class: "list" },
        item("import", "Import Libre data", "Add a LibreView CSV export"),
        item("quality", "Data quality", "Gaps, duplicates, logging completeness"),
        item("data", "Backup, export and delete", "Encrypted backup and restore; files for analysis"),
        item("settings", "Settings", "Units, insulin names, auto-lock"),
        item("about", "About and safety", "What this app is and is not")));
  }

  const back = () => h("button", { class: "linkbtn", onclick: () => go("more") }, "‹ More");

  // ----------------------------------------------------------------- import
  async function readFile(file) {
    if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer());
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
  }

  function runParse() {
    const imp = S.imp;
    imp.result = null; imp.error = ""; imp.candidates = null;
    try { imp.result = parseLibreView(imp.bytes, { tz: imp.tz, dateFormat: imp.dateFormat }); }
    catch (e) {
      if (e instanceof AmbiguousDateFormat) imp.candidates = e.candidates;
      else if (e instanceof ParseError) imp.error = e.message;
      else imp.error = "Could not read this file: " + e.message;
    }
  }

  function importView() {
    const imp = S.imp;
    const fileIn = h("input", { type: "file", accept: ".csv,.txt,text/csv", "aria-label": "LibreView CSV file" });
    fileIn.addEventListener("change", async () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      S.imp = { fileName: f.name, bytes: await readFile(f), tz: tz(), dateFormat: undefined };
      runParse(); render();
    });
    const parts = [back(), h("h2", {}, "Import Libre data"),
      h("p", { class: "muted" }, "Export a CSV from LibreView (Glucose History → Download Glucose Data), then choose it here. The file also contains the account holder's name; this app does not read or keep it. Importing the same file twice is safe."),
      field("LibreView CSV", fileIn)];
    if (imp) {
      if (imp.error) parts.push(h("p", { class: "error", role: "alert" }, imp.error));
      if (imp.candidates) {
        const radios = imp.candidates.map((c, i) => h("label", { class: "check" }, h("input", { type: "radio", name: "datefmt", value: c, checked: i === 0 }), " " + describeFormat(c)));
        parts.push(h("div", { class: "card warn" }, h("strong", {}, "Which date order does this file use?"),
          h("p", {}, "The dates in this file could be read two ways, and the file's export time does not settle it. Please choose."), ...radios,
          h("button", { class: "btn", type: "button", onclick: () => { const v = root.querySelector('input[name="datefmt"]:checked'); imp.dateFormat = v ? v.value : undefined; runParse(); render(); } }, "Use this")));
      }
      if (imp.result) parts.push(reportView(imp));
    }
    parts.push(batchesView());
    return h("div", {}, ...parts);
  }

  function reportView(imp) {
    const r = imp.result.report;
    const tzIn = h("input", { type: "text", value: imp.tz });
    const row = (k, v) => h("div", { class: "kv" }, h("span", { class: "muted" }, k), h("span", {}, v));
    const kinds = Object.entries(r.events_by_kind).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ");
    const iv = r.auto_reading_interval_minutes;
    const unitsFile = [...new Set(Object.values(r.glucose_units_in_file))].join(", ");
    const commit = h("button", { class: "btn primary", type: "button" }, "Import this file");
    commit.addEventListener("click", async () => {
      commit.disabled = true; commit.textContent = "Importing…";
      const res = await store.importBatch(imp.result, { tz: imp.tz, fileName: imp.fileName });
      S.imp = null; render();
      toast(`Imported ${res.newGlucose} readings and ${res.newEvents} log entries (${res.skippedGlucose + res.skippedEvents} already present).`, () => store.undoBatch(res.batchId).then(render));
    });
    return h("div", { class: "card" }, h("h3", {}, "Check before importing"),
      row("File", imp.fileName), row("Date range", r.date_range_local ? `${r.date_range_local[0]} to ${r.date_range_local[1]}` : "none"),
      row("Rows", `${r.rows_in_file} (${kinds || "no events"})`),
      row("Reading interval", iv.count ? `median ${iv.median} min over ${iv.count} automatic readings` : "no automatic readings"),
      row("Gaps over 30 min", `${r.gaps_over_30_min.count} (longest ${r.gaps_over_30_min.longest_min} min)`),
      row("Skipped", `${r.duplicate_rows_dropped} duplicates, ${r.empty_rows_discarded} empty rows, ${r.rows_wrong_length + r.rows_bad_timestamp} unreadable`),
      row("Glucose units in file", unitsFile || "—"), row("Date format", `${describeFormat(r.date_format_used)} (${r.date_format_resolution.replace(/_/g, " ")})`),
      row("Daylight-saving rows flagged", String(r.dst_flagged_rows)), row("Sensor", r.likely_sensor_family),
      r.unknown_columns.length ? row("Unrecognised columns", r.unknown_columns.join(", ")) : null,
      h("p", { class: "small muted" }, "Privacy: the account name in the file was not read or stored."),
      field("Time zone of the sensor's clock", tzIn),
      h("div", { class: "actions" }, commit,
        h("button", { class: "btn", type: "button", onclick: () => { imp.tz = tzIn.value.trim() || imp.tz; runParse(); render(); } }, "Re-check with this zone"),
        h("button", { class: "btn", type: "button", onclick: () => { S.imp = null; render(); } }, "Cancel")));
  }

  function batchesView() {
    const batches = store.list("import_batch").sort((a, b) => b.t - a.t);
    if (!batches.length) return h("p", { class: "muted" }, "No imports yet.");
    return h("div", {}, h("h3", {}, "Previous imports"), h("ul", { class: "list" }, batches.map((b) =>
      h("li", {}, h("span", {}, `${fmtDT(b.t)} · ${b.fileName || "file"} · ${b.counts.newGlucose} readings, ${b.counts.newEvents} entries`, b.undoneAt ? " · undone" : ""),
        b.undoneAt ? null : h("button", { class: "linkbtn", onclick: async () => { await store.undoBatch(b.id); render(); toast("Import undone"); } }, "Undo")))));
  }

  // ---------------------------------------------------------------- quality
  function qualityView() {
    const since = now() - 30 * 24 * 60 * MIN;
    const readings = store.glucoseBetween(since, now() + 1);
    const gaps = glucoseGaps(readings);
    const doses = store.list("dose"), meals = store.list("meal");
    const dup = [...doses, ...meals].filter((r) => r.supersededBy).length;
    const flagged = settings().flagUnlogged ? possibleUnloggedDose(readings, doses) : null;
    const perDay = [];
    for (let i = 6; i >= 0; i--) {
      const key = addDays(todayKey(), -i);
      const { doses: dd, meals: mm } = recordsForDay(key);
      perDay.push(h("div", { class: "kv" }, h("span", {}, key), h("span", {}, `${dd.filter((d) => d.role === "rapid").length} rapid doses · ${mm.length} meals`)));
    }
    return h("div", {}, back(), h("h2", {}, "Data quality"),
      h("p", { class: "muted" }, "These checks describe the log. They are not medical advice."),
      h("div", { class: "card" }, h("h3", {}, "Glucose gaps (last 30 days)"),
        gaps.length ? h("ul", { class: "list" }, gaps.slice(-15).reverse().map((g) => h("li", {}, `${fmtDT(g.from)} → ${fmtDT(g.to)} (${g.minutes} min)`))) : h("p", {}, readings.length ? "No gaps over 30 minutes." : "No readings in the last 30 days.")),
      h("div", { class: "card" }, h("h3", {}, "Duplicates"), h("p", {}, `${dup} imported Libre-app entries match an in-app entry within 10 minutes. Both are kept; the imported one is marked.`)),
      h("div", { class: "card" }, h("h3", {}, "Logging in the last 7 days"), ...perDay),
      flagged ? h("div", { class: "card" }, h("h3", {}, "Rises with no rapid dose logged"),
        h("p", { class: "small muted" }, "A log-completeness check only. Thresholds are placeholders. A rise may have other causes."),
        flagged.length ? h("ul", { class: "list" }, flagged.slice(-10).reverse().map((f) => h("li", {}, `${fmtDT(f.from)} to ${fmtHM(f.to)}: rose ${formatGlucose(f.riseMgdl, unit())} ${unit()}. Is the log complete for this period?`))) : h("p", {}, "None found.")) : null);
  }

  // ------------------------------------------------------------ data screen
  const countOf = (exp) => exp.doses.length + exp.meals.length + exp.tags.length + exp.savedMeals.length + exp.glucose.length;

  function dataView() {
    const s = settings();
    const stamp = localDateKey(now(), tz());

    // storage status
    const status = h("p", { class: "muted small" }, "Checking storage…");
    (async () => {
      try {
        const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
        const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
        status.textContent = `Persistent storage: ${persisted === null ? "unknown" : persisted ? "granted" : "not granted"}. ` +
          (est ? `Using about ${Math.round((est.usage || 0) / 1024)} KB.` : "") + ` Home Screen app: ${isStandalone() ? "yes" : "no"}.`;
      } catch { status.textContent = "Storage status unavailable."; }
    })();

    // encrypted backup
    const bpass = h("input", { type: "password", autocomplete: "off", placeholder: "Backup passphrase (8+ characters)", "aria-label": "Backup passphrase" });
    const berr = h("p", { class: "error", role: "alert" });
    const pending = h("p", { class: "small muted" }, "");
    (async () => {
      const exp = await store.exportAll({ since: s.lastBackupAt ?? null });
      pending.textContent = s.lastBackupAt ? `${countOf(exp)} entries added or changed since your last backup.` : "No backup yet.";
    })();
    const doBackup = async (sinceLast) => {
      berr.textContent = "";
      if (bpass.value.length < 8) return void (berr.textContent = "Use a backup passphrase of at least 8 characters. You will need it to restore.");
      const exp = await store.exportAll({ since: sinceLast ? (s.lastBackupAt ?? null) : null });
      const env = await encryptBackup(bpass.value, exp, iterations);
      await saveFile(`t1dlog-backup-${stamp}${exp.scope === "since" ? "-new" : ""}.json`, "application/json", JSON.stringify(env));
      await store.put({ ...store.settings(), lastBackupAt: now() });
      render();
      toast("Backup file created. Keep it somewhere private (it is encrypted).");
    };

    // restore
    const rfile = h("input", { type: "file", accept: ".json,application/json", "aria-label": "Backup file" });
    const rpass = h("input", { type: "password", autocomplete: "off", placeholder: "Backup passphrase (if encrypted)", "aria-label": "Passphrase for the backup file" });
    const rout = h("div", {});
    const rerr = h("p", { class: "error", role: "alert" });
    const check = h("button", { class: "btn", type: "button" }, "Check backup file");
    check.addEventListener("click", async () => {
      rerr.textContent = ""; clear(rout);
      const f = rfile.files && rfile.files[0];
      if (!f) return void (rerr.textContent = "Choose a backup file first.");
      let obj;
      try {
        let parsed = JSON.parse(new TextDecoder().decode(await readFile(f)));
        if (isEncryptedBackup(parsed)) {
          if (!rpass.value) return void (rerr.textContent = "This backup is encrypted. Enter its passphrase.");
          parsed = await decryptBackup(rpass.value, parsed);
        }
        if (!parsed || parsed.app !== "t1dlog" || parsed.format !== 1) throw new Error("This file is not a T1D Log backup.");
        obj = parsed;
      } catch (e) {
        rerr.textContent = e instanceof BadBackupPassphrase ? "That passphrase does not open this backup." : e.message || "Could not read the file.";
        return;
      }
      const g = obj.glucose || [];
      const times = g.map((r) => r.t).filter(Number.isFinite);
      rout.append(h("div", { class: "card" }, h("h3", {}, "Backup contents"),
        h("div", { class: "kv" }, h("span", { class: "muted" }, "Type"), h("span", {}, obj.scope === "since" ? "New entries only" : "Full backup")),
        h("div", { class: "kv" }, h("span", { class: "muted" }, "Made"), h("span", {}, obj.exportedAt ? obj.exportedAt.slice(0, 16).replace("T", " ") : "unknown")),
        h("div", { class: "kv" }, h("span", { class: "muted" }, "Entries"), h("span", {}, `${(obj.doses || []).length} doses, ${(obj.meals || []).length} meals, ${(obj.tags || []).length} tags, ${(obj.savedMeals || []).length} templates`)),
        h("div", { class: "kv" }, h("span", { class: "muted" }, "Glucose"), h("span", {}, g.length ? `${g.length} readings, ${fmtDT(Math.min(...times.slice(0, 5000)))} onwards` : "none")),
        h("p", { class: "small muted" }, "Restoring adds what is missing. Nothing you already have is deleted, and newer versions are never replaced by older ones. Settings in the file are ignored."),
        h("button", { class: "btn primary", type: "button", onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = "Restoring…";
          try {
            const c = await store.restoreBackup(obj, { tz: tz() });
            render();
            toast(`Restored ${c.records} entries and ${c.glucose} readings (${c.skippedRecords + c.skippedGlucose} already present).`);
          } catch (e) { rerr.textContent = e.message; ev.target.disabled = false; ev.target.textContent = "Restore"; }
        } }, "Restore")));
    });

    // plain exports for analysis
    const plain = async (kind) => {
      const exp = await store.exportAll();
      if (kind === "json") await saveFile(`t1dlog-export-${stamp}.json`, "application/json", JSON.stringify(exp, null, 1));
      else for (const [name, text] of Object.entries(buildCsvs(exp, tz()))) await saveFile(`t1dlog-${stamp}-${name}`, "text/csv", text);
    };

    const savedMeals = store.list("saved_meal");
    const confirm = h("input", { type: "text", placeholder: "Type DELETE", autocomplete: "off" });
    const wipeErr = h("p", { class: "error", role: "alert" });
    return h("div", {}, back(), h("h2", {}, "Backup, export and delete"),
      h("div", { class: "card" }, h("h3", {}, "Encrypted backup"),
        h("p", { class: "muted small" }, "Your data lives only on this phone, so a backup is your safety net (cleared Safari data, a lost phone). The backup file is encrypted with the passphrase below, so it is safe to keep in iCloud Drive or Files. There is no way to recover it without that passphrase."),
        s.lastBackupAt ? h("p", {}, `Last backup: ${fmtDT(s.lastBackupAt)}.`) : null, pending,
        field("Backup passphrase", bpass), berr,
        h("div", { class: "actions" },
          h("button", { class: "btn primary", onclick: () => doBackup(false) }, "Back up everything"),
          s.lastBackupAt ? h("button", { class: "btn", onclick: () => doBackup(true) }, "Back up new entries only") : null)),
      h("div", { class: "card" }, h("h3", {}, "Restore from a backup"),
        h("p", { class: "muted small" }, "On a new phone: set up a log first (any passphrase), then restore. Restore full and 'new entries' backups in any order."),
        rfile, field("Passphrase", rpass), rerr, check, rout),
      h("div", { class: "card" }, h("h3", {}, "Export for analysis (not encrypted)"),
        h("p", { class: "muted small" }, "Plain-text files for your own analysis. They contain your health data unprotected; store and share them carefully."),
        h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => plain("csv") }, "CSV files"), h("button", { class: "btn", onclick: () => plain("json") }, "JSON file"))),
      h("div", { class: "card" }, h("h3", {}, "Storage"), status),
      h("div", { class: "card" }, h("h3", {}, "Saved meal templates"),
        savedMeals.length ? h("ul", { class: "list" }, savedMeals.map((m) => h("li", {}, h("span", {}, `${m.name} (${m.items.length} items)`),
          h("button", { class: "linkbtn", onclick: async () => { await store.remove(m.id); render(); } }, "Delete")))) : h("p", { class: "muted" }, "None yet.")),
      h("div", { class: "card danger-zone" }, h("h3", {}, "Delete everything"),
        h("p", { class: "small" }, "Permanently removes all data from this phone, including the encryption setup. This cannot be undone. Make a backup first."),
        confirm, wipeErr,
        h("button", { class: "btn danger", onclick: async () => {
          if (confirm.value.trim() !== "DELETE") return void (wipeErr.textContent = "Type DELETE to confirm.");
          await store.wipe();
          try { if (typeof caches !== "undefined") for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
          S.screen = "setup"; S.tab = "timeline"; S.sub = null; S.imp = null; render();
        } }, "Delete all data")));
  }

  // --------------------------------------------------------------- settings
  function settingsView() {
    const s = settings();
    const unitSel = h("select", {}, option("mmol/L", "mmol/L", s.glucoseUnit === "mmol/L"), option("mg/dL", "mg/dL", s.glucoseUnit === "mg/dL"));
    const tzIn = h("input", { type: "text", value: s.tz });
    const rapid = h("input", { type: "text", value: s.rapidName }), long = h("input", { type: "text", value: s.longName });
    const inc = h("select", {}, option("0.5", "0.5 units", s.increment === 0.5), option("1", "1 unit", s.increment === 1));
    const lowIn = h("input", { type: "number", step: "0.1", value: formatGlucose(s.targetLowMgdl, s.glucoseUnit) });
    const highIn = h("input", { type: "number", step: "0.1", value: formatGlucose(s.targetHighMgdl, s.glucoseUnit) });
    const lockSel = h("select", {}, [[0, "Whenever I leave the app"], [1, "After 1 minute away"], [5, "After 5 minutes away"], [15, "After 15 minutes away"], [60, "After 1 hour away"]].map(([v, l]) => option(String(v), l, s.lockMinutes === v)));
    const flag = h("input", { type: "checkbox", checked: s.flagUnlogged });
    const err = h("p", { class: "error", role: "alert" });
    const msg = h("p", { class: "ok" });
    return h("div", {}, back(), h("h2", {}, "Settings"),
      field("Glucose units", unitSel), field("Time zone", tzIn), field("Rapid-acting insulin name", rapid), field("Long-acting insulin name", long),
      field("Pen increment", inc), field("Chart target: low", lowIn), field("Chart target: high", highIn), field("Auto-lock", lockSel),
      h("label", { class: "check" }, flag, " Show 'rises with no rapid dose logged' on the data-quality screen"),
      err, msg,
      h("button", { class: "btn primary", onclick: async () => {
        err.textContent = ""; msg.textContent = "";
        try { Intl.DateTimeFormat("en-GB", { timeZone: tzIn.value.trim() }); } catch { return void (err.textContent = "Time zone not recognised."); }
        const u = unitSel.value, lo = numOrNull(lowIn.value), hi = numOrNull(highIn.value);
        if (lo === null || hi === null || lo >= hi) return void (err.textContent = "Check the chart target values.");
        await store.put({ ...store.settings(), glucoseUnit: u, tz: tzIn.value.trim(), rapidName: rapid.value.trim(), longName: long.value.trim(),
          increment: Number(inc.value), targetLowMgdl: toMgdl(lo, u), targetHighMgdl: toMgdl(hi, u), lockMinutes: Number(lockSel.value), flagUnlogged: flag.checked });
        msg.textContent = "Saved.";
      } }, "Save settings"));
  }

  // ------------------------------------------------------------------ about
  function aboutView() {
    return h("div", {}, back(), h("h2", {}, "About and safety"),
      h("div", { class: "card warn" }, h("p", {}, "This is a personal logbook and review tool. It is not a medical device. It does not calculate or suggest insulin doses, does not give alarms, and does not replace your Libre app, your alarms or your care team. Glucose shown here is imported history only.")),
      h("p", {}, "Your data is stored encrypted on this device only. The app makes no network requests for your data; it has no accounts, analytics or ads."),
      h("p", { class: "muted small" }, `Version ${APP_VERSION}. Food data attributions will appear here when food databases are added.`));
  }

  // ------------------------------------------------------------------- boot
  await store.open();
  S.screen = (await store.isInitialised()) ? "unlock" : "setup";
  render();
  return { S, render, go, lock, store };
}
