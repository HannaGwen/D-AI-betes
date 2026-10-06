// Day chart on a <canvas>: imported glucose history plus logged events. Display only.
import { fromMgdl } from "./model.js";

const DEFAULT_COLORS = {
  bg: "#ffffff", grid: "#d9dee3", text: "#4a5560", line: "#0f766e", band: "rgba(15,118,110,0.10)",
  scan: "#0f766e", dose: "#b45309", meal: "#7c3aed", tag: "#475569", gap: "#9aa5b1",
};

export function drawDayChart(canvas, o) {
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return false;                                   // e.g. test environments without canvas
  const c = { ...DEFAULT_COLORS, ...(o.colors || {}) };
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const cssW = canvas.clientWidth || canvas.width || 340, cssH = canvas.clientHeight || canvas.height || 220;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH, padL = 34, padR = 8, padT = 10, padB = 34;
  const x = (t) => padL + ((t - o.startMs) / (o.endMs - o.startMs)) * (W - padL - padR);
  const readings = o.readings.filter((r) => r.mgdl !== null);
  const lo = 40, hi = Math.min(400, Math.max(250, ...readings.map((r) => r.mgdl + 20)));
  const y = (mg) => padT + (1 - (mg - lo) / (hi - lo)) * (H - padT - padB);

  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
  // target band
  ctx.fillStyle = c.band;
  ctx.fillRect(padL, y(o.highMgdl), W - padL - padR, y(o.lowMgdl) - y(o.highMgdl));
  // grid + axis labels
  ctx.strokeStyle = c.grid; ctx.fillStyle = c.text; ctx.lineWidth = 1; ctx.font = "11px system-ui, sans-serif";
  const ticks = o.unit === "mmol/L" ? [3, 5, 7, 10, 13, 16, 20] : [54, 90, 126, 180, 234, 288, 360];
  for (const tk of ticks) {
    const mg = o.unit === "mmol/L" ? tk * 18.0182 : tk;
    if (mg < lo || mg > hi) continue;
    ctx.beginPath(); ctx.moveTo(padL, y(mg)); ctx.lineTo(W - padR, y(mg)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(String(tk), padL - 4, y(mg) + 4);
  }
  ctx.textAlign = "center";
  for (let hr = 0; hr <= 24; hr += 6) {
    const t = o.startMs + hr * 3600000;
    if (t > o.endMs) break;
    ctx.fillText(String(hr).padStart(2, "0"), x(t), H - padB + 14);
  }
  // glucose line (broken at gaps over 30 min)
  const auto = readings.filter((r) => r.kind === "auto");
  ctx.strokeStyle = c.line; ctx.lineWidth = 2; ctx.beginPath();
  auto.forEach((r, i) => {
    const prev = auto[i - 1];
    if (!prev || r.t - prev.t > 30 * 60000) ctx.moveTo(x(r.t), y(r.mgdl)); else ctx.lineTo(x(r.t), y(r.mgdl));
  });
  ctx.stroke();
  ctx.fillStyle = c.line;
  for (const r of auto) { ctx.beginPath(); ctx.arc(x(r.t), y(r.mgdl), 1.8, 0, 7); ctx.fill(); }
  for (const r of readings.filter((q) => q.kind !== "auto")) {
    ctx.strokeStyle = c.scan; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x(r.t), y(r.mgdl), 3.5, 0, 7); ctx.stroke();
  }
  // events along the bottom
  const base = H - padB + 2;
  for (const d of o.doses) {
    ctx.fillStyle = c.dose; ctx.beginPath();
    const px = x(d.t); ctx.moveTo(px, base + 14); ctx.lineTo(px - 4, base + 6); ctx.lineTo(px + 4, base + 6); ctx.fill();
  }
  for (const m of o.meals) { ctx.fillStyle = c.meal; ctx.beginPath(); ctx.arc(x(m.t), base + 24, 3.5, 0, 7); ctx.fill(); }
  for (const t of o.tags) { ctx.fillStyle = c.tag; const px = x(t.t); ctx.fillRect(px - 3, base + 18, 6, 6); }
  return true;
}

export const _test = { fromMgdl };
