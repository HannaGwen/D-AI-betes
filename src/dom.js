// Tiny DOM helpers (no framework). Text is always inserted as text nodes, never as HTML.

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "value") value = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export const numOrNull = (s) => {
  const t = String(s ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

let _id = 0;
export const uid = (p = "f") => `${p}${++_id}`;

/** Label + control wrapper with a matching id. */
export function field(label, control, hint) {
  const id = uid();
  control.setAttribute("id", id);
  return h("div", { class: "field" }, h("label", { for: id }, label), control, hint ? h("small", {}, hint) : null);
}

export function option(value, label, selected) {
  return h("option", { value, selected: !!selected }, label);
}
