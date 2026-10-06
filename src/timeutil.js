// Date/time helpers: a minimal strptime and zone conversion with daylight-saving flags.
// No dependencies. Mirrors the behaviour of reference/libreview_parser.py.

const pad = (n, w = 2) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- strptime
const _compiled = new Map();

function compile(fmt) {
  if (_compiled.has(fmt)) return _compiled.get(fmt);
  const fields = [];
  let re = "^";
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === "%") {
      const t = fmt[++i];
      switch (t) {
        case "m": re += "(\\d{1,2})"; fields.push("mo"); break;
        case "d": re += "(\\d{1,2})"; fields.push("d"); break;
        case "Y": re += "(\\d{4})"; fields.push("y"); break;
        case "I": re += "(\\d{1,2})"; fields.push("h12"); break;
        case "H": re += "(\\d{1,2})"; fields.push("h"); break;
        case "M": re += "(\\d{1,2})"; fields.push("mi"); break;
        case "S": re += "(\\d{1,2})"; fields.push("s"); break;
        case "p": re += "(AM|PM)"; fields.push("p"); break;
        default: throw new Error("Unsupported format token %" + t);
      }
    } else if (/\s/.test(ch)) {
      re += "\\s+";
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
    }
  }
  const out = { re: new RegExp(re + "$", "i"), fields };
  _compiled.set(fmt, out);
  return out;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Parse s with a strptime-style format. Returns a "naive" ms value (as if UTC) or null. */
export function strptime(fmt, s) {
  const { re, fields } = compile(fmt);
  const m = re.exec(s);
  if (!m) return null;
  const v = { s: 0, mi: 0, h: 0 };
  fields.forEach((f, i) => { v[f] = f === "p" ? m[i + 1].toUpperCase() : parseInt(m[i + 1], 10); });
  if (v.h12 !== undefined) {
    if (v.h12 < 1 || v.h12 > 12) return null;
    v.h = (v.h12 % 12) + (v.p === "PM" ? 12 : 0);
  }
  if (v.mo < 1 || v.mo > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.mo)) return null;
  if (v.h < 0 || v.h > 23 || v.mi < 0 || v.mi > 59 || v.s < 0 || v.s > 59) return null;
  return Date.UTC(v.y, v.mo - 1, v.d, v.h, v.mi, v.s);
}

/** Format a naive ms value like Python's isoformat(sep=" "): YYYY-MM-DD HH:MM:SS */
export function isoLocal(naiveMs) {
  const d = new Date(naiveMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Format a UTC ms value like Python's isoformat(): YYYY-MM-DDTHH:MM:SS+00:00 */
export function isoUtc(utcMs) {
  return isoLocal(utcMs).replace(" ", "T") + "+00:00";
}

// ------------------------------------------------------------------ zones
const _fmt = new Map();

function formatter(tz) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  return _fmt.get(tz);
}

/** Offset of tz from UTC, in minutes, at the given UTC instant. */
const _offsetCache = new Map();
const BUCKET = 15 * 60000;   // zone offsets only change on 15-minute boundaries, so cache per bucket

export function offsetMinutesAt(utcMs, tz) {
  const bucket = Math.floor(utcMs / BUCKET);
  const ck = tz + "|" + bucket;
  const hit = _offsetCache.get(ck);
  if (hit !== undefined) return hit;
  const at = bucket * BUCKET;
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(at))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((asUtc - at) / 60000);
  if (_offsetCache.size > 50000) _offsetCache.clear();
  _offsetCache.set(ck, off);
  return off;
}

/**
 * Convert a naive local time (ms, as if UTC) in zone tz to a real UTC instant.
 * Returns { utcMs, flags }. A skipped hour -> 'dst_nonexistent' (offset before the change is
 * used); a repeated hour -> 'dst_ambiguous' (the first occurrence is used).
 */
export function localToUtc(naiveMs, tz) {
  const DAY = 86400000;
  const offsets = new Set([offsetMinutesAt(naiveMs - DAY, tz), offsetMinutesAt(naiveMs + DAY, tz)]);
  const valid = [];
  for (const o of offsets) {
    const utc = naiveMs - o * 60000;
    if (offsetMinutesAt(utc, tz) === o) valid.push(utc);
  }
  if (valid.length === 0) {
    const before = offsetMinutesAt(naiveMs - DAY, tz);
    return { utcMs: naiveMs - before * 60000, flags: ["dst_nonexistent"] };
  }
  valid.sort((a, b) => a - b);
  return { utcMs: valid[0], flags: valid.length > 1 ? ["dst_ambiguous"] : [] };
}

/** Local wall-clock parts for a UTC instant in zone tz. */
export function utcToLocalParts(utcMs, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

/** 'YYYY-MM-DD' of a UTC instant in zone tz. */
export function localDateKey(utcMs, tz) {
  const p = utcToLocalParts(utcMs, tz);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

/** 'YYYY-MM-DDTHH:mm' (datetime-local value) for a UTC instant in zone tz. */
export function toInputValue(utcMs, tz) {
  const p = utcToLocalParts(utcMs, tz);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** Parse a datetime-local value as wall-clock time in tz -> UTC ms. */
export function fromInputValue(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  return localToUtc(naive, tz).utcMs;
}

/** Start-of-day UTC ms for the local date key in zone tz. */
export function dayStartUtc(dateKey, tz) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return localToUtc(Date.UTC(y, m - 1, d, 0, 0, 0), tz).utcMs;
}

/** Add n days to a 'YYYY-MM-DD' key. */
export function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
