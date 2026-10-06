// LibreView CSV importer (JavaScript port of reference/libreview_parser.py).
// Rules: header-driven, tolerant, no silent date guessing, account name discarded,
// duplicate-safe, irregular sampling expected. See the Phase 0a spec, section 5.
// Output must match tests/golden/*.json produced by the Python reference.

import { strptime, isoLocal, isoUtc, localToUtc } from "./timeutil.js";
import { sha256Bytes, sha256Hex } from "./sha256.js";

export const MMOL_TO_MGDL = 18.0182;

export class ParseError extends Error {
  constructor(msg) { super(msg); this.name = "ParseError"; }
}
export class AmbiguousDateFormat extends ParseError {
  constructor(candidates) {
    super("Date format is ambiguous. Candidates: " + candidates.join(", ") + ". Pass dateFormat explicitly.");
    this.name = "AmbiguousDateFormat";
    this.candidates = candidates;
  }
}

const COLUMN_PATTERNS = [
  ["device", /^device$/],
  ["serial", /^serial number$/],
  ["timestamp", /^device timestamp$/],
  ["record_type", /^record type$/],
  ["hist_glucose", /^historic glucose/],
  ["scan_glucose", /^scan glucose/],
  ["rapid_marker", /^non-numeric rapid-acting insulin$/],
  ["rapid_units", /^rapid-acting insulin \(units\)$/],
  ["food_marker", /^non-numeric food$/],
  ["carbs_g", /^carbohydrates \(grams\)$/],
  ["carbs_servings", /^carbohydrates \(servings\)$/],
  ["long_marker", /^non-numeric long-acting insulin$/],
  ["long_units", /^long-acting insulin( value)? \(units\)$/],
  ["notes", /^notes$/],
  ["strip_glucose", /^strip glucose/],
  ["ketone", /^ketone/],
  ["meal_insulin", /^meal insulin \(units\)$/],
  ["correction_insulin", /^correction insulin \(units\)$/],
  ["user_change_insulin", /^user change insulin \(units\)$/],
];
const GLUCOSE_KEYS = ["hist_glucose", "scan_glucose", "strip_glucose"];

export const DATE_FORMATS = [
  "%m-%d-%Y %I:%M %p", "%m-%d-%Y %I:%M:%S %p", "%m-%d-%Y %H:%M", "%m-%d-%Y %H:%M:%S",
  "%m/%d/%Y %I:%M %p", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S",
  "%d-%m-%Y %I:%M %p", "%d-%m-%Y %I:%M:%S %p", "%d-%m-%Y %H:%M", "%d-%m-%Y %H:%M:%S",
  "%d/%m/%Y %I:%M %p", "%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S",
  "%d.%m.%Y %H:%M", "%d.%m.%Y %H:%M:%S",
  "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d %H:%M:%S",
];

// ------------------------------------------------------------------ helpers
const normHeader = (h) => h.trim().toLowerCase().replace(/\s+/g, " ");

function unitFromHeader(h) {
  const l = h.toLowerCase();
  if (l.includes("mmol")) return "mmol/L";
  if (l.includes("mg/dl")) return "mg/dL";
  return null;
}

function decode(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return new TextDecoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function detectDelimiter(line) {
  let best = ",", bestN = 0;
  for (const d of [",", ";", "\t"]) {
    const n = line.split(d).length - 1;
    if (n > bestN) { best = d; bestN = n; }
  }
  return bestN > 0 ? best : ",";
}

/** Parse one CSV line (RFC 4180 style quotes). */
export function parseCsvLine(line, delim) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseNumber(raw, delimiter) {
  const s = raw.trim();
  if (s === "") return [null, null];
  let t = s;
  if (t.includes(",") && !t.includes(".") && delimiter !== ",") t = t.replace(",", ".");
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return [parseFloat(t), null];
  return [null, s];
}

const round2 = (x) => Number(x.toFixed(2));
function pyRound(x) {                   // Python's banker's rounding
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// ----------------------------------------------------------------- metadata
function readMetadata(lines, headerIdx, delimiter) {
  const meta = { generated_on_raw: null, provider_export: false, account_name_discarded: false, extra_rows_discarded: 0 };
  for (let i = 0; i < headerIdx; i++) {
    const cells = parseCsvLine(lines[i], delimiter).map((c) => c.trim());
    if (i === 0) {
      if (cells[0] && cells[0].toLowerCase().startsWith("patient report")) meta.provider_export = true;
      cells.forEach((c, j) => {
        if (c.toLowerCase() === "generated on" && j + 1 < cells.length) {
          meta.generated_on_raw = cells[j + 1].replace(/\s*UTC\s*$/, "").trim();
        }
        if (c.toLowerCase() === "generated by") meta.account_name_discarded = true;  // value never read
      });
    } else {
      meta.extra_rows_discarded += 1;     // e.g. name / date-of-birth row
    }
  }
  return meta;
}

// ------------------------------------------------------- date format choice
function resolveDateFormat(rawTs, generatedOnRaw, forced, maxUnparsed = 0.01) {
  if (!rawTs.length) throw new ParseError("No data rows found.");
  if (forced) return [forced, "user_supplied"];
  const sample = [...new Set(rawTs)];
  const scored = [];
  for (const fmt of DATE_FORMATS) {
    const allowed = maxUnparsed * sample.length;
    let failures = 0, okCount = 0, max = -Infinity;
    for (const s of sample) {
      const v = strptime(fmt, s);
      if (v === null) { if (++failures > allowed) break; }      // this format cannot be the right one
      else { okCount++; if (v > max) max = v; }
    }
    if (okCount && failures <= allowed) scored.push({ failures, fmt, max });
  }
  if (!scored.length) throw new ParseError("No known timestamp format matches this file.");
  const best = Math.min(...scored.map((s) => s.failures));
  const candidates = scored.filter((s) => s.failures === best);
  if (candidates.length === 1) return [candidates[0].fmt, "unambiguous"];

  if (generatedOnRaw) {
    const gens = DATE_FORMATS.map((f) => strptime(f, generatedOnRaw)).filter((g) => g !== null);
    const DAY = 86400000;
    const close = [];
    for (const c of candidates) {
      for (const g of gens) {
        const delta = g - c.max;
        if (delta >= -DAY && delta <= 2 * DAY) { close.push(c.fmt); break; }
      }
    }
    const uniq = [...new Set(close)];
    if (uniq.length === 1) return [uniq[0], "resolved_by_generated_on"];
    if (uniq.length > 1 && sameInstants(uniq, sample)) return [uniq[0], "resolved_by_generated_on"];
  }
  throw new AmbiguousDateFormat(candidates.map((c) => c.fmt));
}

function sameInstants(formats, sample) {
  const first = sample.map((s) => strptime(formats[0], s));
  return formats.slice(1).every((f) => sample.every((s, i) => strptime(f, s) === first[i]));
}

// -------------------------------------------------------------- main parse
/**
 * @param {Uint8Array|ArrayBuffer|string} input
 * @param {{tz?: string, dateFormat?: string}} [opts]
 * @returns {{events: object[], report: object, fileHash: string}}
 */
export function parseLibreView(input, opts = {}) {
  const tz = opts.tz || "Europe/London";
  let bytes;
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else bytes = input;
  if (!bytes.some((b) => ![0x20, 0x09, 0x0a, 0x0d].includes(b))) throw new ParseError("File is empty.");
  const fileHash = sha256Bytes(bytes);
  const text = decode(bytes);

  const original = text.split(/\r\n|\n|\r/);
  const nonblankNumbers = [];
  const lines = [];
  original.forEach((ln, i) => { if (ln.trim() !== "") { lines.push(ln); nonblankNumbers.push(i + 1); } });

  // Header + metadata
  let headerIdx = -1;
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const low = lines[i].toLowerCase();
    if (low.includes("device timestamp") && low.includes("record type")) { headerIdx = i; break; }
  }
  if (headerIdx < 0) {
    throw new ParseError("Could not find a header row containing 'Device Timestamp' and 'Record Type' in the first 8 lines.");
  }
  const delimiter = detectDelimiter(lines[headerIdx]);
  const meta = readMetadata(lines, headerIdx, delimiter);
  const header = parseCsvLine(lines[headerIdx], delimiter);

  // Column map (by name)
  const colmap = {}, units = {}, unknownCols = [];
  header.forEach((h, idx) => {
    const nh = normHeader(h);
    let hit = null;
    for (const [key, pat] of COLUMN_PATTERNS) { if (pat.test(nh)) { hit = key; break; } }
    if (hit && !(hit in colmap)) {
      colmap[hit] = idx;
      if (GLUCOSE_KEYS.includes(hit)) units[hit] = unitFromHeader(h) || "mg/dL";
    } else unknownCols.push(h);
  });
  if (!("timestamp" in colmap) || !("record_type" in colmap)) throw new ParseError("Required columns (Device Timestamp, Record Type) not found.");
  if (!GLUCOSE_KEYS.some((k) => k in colmap)) throw new ParseError("No glucose column found.");

  // Data rows (keeping 1-based file line numbers)
  const rows = [];
  for (let k = headerIdx + 1; k < lines.length; k++) rows.push([nonblankNumbers[k], parseCsvLine(lines[k], delimiter)]);
  const cell = (cells, key) => {
    const i = colmap[key];
    return i !== undefined && i < cells.length ? cells[i].trim() : "";
  };

  const tsRawAll = rows.filter(([, c]) => c.length === header.length).map(([, c]) => cell(c, "timestamp"));
  const [fmt, how] = resolveDateFormat(tsRawAll, meta.generated_on_raw, opts.dateFormat);

  const events = [];
  const counters = { rows_wrong_length: 0, rows_bad_timestamp: 0, empty_rows_discarded: 0,
    duplicate_rows_dropped: 0, dst_flagged_rows: 0, rows_with_unmapped_data: 0 };
  const seen = new Set();
  const devices = new Map(), serials = new Map(), typeCounts = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const unparsed = [];
  const INFO_SKIP = new Set(["device", "serial", "timestamp", "record_type"]);

  for (const [lineNo, cells] of rows) {
    if (cells.length !== header.length) {
      counters.rows_wrong_length++; unparsed.push([lineNo, "wrong number of fields"]); continue;
    }
    const tsRaw = cell(cells, "timestamp");
    const naive = strptime(fmt, tsRaw);
    if (naive === null) {
      counters.rows_bad_timestamp++; unparsed.push([lineNo, "timestamp does not match chosen format"]); continue;
    }
    const rtype = cell(cells, "record_type");
    bump(typeCounts, rtype);
    const device = cell(cells, "device"), serial = cell(cells, "serial");
    bump(devices, device); bump(serials, serial);

    const populated = {};
    for (const key of Object.keys(colmap)) {
      if (INFO_SKIP.has(key)) continue;
      const v = cell(cells, key);
      if (v !== "") populated[key] = v;
    }
    if (!Object.keys(populated).length) { counters.empty_rows_discarded++; continue; }

    const rowHash = sha256Hex([serial, tsRaw, rtype]
      .concat(Object.keys(populated).sort().map((k) => `${k}=${populated[k]}`)).join("\x1f"));
    if (seen.has(rowHash)) { counters.duplicate_rows_dropped++; continue; }
    seen.add(rowHash);

    const { utcMs, flags: dstFlags } = localToUtc(naive, tz);
    if (dstFlags.length) counters.dst_flagged_rows++;

    const add = (kind, data, extra = []) => events.push({
      kind, local: isoLocal(naive), utc: isoUtc(utcMs), utcMs, naiveMs: naive,
      source_row: lineNo, row_hash: rowHash, device, serial, flags: [...dstFlags, ...extra], data,
    });
    let produced = false;

    for (const [key, kind, expect] of [["hist_glucose", "glucose_auto", "0"], ["scan_glucose", "glucose_scan", "1"],
      ["strip_glucose", "glucose_strip", null]]) {
      if (populated[key]) {
        const [val, textVal] = parseNumber(populated[key], delimiter);
        const unit = units[key] || "mg/dL";
        const fl = [];
        if (expect && rtype !== expect) fl.push(`type_mismatch_expected_${expect}`);
        if (val === null) add(kind, { value_mgdl: null, orig_value: textVal, orig_unit: unit }, [...fl, "non_numeric_glucose"]);
        else add(kind, { value_mgdl: round2(unit === "mmol/L" ? val * MMOL_TO_MGDL : val), orig_value: val, orig_unit: unit }, fl);
        produced = true;
      }
    }

    for (const [ukey, mkey, role, purpose] of [["rapid_units", "rapid_marker", "rapid", "unspecified"],
      ["long_units", "long_marker", "long", "unspecified"], ["meal_insulin", null, "rapid", "meal"],
      ["correction_insulin", null, "rapid", "correction"], ["user_change_insulin", null, "rapid", "user_change"]]) {
      if (populated[ukey] || (mkey && populated[mkey])) {
        const [u] = parseNumber(populated[ukey] || "", delimiter);
        add("insulin", { role, purpose, units: u, marker_only: u === null, confidence: "low", source: "libre_app" });
        produced = true;
      }
    }

    if (populated.carbs_g || populated.carbs_servings || populated.food_marker) {
      const [carbs] = parseNumber(populated.carbs_g || "", delimiter);
      const [serv] = parseNumber(populated.carbs_servings || "", delimiter);
      add("food", { carbs_g: carbs, servings: serv, marker_only: carbs === null && serv === null, confidence: "low", source: "libre_app" });
      produced = true;
    }
    if (populated.notes) { add("note", { text: populated.notes }); produced = true; }
    if (populated.ketone) { const [kv] = parseNumber(populated.ketone, delimiter); add("ketone", { value_mmol_l: kv }); produced = true; }
    if (!produced) counters.rows_with_unmapped_data++;
  }

  events.sort((a, b) => a.utcMs - b.utcMs);
  const report = buildReport(events, counters, typeCounts, devices, serials, unknownCols, units, fmt, how, tz, meta, unparsed, rows.length);
  return { events, report, fileHash };
}

function sensorHint(devices, med) {
  const names = [...devices.keys()].filter(Boolean).join(" | ").toLowerCase();
  let base;
  if (names.includes("libre 3")) base = "Libre 3 family (device name)";
  else if (names.includes("libre 2 plus")) base = "Libre 2 Plus (device name)";
  else if (names.includes("librelink") || names.includes("libre 2")) base = "LibreLink app / Libre 1-2 family (device name)";
  else base = "unknown (device name not recognised)";
  return med ? `${base}; automatic-reading median interval: ${med} min` : base;
}

function buildReport(events, c, typeCounts, devices, serials, unknownCols, units, fmt, how, tz, meta, unparsed, nRows) {
  const auto = events.filter((e) => e.kind === "glucose_auto").map((e) => e.utcMs).sort((a, b) => a - b);
  const intervals = auto.slice(1).map((t, i) => (t - auto[i]) / 60000);
  const gaps = intervals.filter((x) => x > 30);
  const med = intervals.length ? Number(median(intervals).toFixed(1)) : null;
  const counts = new Map();
  for (const x of intervals) { const r = pyRound(x); counts.set(r, (counts.get(r) || 0) + 1); }
  const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, v]);
  const kinds = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const locals = events.map((e) => e.naiveMs);
  return {
    rows_in_file: nRows,
    events_created: events.length,
    events_by_kind: kinds,
    record_type_counts: Object.fromEntries(typeCounts),
    date_range_local: locals.length ? [isoLocal(locals.reduce((a, b) => (b < a ? b : a))), isoLocal(locals.reduce((a, b) => (b > a ? b : a)))] : null,
    devices: Object.fromEntries(devices),
    serial_numbers_seen: [...serials.keys()].filter(Boolean).length,
    glucose_units_in_file: units,
    date_format_used: fmt,
    date_format_resolution: how,
    timezone_assumed: tz,
    auto_reading_interval_minutes: { count: auto.length, median: med, most_common_rounded: mostCommon },
    gaps_over_30_min: {
      count: gaps.length,
      total_hours: gaps.length ? Number((gaps.reduce((a, b) => a + b, 0) / 60).toFixed(1)) : 0,
      longest_min: gaps.length ? pyRound(Math.max(...gaps)) : 0,
    },
    duplicate_rows_dropped: c.duplicate_rows_dropped,
    empty_rows_discarded: c.empty_rows_discarded,
    rows_wrong_length: c.rows_wrong_length,
    rows_bad_timestamp: c.rows_bad_timestamp,
    rows_with_unmapped_data: c.rows_with_unmapped_data,
    dst_flagged_rows: c.dst_flagged_rows,
    unknown_columns: unknownCols,
    provider_export: meta.provider_export,
    privacy: {
      account_name_discarded: meta.account_name_discarded,
      extra_metadata_rows_discarded: meta.extra_rows_discarded,
      note: "The export contains the account holder's name; it was not read or stored.",
    },
    likely_sensor_family: sensorHint(devices, med),
    unparsed_row_examples: unparsed.slice(0, 5),
  };
}
