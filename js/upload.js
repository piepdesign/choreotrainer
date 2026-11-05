// Upload: Video + Class + Song + Recording-Datum + Notizen → Class › Choreo › Aufnahme
import { tr, tn, dayLabel } from './i18n.js';
import { db, uid, requestPersist } from './db.js';
import { h, fmt, parseTime, isoDate, classTitle, classMeta, PALETTE, textOn, WEEKDAYS, byClassOrder, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { songPicker, songKeyOf, sameSong } from './song.js';
import { identifyAudio } from './recognize.js';
import { alignToSong, checkAudio } from './align.js';
import { classPickers, confirmDialog, colorChooser } from './ui.js';
import { dropzone } from './hub.js';
import { state, go, toast } from './app.js';
import { compressVideo } from './compress.js';
import { analyzeBeat } from './beat.js';
import { needsCapture } from './audio.js';
import { carrySource, carryOver } from './carry.js';


const norm = s => String(s || '').trim().toLowerCase();

export async function renderUpload(root, kind, refId) {
  let file = state.pendingFile;
  state.pendingFile = null;
  let previewUrl = null;
  // Komprimieren läuft ab der Videoauswahl im Hintergrund, Speichern wartet darauf (oder nimmt das Original)
  let job = null, packed = null, packing = false, keepOriginal = false, packPct = null;
  const packInfo = h('span.label.pack-info');
  const mbOf = b => `${Math.max(1, Math.round(b / 1e6))} MB`;
  function startPack() {
    job?.cancel();
    packed = null; keepOriginal = false;
    if (!file) { job = null; return; }
    packing = true; packPct = null;
    const mine = compressVideo(file, p => {
      if (job !== mine) return;
      packPct = Math.round(p * 100);
      packInfo.replaceChildren(tr('Verkleinere … {p} %', { p: packPct }), ' ', keepBtn());
      if (saving) saveBtn.textContent = tr('Verkleinere … {p} %', { p: packPct });
    });
    job = mine;
    packInfo.replaceChildren(tr('Prüfe Video …'), ' ', keepBtn());
    mine.promise.then(({ file: f, reason }) => {
      if (job !== mine) return;
      packing = false;
      packed = keepOriginal ? null : f;
      packInfo.replaceChildren(packed ? tr('Verkleinert: {a} → {b}', { a: mbOf(file.size), b: mbOf(packed.size) }) : `${tr('Original wird gespeichert')}${keepOriginal ? '' : ` (${reason})`}`);
      if (saving) save();
    });
  }
  function useOriginal() { keepOriginal = true; job?.cancel(); }
  const keepBtn = () => h('button.linkbtn', { type: 'button', onclick: useOriginal }, tr('Original behalten'));
  let saving = false;
  let picked; // Antwort auf „Choreo gibt es schon“: Choreo, 'new' oder undefined (noch nicht gefragt)
  let pickedFor = null; // Song-Schlüssel, für den gefragt wurde (anderer Song: neu fragen)
  let asking = null; // offene Abfrage (nicht doppelt zeigen)

  const classes = (await db.all('classes')).sort(byClassOrder);
  let preChoreo = null, preClass = null;
  if (kind === 'choreo') {
    preChoreo = await db.get('choreos', refId);
    preClass = preChoreo && await db.get('classes', preChoreo.classId);
  } else if (kind === 'class') {
    preClass = await db.get('classes', refId);
  }

  // ── Class ──
  const f = {
    ...classPickers(classes, { styles: CLASS_TITLES, levels: CLASS_LEVELS }),
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', { value: d }, dayLabel(d)))),
    time: h('input', { type: 'time' }),
  };
  const fill = c => { for (const k of Object.keys(f)) f[k].value = c?.[k] || ''; showColor(); };
  const selectChip = c => chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('sel', x.dataset.id === c?.id));
  const chips = h('div.chips', classes.map(c => h('button.chip', {
    type: 'button', 'data-id': c.id, style: { background: `#${c.color}`, color: textOn(c.color) },
    onclick: () => {
      fill(c); selectChip(c);
      if (picked && picked !== 'new' && picked.classId !== c.id) picked = undefined; // andere Class gewählt: beim Speichern neu fragen
    },
  }, `${classTitle(c)}${classMeta(c) ? ' · ' + classMeta(c) : ''}`.toUpperCase())));
  // Farbe für eine neue Class (nur sichtbar, solange die Angaben zu keiner bestehenden Class passen)
  const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, String(el.value || '').trim()]));
  const existingClass = v => classes.find(c => KEYS.every(k => norm(c[k]) === norm(v[k])));
  const swatches = colorChooser(PALETTE[classes.length % PALETTE.length]);
  const colorRow = h('div', { style: { marginTop: '12px' }, hidden: true }, h('span.label.color-label', tr('Farbe der neuen Class')), swatches);
  function showColor() {
    const v = values();
    colorRow.hidden = !v.category || !!existingClass(v);
    selectChip(existingClass(v));
  }
  for (const el of Object.values(f)) for (const ev of ['input', 'change']) el.addEventListener(ev, showColor);
  if (preClass) fill(preClass);
  const field = (label, input) => h('label.field', h('span', label), input);

  // ── Song ──
  const offsetIn = h('input.offset-in', { type: 'text', placeholder: '0:00' });
  let songFile = null; // optionale Songdatei (wird mit der Choreo gespeichert, wie in der Trainingsansicht)
  let fileOffset; // Position des Videos in der Songdatei aus dem Abgleich (undefined = wie Startpunkt)
  offsetIn.addEventListener('input', () => { fileOffset = undefined; }); // von Hand: gilt für Song und Datei
  const picker = songPicker({
    song: preChoreo?.song || null,
    getBlob: () => file,
    onChange: (s, offset, { reset } = {}) => {
      if (reset) { offsetIn.value = ''; fileOffset = undefined; } // andere Fassung: alter Startpunkt passt nicht mehr
      if (offset != null) offsetIn.value = fmt(offset, true);
      songStep.hidden = false;
      askExisting(s); // gleich fragen, sobald der Song feststeht (nicht erst beim Speichern)
    },
    // file: Position in der Songdatei (kann bei Musikvideo-Fassungen abweichen), null = Datei passt nicht
    onOffset: (offset, { file: pos } = {}) => { offsetIn.value = fmt(offset, true); fileOffset = pos; },
    align: () => (songFile && file ? alignToSong(file, songFile) : null),
    startField: offsetIn,
    // Tempo des Videos für den Fassungs-Hinweis (auf dem Handy nicht, wenn die Analyse den Ton hörbar abspielen müsste)
    tempo: b => (needsCapture(b) ? null : analyzeBeat(b).then(r => r?.bpm || null)),
  });
  // Schritt 3: Songdatei (optional) – gleicher Aufbau wie im Panel der Trainingsansicht
  const songFileIn = h('input', { type: 'file', accept: 'audio/*,audio/flac,audio/x-flac,.mp3,.m4a,.aac,.wav,.flac,.aiff', hidden: true });
  const songStep = h('div.song-step', { hidden: !preChoreo?.song });
  function renderSongStep(msg = '') {
    songStep.replaceChildren(songFileIn, songFile
      ? h('div.actions',
        h('span.label', `♪ ${songFile.name}`),
        h('button.linkbtn', { type: 'button', onclick: () => songFileIn.click() }, tr('Ersetzen')),
        h('button.linkbtn', { type: 'button', onclick: () => { songFile = null; renderSongStep(); } }, tr('Entfernen')))
      : h('div.actions', h('button.btn.small', { type: 'button', title: tr('Kauf-Download oder vom Coach. Downloads aus Streaming-Apps sind kopiergeschützt.'), onclick: () => songFileIn.click() }, tr('Songdatei laden'))),
    ...(msg ? [h('div.hint-text', { style: { marginTop: '6px' } }, msg)] : []));
  }
  songFileIn.addEventListener('change', async () => {
    const f = songFileIn.files[0];
    songFileIn.value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|aac|wav|flac|aiff?)$/i.test(f.name)) { toast(tr('Bitte eine Audiodatei wählen')); return; }
    renderSongStep(tr('Prüfe Songdatei …'));
    const problem = await checkAudio(f);
    if (problem) { toast(problem, 8000); renderSongStep(); return; }
    // Ist es wirklich der gewählte Song? (kurz bei Shazam nachfragen; scheitert das, ohne Prüfung weiter)
    const chosen = picker.get();
    if (chosen?.title) {
      renderSongStep(tr('Prüfe, welcher Song in der Datei ist …'));
      const found = await identifyAudio(f).catch(() => null);
      if (found && !sameSong(found, chosen)
        && !(await confirmDialog({ title: tr('ANDERER SONG?'), text: tr('Die Datei klingt nach „{found}“, gewählt ist aber „{chosen}“.', { found: [found.artist, found.title].filter(Boolean).join(' — '), chosen: chosen.title }), ok: tr('Trotzdem verwenden'), danger: false }))) {
        renderSongStep();
        return;
      }
    }
    songFile = f;
    fileOffset = undefined;
    renderSongStep();
    if (file && picker.get()) picker.detectStart(); // Startpunkt direkt per Abgleich
  });
  renderSongStep();

  // ── Recording + Notizen ──
  const dateIn = h('input', { type: 'date', value: isoDate(Date.now()), oninput: e => { e.target.dataset.touched = '1'; } });
  const notesIn = h('textarea', { placeholder: tr('5, 6, 7, 8 Anmerkungen …') });
  const saveBtn = h('button.btn.primary', { onclick: save }, tr('Speichern'));

  // ── linke Spalte: Video ──
  const left = h('div');
  function renderLeft() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (!file) {
      job?.cancel(); job = null; packed = null; packing = false;
      left.replaceChildren(dropzone(f => { file = f; renderLeft(); }));
    } else {
      previewUrl = URL.createObjectURL(file);
      left.replaceChildren(
        h('video', { src: previewUrl, controls: true, playsinline: true, preload: 'metadata' }),
        h('div.actions', { style: { marginTop: '8px', justifyContent: 'space-between' } },
          h('span.label', `${file.name} · ${(file.size / 1e6).toFixed(0)} MB`),
          h('button.linkbtn', { onclick: () => { file = null; renderLeft(); } }, tr('Anderes Video'))),
        packInfo);
      startPack();
      // Aufnahmetag aus Metadaten oder Dateiname, nicht der Tag des Hochladens
      const mine = file;
      if (!dateIn.dataset.touched) recordedDate(file).then(d => { if (d && file === mine && !dateIn.dataset.touched) dateIn.value = d; });
      // Song automatisch erkennen, solange noch keiner gewählt ist
      if (!picker.get() && !picker.typed()) picker.recognize(true);
    }
    saveBtn.disabled = !file;
    picker.refresh();
  }

  root.append(
    h('div.section-head', { style: { marginTop: '18px' } },
      h('h2.wide', preChoreo ? tr('NEUE AUFNAHME') : tr('UPLOAD')),
      preChoreo ? h('span.label', tr('zu {title}', { title: preChoreo.song?.title || 'Choreo' })) : null),
    h('div.upload-grid',
      left,
      h('div',
        h('div.fieldset', h('span.label', 'Class'),
          classes.length ? chips : null,
          h('div.row', field('Style', f.category), field('Level', f.level)),
          h('div.row', { style: { marginTop: '12px' } }, field(tr('Wochentag'), f.weekday), field(tr('Uhrzeit'), f.time), field('Coach', f.coach)),
          colorRow),
        h('div.fieldset', h('span.label', tr('Song')),
          picker.el, songStep),
        h('div.fieldset', h('span.label', tr('Recording')), h('div.row', field(tr('Aufgenommen am'), dateIn))),
        h('div.fieldset', h('span.label', tr('Notizen')), notesIn),
        h('div.actions', saveBtn))),
  );
  renderLeft();

  // Über „Neue Choreo“: Gibt es den Song schon als Choreo (in dieser oder einer anderen Class)? Dann fragen.
  // Läuft, sobald ein Song gewählt oder erkannt ist, und noch einmal beim Speichern (falls dort noch offen).
  // → true = weiter, false = abgebrochen
  async function askExisting(song) {
    if (preChoreo || !song) return true;
    const key = songKeyOf(song);
    if (picked !== undefined && pickedFor === key) return true;
    if (asking) return asking;
    asking = (async () => {
      const same = await sameSongChoreos(song);
      if (!same.length) { picked = 'new'; pickedFor = key; return true; }
      const r = await chooseChoreo(same, song, values());
      if (!r) return false; // abgebrochen: beim Speichern noch einmal fragen
      picked = r; pickedFor = key;
      if (r !== 'new') { const k = classes.find(c => c.id === r.classId); if (k) fill(k); } // Class der gewählten Choreo eintragen
      return true;
    })();
    try { return await asking; } finally { asking = null; }
  }

  async function save() {
    if (!file) return;
    let song = picker.get();
    if (!song && picker.typed()) song = { source: 'manual', title: picker.typed(), artist: '' };
    // Knopf zeigt den Stand (nicht ausgegraut wie „disabled“, sonst ist er am Handy kaum lesbar), weitere Klicks zählen nicht
    if (saving && packing) return;
    if (!(await askExisting(song))) return;
    const cls = values();
    if (!cls.category && !(picked && picked !== 'new')) { toast(tr('Bitte mindestens den Style der Class angeben')); f.category.focus(); return; }
    saveBtn.classList.add('busy');
    saveBtn.setAttribute('aria-busy', 'true');
    // noch am Verkleinern: warten (Fortschritt im Knopf), danach geht es von selbst weiter
    if (packing && !keepOriginal) { saving = true; saveBtn.textContent = packPct == null ? tr('Bereite vor …') : tr('Verkleinere … {p} %', { p: packPct }); return; }
    saving = false;
    saveBtn.disabled = true;
    saveBtn.textContent = tr('Speichere …');
    try {
      // Class finden oder anlegen (bei gewählter bestehender Choreo gilt deren Class)
      const target = picked && picked !== 'new' ? picked : null;
      let klass = target ? classes.find(c => c.id === target.classId)
        : classes.find(c => ['category', 'level', 'weekday', 'time', 'coach'].every(k => norm(c[k]) === norm(cls[k])));
      if (!klass) {
        klass = { id: uid(), ...cls, color: swatches.value, order: classes.length, created: Date.now() };
        await db.put('classes', klass);
      }
      // Choreo finden oder anlegen (gleiche Class + gleicher Song = gleiche Choreo)
      // „Als neue Choreo anlegen“ gewählt: nicht in die gleichnamige einsortieren
      let choreo = target || (preChoreo && preChoreo.classId === klass.id ? preChoreo : null);
      if (!choreo && song && picked !== 'new') {
        const key = songKeyOf(song);
        choreo = (await db.byIndex('choreos', 'classId', klass.id)).find(c => c.songKey === key) || null;
      }
      if (!choreo) {
        choreo = { id: uid(), classId: klass.id, song, songKey: song ? songKeyOf(song) : `none:${uid()}`, created: Date.now(), ratings: [], lastPracticed: null };
      } else if (song && !choreo.song) {
        Object.assign(choreo, { song, songKey: songKeyOf(song) });
      }
      await db.put('choreos', choreo);

      const meta = await videoMeta(file);
      const count = (await db.byIndex('recordings', 'choreoId', choreo.id)).length;
      const rec = {
        id: uid(),
        choreoId: choreo.id,
        title: tr('Aufnahme {n}', { n: count + 1 }),
        recordedAt: dateIn.value ? new Date(dateIn.value + 'T12:00').getTime() : Date.now(),
        uploadedAt: Date.now(),
        notes: notesIn.value.trim(),
        fileName: file.name,
        size: file.size,
        duration: meta.duration,
        thumb: meta.thumb,
        songOffset: parseTime(offsetIn.value),
        ...(fileOffset !== undefined ? { fileOffset } : {}),
        markers: [],
        player: {},
      };
      if (packed) rec.storedSize = packed.size; // fileName/size bleiben die des Originals (zum Wiederfinden beim Zuordnen)
      // Bestehende Choreo: Marker, Loop, 8er, Start/Ende der zuletzt gespeicherten Aufnahme übernehmen (umgerechnet)
      let carried = null;
      const src = count ? await carrySource(choreo.id) : null;
      if (src) {
        saveBtn.textContent = tr('Übernehme Marker …');
        carried = await carryOver(src, rec, packed || file).catch(e => { console.warn(e); return null; });
      }
      await db.put('videos', packed || file, rec.id);
      if (songFile) await db.put('videos', songFile, `song:${choreo.id}`);
      await db.put('recordings', rec);
      requestPersist(); // spätestens jetzt liegen Daten vor: Browser bitten, sie nicht selbst zu räumen
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      go(`#/train/${rec.id}`, { replace: true });
      if (carried) toast(carryText(carried), 5000);
    } catch (e) {
      picked = undefined;
      console.error(e);
      toast(tr('Speichern fehlgeschlagen: {msg}', { msg: e.message }), 5000);
      saveBtn.disabled = false;
      saveBtn.classList.remove('busy'); saveBtn.removeAttribute('aria-busy');
      saveBtn.textContent = tr('Speichern');
    }
  }

  return () => { job?.cancel(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
}

// Choreos mit demselben Song: gleicher Schlüssel (Deezer-ID bzw. Interpret|Titel) oder gleicher Titel und
// passender Interpret (z. B. einmal über Deezer gewählt, einmal von Hand eingetippt).
async function sameSongChoreos(song) {
  const key = songKeyOf(song), artist = norm(song.artist);
  const fits = c => c.song && (c.songKey === key || (sameSong(c.song, song)
    && (!artist || !norm(c.song.artist) || norm(c.song.artist).includes(artist) || artist.includes(norm(c.song.artist)))));
  const out = [];
  for (const c of (await db.all('choreos')).filter(fits)) {
    const klass = await db.get('classes', c.classId);
    if (klass) out.push({ choreo: c, klass, recs: (await db.byIndex('recordings', 'choreoId', c.id)).length });
  }
  return out;
}

// Abfrage: zur bestehenden Choreo hinzufügen oder neue Choreo anlegen. → Choreo, 'new' oder null (abgebrochen)
// Vorgewählt: die Choreo in der eingetragenen Class, sonst die zuletzt geübte.
function chooseChoreo(list, song, cls) {
  const sameClass = x => ['category', 'level', 'weekday', 'time', 'coach'].every(k => norm(x.klass[k]) === norm(cls[k]));
  list.sort((a, b) => sameClass(b) - sameClass(a) || (b.choreo.lastPracticed || 0) - (a.choreo.lastPracticed || 0));
  let mode = list[0].choreo.id;
  const radio = (v, l) => {
    const r = h('input', { type: 'radio', name: 'choreo-choice', value: v, checked: v === mode });
    r.addEventListener('change', () => { mode = v; });
    return h('label.share-item', r, h('span', l));
  };
  const items = [
    ...list.map(x => radio(x.choreo.id, [tr('Zu Class „{cls}“', { cls: [classTitle(x.klass), classMeta(x.klass)].filter(Boolean).join(' · ') }), ' ',
      h('span.muted', tn(x.recs, 'Aufnahme', 'Aufnahmen'))])),
    radio('new', tr('Als neue Choreo anlegen')),
  ];
  return new Promise(resolve => {
    const close = v => { box.remove(); removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const ok = () => close(mode === 'new' ? 'new' : list.find(x => x.choreo.id === mode).choreo);
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(null); } },
      h('div.modal-card.share-card', h('h2.wide', tr('CHOREO GIBT ES SCHON')),
        h('p.label', tr('„{song}“ ist schon angelegt. Neue Aufnahme dazu?', { song: song.title })),
        h('div.choice-list', items),
        h('p.hint-text', tr('Marker, Loop, 8er und Start/Ende kommen von der letzten Aufnahme, umgerechnet auf die Stelle im Song. Der Status bleibt.')),
        h('div.actions', h('button.btn.small.primary', { type: 'button', onclick: ok }, tr('Hinzufügen')),
          h('button.linkbtn', { type: 'button', onclick: () => close(null) }, tr('Abbrechen')))));
    addEventListener('keydown', onKey, true);
    document.body.append(box);
    box.querySelector('button.primary').focus();
  });
}

function carryText(c) {
  if (!c.how) return tr('Keine gemeinsame Stelle mit „{from}“ gefunden. Marker und 8er bitte neu setzen.', { from: c.from });
  const parts = [c.markers && tn(c.markers, 'Marker', 'Marker'), c.loop && tr('Loop'), c.beat && tr('8er')].filter(Boolean);
  return parts.length ? tr('Von „{from}“ übernommen: {what}.', { from: c.from, what: parts.join(', ') }) : tr('Nichts von „{from}“ liegt in dieser Aufnahme.', { from: c.from });
}

// Aufnahmetag (JJJJ-MM-TT) bestimmen, der Reihe nach: Aufnahmedatum in den Metadaten (iPhone, Android),
// Datum im Dateinamen (IMG_20261028_…, VID-20261028-WA…, 2026-10-28 19.30.12 …), Erstellzeit des Videos,
// Änderungsdatum der Datei. Liefert null, wenn nichts Brauchbares dabei ist.
export async function recordedDate(file) {
  const ok = d => (d && d.getFullYear() >= 2000 && d.getTime() <= Date.now() + 864e5 ? isoDate(d.getTime()) : null);
  const meta = await movieDates(file).catch(() => ({}));
  return (meta.tagged && ok(meta.tagged)) || dateFromName(file.name) || (meta.created && ok(meta.created))
    || (file.lastModified ? isoDate(file.lastModified) : null);
}
function dateFromName(name) {
  const n = String(name);
  let m, y, mo, d;
  if ((m = n.match(/(?:^|\D)(20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/))) [, y, mo, d] = m;
  else if ((m = n.match(/(?:^|\D)(0[1-9]|[12]\d|3[01])[-_.](0[1-9]|1[0-2])[-_.](20\d\d)(?!\d)/))) [, d, mo, y] = m;
  else return null;
  return new Date(+y, mo - 1, +d) <= Date.now() ? `${y}-${mo}-${d}` : null;
}
// MP4/MOV: Box „moov“ suchen (steht am Anfang oder am Ende) und darin lesen.
// tagged = Aufnahmedatum als Text (com.apple.quicktime.creationdate bzw. ©day), created = Erstellzeit aus „mvhd“
async function movieDates(file) {
  const read = async (at, n) => new DataView(await file.slice(at, at + n).arrayBuffer());
  let pos = 0;
  for (let i = 0; i < 64 && pos + 8 <= file.size; i++) {
    const v = await read(pos, 16);
    let size = v.getUint32(0);
    const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    if (size === 1) size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') {
      const buf = new Uint8Array(await file.slice(pos, pos + Math.min(size, 32e6)).arrayBuffer());
      const text = new TextDecoder('latin1').decode(buf);
      const out = {};
      // Text mit Zeitzone (2026-10-28T19:30:12+0100): Datum wie geschrieben, also Ortszeit der Aufnahme
      const t = text.match(/(20\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?/);
      if (t) out.tagged = t[7] === 'Z' ? new Date(t[0]) : new Date(+t[1], t[2] - 1, +t[3], +t[4], +t[5]);
      const at = text.indexOf('mvhd');
      if (at > 0) {
        const d = new DataView(buf.buffer, at + 4);
        const secs = d.getUint8(0) === 1 ? d.getUint32(4) * 2 ** 32 + d.getUint32(8) : d.getUint32(4);
        if (secs) out.created = new Date((secs - 2082844800) * 1000); // Sekunden seit 1904, UTC
      }
      return out;
    }
    pos += size;
  }
  return {};
}

// Dauer + Vorschaubild (Frame bei ~1 s)
function videoMeta(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = r => { URL.revokeObjectURL(url); resolve(r); };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 3) / 3); };
    v.onseeked = () => {
      try {
        const w = 360, hgt = Math.round((w * v.videoHeight) / v.videoWidth) || 225;
        const c = document.createElement('canvas');
        c.width = w; c.height = hgt;
        c.getContext('2d').drawImage(v, 0, 0, w, hgt);
        done({ duration: v.duration, thumb: c.toDataURL('image/jpeg', 0.72) });
      } catch {
        done({ duration: v.duration, thumb: null });
      }
    };
    v.onerror = () => done({ duration: null, thumb: null });
    setTimeout(() => done({ duration: v.duration || null, thumb: null }), 10000);
    v.src = url;
  });
}
