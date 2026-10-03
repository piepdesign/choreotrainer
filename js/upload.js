// Upload: Video + Class + Song + Recording-Datum + Notizen → Class › Choreo › Aufnahme
import { db, uid } from './db.js';
import { h, fmt, parseTime, isoDate, classTitle, classMeta, PALETTE, textOn, WEEKDAYS, byClassOrder, CLASS_TITLES, CLASS_LEVELS } from './util.js';
import { songPicker, songKeyOf } from './song.js';
import { classPickers } from './ui.js';
import { dropzone } from './hub.js';
import { state, go, toast } from './app.js';


const norm = s => String(s || '').trim().toLowerCase();

export async function renderUpload(root, kind, refId) {
  let file = state.pendingFile;
  state.pendingFile = null;
  let previewUrl = null;

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
  const offsetIn = h('input', { type: 'text', placeholder: '0:00', style: { maxWidth: '90px' } });
  const picker = songPicker({
    song: preChoreo?.song || null,
    getBlob: () => file,
    onChange: (s, offset) => { if (offset != null) offsetIn.value = fmt(offset, true); },
    onOffset: offset => { offsetIn.value = fmt(offset, true); },
  });

  // ── Recording + Notizen ──
  const dateIn = h('input', { type: 'date', value: isoDate(Date.now()), oninput: e => { e.target.dataset.touched = '1'; } });
  const notesIn = h('textarea', { placeholder: 'Outfit, Gedankenstützen, Anmerkungen vom Coach …' });
  const saveBtn = h('button.btn.primary', { onclick: save }, 'Speichern & trainieren');

  // ── linke Spalte: Video ──
  const left = h('div');
  function renderLeft() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (!file) {
      left.replaceChildren(dropzone(f => { file = f; renderLeft(); }));
    } else {
      previewUrl = URL.createObjectURL(file);
      left.replaceChildren(
        h('video', { src: previewUrl, controls: true, playsinline: true, preload: 'metadata' }),
        h('div.actions', { style: { marginTop: '8px', justifyContent: 'space-between' } },
          h('span.label', `${file.name} · ${(file.size / 1e6).toFixed(0)} MB`),
          h('button.linkbtn', { onclick: () => { file = null; renderLeft(); } }, 'Anderes Video')));
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
          picker.el,
          h('div.row', { style: { marginTop: '12px' } }, field('Video beginnt im Song bei (optional)', offsetIn))),
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
        markers: [],
        player: {},
      };
      await db.put('videos', file, rec.id);
      await db.put('recordings', rec);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      go(`#/train/${rec.id}`, { replace: true });
    } catch (e) {
      console.error(e);
      toast(`Speichern fehlgeschlagen: ${e.message}`, 5000);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern & trainieren';
    }
  }

  return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
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
