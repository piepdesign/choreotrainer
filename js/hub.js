// Base (Übersicht) und Class-Ansicht
import { tr, tn, dayLabel } from './i18n.js';
import { db, deleteChoreo, deleteClass, deleteRecording } from './db.js';
import { h, balanceTiles, isTouch, onHold, holdGate, tt, fmt, fmtRecDate, fmtDuration, relDate, classTitle, classMeta, stripe, inlineEdit, PALETTE, textOn, WEEKDAYS, byClassOrder, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { state, go, toast } from './app.js';
import { baseStats } from './stats.js';
import { settings, saveSettings, BASE_STATS } from './settings.js';
import { isInstalled, installApp } from './backup.js';
import { songLink } from './providers.js';
import { classPickers, icon, confirmDialog } from './ui.js';
import { classForm } from './classform.js';
import { exportClassDialog, exportChoreoDialog, chooseFile, importExport, importSummary } from './share.js';

export async function loadAll() {
  const [classes, choreos, recordings, sessions] = await Promise.all(
    ['classes', 'choreos', 'recordings', 'sessions'].map(n => db.all(n)));
  const classById = Object.fromEntries(classes.map(c => [c.id, c]));
  const recsByChoreo = {};
  for (const r of recordings.sort((a, b) => a.recordedAt - b.recordedAt)) (recsByChoreo[r.choreoId] ||= []).push(r);
  return { classes, choreos, recordings, sessions, classById, recsByChoreo };
}

export const latestRating = c => c.ratings?.length ? c.ratings[c.ratings.length - 1].value : null;

export function dots(value, max = 5) {
  return h('span.dots', { title: value ? `${value}/5` : tr('noch nicht bewertet') },
    Array.from({ length: max }, (_, i) => h(`i${value && i < value ? '.on' : ''}`)));
}

export function dropzone(onFile) {
  const input = h('input', { type: 'file', accept: 'video/*' });
  const zone = h('label.dropzone',
    input,
    h('strong', tr('NEUE CHOREO')),
    h('span.label', tt(tr('(Video ablegen oder klicken zum Auswählen)'), tr('(Tippen, um ein Video auszuwählen)'))),
    // eigener Knopf im Feld: öffnet nicht die Videoauswahl, sondern den Import (Class/Choreo aus einem Export)
    h('button.linkbtn.small-link.dz-import', { type: 'button', onclick: e => { e.preventDefault(); e.stopPropagation(); importInto(); } }, tr('importieren')));
  const take = f => {
    if (!f) return;
    if (/\.ctbackup$/i.test(f.name)) { importInto(undefined, f); return; } // Export einer Class/Choreo abgelegt
    if (!f.type.startsWith('video/') && !/\.(mov|mp4|m4v|webm)$/i.test(f.name)) return toast(tr('Bitte eine Videodatei wählen'));
    onFile(f);
  };
  input.addEventListener('change', () => take(input.files[0]));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files[0]); });
  return zone;
}

// Standardname „Aufnahme 3“ in der aktuellen Sprache, auch wenn er früher in einer anderen gespeichert wurde
const DEFAULT_REC = /^(?:Aufnahme|Recording|Enregistrement|Grabación|Registrazione) (\d+)$/;
export const recTitle = (r, i) => {
  const m = r.title?.match(DEFAULT_REC);
  return m ? tr('Aufnahme {n}', { n: m[1] }) : r.title || tr('Aufnahme {n}', { n: i + 1 });
};

// Mittlere Helligkeit (0–255) aus RGBA-Pixeln
export function luminance(d) {
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return s / (d.length / 4);
}

// Lässt kurze Helligkeits-Ausreißer (>6 % Abweichung) aus. Zeitbasiert, damit es bei 60 und 120 Hz
// gleich wirkt: Hält die Abweichung länger als 150 ms an, ist sie echt (Lichtwechsel, Schnitt).
export function deflicker({ tolerance = 0.06, holdMs = 150 } = {}) {
  let ref = null, since = null;
  return {
    reset() { ref = null; since = null; },
    accept(l, now = performance.now()) {
      if (ref == null || Math.abs(l - ref) <= ref * tolerance) { ref = l; since = null; return true; }
      since ??= now;
      if (now - since >= holdMs) { ref = l; since = null; return true; }
      return false;
    },
  };
}

// Vorschau beim Hovern: spielt stumm den Bereich Start–Ende (sonst das ganze Video).
// Das <video> selbst ist nie sichtbar. Jeder Frame wird in ein <canvas> (SDR) gezeichnet.
// Grund: iPhone-Videos sind HDR. Ein sichtbares HDR-Video schaltet macOS in den EDR-Modus,
// Helligkeit/Kontrast der Seite springen und flackern, auch nach dem Hovern.
// Beim Verlassen bleibt der letzte Frame im Canvas stehen, beim Wiedereintritt geht es dort weiter.
export function hoverVideo(rec, urls, cls) {
  const v = h('video', { muted: true, playsinline: true, preload: 'none' });
  v.muted = true;
  v.style.display = 'none';
  const canvas = h('canvas.frame', { hidden: true, draggable: 'false' });
  const ctx = canvas.getContext('2d');
  const still = h('img.still', { src: rec?.thumb || null, alt: '', hidden: !rec?.thumb, draggable: 'false' });
  const box = h(`div.${cls}`, canvas, still, v);
  if (!rec) return box;

  const mark = type => rec.markers?.find(m => m.type === type)?.t ?? null;
  const start = mark('start') ?? 0;
  let url = null, hover = false, raf = 0, pos = start, token = 0;

  const end = () => {
    const e = mark('end');
    return e != null && e > start + 0.2 ? e : (v.duration || Infinity) - 0.05;
  };
  const once = ev => new Promise(r => v.addEventListener(ev, r, { once: true }));

  // Ausreißer-Filter: Chrome liefert bei manchen iPhone-HDR-Videos (Dolby Vision 8.4) an jedem
  // Schlüsselbild ein einzelnes, deutlich dunkleres Bild, aber nur bei kleiner Darstellung. Die Datei
  // selbst ist sauber. Jedes neue Bild wird erst in einen Puffer gezeichnet, verkleinert gemessen
  // und nur bei Erfolg angezeigt. (Direkt vom 4K-Video messen kostet ~22 ms/Bild, über den Puffer ~2,5 ms.)
  const buffer = document.createElement('canvas');
  const bctx = buffer.getContext('2d');
  const probe = document.createElement('canvas');
  probe.width = 16; probe.height = 9;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  const filter = deflicker();
  let lastTime = -1;

  const draw = (force = false) => {
    if (v.readyState < 2) return;
    if (!canvas.dataset.sized) {
      canvas.dataset.sized = '1';
      canvas.width = 480;
      canvas.height = Math.round((480 * v.videoHeight) / v.videoWidth) || 300;
      buffer.width = canvas.width;
      buffer.height = canvas.height;
    }
    if (!force && v.currentTime === lastTime) return; // kein neues Bild
    lastTime = v.currentTime;
    bctx.drawImage(v, 0, 0, buffer.width, buffer.height);
    pctx.drawImage(buffer, 0, 0, 16, 9);
    if (!filter.accept(luminance(pctx.getImageData(0, 0, 16, 9).data)) && !force) return;
    ctx.drawImage(buffer, 0, 0);
    if (canvas.hidden) { canvas.hidden = false; still.hidden = true; }
  };

  // läuft nur während des Hovers: Frame zeichnen, Bereich loopen, verpasstes mouseleave abfangen
  const tick = () => {
    if (!hover) return;
    if ((!isTouch() && !box.matches(':hover')) || document.hidden) { leave(); return; } // Touch: endet beim Loslassen
    if (v.currentTime >= end() || v.ended) { v.currentTime = start; filter.reset(); v.play().catch(() => {}); }
    draw();
    raf = requestAnimationFrame(tick);
  };

  async function enter() {
    if (hover) return;
    hover = true;
    const my = ++token;
    if (!url) {
      const blob = await db.get('videos', rec.id);
      if (!blob) return;
      url = URL.createObjectURL(blob);
      urls.push(url);
    }
    if (my !== token || !hover) return;
    v.preload = 'auto';
    v.src = url;
    await once('loadedmetadata');
    if (my !== token || !hover) return;
    v.currentTime = Math.min(pos, end());
    filter.reset();
    await once('seeked');
    if (my !== token || !hover) return;
    v.play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function leave() {
    if (!hover) return;
    hover = false;
    token++;
    cancelAnimationFrame(raf);
    if (v.readyState >= 2) { pos = v.currentTime; draw(); }
    v.pause();
    v.removeAttribute('src');
    v.load(); // Decoder freigeben, im Canvas bleibt der letzte Frame stehen
  }

  // Maus: beim Überfahren. Touch: solange gehalten wird (ein kurzes Tippen öffnet wie gewohnt die Choreo)
  box.addEventListener('mouseenter', () => { if (!isTouch()) enter(); });
  box.addEventListener('mouseleave', () => { if (!isTouch()) leave(); });
  onHold(box, enter, leave);
  return box;
}

const cover = (song, cls = 'nocover') => song?.cover ? h('img', { src: song.cover, alt: '', loading: 'lazy' }) : h(`div.${cls}`);

export async function renderHub(root) {
  const data = await loadAll();
  const { classes, choreos, classById, recsByChoreo } = data;

  // Kacheln nach Wahl im Profil
  const values = baseStats(data);
  const chosen = settings().baseStats.filter(id => values[id]);
  const label = id => BASE_STATS.find(x => x[0] === id)?.[1] || id;

  const sorted = [...choreos].sort((a, b) => (b.lastPracticed || b.created) - (a.lastPracticed || a.created));
  const recent = sorted.slice(0, 5);
  const songs = [];
  const seen = new Set();
  for (const c of [...choreos].sort((a, b) => b.created - a.created)) {
    if (!c.song || seen.has(c.songKey)) continue;
    seen.add(c.songKey);
    songs.push(c);
  }

  const urls = [];
  // Letzte Choreos: eine Zeile, waagrecht scrollbar, max. 5. Mehr → „>“ zur Gesamtübersicht im Profil
  const cardsRow = fitCardLabels(h('div.cards.hscroll', recent.map(c => choreoCard(c, classById[c.classId], recsByChoreo[c.id] || [], urls)),
    choreos.length > 5 ? h('a.more', { href: '#/profile/choreos', title: tr('Alle {n} Choreos', { n: choreos.length }) }, '>') : null));
  // Letzte Songs: so hoch wie die Choreo-Zeile, darüber hinaus senkrecht scrollbar
  const songList = h('ul.songlist.vscroll', songs.map(c => h('li',
    songLink(cover(c.song), c.song),
    songLink(h('div', h('div.t', c.song.title), h('div.label', c.song.artist || '—')), c.song),
    h('span.label', c.song.duration ? fmt(c.song.duration) : ''))));

  root.append(
    h('div', { style: { height: '12px' } }),
    dropzone(f => { state.pendingFile = f; go('#/upload'); }),
    appHint() || '', // null würde als Text „null“ erscheinen
    balanceTiles(h('div.stats', chosen.map(id => stat(label(id), values[id].value, values[id].hint, `#/profile/${STAT_TARGET[id] || 'overview'}`)))),
    h('div.columns',
      h('div.col-choreos',
        h('div.section-head', h('h2.wide', tr('LETZTE CHOREOS'))),
        recent.length ? cardsRow : h('p.empty', tr('Noch keine Choreo. Leg oben das erste Video ab.'))),
      h('div.col-songs',
        h('div.section-head', h('h2.wide', tr('LETZTE SONGS'))),
        songs.length ? songList : h('p.empty', tr('Noch keine Songs.')))),
    h('div.section-head', h('h2.wide', 'CLASSES'), classes.length ? h('span.label', '# Choreos') : null),
    classes.length
      ? sortableStripes(classes.sort(byClassOrder), c => stripe(c, String(choreos.filter(x => x.classId === c.id).length)))
      : h('p.empty', tr('Noch keine Class.')),
    addRow(h('button.btn.small', { type: 'button', onclick: newClassDialog }, tr('Neue Class')), () => importInto()),
  );

  // Songliste an die Höhe der Choreo-Zeile koppeln
  let ro = null;
  if (recent.length && songs.length) {
    ro = new ResizeObserver(() => { songList.style.maxHeight = `${cardsRow.offsetHeight}px`; });
    ro.observe(cardsRow);
  }
  return () => { ro?.disconnect(); urls.forEach(u => URL.revokeObjectURL(u)); };
}

// Classes per Drag & Drop umsortieren (ab zwei Classes). Zeiger-Ereignisse statt HTML5-Drag,
// damit es mit Maus und Trackpad gleich zuverlässig ist. Die Reihenfolge wird als `order` gespeichert.
function sortableStripes(classes, render) {
  const box = h('div.stripes');
  const els = classes.map(c => { const el = render(c); el.dataset.id = c.id; return el; });
  box.append(...els);
  if (classes.length < 2) return box;

  let drag = null; // { el, startY, active, target, after }
  const gate = holdGate(); // Touch: erst halten, dann ziehen (Wischen scrollt)
  const clearMarks = () => els.forEach(x => x.classList.remove('drop-before', 'drop-after'));

  els.forEach(el => {
    el.prepend(h('i.grip', { 'aria-hidden': 'true', html: icon('grip') }));
    el.title = tr('Klicken zum Öffnen · ziehen zum Umsortieren');
    el.addEventListener('dragstart', e => e.preventDefault()); // native Link-Drag aus
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      gate.arm(e);
      drag = { el, startY: e.clientY, active: false, target: null, after: false, touch: e.pointerType === 'touch' };
    });
    el.addEventListener('click', e => {
      if (el.dataset.justDragged) { e.preventDefault(); delete el.dataset.justDragged; }
    });
  });

  const onMove = e => {
    if (!drag) return;
    if (!drag.active) {
      const g = gate.gate(e);
      if (g === null) { drag = null; return; } // gescrollt
      if (!g) return;
      if (!drag.touch && Math.abs(e.clientY - drag.startY) < 6) return;
      drag.active = true;
      drag.el.classList.add('dragging');
      document.body.classList.add('is-sorting');
    }
    e.preventDefault();
    clearMarks();
    const over = els.find(x => { const r = x.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; })
      || (e.clientY < els[0].getBoundingClientRect().top ? els[0] : els[els.length - 1]);
    const r = over.getBoundingClientRect();
    drag.target = over;
    drag.after = e.clientY > r.top + r.height / 2;
    if (over !== drag.el) over.classList.add(drag.after ? 'drop-after' : 'drop-before');
  };

  const onUp = async () => {
    gate.done();
    if (!drag) return;
    const { el, active, target, after } = drag;
    drag = null;
    clearMarks();
    el.classList.remove('dragging');
    document.body.classList.remove('is-sorting');
    if (!active) return;
    el.dataset.justDragged = '1'; // folgenden Klick nicht als Öffnen werten
    setTimeout(() => delete el.dataset.justDragged, 0);
    if (!target || target === el) return;
    const moved = classes.find(x => x.id === el.dataset.id);
    const order = classes.filter(x => x !== moved);
    order.splice(order.findIndex(x => x.id === target.dataset.id) + (after ? 1 : 0), 0, moved);
    for (const [i, x] of order.entries()) { x.order = i; await db.put('classes', x); }
    go(location.hash || '#/', { keep: true }); // an der Stelle bleiben
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  // Aufräumen, sobald der Hub verlassen wird
  addEventListener('hashchange', () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }, { once: true });
  return box;
}

// Nächster Termin einer Class aus Wochentag + Uhrzeit → Text wie „heute 19:30 · in 3 h“
export function nextClass(cls, now = new Date()) {
  const wd = WEEKDAYS.indexOf(cls?.weekday);
  if (wd < 0) return null;
  const [hh, mm] = (cls.time || '00:00').split(':').map(Number);
  const t = new Date(now);
  t.setHours(hh || 0, mm || 0, 0, 0);
  const today = (now.getDay() + 6) % 7; // Mo = 0
  let add = (wd - today + 7) % 7;
  if (add === 0 && t <= now) add = 7; // heute schon vorbei → nächste Woche
  t.setDate(t.getDate() + add);
  const mins = Math.round((t - now) / 60000);
  const when = add === 0 ? tr('heute') : add === 1 ? tr('morgen') : dayLabel(cls.weekday);
  const at = cls.time ? ` ${cls.time}` : '';
  // ab einer Stunde nur volle Stunden („in 19 h“): kurz genug für eine Kachelzeile, auf die Minute kommt es nicht an
  const dur = mins < 60 ? `${mins} min` : mins < 24 * 60 ? `${Math.round(mins / 60)} h` : null;
  const rel = dur ? tr('in {t}', { t: dur }) : tr('in {n} Tagen', { n: Math.round(mins / 1440) });
  return `${when}${at} · ${rel}`;
}

// Kachel → passende Stelle im Profil
const STAT_TARGET = { last: 'overview', streak: 'overview', duration: 'choreos', week: 'time', total: 'time', sessions: 'sessions', status: 'status', choreos: 'choreos', recordings: 'choreos', classes: 'classes' };

function stat(label, value, hint, href) {
  return h(href ? 'a.stat.stat-link' : 'div.stat', { href, title: hint ? `${hint} · ${tr('Details im Profil')}` : href ? tr('Details im Profil') : null }, h('span.label', label), h('b', value));
}

// Kachel-Angaben: einzeilig, solange alles passt; sonst die ganze Reihe zweizeilig (Klasse wrap2), auch nach Größenänderung
export function fitCardLabels(box) {
  let lastW = -1;
  const check = () => {
    if (!box.isConnected) { if (lastW >= 0) ro.disconnect(); return; }
    if (box.clientWidth === lastW) return; // nur bei neuer Breite (das Umbrechen selbst ändert die Höhe)
    lastW = box.clientWidth;
    box.classList.remove('wrap2');
    if ([...box.querySelectorAll('.card > .label')].some(l => l.scrollWidth > l.clientWidth + 1)) box.classList.add('wrap2');
  };
  const ro = new ResizeObserver(check);
  ro.observe(box);
  return box;
}

export function choreoCard(c, cls, recs, urls) {
  const latest = recs[recs.length - 1];
  const thumb = hoverVideo(latest, urls, 'thumb');
  thumb.append(h('div.bar', { style: { background: `#${cls?.color || PALETTE[0]}` } }));
  // Song-Cover klein unten links auf dem Video (Hover = Hörprobe, Klick = Musikprovider);
  // darunter ruhige einzeilige Textzeilen, damit alle Kacheln gleich hoch sind
  if (c.song?.cover) thumb.append(songLink(h('img.card-cover', { src: c.song.cover, alt: '' }), c.song));
  return h('a.card', { href: latest ? `#/train/${latest.id}` : `#/class/${c.classId}` },
    thumb,
    h('h3', c.title || c.song?.title || tr('Ohne Song')),
    h('div.label', `${cls ? classTitle(cls) : ''} · ${relDate(c.lastPracticed || c.created)}`),
    // kurz und einzeilig: nur „in 4 Tagen“, Tag und Uhrzeit im Tooltip. Zeile bleibt auch ohne Angabe stehen,
    // damit gleiche Infos in allen Kacheln auf derselben Höhe sitzen
    h('div.label.next-class', { title: cls && nextClass(cls) ? tr('Nächste Class {when}', { when: nextClass(cls) }) : null }, cls && nextClass(cls) ? tr('Nächste Class {when}', { when: nextClass(cls).split(' · ').at(-1) }) : '\u00a0'),
    h('div', { style: { marginTop: '4px' } }, dots(latestRating(c)), h('span.label', `  ${recs.length} ${tr('Aufn.')}`)));
}

// ── Class-Ansicht ─────────────────────────────

export async function renderClass(root, id) {
  const cls = await db.get('classes', id);
  if (!cls) { go('#/'); return; }
  const { classes, choreos, recsByChoreo, sessions } = await loadAll();
  const mine = choreos.filter(c => c.classId === id).sort((a, b) => b.created - a.created);
  const urls = [];

  const editBox = h('div', { hidden: true });
  const header = stripe(cls, '', () => {});
  root.append(
    h('div.stripes', { style: { marginTop: '8px' } }, header),
    // direkt unter der Leiste nur die Class selbst: Bearbeiten, Exportieren, Löschen
    h('div.actions', { style: { margin: '14px 0 28px' } },
      h('button.linkbtn', { onclick: () => { if (editBox.hidden) { editBox.replaceChildren(classEditor(cls, header, () => { editBox.hidden = true; }, classes)); editBox.hidden = false; } else editBox.hidden = true; } }, tr('Bearbeiten')),
      h('button.linkbtn', {
        type: 'button',
        onclick: async () => {
          try { const r = await exportClassDialog(cls); if (r) toast(`${tr('Exportiert: {choreos}', { choreos: tn(r.choreos, 'Choreo', 'Choreos') })}${r.files ? `, ${tr('{n} Dateien ({mb} MB)', { n: r.files, mb: Math.round(r.bytes / 1e6) })}` : ''}`, 3500); }
          catch (e) { console.error(e); toast(tr('Export fehlgeschlagen: {msg}', { msg: e.message }), 5000); }
        },
      }, tr('Exportieren')),
      h('button.linkbtn', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog({ title: tr('CLASS LÖSCHEN'), text: tr('Löscht „{name}“ mit {choreos} samt Videos.', { name: classTitle(cls), choreos: tn(mine.length, 'Choreo', 'Choreos') }), ok: tr('Löschen') }))) return;
          await deleteClass(id);
          toast(tr('Class gelöscht'));
          go('#/');
        },
      }, tr('Löschen'))),
    editBox,
    ...(mine.length ? mine.map(c => choreoBlock(c, recsByChoreo[c.id] || [], sessions, urls)) : [h('p.empty', tr('Keine Choreos in dieser Class.'))]),
    // unter der letzten Choreo: neue Choreo (Video hochladen), daneben kleiner: aus einem Export übernehmen
    addRow(h('a.btn.small', { href: `#/upload?class=${id}`, onclick: () => { state.pendingFile = null; } }, tr('Neue Choreo')), () => importInto(id)),
  );
  return () => urls.forEach(u => URL.revokeObjectURL(u));
}

// Hinweis „Als App installieren“ in der Base: nur im Browser (nicht installiert), mit „Ausblenden“ abschaltbar
function appHint() {
  if (isInstalled() || !settings().appHint) return null;
  const bar = h('div.app-hint',
    h('span', tr('Als App installieren: startet wie eine eigene App, auch offline.')),
    h('span.app-hint-actions',
      h('button.btn.small', { type: 'button', onclick: async () => { if (await installApp()) go('#/', { replace: true }); } }, tr('Installieren')),
      h('button.linkbtn.small-link', {
        type: 'button',
        onclick: async () => { await saveSettings({ appHint: false }); bar.remove(); },
      }, tr('Ausblenden'))));
  return bar;
}

// Neue Class (Base, Profil): Class-Formular im Fenster. „Weitere Class“ legt an und leert das Formular,
// „Fertig“ übernimmt die eingetragene und schließt. Danach die aktuelle Seite neu aufbauen, falls etwas dazukam.
export function newClassDialog() {
  let added = false;
  const close = () => { box.remove(); if (added) go(location.hash || '#/', { replace: true }); };
  const form = classForm(() => { added = true; }, { heading: false, done: close, more: true });
  const box = h('div.modal', { onclick: e => { if (e.target === box) close(); } },
    h('div.modal-card.class-card', h('h2.wide', tr('NEUE CLASS')), form, h('button.linkbtn', { type: 'button', onclick: close, style: { justifySelf: 'start' } }, tr('Abbrechen'))));
  document.body.append(box);
  form.querySelector('input, select')?.focus();
}

// „Neu …“ als Knopf, daneben klein „importieren“ (unter der letzten Choreo bzw. Class)
export function addRow(main, onImport) {
  return h('div.actions.add-row', main, h('button.linkbtn.small-link', { type: 'button', onclick: onImport }, tr('importieren')));
}

// Import aus Class-Übersicht, Class-Formular und Einstellungen: Datei wählen, einspielen, zur Class springen
export async function importInto(classId, picked) {
  const file = picked || await chooseFile();
  if (!file) return null;
  try {
    const r = await importExport(file, { classId });
    if (!r) return null;
    toast(importSummary(r), 4500);
    go(`#/class/${r.classId}`, { replace: location.hash === `#/class/${r.classId}` });
    return r;
  } catch (e) { console.error(e); toast(e.message, 5000); return null; }
}

// Farbe wirkt sofort als Vorschau auf den Kopfstreifen. Speichern behält sie, Abbrechen setzt sie zurück.
function classEditor(cls, header, close, allClasses = []) {
  const pick = classPickers(allClasses, { styles: CLASS_TITLES, levels: CLASS_LEVELS });
  pick.category.value = cls.category || ''; pick.level.value = cls.level || ''; pick.coach.value = cls.coach || '';
  const f = {};
  const field = (key, label, input) => { f[key] = input; return h('label.field', h('span', label), input); };
  const original = cls.color;
  let color = cls.color;
  const preview = hex => {
    color = hex.replace('#', '').toUpperCase();
    header.style.background = `#${color}`;
    header.style.color = textOn(color);
    swatches.querySelectorAll('.chip').forEach(x => x.classList.toggle('sel', x.dataset.hex === color));
    custom.classList.toggle('sel', !PALETTE.includes(color));
    customLabel.textContent = PALETTE.includes(color) ? tr('Eigene') : color;
    custom.style.background = PALETTE.includes(color) ? '' : `#${color}`;
    custom.style.color = PALETTE.includes(color) ? '' : textOn(color);
  };
  const picker = h('input', { type: 'color', value: `#${color}` });
  picker.addEventListener('input', () => preview(picker.value));
  const customLabel = h('span', tr('Eigene'));
  const custom = h('label.chip.custom', { title: tr('Eigene Farbe wählen') }, customLabel, picker);
  const swatches = h('div.chips', PALETTE.map(p => h('button.chip', {
    type: 'button', 'data-hex': p, style: { background: `#${p}`, color: textOn(p) },
    onclick: () => preview(p), title: tr('Farbe'), 'aria-label': tr('Farbe'),
  })), custom);
  preview(color);
  return h('div.fieldset',
    h('div.row',
      field('category', 'Style', pick.category),
      field('level', 'Level', pick.level),
      field('weekday', tr('Wochentag'), h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', { value: d, selected: d === cls.weekday }, dayLabel(d))))),
      field('time', tr('Uhrzeit'), h('input', { type: 'time', value: cls.time || '' })),
      field('coach', 'Coach', pick.coach)),
    h('div', { style: { marginTop: '14px' } }, h('span.label.color-label', tr('Farbe')), swatches),
    h('div.actions',
      h('button.btn.primary', {
        onclick: async () => {
          for (const k of Object.keys(f)) cls[k] = f[k].value.trim();
          cls.color = color;
          await db.put('classes', cls);
          toast(tr('Gespeichert'));
          go(location.hash);
        },
      }, tr('Speichern')),
      h('button.btn', {
        onclick: () => { preview(original); close(); },
      }, tr('Abbrechen'))));
}

function choreoBlock(c, recs, sessions, urls) {
  const practiced = sessions.filter(s => s.choreoId === c.id).reduce((a, s) => a + s.seconds, 0);
  return h('div.choreo-block',
    c.song?.cover ? songLink(h('img', { src: c.song.cover, alt: '' }), c.song) : h('div.nocover'),
    h('div',
      h('h2.wide', { style: { fontSize: '20px', margin: '0 0 6px' } }, h('a', { href: recs.length ? `#/train/${recs[recs.length - 1].id}` : null }, (c.title || c.song?.title || tr('Ohne Song')).toUpperCase())),
      h('div.label', `${c.song?.artist || ''}${c.song?.artist ? ' · ' : ''}${tr('geübt {t} · zuletzt {when}', { t: fmtDuration(practiced), when: relDate(c.lastPracticed) })}  `, dots(latestRating(c))),
      h('ul.reclist', recs.map((r, i) => {
        const title = inlineEdit(recTitle(r, i), async v => { r.title = v; await db.put('recordings', r); }, { href: `#/train/${r.id}` });
        return h('li',
        h('a.mini', { href: `#/train/${r.id}` }, hoverVideo(r, urls, 'mini-thumb')),
        h('strong', title),
        h('span', fmtRecDate(r.recordedAt)),
        h('span.muted', r.duration ? fmt(r.duration) : ''),
        h('span.muted', { style: { flex: 1, minWidth: '120px' } }, (r.notes || '').slice(0, 80)),
        h('button.linkbtn', { onclick: () => title.startEdit() }, tr('Umbenennen')),
        h('button.linkbtn', {
          onclick: async () => {
            if (!(await confirmDialog({ title: tr('AUFNAHME LÖSCHEN'), text: tr('Löscht diese Aufnahme samt Video.'), ok: tr('Löschen') }))) return;
            await deleteRecording(r.id);
            if (recs.length === 1) await deleteChoreo(c.id);
            go(location.hash);
          },
        }, tr('Löschen')));
      })),
      h('div.actions', { style: { marginTop: '10px' } },
        h('a.linkbtn', { href: `#/upload?choreo=${c.id}`, onclick: () => { state.pendingFile = null; } }, tr('+ Aufnahme hinzufügen')),
        h('button.linkbtn', {
          type: 'button',
          onclick: async () => {
            try { const r = await exportChoreoDialog(c); if (r) toast(r.files ? tr('Choreo exportiert: {n} Dateien ({mb} MB)', { n: r.files, mb: Math.round(r.bytes / 1e6) }) : tr('Choreo exportiert, ohne Videos'), 3500); }
            catch (e) { console.error(e); toast(tr('Export fehlgeschlagen: {msg}', { msg: e.message }), 5000); }
          },
        }, tr('Exportieren')),
        h('button.linkbtn', {
          onclick: async () => {
            const name = c.title || c.song?.title || tr('Ohne Song');
            if (!(await confirmDialog({ title: tr('CHOREO LÖSCHEN'), text: tr('Löscht „{name}“ mit {recs} samt Videos.', { name, recs: tn(recs.length, 'Aufnahme', 'Aufnahmen') }), ok: tr('Löschen') }))) return;
            await deleteChoreo(c.id);
            toast(tr('Choreo gelöscht'));
            go(location.hash);
          },
        }, tr('Choreo löschen')))));
}
