// Gemeinsame Bedienelemente: Auswahlliste mit „+ Neu …“, Präferenzen, Icons
import { tr, lang, LANGS, setLang } from './i18n.js';
import { h, holdGate, tt, balanceTiles } from './util.js';
import { PROVIDERS } from './providers.js';
import { BASE_STATS } from './settings.js';
import { brandIcon } from './brand-icons.js';

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
// gleiche Icons klein für die Kopfleiste
export const themeIcon = (id, size = 18) => svg26(THEME_PATHS[id], size);

// Auswahlliste wie beim Wochentag, mit zusätzlicher Option, einen eigenen Wert hinzuzufügen.
// Liefert ein Element mit .value (lesen/setzen) und .focus(), passt also überall, wo vorher ein Input stand.
export function pickSelect(options, { value = '', empty = '—', addLabel = tr('+ Neu …'), placeholder = '' } = {}) {
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
    category: pickSelect([...styles, ...from('category')], { addLabel: tr('+ Neuer Style …'), placeholder: 'Style' }),
    level: pickSelect([...levels, ...from('level')], { addLabel: tr('+ Neues Level …'), placeholder: 'Level' }),
    coach: pickSelect(from('coach'), { addLabel: tr('+ Neuer Coach …'), placeholder: tr('Name') }),
  };
}

// Schlichte Einzelauswahl: Text-Optionen in einer Zeile, die gewählte unterstrichen + Punkt
// Kleine Strich-Icons (SVG, currentColor)
const ICONS = {
  // Seitenpanel: Rahmen mit rechter Spalte (offen = gefüllt). Schmale Ansicht: Panel liegt unter dem Video,
  // dort zeigt das Icon den Streifen unten (CSS blendet je nach Breite eine der beiden Fassungen aus)
  panelOpen: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><g class="pi-side"><rect x="12" y="2.5" width="6.5" height="13" fill="currentColor" stroke="none"/></g><g class="pi-below"><rect x="1.5" y="10.5" width="17" height="5" fill="currentColor" stroke="none"/></g>',
  panelClosed: '<rect x="1.5" y="2.5" width="17" height="13" rx="1.5"/><g class="pi-side"><line x1="12.5" y1="2.5" x2="12.5" y2="15.5"/></g><g class="pi-below"><line x1="1.5" y1="10.5" x2="18.5" y2="10.5"/></g>',
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
  // Tutorial-Teile: Teil 1 = Base (Kacheln), Teil 2 = Trainingsansicht (Video mit Zeitleiste)
  part1: '<rect x="2" y="2.5" width="7" height="5.5" rx="1"/><rect x="11" y="2.5" width="7" height="5.5" rx="1"/><rect x="2" y="10" width="16" height="5.5" rx="1"/>',
  part2: '<rect x="1.5" y="1.5" width="17" height="11" rx="1.5"/><path d="M8.5 4.8v4.4l3.6-2.2z" stroke-linejoin="round"/><path d="M1.5 16h17M7 14.5v3"/>',
  // Marker-Optionen: Umbenennen (Stift), Hierhin (Pfeil an die Linie), Auf jetzt setzen (Fadenkreuz), Löschen (Eimer)
  rename: '<path d="M4 15l.8-3.4 7.7-7.7 2.6 2.6-7.7 7.7z" stroke-linejoin="round"/><path d="M11 5.4l2.6 2.6"/>',
  jump: '<path d="M3 9h9.5M9 5.5 12.5 9 9 12.5"/><path d="M16 3v12"/>',
  setNow: '<circle cx="10" cy="9" r="5.5"/><circle cx="10" cy="9" r="1.3" fill="currentColor"/><path d="M10 1v2.5M10 14.5V17M2 9h2.5M15.5 9H18"/>',
  trash: '<path d="M4 5h12M8 5V3h4v2M5.5 5l.8 10.5h7.4L14.5 5M8.5 8v5M11.5 8v5" stroke-linejoin="round"/>',
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
export function confirmDialog({ title, text, ok = tr('Bestätigen'), danger = true, typeToConfirm = null, cancel = true, extra = [] }) {
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
        input ? h('label.field', h('span', tr('Zur Bestätigung „{word}“ eintippen', { word: typeToConfirm })), input) : null,
        h('div.actions', okBtn, cancel ? h('button.linkbtn', { type: 'button', onclick: () => close(false) }, tr('Abbrechen')) : null)));
    addEventListener('keydown', onKey, true);
    document.body.append(box);
    (input || okBtn).focus();
  });
}

// Anleitung in Schritten: je Schritt eine vereinfachte Grafik und ein kurzer Satz, darunter ein Hinweis (optional)
const GUIDE_ICONS = {
  share: '<path d="M14 11h-2.5A1.5 1.5 0 0 0 10 12.5v14a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-14a1.5 1.5 0 0 0-1.5-1.5H22M18 4v15M14 8l4-4 4 4"/>',
  addHome: '<rect x="8" y="8" width="20" height="20" rx="4"/><path d="M18 13v10M13 18h10"/>',
  phone: '<rect x="11" y="3.5" width="14" height="29" rx="2.5"/><rect x="14.5" y="9" width="7" height="7" rx="1.5" fill="currentColor"/><path d="M16.5 29h3"/>',
  addressBar: '<rect x="2.5" y="11" width="31" height="14" rx="7"/><path d="M7 18h11"/><rect x="23" y="14.5" width="7" height="6" rx="1"/><path d="M26.5 14.5v-2"/>',
  menu: '<rect x="4" y="5" width="28" height="26" rx="2"/><path d="M27 10.5v.01M27 14v.01M27 17.5v.01M9 23h14"/>',
  menuH: '<rect x="4" y="5" width="28" height="26" rx="2"/><path d="M21 10h.01M24.5 10h.01M28 10h.01M9 23h14"/>', // Edge: ··· waagrecht
  phoneMenu: '<rect x="10" y="3.5" width="16" height="29" rx="2.5"/><path d="M22 8v.01M22 10.5v.01M22 13v.01M16.5 29h3"/>', // Handy mit ⋮ oben rechts
  menuBar: '<rect x="3" y="7" width="30" height="22" rx="2"/><path d="M3 12h30M7 9.5h5M15 9.5h5"/>',
  dock: '<path d="M4 27h28"/><rect x="7" y="17" width="7" height="7" rx="1.5"/><rect x="15" y="17" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="23" y="17" width="7" height="7" rx="1.5"/>',
  browsers: '<circle cx="18" cy="18" r="13"/><path d="M5 18h26M18 5c4 4 4 22 0 26M18 5c-4 4-4 22 0 26"/>',
};
export function guideDialog({ title, steps, note = null, ok = 'OK' }) {
  return new Promise(resolve => {
    const close = () => { box.remove(); resolve(true); };
    const svg = id => `<svg viewBox="0 0 36 36" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GUIDE_ICONS[id]}</svg>`;
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(); } },
      h('div.modal-card.guide-card', h('h2.wide', title),
        h('ol.guide', steps.map(([icon, text], i) => h('li', h('span.guide-num', String(i + 1)), h('span.guide-ico', { html: svg(icon) }), h('span.guide-text', text)))),
        note ? h('p.guide-note', note) : null,
        h('div.actions', h('button.btn.small.primary', { type: 'button', onclick: close }, ok))));
    document.body.append(box);
  });
}

// language: Block „Sprache“ (nur Einstellungen; im Intro steht die Wahl beim Namen). Wahl lädt die Seite neu.
// cards (Einstellungen): jede Auswahl als Zeile wie unter Daten (Titel · kurzer Satz · Auswahl), ohne Statistiken
// (die stehen dort unter eigener Überschrift, statPicker)
export function preferences(values, onChange, statValues = null, { baseLabel = true, tester = false, hints = false, language = false, cards = false } = {}) {
  // hints: im Intro ein Satz unter jedem Titel, was die Einstellung bewirkt
  const HINTS = {
    'Musikprovider': tr('Hier öffnen sich erkannte Songs: in der App, wenn sie installiert ist, sonst im Browser.'),
    'Song-Cover Hörprobe': tt(tr('Fährst du mit der Maus über ein Song-Cover, spielt eine 30-Sekunden-Hörprobe in dieser Lautstärke.'), tr('Hältst du ein Song-Cover gedrückt, spielt eine 30-Sekunden-Hörprobe in dieser Lautstärke.')),
    'Helfer*in': tr('Blendet unten rechts einen Knopf ein, über den du Bugs und Ideen direkt per Mail meldest.'),
    'Statistiken': tt(tr('Diese Kennzahlen siehst du in deiner „Base“. Klicke oder ziehe Kacheln hinein oder heraus.'), tr('Diese Kennzahlen siehst du in deiner „Base“. Tippe Kacheln an oder halte und ziehe sie hinein oder heraus.')),
    'Ansicht': tr('Hell, dunkel oder automatisch passend zu deinem System.'),
  };
  // Einzelauswahl als eine Zeile (Titel links, gewählte Option rechts); Statistiken als Kacheln über die volle Breite
  // Kurzfassung je Zeile in den Einstellungen (ein Satz, Zustand statt Erklärung wie unter Daten)
  const LEADS = {
    'Musikprovider': tr('Hier öffnen sich Songs.'),
    'Song-Cover Hörprobe': tt(tr('Lautstärke beim Darüberfahren.'), tr('Lautstärke beim Halten.')),
    'Ansicht': tr('Hell, dunkel oder wie das System.'),
    'Sprache': tr('Sprache der App.'),
    'Helfer*in': tr('Knopf für Bugs und Ideen.'),
  };
  const block = (title, control, row = true) => cards && row
    ? h('div.acc-card', h('span.acc-title', tr(title)), h('div.acc-text', h('p.acc-lead', LEADS[title])), control)
    : h(`div.pref-block${row ? '.pref-row' : ''}`, h('div.pref-head', h('h3.p-sub', tr(title)), hints ? h('p.pref-hint', HINTS[title]) : null), control);
  const chips = cards ? null : statPicker(values.baseStats || [], statValues, list => onChange({ baseStats: list }), { baseLabel });
  return h(cards ? 'div.acc' : 'div.prefs',
    block('Musikprovider', choiceRow(PROVIDERS.map(([id, name]) => [id, name, brandIcon(id, 18)]), values.provider,
      id => onChange({ provider: id }), { placeholder: tr('Auswählen …') })),
    // An/Aus und Lautstärke in einem: Aus · Leise · Mittel · Laut
    block('Song-Cover Hörprobe', choiceRow([['off', tr('Aus')], ['low', tr('Leise')], ['mid', tr('Mittel')], ['high', tr('Laut')]].map(([id, l]) => [id, l, svg26(SOUND_PATHS[id], 18)]),
      values.hoverPreview === 'on' || !values.hoverPreview ? 'mid' : values.hoverPreview, id => onChange({ hoverPreview: id }))),
    block('Ansicht', choiceRow([['light', tr('Hell')], ['dark', tr('Dunkel')], ['system', tr('System')]].map(([id, l]) => [id, l, svg26(THEME_PATHS[id], 18)]),
      values.theme || 'system', id => onChange({ theme: id }))),
    // Sprache: Wahl lädt die Seite neu (an derselben Stelle)
    language ? block('Sprache', choiceRow(LANGS.map(([id, name]) => [id, name, `<b class="choice-code">${id.toUpperCase()}</b>`]), lang, id => setLang(id))) : null,
    tester ? block('Helfer*in', choiceRow([['on', tr('Aktiviert')], ['off', tr('Deaktiviert')]].map(([id, l]) => [id, l, svg26(TOOL_PATHS.clipboard, 18)]), values.tester ? 'on' : 'off', id => onChange({ tester: id === 'on' }))) : null,
    cards ? null : block('Statistiken', chips, false));
}

// Einzelauswahl in einer Zeile: zu sehen ist nur die gewählte Option (Symbol, Name, Pfeil). Klick klappt darunter
// alle Optionen aus (Gestaltung wie das Ansicht-Menü in der Kopfleiste), Wahl schließt wieder. Esc/daneben schließt.
// options: [[id, Name, Symbol-HTML?]] · onPick(id) · el.set(id) setzt von außen
const CHEV = '<svg viewBox="0 0 12 8" width="12" height="8" aria-hidden="true"><path d="M1 1.5 6 6.5l5-5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
export function choiceRow(options, value, onPick, { placeholder = '—' } = {}) {
  let cur = value, menu = null;
  const wrap = h('div.choice');
  const btn = h('button.choice-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const face = o => [o?.[2] ? h('i.choice-ico', { html: o[2] }) : null, h('span.choice-label', o ? o[1] : placeholder)].filter(Boolean);
  const paint = () => {
    const o = options.find(x => x[0] === cur);
    btn.replaceChildren(...face(o), h('i.choice-chev', { html: CHEV }));
    btn.classList.toggle('empty', !o);
  };
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null;
    wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true); removeEventListener('keydown', onKey, true);
  };
  const outside = e => { if (!wrap.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
  btn.addEventListener('click', () => {
    if (menu) { close(); return; }
    menu = h('div.choice-menu', { role: 'listbox' }, options.map(o => h(`button${o[0] === cur ? '.on' : ''}`, {
      type: 'button', role: 'option', 'aria-selected': String(o[0] === cur),
      onclick: () => { const changed = o[0] !== cur; cur = o[0]; paint(); close(); if (changed) onPick(o[0]); },
    }, ...face(o))));
    wrap.append(menu);
    wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    addEventListener('pointerdown', outside, true); addEventListener('keydown', onKey, true);
    // ganz zu sehen: bei Platzmangel unten die Seite ein Stück mitscrollen
    menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  paint();
  wrap.append(btn);
  wrap.set = v => { cur = v; paint(); };
  return wrap;
}

// Statistik-Kacheln wie in der Base. Oben die gezeigten, unten die übrigen.
// Klick verschiebt eine Kachel in die andere Fläche (oben ans Ende). Ziehen setzt sie an jede Stelle,
// auch zwischen zwei andere; der Rest ordnet sich beim Ziehen sofort neu an.
export function statPicker(selected, values, onChange, { baseLabel = true } = {}) {
  let vals = values && !values.then ? values : {};
  const label = id => BASE_STATS.find(x => x[0] === id)?.[1] || id;
  const tile = id => h('div.stat.pick-tile', { 'data-id': id }, h('span.label', label(id)), h('b', vals[id]?.value ?? '—'));
  const shown = balanceTiles(h('div.stats.stat-zone.zone-in'));
  const rest = balanceTiles(h('div.stats.stat-zone.zone-out'));
  const hintIn = h('p.zone-empty', tt(tr('Hierher ziehen oder unten anklicken'), tr('Hierher ziehen oder unten antippen')));
  const hintOut = h('p.zone-empty', tr('Alle Statistiken sind in deiner Base'));
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
  const box = h('div.stat-picker', baseLabel ? h('span.label.zone-label', tr('In deiner Base')) : null, shown, h('span.label.zone-label', tr('Weitere')), rest);
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

// Titelspalte der Einstellungs-Zeilen (auch Intro › Präferenzen) so breit wie der längste Titel (110–230 px, längere brechen um): die Mitte
// beginnt so nah wie möglich am Titel, bleibt aber in allen Abschnitten bündig. Dazu die natürliche Breite des
// längsten Wort-Knopfs (--acc-btn): ganz schmale Ansichten nutzen sie als Knopfspalte. Misst neu, wenn Zeilen dazukommen.
export function fitAccTitles(root) {
  let raf = 0;
  const fit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const titles = [...root.querySelectorAll('.acc-title')];
      if (!titles.length || !root.isConnected) return;
      // Wort-Knöpfe: Knöpfe und Auswahlfelder ohne Symbol (die mit Symbol zeigen schmal nur das Symbol)
      const btns = [...root.querySelectorAll('.acc-card > .btn, .acc-card .choice-btn:not(:has(.choice-ico))')];
      const all = [...titles, ...btns];
      all.forEach(t => t.classList.add('measure'));
      const w = Math.max(...titles.map(t => t.getBoundingClientRect().width));
      const bw = Math.max(0, ...btns.map(b => b.getBoundingClientRect().width));
      all.forEach(t => t.classList.remove('measure'));
      root.style.setProperty('--acc-title', `${Math.round(Math.min(230, Math.max(110, w + 1)))}px`);
      if (bw) root.style.setProperty('--acc-btn', `${Math.ceil(bw + 1)}px`);
    });
  };
  new MutationObserver(fit).observe(root, { childList: true, subtree: true });
  new ResizeObserver(fit).observe(root); // auch sobald der Bereich auf der Seite steht (Intro baut erst danach ein)
  document.fonts?.ready.then(fit);
  fit();
  return root;
}
