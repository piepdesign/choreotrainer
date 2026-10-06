// Upload: Video + Class + Song + Recording-Datum + Notizen → Class › Choreo › Aufnahme
import { db, uid, requestPersist } from './db.js';
import { h, fmt, parseTime, isoDate, classTitle, classMeta, PALETTE, textOn, WEEKDAYS, byClassOrder, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { songPicker, songKeyOf, sameSong } from './song.js';
import { identifyAudio } from './recognize.js';
import { alignToSong, checkAudio } from './align.js';
import { classPickers, confirmDialog } from './ui.js';
import { dropzone } from './hub.js';
import { state, go, toast } from './app.js';
import { compressVideo } from './compress.js';


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
      packInfo.replaceChildren(`Verkleinere … ${packPct} %`, ' ', keepBtn());
      if (saving) saveBtn.textContent = `Verkleinere … ${packPct} %`;
    });
    job = mine;
    packInfo.replaceChildren('Prüfe Video …', ' ', keepBtn());
    mine.promise.then(({ file: f, reason }) => {
      if (job !== mine) return;
      packing = false;
      packed = keepOriginal ? null : f;
      packInfo.replaceChildren(packed ? `Verkleinert: ${mbOf(file.size)} → ${mbOf(packed.size)}` : `Original wird gespeichert${keepOriginal ? '' : ` (${reason})`}`);
      if (saving) save();
    });
  }
  function useOriginal() { keepOriginal = true; job?.cancel(); }
  const keepBtn = () => h('button.linkbtn', { type: 'button', onclick: useOriginal }, 'Original behalten');
  let saving = false;

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
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', d))),
    time: h('input', { type: 'time' }),
  };
  const fill = c => { for (const k of Object.keys(f)) f[k].value = c?.[k] || ''; };
  const chips = h('div.chips', classes.map(c => h('button.chip', {
    type: 'button', style: { background: `#${c.color}`, color: textOn(c.color) },
    onclick: e => { fill(c); chips.querySelectorAll('.chip').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); },
  }, `${classTitle(c)}${classMeta(c) ? ' · ' + classMeta(c) : ''}`.toUpperCase())));
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
    onChange: (s, offset) => { if (offset != null) offsetIn.value = fmt(offset, true); songStep.hidden = false; },
    // file: Position in der Songdatei (kann bei Musikvideo-Fassungen abweichen), null = Datei passt nicht
    onOffset: (offset, { file: pos } = {}) => { offsetIn.value = fmt(offset, true); fileOffset = pos; },
    align: () => (songFile && file ? alignToSong(file, songFile) : null),
    startField: offsetIn,
  });
  // Schritt 3: Songdatei (optional) – gleicher Aufbau wie im Panel der Trainingsansicht
  const songFileIn = h('input', { type: 'file', accept: 'audio/*,audio/flac,audio/x-flac,.mp3,.m4a,.aac,.wav,.flac,.aiff', hidden: true });
  const songStep = h('div.song-step', { hidden: !preChoreo?.song });
  function renderSongStep(msg = '') {
    songStep.replaceChildren(songFileIn, h('span.label.step-label', 'Songdatei (optional)'), songFile
      ? h('div.actions',
        h('span.label', `♪ ${songFile.name}`),
        h('button.linkbtn', { type: 'button', onclick: () => songFileIn.click() }, 'Ersetzen'),
        h('button.linkbtn', { type: 'button', onclick: () => { songFile = null; renderSongStep(); } }, 'Entfernen'))
      : h('div.actions', h('button.btn.small', { type: 'button', onclick: () => songFileIn.click() }, 'Songdatei laden')),
    h('div.label', { style: { marginTop: '6px' } }, msg || 'Zum Trainieren auf den Song.'));
  }
  songFileIn.addEventListener('change', async () => {
    const f = songFileIn.files[0];
    songFileIn.value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|aac|wav|flac|aiff?)$/i.test(f.name)) { toast('Bitte eine Audiodatei wählen'); return; }
    renderSongStep('Prüfe Songdatei …');
    const problem = await checkAudio(f);
    if (problem) { toast(problem, 8000); renderSongStep(); return; }
    // Ist es wirklich der gewählte Song? (kurz bei Shazam nachfragen; scheitert das, ohne Prüfung weiter)
    const chosen = picker.get();
    if (chosen?.title) {
      renderSongStep('Prüfe, welcher Song in der Datei ist …');
      const found = await identifyAudio(f).catch(() => null);
      if (found && !sameSong(found, chosen)
        && !(await confirmDialog({ title: 'ANDERER SONG?', text: `Die Datei klingt nach „${[found.artist, found.title].filter(Boolean).join(' — ')}“, gewählt ist aber „${chosen.title}“.`, ok: 'Trotzdem verwenden', danger: false }))) {
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
  const notesIn = h('textarea', { placeholder: '5, 6, 7, 8 Anmerkungen …' });
  const saveBtn = h('button.btn.primary', { onclick: save }, 'Speichern');

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
          h('button.linkbtn', { onclick: () => { file = null; renderLeft(); } }, 'Anderes Video')),
        packInfo);
      startPack();
      if (!dateIn.dataset.touched && file.lastModified) dateIn.value = isoDate(file.lastModified);
      // Song automatisch erkennen, solange noch keiner gewählt ist
      if (!picker.get() && !picker.typed()) picker.recognize(true);
    }
    saveBtn.disabled = !file;
    picker.refresh();
  }

  root.append(
    h('div.section-head', { style: { marginTop: '18px' } },
      h('h2.wide', preChoreo ? 'NEUE AUFNAHME' : 'UPLOAD'),
      preChoreo ? h('span.label', `zu ${preChoreo.song?.title || 'Choreo'}`) : null),
    h('div.upload-grid',
      left,
      h('div',
        h('div.fieldset', h('span.label', 'Class'),
          classes.length ? chips : null,
          h('div.row', field('Style', f.category), field('Level', f.level)),
          h('div.row', { style: { marginTop: '12px' } }, field('Wochentag', f.weekday), field('Uhrzeit', f.time), field('Coach', f.coach))),
        h('div.fieldset', h('span.label', 'Song'),
          picker.el, songStep),
        h('div.fieldset', h('span.label', 'Recording'), h('div.row', field('Aufgenommen am', dateIn))),
        h('div.fieldset', h('span.label', 'Notizen'), notesIn),
        h('div.actions', saveBtn))),
  );
  renderLeft();

  async function save() {
    if (!file) return;
    let song = picker.get();
    if (!song && picker.typed()) song = { source: 'manual', title: picker.typed(), artist: '' };
    const cls = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    if (!cls.category) { toast('Bitte mindestens den Style der Class angeben'); f.category.focus(); return; }

    // Knopf zeigt den Stand (nicht ausgegraut wie „disabled“, sonst ist er am Handy kaum lesbar), weitere Klicks zählen nicht
    if (saving && packing) return;
    saveBtn.classList.add('busy');
    saveBtn.setAttribute('aria-busy', 'true');
    // noch am Verkleinern: warten (Fortschritt im Knopf), danach geht es von selbst weiter
    if (packing && !keepOriginal) { saving = true; saveBtn.textContent = packPct == null ? 'Bereite vor …' : `Verkleinere … ${packPct} %`; return; }
    saving = false;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere …';
    try {
      // Class finden oder anlegen
      let klass = classes.find(c => ['category', 'level', 'weekday', 'time', 'coach'].every(k => norm(c[k]) === norm(cls[k])));
      if (!klass) {
        klass = { id: uid(), ...cls, color: PALETTE[classes.length % PALETTE.length], order: classes.length, created: Date.now() };
        await db.put('classes', klass);
      }
      // Choreo finden oder anlegen (gleiche Class + gleicher Song = gleiche Choreo)
      let choreo = preChoreo && preChoreo.classId === klass.id ? preChoreo : null;
      if (!choreo && song) {
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
        title: `Aufnahme ${count + 1}`,
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
      await db.put('videos', packed || file, rec.id);
      if (songFile) await db.put('videos', songFile, `song:${choreo.id}`);
      await db.put('recordings', rec);
      requestPersist(); // spätestens jetzt liegen Daten vor: Browser bitten, sie nicht selbst zu räumen
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      go(`#/train/${rec.id}`, { replace: true });
    } catch (e) {
      console.error(e);
      toast(`Speichern fehlgeschlagen: ${e.message}`, 5000);
      saveBtn.disabled = false;
      saveBtn.classList.remove('busy'); saveBtn.removeAttribute('aria-busy');
      saveBtn.textContent = 'Speichern';
    }
  }

  return () => { job?.cancel(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
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
