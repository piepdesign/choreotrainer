// Export und Import einzelner Classes und Choreos (gleiches Dateiformat wie die Sicherung, „.ctbackup“).
// Export: Class mit allen, ausgewählten oder ohne Choreos bzw. eine einzelne Choreo, wahlweise mit Videos und
// Songdateien. Mit dabei: Class-Angaben, Choreos (Song, Status), Aufnahmen (Marker, Notizen, Einstellungen).
// Nicht dabei: Einheiten (Übungszeit-Protokoll).
// Import einer Class: landet in ihrer Class, wenn es die schon gibt (gleiche ID oder gleiche Angaben), sonst wird sie
// angelegt. Import einer Choreo: immer fragen, wohin (Class aus der Datei, andere Class oder neue Class).
// Schon vorhandene Choreos (gleiche ID) kommen als Kopie dazu, nichts wird überschrieben.
import { tr, tn, dayLabel } from './i18n.js';
import { db, uid, untracked } from './db.js';
import { packFile, unpackFile } from './backup.js';
import { h, isTouch, classTitle, classMeta, byClassOrder, PALETTE, WEEKDAYS, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { toggle, classPickers, colorChooser } from './ui.js';

const FORMAT = 'choreotrainer-export';
const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];
const norm = s => String(s || '').trim().toLowerCase();
const slug = s => norm(s).normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
const label = c => [classTitle(c), classMeta(c)].filter(Boolean).join(' · ');
const choreoName = c => c.title || c.song?.title || tr('Ohne Song');

// ── Export ──
async function collectChoreos(choreos, videos) {
  const recordings = [], blobs = [];
  for (const c of choreos) {
    const recs = await db.byIndex('recordings', 'choreoId', c.id);
    recordings.push(...recs);
    if (!videos) continue;
    for (const r of recs) { const b = await db.get('videos', r.id); if (b) blobs.push([r.id, b]); }
    const song = await db.get('videos', `song:${c.id}`);
    if (song) blobs.push([`song:${c.id}`, song]);
  }
  return { recordings, blobs };
}
async function exportChoreos(kind, cls, choreos, videos, name) {
  const { recordings, blobs } = await collectChoreos(choreos, videos);
  const r = packFile({ format: FORMAT, version: 1, kind, exportedAt: Date.now(), data: { class: cls, choreos, recordings } }, blobs, name);
  return { choreos: choreos.length, recordings: recordings.length, ...r };
}
export async function exportClass(cls, choreoIds, { videos = true } = {}) {
  const choreos = (await db.byIndex('choreos', 'classId', cls.id)).filter(c => choreoIds.includes(c.id));
  return exportChoreos('class', cls, choreos, videos, `class-${slug(label(cls))}.ctbackup`);
}
export async function exportChoreo(choreo, { videos = true } = {}) {
  const cls = await db.get('classes', choreo.classId);
  return exportChoreos('choreo', cls, [choreo], videos, `choreo-${slug(choreoName(choreo))}.ctbackup`);
}

// ── Dialoge ──
function dialog(title, body, buttons) {
  return new Promise(resolve => {
    const close = v => { box.remove(); resolve(v); };
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(null); } },
      h('div.modal-card.share-card', h('h2.wide', title), ...body,
        h('div.actions', buttons.map(([text, value, cls = '']) => h(`button.${value === null ? 'linkbtn' : `btn.small${cls}`}`, { type: 'button', onclick: () => close(typeof value === 'function' ? value() : value) }, text)))));
    document.body.append(box);
  });
}
const seg = (options, get, set) => {
  const box = h('div.seg');
  const render = () => box.replaceChildren(...options.map(([v, l]) => h(`button.ctl${get() === v ? '.on' : ''}`, { type: 'button', onclick: () => { set(v); render(); } }, l)));
  render();
  return box;
};

// Class exportieren: alle / Auswahl / ohne Choreos, mit oder ohne Videos
export async function exportClassDialog(cls) {
  const choreos = (await db.byIndex('choreos', 'classId', cls.id)).sort((a, b) => b.created - a.created);
  let mode = choreos.length ? 'all' : 'none', videos = true;
  const checks = choreos.map(c => h('input', { type: 'checkbox', checked: true, value: c.id }));
  const list = h('div.share-list', { hidden: true }, choreos.map((c, i) => h('label.share-item', checks[i], h('span', choreoName(c)))));
  const modeSeg = seg([['all', tr('Alle')], ['pick', tr('Auswahl')], ['none', tr('Ohne')]].filter(([v]) => choreos.length || v === 'none'),
    () => mode, v => { mode = v; list.hidden = v !== 'pick'; });
  const go = await dialog(tr('CLASS EXPORTIEREN'), [
    h('p.label', label(cls)),
    h('div.field', h('span', 'Choreos'), modeSeg), list,
    toggle(tr('Mit Videos und Songdateien'), videos, v => { videos = v; }),
  ], [[tr('Exportieren'), true, '.primary'], [tr('Abbrechen'), null]]);
  if (!go) return null;
  const ids = mode === 'all' ? choreos.map(c => c.id) : mode === 'pick' ? checks.filter(x => x.checked).map(x => x.value) : [];
  return exportClass(cls, ids, { videos });
}
export async function exportChoreoDialog(choreo) {
  let videos = true;
  const go = await dialog(tr('CHOREO EXPORTIEREN'), [
    h('p.label', choreoName(choreo)),
    toggle(tr('Mit Videos und Songdateien'), videos, v => { videos = v; }),
  ], [[tr('Exportieren'), true, '.primary'], [tr('Abbrechen'), null]]);
  return go ? exportChoreo(choreo, { videos }) : null;
}

// ── Import ──
export function chooseFile() {
  return new Promise(resolve => {
    // nur .ctbackup; am Handy ohne Filter (iPhone graut unbekannte Endungen sonst aus), geprüft wird nach dem Wählen
    const input = h('input', { type: 'file', accept: isTouch() ? '' : '.ctbackup', hidden: true });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}
export async function readExport(file) {
  const head = await unpackFile(file);
  if (head?.format === 'choreotrainer-sicherung') throw new Error(tr('Das ist eine vollständige Sicherung. Bitte unter Einstellungen › Daten › Wiederherstellen einspielen.'));
  if (head?.format !== FORMAT || !head.data?.class) throw new Error(tr('Bitte einen Export einer Class oder Choreo (.ctbackup) wählen.'));
  return head;
}

// Class wählen (Import einer Choreo, Choreo verschieben). Optionen als Liste, die gewählte zeigt ihr Eingabefeld:
// file = Class aus der Datei (existing: gibt es hier schon) · other = bestehende Class · new = neue Class aus Angaben.
// Liefert { cls, created } oder null (abgebrochen)
export async function chooseClass({ title, text, file = null, existing = null, exclude = null, preselect = null, ok }) {
  const classes = (await db.all('classes')).sort(byClassOrder);
  const others = classes.filter(c => c.id !== exclude && c.id !== existing?.id);
  const select = h('select', others.map(c => h('option', { value: c.id, selected: c.id === preselect }, label(c))));
  const f = {
    ...classPickers(classes, { styles: CLASS_TITLES, levels: CLASS_LEVELS }),
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', { value: d }, dayLabel(d)))),
    time: h('input', { type: 'time' }),
  };
  const field = (l, input) => h('label.field', h('span', l), input);
  const fileColors = file && !existing ? colorChooser(file.color || PALETTE[classes.length % PALETTE.length]) : null;
  const colors = colorChooser(PALETTE[classes.length % PALETTE.length]);
  const newBox = h('div.choice-sub',
    h('div.row', field('Style', f.category), field('Level', f.level)),
    h('div.row', field(tr('Wochentag'), f.weekday), field(tr('Uhrzeit'), f.time), field('Coach', f.coach)),
    h('div', h('span.label.color-label', tr('Farbe')), colors));
  const options = [
    file && ['file', existing ? [label(existing), ' ', h('span.muted', tr('wie in der Datei'))] : tr('„{name}“ anlegen', { name: label(file) }), fileColors && h('div.choice-sub', fileColors)],
    others.length && ['other', existing || file ? tr('Andere Class') : tr('Bestehende Class'), select],
    ['new', tr('Neue Class'), newBox],
  ].filter(Boolean);
  let mode = options[0][0];
  const msg = h('span.label');
  const items = options.map(([v, l, sub]) => {
    const radio = h('input', { type: 'radio', name: 'cls-choice', value: v, checked: v === mode });
    radio.addEventListener('change', () => { mode = v; render(); });
    return [v, h('label.share-item', radio, h('span', l)), sub];
  });
  const list = h('div.choice-list');
  function render() { list.replaceChildren(...items.flatMap(([v, el, sub]) => [el, v === mode && sub ? sub : null].filter(Boolean))); }
  render();
  const choice = await new Promise(resolve => {
    const close = v => { box.remove(); resolve(v); };
    const go = () => {
      if (mode === 'new' && !f.category.value.trim()) { msg.textContent = tr('Bitte mindestens den Style angeben'); f.category.focus(); return; }
      close(mode);
    };
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(null); } },
      h('div.modal-card.share-card', h('h2.wide', title), text ? h('p.label', text) : null, list,
        h('div.actions', h('button.btn.small.primary', { type: 'button', onclick: go }, ok), h('button.linkbtn', { type: 'button', onclick: () => close(null) }, tr('Abbrechen')), msg)));
    document.body.append(box);
  });
  if (!choice) return null;
  if (choice === 'other') return { cls: classes.find(c => c.id === select.value), created: false };
  if (choice === 'file' && existing) return { cls: existing, created: false };
  const vals = choice === 'file' ? file : Object.fromEntries(Object.entries(f).map(([k, el]) => [k, String(el.value || '').trim()]));
  // gibt es die eingetragene Class schon, dort einfügen statt doppelt anlegen
  const same = classes.find(c => KEYS.every(k => norm(c[k]) === norm(vals[k])));
  if (same) return { cls: same, created: false };
  const cls = choice === 'file'
    ? { ...file, id: classes.some(c => c.id === file.id) ? uid() : file.id, order: classes.length, color: fileColors?.value || file.color || PALETTE[classes.length % PALETTE.length], created: Date.now() }
    : { id: uid(), ...vals, color: colors.value, order: classes.length, created: Date.now() };
  await db.put('classes', cls);
  return { cls, created: true };
}

// Choreo in eine andere Class verschieben (samt Aufnahmen, die hängen an der Choreo). Liefert die neue Class oder null
export async function moveChoreo(choreo) {
  const r = await chooseClass({ title: tr('CLASS ÄNDERN'), text: choreoName(choreo), exclude: choreo.classId, ok: tr('Verschieben') });
  if (!r) return null;
  choreo.classId = r.cls.id; // am selben Objekt, sonst schreibt die offene Trainingsansicht die alte Class zurück
  await db.put('choreos', choreo);
  return r.cls;
}

// Ziel-Class bestimmen. Liefert { cls, created } oder null (abgebrochen)
async function targetClass(src, kind, contextClassId, choreoTitle) {
  const classes = await db.all('classes');
  const same = classes.find(c => c.id === src.id) || classes.find(c => KEYS.every(k => norm(c[k]) === norm(src[k])));
  if (kind === 'class') {
    // ganze Class: in die gleiche, sonst so anlegen, wie sie exportiert wurde
    if (same) return { cls: same, created: false };
    const cls = { ...src, order: classes.length, color: src.color || PALETTE[classes.length % PALETTE.length], created: Date.now() };
    await db.put('classes', cls);
    return { cls, created: true };
  }
  return chooseClass({ title: tr('CHOREO IMPORTIEREN'), text: choreoTitle, file: src, existing: same || null, preselect: contextClassId, ok: tr('Importieren') });
}

export async function importExport(file, { classId: contextClassId } = {}) {
  const head = await readExport(file);
  const { class: srcClass, choreos = [], recordings = [] } = head.data;
  const target = await targetClass(srcClass, head.kind, contextClassId, choreos.map(choreoName).join(', '));
  if (!target) return null;
  const videos = new Map(head.videos || []);
  let copies = 0;
  await untracked(async () => {
    for (const c of choreos) {
      const exists = !!(await db.get('choreos', c.id));
      if (exists) copies++;
      const choreoId = exists ? uid() : c.id;
      await db.put('choreos', { ...c, id: choreoId, classId: target.cls.id });
      const song = videos.get(`song:${c.id}`);
      if (song) await db.put('videos', song, `song:${choreoId}`);
      for (const r of recordings.filter(x => x.choreoId === c.id)) {
        const recId = exists || (await db.get('recordings', r.id)) ? uid() : r.id;
        await db.put('recordings', { ...r, id: recId, choreoId });
        const v = videos.get(r.id);
        if (v) await db.put('videos', v, recId);
      }
    }
  });
  return { classId: target.cls.id, className: classTitle(target.cls), createdClass: target.created, choreos: choreos.length, recordings: recordings.length, videos: videos.size, copies };
}

// Kurzmeldung zum Ergebnis
export const importSummary = r => [
  r.createdClass ? tr('Class „{name}“ angelegt', { name: r.className }) : tr('In „{name}“ eingefügt', { name: r.className }),
  r.choreos ? `${tn(r.choreos, 'Choreo', 'Choreos')}${r.copies ? ` ${tr('({n} als Kopie, gab es schon)', { n: r.copies })}` : ''}` : null,
  r.choreos && !r.videos ? tr('ohne Videos') : null,
].filter(Boolean).join(', ');
