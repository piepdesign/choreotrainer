// Gemeinsame Bedienelemente: Auswahlliste mit „+ Neu …“, Optionsauswahl, Schalterliste, Icons
import { h } from './util.js';

// Auswahlliste wie beim Wochentag, mit zusätzlicher Option, einen eigenen Wert hinzuzufügen.
// Liefert ein Element mit .value (lesen/setzen) und .focus(), passt also überall, wo vorher ein Input stand.
export function pickSelect(options, { value = '', empty = '—', addLabel = '+ Neu …', placeholder = '' } = {}) {
  const opts = [...new Set(options.filter(Boolean))];
  const select = h('select');
  const input = h('input', { type: 'text', placeholder, hidden: true });
  const ok = h('button.linkbtn', { type: 'button', hidden: true }, 'OK');
  const wrap = h('span.pick', select, input, ok);
  const ADD = '__add__';
  function fill(sel) {
    select.replaceChildren(
      h('option', { value: '' }, empty),
      ...opts.map(o => h('option', { value: o, selected: o === sel }, o)),
      h('option', { value: ADD }, addLabel));
    select.value = sel && opts.includes(sel) ? sel : '';
  }
  const commit = () => {
    const v = input.value.trim();
    if (v) { if (!opts.includes(v)) opts.push(v); fill(v); } else fill('');
    input.hidden = ok.hidden = true;
    select.hidden = false;
    wrap.dispatchEvent(new Event('change', { bubbles: true }));
  };
  select.addEventListener('change', () => {
    if (select.value !== ADD) return;
    select.hidden = true;
    input.hidden = ok.hidden = false;
    input.value = '';
    input.focus();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { input.value = ''; commit(); } });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.hidden) commit(); }, 150));
  ok.addEventListener('click', commit);
  if (value && !opts.includes(value)) opts.push(value);
  fill(value);
  Object.defineProperty(wrap, 'value', {
    get: () => (select.hidden ? input.value.trim() : select.value === ADD ? '' : select.value),
    set: v => { if (v && !opts.includes(v)) opts.push(v); fill(v); input.hidden = ok.hidden = true; select.hidden = false; },
  });
  wrap.focus = () => (select.hidden ? input : select).focus();
  // weitere Optionen nachladen (z. B. aus gespeicherten Classes), Auswahl bleibt
  wrap.setOptions = list => { const v = wrap.value; for (const o of list) if (o && !opts.includes(o)) opts.push(o); fill(v); };
  return wrap;
}

// Die drei Class-Felder als Auswahllisten. Vorschläge + alles, was in Classes schon vorkommt.
export function classPickers(classes, { styles = [], levels = [] } = {}) {
  const from = k => classes.map(c => c[k]).filter(Boolean);
  return {
    category: pickSelect([...styles, ...from('category')], { addLabel: '+ Neuer Style …', placeholder: 'Style' }),
    level: pickSelect([...levels, ...from('level')], { addLabel: '+ Neues Level …', placeholder: 'Level' }),
    coach: pickSelect(from('coach'), { addLabel: '+ Neuer Coach …', placeholder: 'Name' }),
  };
}

// Schlichte Einzelauswahl: Text-Optionen in einer Zeile, die gewählte unterstrichen + Punkt
// Optionen: [id, Text] oder [id, Text, Icon-SVG] (z. B. Logos der Musikprovider)
export function optionGroup(options, value, onChange) {
  const el = h('div.optgroup', { role: 'radiogroup' });
  const render = v => el.replaceChildren(...options.map(([id, label, svg]) => h(`button.opt${id === v ? '.on' : ''}${svg ? '.has-icon' : ''}`, {
    type: 'button', role: 'radio', 'aria-checked': String(id === v),
    onclick: () => { render(id); onChange(id); },
  }, h('i.dot'), svg ? h('i.brand', { html: svg }) : null, label)));
  render(value);
  return el;
}

// Mehrfachauswahl als Schalterliste (z. B. Kennzahlen der Base)
export function toggleList(options, selected, onChange) {
  const cur = new Set(selected);
  return h('div.toggles', options.map(([id, label]) => {
    const btn = h(`button.toggle${cur.has(id) ? '.on' : ''}`, {
      type: 'button', role: 'switch', 'aria-checked': String(cur.has(id)),
      onclick: () => {
        if (cur.has(id)) cur.delete(id); else cur.add(id);
        btn.classList.toggle('on', cur.has(id));
        btn.setAttribute('aria-checked', String(cur.has(id)));
        onChange(options.map(o => o[0]).filter(x => cur.has(x)));
      },
    }, h('span.switch'), label);
    return btn;
  }));
}

// Kleine Strich-Icons (SVG, currentColor)
const ICONS = {
  // Seitenpanel: Rahmen mit rechter Spalte (offen = gefüllt)
  panelOpen: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><rect x="12" y="2.5" width="6.5" height="13" fill="currentColor" stroke="none"/>',
  panelClosed: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><line x1="12.5" y1="2.5" x2="12.5" y2="15.5"/>',
  // Breite füllen: Pfeile nach außen
  fitWidth: '<rect x="1.5" y="3.5" width="17" height="11" rx="1.5"/><path d="M5 9h10M5 9l2.2-2.2M5 9l2.2 2.2M15 9l-2.2-2.2M15 9l-2.2 2.2"/>',
  // Komplett zeigen: Bild innerhalb des Rahmens
  fitAll: '<rect x="1.5" y="3.5" width="17" height="11" rx="1.5"/><rect x="6" y="5.5" width="8" height="7" rx="1"/>',
  grip: '<circle cx="7" cy="5" r="1.2"/><circle cx="13" cy="5" r="1.2"/><circle cx="7" cy="9" r="1.2"/><circle cx="13" cy="9" r="1.2"/><circle cx="7" cy="13" r="1.2"/><circle cx="13" cy="13" r="1.2"/>',
};
export function icon(name) {
  const fillOnly = name === 'grip';
  return `<svg viewBox="0 0 20 18" width="20" height="18" aria-hidden="true" fill="${fillOnly ? 'currentColor' : 'none'}" stroke="${fillOnly ? 'none' : 'currentColor'}" stroke-width="1.4" stroke-linecap="round">${ICONS[name]}</svg>`;
}
