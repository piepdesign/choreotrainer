// Base (Übersicht) und Class-Ansicht
import { db, deleteChoreo, deleteClass, deleteRecording } from './db.js';
import { h, fmt, fmtRecDate, fmtDuration, relDate, classTitle, classMeta, stripe, inlineEdit, PALETTE, textOn, WEEKDAYS, byClassOrder, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { state, go, toast } from './app.js';
import { baseStats } from './stats.js';
import { settings, BASE_STATS } from './settings.js';
import { songLink } from './providers.js';
import { classPickers, icon } from './ui.js';

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
  return h('span.dots', { title: value ? `${value}/5` : 'noch nicht bewertet' },
    Array.from({ length: max }, (_, i) => h(`i${value && i < value ? '.on' : ''}`)));
}

export function dropzone(onFile) {
  const input = h('input', { type: 'file', accept: 'video/*' });
  const zone = h('label.dropzone',
    input,
    h('strong', 'NEUE CHOREO'),
    h('span.label', '(Video ablegen oder klicken zum Auswählen)'));
  const take = f => {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mov|mp4|m4v|webm)$/i.test(f.name)) return toast('Bitte eine Videodatei wählen');
    onFile(f);
  };
  input.addEventListener('change', () => take(input.files[0]));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files[0]); });
  return zone;
}

export const recTitle = (r, i) => r.title || `Aufnahme ${i + 1}`;

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
  const canvas = h('canvas.frame', { hidden: true });
  const ctx = canvas.getContext('2d');
  const still = h('img.still', { src: rec?.thumb || null, alt: '', hidden: !rec?.thumb });
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
    if (!box.matches(':hover') || document.hidden) { leave(); return; }
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

  box.addEventListener('mouseenter', enter);
  box.addEventListener('mouseleave', leave);
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
  const cardsRow = h('div.cards.hscroll', recent.map(c => choreoCard(c, classById[c.classId], recsByChoreo[c.id] || [], urls)),
    choreos.length > 5 ? h('a.more', { href: '#/profile/choreos', title: `Alle ${choreos.length} Choreos` }, '>') : null);
  // Letzte Songs: so hoch wie die Choreo-Zeile, darüber hinaus senkrecht scrollbar
  const songList = h('ul.songlist.vscroll', songs.map(c => h('li',
    songLink(cover(c.song), c.song),
    songLink(h('div', h('div.t', c.song.title), h('div.label', c.song.artist || '—')), c.song),
    h('span.label', c.song.duration ? fmt(c.song.duration) : ''))));

  root.append(
    h('div', { style: { height: '12px' } }),
    dropzone(f => { state.pendingFile = f; go('#/upload'); }),
    h('div.stats', chosen.map(id => stat(label(id), values[id].value, values[id].hint, `#/profile/${STAT_TARGET[id] || 'overview'}`))),
    h('div.columns',
      h('div.col-choreos',
        h('div.section-head', h('h2.wide', 'LETZTE CHOREOS')),
        recent.length ? cardsRow : h('p.empty', 'Noch keine Choreo. Leg oben das erste Video ab.')),
      h('div.col-songs',
        h('div.section-head', h('h2.wide', 'LETZTE SONGS')),
        songs.length ? songList : h('p.empty', 'Noch keine Songs.'))),
    h('div.section-head', h('h2.wide', 'CLASSES'), classes.length ? h('span.label', '# Choreos') : null),
    classes.length
      ? sortableStripes(classes.sort(byClassOrder), c => stripe(c, String(choreos.filter(x => x.classId === c.id).length)))
      : h('p.empty', 'Lege Classes im Profil an oder beim ersten Upload.'),
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
  const clearMarks = () => els.forEach(x => x.classList.remove('drop-before', 'drop-after'));

  els.forEach(el => {
    el.prepend(h('i.grip', { 'aria-hidden': 'true', html: icon('grip') }));
    el.title = 'Klicken zum Öffnen · ziehen zum Umsortieren';
    el.addEventListener('dragstart', e => e.preventDefault()); // native Link-Drag aus
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = { el, startY: e.clientY, active: false, target: null, after: false };
    });
    el.addEventListener('click', e => {
      if (el.dataset.justDragged) { e.preventDefault(); delete el.dataset.justDragged; }
    });
  });

  const onMove = e => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < 6) return;
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
  const when = add === 0 ? 'heute' : add === 1 ? 'morgen' : cls.weekday;
  const at = cls.time ? ` ${cls.time}` : '';
  const rel = mins < 60 ? `in ${mins} min` : mins < 24 * 60 ? `in ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `in ${Math.round(mins / 1440)} Tagen`;
  return `${when}${at} · ${rel}`;
}

// Kachel → passende Stelle im Profil
const STAT_TARGET = { last: 'overview', streak: 'overview', duration: 'choreos', week: 'time', total: 'time', sessions: 'sessions', status: 'status', choreos: 'choreos', recordings: 'choreos', classes: 'classes' };

function stat(label, value, hint, href) {
  return h(href ? 'a.stat.stat-link' : 'div.stat', { href, title: hint ? `${hint} · Details im Profil` : href ? 'Details im Profil' : null }, h('span.label', label), h('b', value));
}

export function choreoCard(c, cls, recs, urls) {
  const latest = recs[recs.length - 1];
  const thumb = hoverVideo(latest, urls, 'thumb');
  thumb.append(h('div.bar', { style: { background: `#${cls?.color || PALETTE[0]}` } }));
  return h('a.card', { href: latest ? `#/train/${latest.id}` : `#/class/${c.classId}` },
    thumb,
    h('h3', c.title || c.song?.title || 'Ohne Song'),
    h('div.label', `${cls ? classTitle(cls) : ''} · ${relDate(c.lastPracticed || c.created)}`),
    cls && nextClass(cls) ? h('div.label.next-class', `Nächste Class ${nextClass(cls)}`) : null,
    h('div', { style: { marginTop: '4px' } }, dots(latestRating(c)), h('span.label', `  ${recs.length} Aufn.`)));
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
    h('div.actions', { style: { margin: '14px 0 28px' } },
      h('button.linkbtn', { onclick: () => { if (editBox.hidden) { editBox.replaceChildren(classEditor(cls, header, () => { editBox.hidden = true; }, classes)); editBox.hidden = false; } else editBox.hidden = true; } }, 'Bearbeiten'),
      h('a.linkbtn', { href: `#/upload?class=${id}`, onclick: () => { state.pendingFile = null; } }, 'Neue Aufnahme')),
    editBox,
    ...(mine.length ? mine.map(c => choreoBlock(c, recsByChoreo[c.id] || [], sessions, urls)) : [h('p.empty', 'Keine Choreos in dieser Class.')]),
    h('div.actions', { style: { marginTop: '40px' } },
      h('button.btn.small.danger', {
        onclick: async () => {
          if (!confirm(`Class „${classTitle(cls)}“ mit allen Choreos und Videos löschen?`)) return;
          await deleteClass(id);
          toast('Class gelöscht');
          go('#/');
        },
      }, 'Class löschen')),
  );
  return () => urls.forEach(u => URL.revokeObjectURL(u));
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
    customLabel.textContent = PALETTE.includes(color) ? 'Eigene' : color;
    custom.style.background = PALETTE.includes(color) ? '' : `#${color}`;
    custom.style.color = PALETTE.includes(color) ? '' : textOn(color);
  };
  const picker = h('input', { type: 'color', value: `#${color}` });
  picker.addEventListener('input', () => preview(picker.value));
  const customLabel = h('span', 'Eigene');
  const custom = h('label.chip.custom', { title: 'Eigene Farbe wählen' }, customLabel, picker);
  const swatches = h('div.chips', PALETTE.map(p => h('button.chip', {
    type: 'button', 'data-hex': p, style: { background: `#${p}`, color: textOn(p) },
    onclick: () => preview(p), title: 'Farbe', 'aria-label': 'Farbe',
  })), custom);
  preview(color);
  return h('div.fieldset',
    h('div.row',
      field('category', 'Style', pick.category),
      field('level', 'Level', pick.level),
      field('weekday', 'Wochentag', h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', { selected: d === cls.weekday }, d)))),
      field('time', 'Uhrzeit', h('input', { type: 'time', value: cls.time || '' })),
      field('coach', 'Coach', pick.coach)),
    h('div', { style: { marginTop: '14px' } }, h('span.label.color-label', 'Farbe'), swatches),
    h('div.actions',
      h('button.btn.primary', {
        onclick: async () => {
          for (const k of Object.keys(f)) cls[k] = f[k].value.trim();
          cls.color = color;
          await db.put('classes', cls);
          toast('Gespeichert');
          go(location.hash);
        },
      }, 'Speichern'),
      h('button.btn', {
        onclick: () => { preview(original); close(); },
      }, 'Abbrechen')));
}

function choreoBlock(c, recs, sessions, urls) {
  const practiced = sessions.filter(s => s.choreoId === c.id).reduce((a, s) => a + s.seconds, 0);
  return h('div.choreo-block',
    c.song?.cover ? songLink(h('img', { src: c.song.cover, alt: '' }), c.song) : h('div.nocover'),
    h('div',
      h('h2.wide', { style: { fontSize: '20px', margin: '0 0 6px' } }, h('a', { href: recs.length ? `#/train/${recs[recs.length - 1].id}` : null }, (c.title || c.song?.title || 'Ohne Song').toUpperCase())),
      h('div.label', `${c.song?.artist || ''}${c.song?.artist ? ' · ' : ''}geübt ${fmtDuration(practiced)} · zuletzt ${relDate(c.lastPracticed)}  `, dots(latestRating(c))),
      h('ul.reclist', recs.map((r, i) => {
        const title = inlineEdit(recTitle(r, i), async v => { r.title = v; await db.put('recordings', r); }, { href: `#/train/${r.id}` });
        return h('li',
        h('a.mini', { href: `#/train/${r.id}` }, hoverVideo(r, urls, 'mini-thumb')),
        h('strong', title),
        h('span', fmtRecDate(r.recordedAt)),
        h('span.muted', r.duration ? fmt(r.duration) : ''),
        h('span.muted', { style: { flex: 1, minWidth: '120px' } }, (r.notes || '').slice(0, 80)),
        h('button.linkbtn', { onclick: () => title.startEdit() }, 'Umbenennen'),
        h('button.linkbtn', {
          onclick: async () => {
            if (!confirm('Diese Aufnahme samt Video löschen?')) return;
            await deleteRecording(r.id);
            if (recs.length === 1) await deleteChoreo(c.id);
            go(location.hash);
          },
        }, 'Löschen'));
      })),
      h('div.actions', { style: { marginTop: '10px' } },
        h('a.linkbtn', { href: `#/upload?choreo=${c.id}`, onclick: () => { state.pendingFile = null; } }, '+ Aufnahme hinzufügen'),
        h('button.linkbtn', {
          onclick: async () => {
            const name = c.title || c.song?.title || 'Ohne Song';
            if (!confirm(`Choreo „${name}“ mit ${recs.length} Aufnahme${recs.length === 1 ? '' : 'n'} samt Videos löschen?`)) return;
            await deleteChoreo(c.id);
            toast('Choreo gelöscht');
            go(location.hash);
          },
        }, 'Choreo löschen'))));
}
