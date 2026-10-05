// Gemeinsame Bedienelemente: Auswahlliste mit „+ Neu …“, Präferenzen, Icons
import { h, holdGate, tt } from './util.js';
import { PROVIDERS } from './providers.js';
import { BASE_STATS } from './settings.js';
import { brandIcon } from './brand-icons.js';

const brandSvg = id => brandIcon(id, 26);
// Ansicht: halber Kreis (System), Sonne (Hell), Mond (Dunkel), Größe wie die Provider-Logos
const svg26 = (body, size = 26) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${body}</svg>`;
const THEME_PATHS = {
  system: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  dark: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
};
const SPEAKER = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>';
const SOUND_PATHS = {
  off: `${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  low: `${SPEAKER}<path d="M15.5 10a2.8 2.8 0 0 1 0 4"/>`,
  mid: `${SPEAKER}<path d="M15.5 10a2.8 2.8 0 0 1 0 4M17.8 8a5.8 5.8 0 0 1 0 8"/>`,
  high: `${SPEAKER}<path d="M15.5 10a2.8 2.8 0 0 1 0 4M17.8 8a5.8 5.8 0 0 1 0 8M20.1 6a8.8 8.8 0 0 1 0 12"/>`,
};
// Tester-Symbole: Klemmbrett, Käfer, Glühbirne
export const TOOL_PATHS = {
  none: '<rect x="6" y="4.5" width="12" height="16" rx="1.5" stroke-dasharray="2 2.2"/>',
  clipboard: '<rect x="5.5" y="4.5" width="13" height="16.5" rx="1.5"/><rect x="9" y="3" width="6" height="3.2" rx=".8"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  bug: '<ellipse cx="12" cy="14" rx="4.5" ry="5.5"/><path d="M12 8.5v11M9.5 6.5l1.2 1.8M14.5 6.5l-1.2 1.8M7.5 12H4.5M7.5 16H5M16.5 12h3M16.5 16H19M8.2 9.5 6 8M15.8 9.5 18 8"/>',
  idea: '<path d="M9 17.5h6M9.8 20.5h4.4M12 3.5a5.8 5.8 0 0 0-3.3 10.6c.6.5.8 1.1.8 1.8v1.6h5v-1.6c0-.7.2-1.3.8-1.8A5.8 5.8 0 0 0 12 3.5z"/>',
};
export const toolIcon = (id, size = 22) => svg26(TOOL_PATHS[id], size);
const THEME_ICONS = Object.fromEntries(Object.entries(THEME_PATHS).map(([k, p]) => [k, svg26(p)]));
// gleiche Icons klein für die Kopfleiste
export const themeIcon = (id, size = 18) => svg26(THEME_PATHS[id], size);

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
// Kleine Strich-Icons (SVG, currentColor)
const ICONS = {
  // Seitenpanel: Rahmen mit rechter Spalte (offen = gefüllt)
  panelOpen: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><rect x="12" y="2.5" width="6.5" height="13" fill="currentColor" stroke="none"/>',
  panelClosed: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><line x1="12.5" y1="2.5" x2="12.5" y2="15.5"/>',
  // Breite füllen: Pfeile nach außen
  fitWidth: '<rect x="1.5" y="3.5" width="17" height="11" rx="1.5"/><path d="M5 9h10M5 9l2.2-2.2M5 9l2.2 2.2M15 9l-2.2-2.2M15 9l-2.2 2.2"/>',
  // Komplett zeigen: Bild innerhalb des Rahmens
  fitAll: '<rect x="1.5" y="3.5" width="17" height="11" rx="1.5"/><rect x="6" y="5.5" width="8" height="7" rx="1"/>',
  // Vollbild: vier Ecken nach außen
  full: '<path d="M2 7V4.5A1.5 1.5 0 0 1 3.5 3H6M14 3h2.5A1.5 1.5 0 0 1 18 4.5V7M18 11v2.5a1.5 1.5 0 0 1-1.5 1.5H14M6 15H3.5A1.5 1.5 0 0 1 2 13.5V11"/>',
  // Spiegeln: zwei Dreiecke an einer gestrichelten Achse
  mirror: '<path d="M10 1.5v15" stroke-dasharray="1.6 2"/><path d="M7.5 4L2.5 14h5z"/><path d="M12.5 4l5 10h-5z"/>',
  // Bild (Helligkeit/Kontrast): zwei Regler (nicht der Halbkreis, der steht schon für Hell/Dunkel)
  image: '<path d="M2.5 5.5h2.5M9 5.5h8.5M2.5 12.5h8.5M15 12.5h2.5"/><circle cx="7" cy="5.5" r="2"/><circle cx="13" cy="12.5" r="2"/>',
  // Marker setzen: Fähnchen mit Plus
  marker: '<path d="M4 16.5V2"/><path d="M4 2.5h9l-2.2 3 2.2 3H4"/><path d="M15.5 11.5v5M13 14h5"/>',
  // Wiedergabe: Dreieck bzw. zwei Balken, gleiche Strichstärke wie die übrigen Icons
  play: '<path d="M6.5 3.5v11l8.5-5.5z" stroke-linejoin="round"/>',
  pause: '<rect x="5.5" y="3.5" width="3" height="11" rx=".8"/><rect x="11.5" y="3.5" width="3" height="11" rx=".8"/>',
  // Tempo: Stoppuhr
  tempo: '<circle cx="10" cy="10.5" r="6"/><path d="M8.5 1.8h3M10 1.8v2.7M10 10.5V7.5M15.2 5.3l1.1-1.1"/>',
  // Lautstärke: Lautsprecher mit 0–2 Wellen bzw. Kreuz (stumm)
  vol0: '<path d="M2.5 7v4h3l4 3.3V3.7l-4 3.3z"/><path d="M13 6.5l4 5M17 6.5l-4 5"/>',
  vol1: '<path d="M2.5 7v4h3l4 3.3V3.7l-4 3.3z"/><path d="M12.5 6.5a3.4 3.4 0 0 1 0 5"/>',
  vol2: '<path d="M2.5 7v4h3l4 3.3V3.7l-4 3.3z"/><path d="M12.5 6.5a3.4 3.4 0 0 1 0 5M15 4a7 7 0 0 1 0 10"/>',
  // Ton vom Song statt vom Video: Doppelnote
  note: '<path d="M7.5 14V3.8l9-1.8v10"/><ellipse cx="5.5" cy="14" rx="2" ry="1.6" fill="currentColor"/><ellipse cx="14.5" cy="12" rx="2" ry="1.6" fill="currentColor"/>',
  grip: '<circle cx="7" cy="5" r="1.2"/><circle cx="13" cy="5" r="1.2"/><circle cx="7" cy="9" r="1.2"/><circle cx="13" cy="9" r="1.2"/><circle cx="7" cy="13" r="1.2"/><circle cx="13" cy="13" r="1.2"/>',
};
export function icon(name) {
  const fillOnly = name === 'grip';
  return `<svg viewBox="0 0 20 18" width="20" height="18" aria-hidden="true" fill="${fillOnly ? 'currentColor' : 'none'}" stroke="${fillOnly ? 'none' : 'currentColor'}" stroke-width="1.4" stroke-linecap="round">${ICONS[name]}</svg>`;
}

// Präferenzen (Intro und Profil gleich): Ansicht als Umschalter, Musikprovider als Kacheln mit Logo,
// Statistiken als Kacheln wie in der Base. values: { theme, provider, baseStats } · onChange(patch)
// statValues: { id: { value } } bzw. Promise darauf, für echte Werte in den Kacheln
// Schalter für Ja/Nein bzw. Mit/Ohne: eckige Spur mit Quadrat, an = gefüllt. el.set(v) setzt ihn von außen.
export function toggle(label, on, onChange) {
  const el = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': String(!!on) },
    h('span.toggle-track', h('i')), label ? h('span.toggle-label', label) : null);
  el.addEventListener('click', () => { const v = el.getAttribute('aria-checked') !== 'true'; el.set(v); onChange(v); });
  el.set = v => el.setAttribute('aria-checked', String(!!v));
  return el;
}

// Bestätigung vor Zurücksetzen/Löschen: erklärt kurz, was passiert. typeToConfirm: Wort, das eingetippt werden muss.
export function confirmDialog({ title, text, ok = 'Bestätigen', danger = true, typeToConfirm = null, cancel = true, extra = [] }) {
  return new Promise(resolve => {
    const close = v => { box.remove(); removeEventListener('keydown', onKey, true); resolve(v); };
    const okBtn = h(`button.btn.small${danger ? '.danger' : '.primary'}`, { type: 'button', onclick: () => close(true) }, ok);
    const input = typeToConfirm ? h('input', { type: 'text', placeholder: typeToConfirm, autocomplete: 'off' }) : null;
    if (input) {
      okBtn.disabled = true;
      input.addEventListener('input', () => { okBtn.disabled = input.value.trim().toLowerCase() !== typeToConfirm.toLowerCase(); });
    }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(false); } },
      h('div.modal-card.confirm-card', h('h2.wide', title), h('p', text), ...extra, // extra: z. B. ein Schalter vor dem Bestätigen
        input ? h('label.field', h('span', `Zur Bestätigung „${typeToConfirm}“ eintippen`), input) : null,
        h('div.actions', okBtn, cancel ? h('button.linkbtn', { type: 'button', onclick: () => close(false) }, 'Abbrechen') : null)));
    addEventListener('keydown', onKey, true);
    document.body.append(box);
    (input || okBtn).focus();
  });
}

export function preferences(values, onChange, statValues = null, { baseLabel = true, tester = false, hints = false } = {}) {
  // hints: im Intro ein Satz unter jedem Titel, was die Einstellung bewirkt
  const HINTS = {
    'Musikprovider': 'Hier öffnen sich erkannte Songs: in der App, wenn sie installiert ist, sonst im Browser.',
    'Song-Cover Hörprobe': tt('Fährst du mit der Maus über ein Song-Cover, spielt eine 30-Sekunden-Hörprobe in dieser Lautstärke.', 'Hältst du ein Song-Cover gedrückt, spielt eine 30-Sekunden-Hörprobe in dieser Lautstärke.'),
    'Helfer*in': 'Blendet unten rechts einen Knopf ein, über den du Bugs und Ideen direkt per Mail meldest.',
    'Statistiken': tt('Diese Kennzahlen siehst du in deiner „Base“. Klicke oder ziehe Kacheln hinein oder heraus.', 'Diese Kennzahlen siehst du in deiner „Base“. Tippe Kacheln an oder halte und ziehe sie hinein oder heraus.'),
    'Ansicht': 'Hell, dunkel oder automatisch passend zu deinem System.',
  };
  const block = (title, control) => h('div.pref-block', h('h3.p-sub', title), hints ? h('p.pref-hint', HINTS[title]) : null, control);
  // Einzelauswahl; render(neu) setzt die Markierung
  // Einzelauswahl als Kacheln (Musikprovider, Ansicht); key = Name der Einstellung
  const single = (key, options, value, content) => {
    // Kacheln einmal bauen, beim Antippen nur die Markierung umschalten (Neuaufbau verschob die Ansicht)
    const btns = options.map(o => h('button', {
      type: 'button', role: 'radio',
      onclick: () => { mark(o[0]); onChange({ [key]: o[0] }); },
    }, content(o)));
    const mark = v => btns.forEach((b, i) => { const on = options[i][0] === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    mark(value);
    return h('div.provider-tiles', { role: 'radiogroup' }, btns);
  };
  const chips = statPicker(values.baseStats || [], statValues, list => onChange({ baseStats: list }), { baseLabel });
  return h('div.prefs',
    block('Musikprovider', single('provider', PROVIDERS, values.provider,
      ([id, name]) => [h('i.brand', { html: brandSvg(id) }), h('span', name)])),
    // An/Aus und Lautstärke in einem: Aus · Leise · Mittel · Laut
    block('Song-Cover Hörprobe', single('hoverPreview', [['off', 'Aus'], ['low', 'Leise'], ['mid', 'Mittel'], ['high', 'Laut']],
      values.hoverPreview === 'on' || !values.hoverPreview ? 'mid' : values.hoverPreview,
      ([id, label]) => [h('i.brand', { html: svg26(SOUND_PATHS[id]) }), h('span', label)])),
    tester ? block('Helfer*in', toggle('Knopf für Bugs und Ideen', !!values.tester, v => onChange({ tester: v }))) : null,
    block('Statistiken', chips),
    block('Ansicht', single('theme', [['light', 'Hell'], ['dark', 'Dunkel'], ['system', 'System']], values.theme,
      ([id, label]) => [h('i.brand', { html: THEME_ICONS[id] }), h('span', label)])));
}

// Statistik-Kacheln wie in der Base. Oben die gezeigten, unten die übrigen.
// Klick verschiebt eine Kachel in die andere Fläche (oben ans Ende). Ziehen setzt sie an jede Stelle,
// auch zwischen zwei andere; der Rest ordnet sich beim Ziehen sofort neu an.
export function statPicker(selected, values, onChange, { baseLabel = true } = {}) {
  let vals = values && !values.then ? values : {};
  const label = id => BASE_STATS.find(x => x[0] === id)?.[1] || id;
  const tile = id => h('div.stat.pick-tile', { 'data-id': id }, h('span.label', label(id)), h('b', vals[id]?.value ?? '—'));
  const shown = h('div.stats.stat-zone.zone-in');
  const rest = h('div.stats.stat-zone.zone-out');
  const hintIn = h('p.zone-empty', tt('Hierher ziehen oder unten anklicken', 'Hierher ziehen oder unten antippen'));
  const hintOut = h('p.zone-empty', 'Alle Statistiken sind in deiner Base');
  let sel = selected.filter(id => BASE_STATS.some(x => x[0] === id));
  function render() {
    shown.replaceChildren(...sel.map(tile), hintIn);
    rest.replaceChildren(...BASE_STATS.map(x => x[0]).filter(id => !sel.includes(id)).map(tile), hintOut);
  }
  const commit = () => {
    sel = [...shown.querySelectorAll('.pick-tile')].map(t => t.dataset.id);
    render();
    onChange(sel);
  };
  // Einfügestelle: erste Kachel, vor der der Zeiger liegt (Lesereihenfolge, zeilenweise)
  const before = (zone, x, y, self) => [...zone.querySelectorAll('.pick-tile')].filter(t => t !== self).find(t => {
    const r = t.getBoundingClientRect();
    return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
  }) || zone.querySelector('.zone-empty');
  const box = h('div.stat-picker', baseLabel ? h('span.label.zone-label', 'In deiner Base') : null, shown, h('span.label.zone-label', 'Weitere'), rest);
  const gate = holdGate(); // Touch: erst halten, dann ziehen (Wischen scrollt)
  box.addEventListener('pointerdown', e => {
    const t = e.target.closest('.pick-tile');
    if (!t || e.button !== 0) return;
    if (e.pointerType !== 'touch') e.preventDefault();
    gate.arm(e);
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null, scrolled = false;
    const move = ev => {
      if (!ghost) {
        const g = gate.gate(ev);
        if (g === null) { scrolled = true; return; }
        if (!g) return;
        if (ev.pointerType !== 'touch' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        const r = t.getBoundingClientRect();
        ghost = t.cloneNode(true);
        ghost.classList.add('pick-ghost');
        Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
        ghost.dx = x0 - r.left; ghost.dy = y0 - r.top;
        document.body.append(ghost);
        t.classList.add('pick-hole');
        document.body.classList.add('is-sorting');
      }
      ghost.style.left = `${ev.clientX - ghost.dx}px`;
      ghost.style.top = `${ev.clientY - ghost.dy}px`;
      // Fläche unter dem Zeiger: oben einsortieren, unten zurücklegen
      const rIn = shown.getBoundingClientRect(), rOut = rest.getBoundingClientRect();
      const zone = ev.clientY < (rIn.bottom + rOut.top) / 2 ? shown : rest;
      const ref = before(zone, ev.clientX, ev.clientY, t);
      if (t.nextSibling !== ref || t.parentNode !== zone) zone.insertBefore(t, ref);
    };
    const up = ev => {
      if (ev?.type === 'pointercancel') scrolled = true; // Browser hat das Wischen übernommen
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      document.body.classList.remove('is-sorting');
      gate.done();
      if (ghost) { ghost.remove(); t.classList.remove('pick-hole'); commit(); return; }
      if (scrolled) return; // gewischt, nicht angetippt
      // Klick: in die andere Fläche, oben ans Ende
      if (t.parentNode === shown) rest.prepend(t); else shown.insertBefore(t, hintIn);
      commit();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  render();
  if (values?.then) values.then(v => { vals = v || {}; render(); }).catch(() => {});
  return box;
}
