// Export und Import einzelner Classes und Choreos (gleiches Dateiformat wie die Sicherung, „.ctbackup“).
// Export: Class mit allen, ausgewählten oder ohne Choreos bzw. eine einzelne Choreo, wahlweise mit Videos und
// Songdateien. Mit dabei: Class-Angaben, Choreos (Song, Status), Aufnahmen (Marker, Notizen, Einstellungen).
// Nicht dabei: Einheiten (Übungszeit-Protokoll).
// Import: Choreos landen in ihrer Class, wenn es die schon gibt (gleiche ID oder gleiche Angaben). Sonst wird gefragt:
// in eine bestehende Class einfügen oder aus den Angaben eine neue anlegen. Schon vorhandene Choreos (gleiche ID)
// kommen als Kopie dazu, nichts wird überschrieben.
import { db, uid, untracked } from './db.js';
import { packFile, unpackFile } from './backup.js';
import { h, isTouch, classTitle, classMeta, byClassOrder, PALETTE } from './util.js';

const FORMAT = 'choreotrainer-export';
const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];
const norm = s => String(s || '').trim().toLowerCase();
const slug = s => norm(s).normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
const label = c => [classTitle(c), classMeta(c)].filter(Boolean).join(' · ');
const choreoName = c => c.title || c.song?.title || 'Ohne Song';

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
  const modeSeg = seg([['all', 'Alle'], ['pick', 'Auswahl'], ['none', 'Ohne']].filter(([v]) => choreos.length || v === 'none'),
    () => mode, v => { mode = v; list.hidden = v !== 'pick'; });
  const go = await dialog('CLASS EXPORTIEREN', [
    h('p.label', label(cls)),
    h('div.field', h('span', 'Choreos'), modeSeg), list,
    h('div.field', h('span', 'Videos und Songdateien'), seg([[true, 'Mit'], [false, 'Ohne']], () => videos, v => { videos = v; })),
  ], [['Exportieren', true, '.primary'], ['Abbrechen', null]]);
  if (!go) return null;
  const ids = mode === 'all' ? choreos.map(c => c.id) : mode === 'pick' ? checks.filter(x => x.checked).map(x => x.value) : [];
  return exportClass(cls, ids, { videos });
}
export async function exportChoreoDialog(choreo) {
  let videos = true;
  const go = await dialog('CHOREO EXPORTIEREN', [
    h('p.label', choreoName(choreo)),
    h('div.field', h('span', 'Videos und Songdateien'), seg([[true, 'Mit'], [false, 'Ohne']], () => videos, v => { videos = v; })),
  ], [['Exportieren', true, '.primary'], ['Abbrechen', null]]);
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
  if (head?.format === 'choreotrainer-sicherung') throw new Error('Das ist eine vollständige Sicherung. Bitte unter Einstellungen › Daten › Wiederherstellen einspielen.');
  if (head?.format !== FORMAT || !head.data?.class) throw new Error('Bitte einen Export einer Class oder Choreo (.ctbackup) wählen.');
  return head;
}

// Ziel-Class bestimmen. Liefert { cls, created } oder null (abgebrochen)
async function targetClass(src, kind, contextClassId) {
  const classes = (await db.all('classes')).sort(byClassOrder);
  const same = classes.find(c => c.id === src.id) || classes.find(c => KEYS.every(k => norm(c[k]) === norm(src[k])));
  if (same) return { cls: same, created: false };
  const fresh = async () => {
    const cls = { ...src, id: classes.some(c => c.id === src.id) ? uid() : src.id, order: classes.length, color: src.color || PALETTE[classes.length % PALETTE.length], created: Date.now() };
    await db.put('classes', cls);
    return { cls, created: true };
  };
  if (kind === 'class' || !classes.length) return fresh(); // ganze Class: so anlegen, wie sie exportiert wurde
  // Choreo, deren Class es hier nicht gibt: fragen
  const select = h('select', classes.map(c => h('option', { value: c.id, selected: c.id === contextClassId }, label(c))));
  const choice = await dialog('CHOREO IMPORTIEREN', [
    h('p', `Die Class „${label(src)}“ gibt es hier noch nicht.`),
    h('label.field', h('span', 'In bestehende Class einfügen'), select),
  ], [['Einfügen', () => select.value, '.primary'], ['Neue Class anlegen', 'new'], ['Abbrechen', null]]);
  if (!choice) return null;
  if (choice === 'new') return fresh();
  return { cls: classes.find(c => c.id === choice), created: false };
}

export async function importExport(file, { classId: contextClassId } = {}) {
  const head = await readExport(file);
  const { class: srcClass, choreos = [], recordings = [] } = head.data;
  const target = await targetClass(srcClass, head.kind, contextClassId);
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
  r.createdClass ? `Class „${r.className}“ angelegt` : `In „${r.className}“ eingefügt`,
  r.choreos ? `${r.choreos} Choreo${r.choreos === 1 ? '' : 's'}${r.copies ? ` (${r.copies} als Kopie, gab es schon)` : ''}` : null,
  r.choreos && !r.videos ? 'ohne Videos' : null,
].filter(Boolean).join(', ');
