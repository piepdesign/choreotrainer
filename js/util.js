// Kleine Helfer: DOM, Zeitformate, Farben

// h('div.klasse', {attr}, kinder…)
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// 83.4 → "1:23.4" (mit Zehnteln) bzw. "1:23"
export function fmt(sec, tenths = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${m}:${ss}`;
}

// "1:23" / "83" / "1:23.5" → Sekunden
export function parseTime(str) {
  if (str == null || String(str).trim() === '') return null;
  const parts = String(str).trim().replace(',', '.').split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (hh) return `${hh} h ${String(mm).padStart(2, '0')} min`;
  if (mm) return `${mm} min`;
  return `${sec} s`;
}

export function fmtDate(ts, opts = { day: '2-digit', month: '2-digit', year: '2-digit' }) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('de-DE', opts);
}

export function relDate(ts) {
  if (!ts) return '—';
  const day = 86400000;
  const start = d => new Date(d).setHours(0, 0, 0, 0);
  const diff = Math.round((start(Date.now()) - start(ts)) / day);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff < 7) return `Vor ${diff} Tagen`;
  return fmtDate(ts);
}

export const isoDate = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Palette aus der A-29-Vorlage: jede Class bekommt einen Streifen
export const PALETTE = ['F5769C', '1E6236', 'AFA23A', 'F9C041', 'F3672D', '324BB4'];
// Schwarz oder Weiß, je nachdem was auf der Farbe mehr Kontrast hat (gilt auch für eigene Farben)
export function textOn(hex) {
  const c = String(hex || '').replace('#', '');
  const lin = i => { const v = parseInt(c.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000' : '#fff';
}

export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// Class-Titel als Vorschläge (aus einem Kursplan), ohne Level und Altersangabe.
// Eigene Namen bleiben möglich, die Liste ist nur ein Vorschlag.
export const CLASS_TITLES = [
  'Hip Hop', 'Hip Hop Kids', 'Hip Hop Juniors', 'Hip Hop Preschool', 'Hip Hop Adults',
  'Female Hip Hop', 'Female', 'Heels', 'K-Pop', 'Reggaeton', 'Popping',
  'Dancers Rehab', 'The Art of Freestyle', 'Kid Cut Formation', 'Baby Cut Formation',
];
export const CLASS_LEVELS = ['Lvl 1', 'Lvl 2', 'Open'];

// Aufnahmedatum mit Wochentag: (Fr) 26.09.26
export const fmtRecDate = ts => (ts ? `(${WEEKDAYS[(new Date(ts).getDay() + 6) % 7]}) ${fmtDate(ts)}` : '—');

// Eigene Reihenfolge (Drag & Drop im Hub), sonst nach Wochentag und Uhrzeit
export const byClassOrder = (a, b) =>
  ((a.order ?? 1e9) - (b.order ?? 1e9))
  || (WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday))
  || String(a.time || '').localeCompare(String(b.time || ''));

export function classTitle(c) {
  return [c.category, c.level].filter(Boolean).join(' ');
}

export function classMeta(c) {
  return [c.weekday, c.time, c.coach].filter(Boolean).join(' · ');
}

export function songTitle(s) {
  if (!s) return 'Ohne Song';
  return s.artist ? `${s.artist} — ${s.title}` : s.title;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Text, der per Klick (oder el.startEdit()) zum Eingabefeld wird. Enter/Verlassen speichert, Esc bricht ab.
// Eingabefeld wächst mit dem Text, damit nichts umbricht oder springt
export function fitInput(input) {
  if (CSS.supports?.('field-sizing', 'content')) return;
  const fit = () => { const n = Math.max(input.value.length, input.placeholder.length, 3) + 1; input.style.width = `calc(${n}ch + ${n * 0.08}em)`; };
  input.addEventListener('input', fit);
  fit();
}

export function inlineEdit(text, onSave, { href = null, clickToEdit = !href, placeholder = '' } = {}) {
  const view = h(href ? 'a' : 'span.editable', { href, title: clickToEdit ? 'Klicken zum Umbenennen' : null }, text);
  const wrap = h('span.inline-edit', view);
  wrap.startEdit = () => {
    const input = h('input.inline-input', { type: 'text', value: text, placeholder });
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== text) { text = v; await onSave(v); }
      view.textContent = text;
      input.replaceWith(view);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    fitInput(input);
    // gleiche Höhe wie der Text, damit beim Umbenennen nichts springt
    input.style.height = `${view.getBoundingClientRect().height}px`;
    view.replaceWith(input);
    input.focus();
    input.select();
  };
  wrap.setText = v => { text = v; view.textContent = v; };
  if (clickToEdit) view.addEventListener('click', e => { e.preventDefault(); wrap.startEdit(); });
  return wrap;
}

export function stripe(c, right, onclick) {
  const color = c?.color || PALETTE[0];
  return h('a.stripe', {
    href: onclick ? null : `#/class/${c.id}`,
    style: { background: `#${color}`, color: textOn(color) },
    onclick,
  }, h('span', `${classTitle(c)}${classMeta(c) ? ' · ' + classMeta(c) : ''}`.toUpperCase()), h('span', right ?? color));
}
