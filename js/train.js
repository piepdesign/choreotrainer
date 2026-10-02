// Trainingsansicht: Player mit Spiegeln, Tempo, Lautstärke, Bild, Loop, 8er-Count, Markern, Song-Zeitleiste
import { db, uid, deleteRecording, deleteChoreo } from './db.js';
import { h, fmt, fmtRecDate, fmtDuration, relDate, parseTime, debounce, inlineEdit, fitInput, classTitle, classMeta, PALETTE, textOn } from './util.js';
import { analyzeBeat } from './beat.js';
import { songPicker, songKeyOf } from './song.js';
import { alignToSong, checkAudio } from './align.js';
import { recTitle } from './hub.js';
import { go, toast } from './app.js';

const MARKER_TYPES = {
  start: { label: 'START', color: 'var(--fg)', key: 'S' },
  end: { label: 'ENDE', color: 'var(--fg)', key: 'E' },
  memo: { label: 'GEDANKE', color: 'var(--c4)', key: 'N' },
  highlight: { label: 'HIGHLIGHT', color: 'var(--c1)', key: 'H' },
};

// Darstellung des Counts gilt für alle Aufnahmen (Ansichtssache, nicht Aufnahme-Eigenschaft)
const COUNT_DEFAULT = { size: 'm', pos: 'tr', plus: false, show: true };
function loadCountView() {
  try { return { ...COUNT_DEFAULT, ...JSON.parse(localStorage.getItem('ct-count')) }; } catch { return { ...COUNT_DEFAULT }; }
}
function saveCountView(c) {
  try { localStorage.setItem('ct-count', JSON.stringify(c)); } catch { /* egal */ }
}

const RATING_HINT = ['', 'noch gar nicht', 'Bruchstücke', 'mit Video', 'fast frei', 'sitzt'];

export async function renderTrain(root, recId) {
  const rec = await db.get('recordings', recId);
  if (!rec) { go('#/'); return; }
  const choreo = await db.get('choreos', rec.choreoId);
  const cls = await db.get('classes', choreo.classId);
  const recs = (await db.byIndex('recordings', 'choreoId', choreo.id)).sort((a, b) => a.recordedAt - b.recordedAt);
  const sessions = await db.byIndex('sessions', 'choreoId', choreo.id);
  const blob = await db.get('videos', recId);
  if (!blob) { root.append(h('p.empty', 'Das Video zu dieser Aufnahme fehlt im Speicher dieses Browsers.')); return; }
  const songKey = `song:${choreo.id}`; // Songdatei gehört zur Choreo, gilt für alle Aufnahmen
  let songBlob = (await db.get('videos', songKey)) || null;

  const url = URL.createObjectURL(blob);
  const color = cls?.color || PALETTE[3];
  const song = choreo.song;
  rec.markers ||= [];
  const P = Object.assign({
    mirror: false, rate: 1, volume: 1, muted: false, brightness: 100, contrast: 100,
    countOn: false, click: false, bpm: null, anchor: 0, loopIn: null, loopOut: null, loopOn: false,
    audio: 'video', // 'song': Video stumm, Songdatei läuft an der passenden Stelle mit
  }, rec.player);

  // nach dem Löschen nichts mehr zurückschreiben, sonst taucht die Aufnahme wieder auf
  let deleted = false;
  const saveRec = debounce(() => { if (!deleted) db.put('recordings', rec); }, 400);
  const persist = () => { rec.player = { ...P }; saveRec(); };

  let lastK = null;

  // ── Video ──
  const video = h('video', { src: url, playsinline: true, preload: 'auto' });
  video.preservesPitch = true; // Tempo ändern ohne Tonhöhe zu verschieben
  const C = loadCountView();
  const countNum = h('span', '');
  const countPlus = h('span.plus.off', '+');
  const countBig = h('b', countNum, countPlus);
  const countEight = h('div.eight', Array.from({ length: 8 }, () => h('i')));
  const countBox = h('div.count', countBig, countEight);
  const status = h('div.status', '');
  const stage = h('div.stage', video, countBox, status);
  video.addEventListener('click', () => togglePlay());
  const dur = () => (isFinite(video.duration) && video.duration) || rec.duration || 0;

  // ── Songdatei synchron zum Video ──
  // Position im Song = Startpunkt + Videozeit. Tempo, Lautstärke und Sprünge folgen dem Video.
  const songAudio = new Audio();
  songAudio.preload = 'auto';
  songAudio.preservesPitch = true;
  let songUrl = null;
  function loadSongAudio() {
    if (songUrl) URL.revokeObjectURL(songUrl);
    songUrl = songBlob ? URL.createObjectURL(songBlob) : null;
    if (songUrl) songAudio.src = songUrl; else songAudio.removeAttribute('src');
  }
  loadSongAudio();
  songAudio.addEventListener('loadedmetadata', () => {
    // Manuell eingetragener Song ohne Länge: Länge aus der Datei übernehmen (für die Song-Zeitleiste)
    if (song && !song.duration && isFinite(songAudio.duration)) {
      song.duration = songAudio.duration;
      db.put('choreos', choreo);
      renderStatic();
    }
  });
  const songMode = () => P.audio === 'song' && !!songBlob && rec.songOffset != null;
  function syncSong(force = false) {
    if (!songMode()) { if (!songAudio.paused) songAudio.pause(); return; }
    songAudio.volume = P.volume;
    songAudio.muted = P.muted;
    const target = rec.songOffset + video.currentTime;
    const outside = target < 0 || (isFinite(songAudio.duration) && target >= songAudio.duration);
    if (outside || video.paused) { if (!songAudio.paused) songAudio.pause(); if (!outside && force) songAudio.currentTime = target; return; }
    // Kleine Abweichungen weich ausgleichen: Song minimal schneller/langsamer (max. ±6 %, Tonhöhe
    // bleibt). Springen nur bei großen Abständen, denn nach jedem Sprung hängt Audio ~50 ms hinterher.
    const err = target - songAudio.currentTime; // > 0: Song hinkt hinterher
    if (force || Math.abs(err) > 0.25) {
      songAudio.currentTime = target;
      songAudio.playbackRate = P.rate;
    } else {
      const nudge = Math.abs(err) < 0.008 ? 0 : Math.max(-0.06, Math.min(0.06, err * 0.8));
      songAudio.playbackRate = P.rate * (1 + nudge);
    }
    if (songAudio.paused) songAudio.play().catch(() => {});
  }
  for (const ev of ['play', 'seeked', 'ratechange']) video.addEventListener(ev, () => syncSong(true));
  video.addEventListener('pause', () => songAudio.pause());

  function applyVideo() {
    video.playbackRate = P.rate;
    video.volume = P.volume;
    video.muted = P.muted || songMode(); // im Song-Modus ist der Videoton aus
    video.classList.toggle('mirror', P.mirror);
    // Filter nur bei echter Änderung: ein Filter auf <video> lässt Chrome am Mac flackern
    video.style.filter = P.brightness !== 100 || P.contrast !== 100 ? `brightness(${P.brightness}%) contrast(${P.contrast}%)` : '';
    countBox.hidden = !(P.countOn && P.bpm && C.show);
    for (const k of ['s', 'm', 'l', 'xl']) countBox.classList.toggle(`size-${k}`, C.size === k);
    for (const k of ['tl', 'tr', 'bl', 'br', 'c']) countBox.classList.toggle(`pos-${k}`, C.pos === k);
    countPlus.hidden = !C.plus;
    lastK = null;
  }

  // ── Zeitleisten ──
  const vTrack = h('div.track');
  const vFill = h('div.fill'), vPh = h('div.ph'), vStatic = h('div');
  vTrack.append(vStatic, vFill, vPh);
  const vTime = h('span.time', '0:00.0');
  const sTrack = h('div.track');
  const sPh = h('div.ph'), sStatic = h('div');
  sTrack.append(sStatic, sPh);
  const sTime = h('span.time', '');
  const songRow = h('div.tl-row', h('span.label', 'Song'), sTrack, sTime);
  // 8er-Zeile: jede Acht ein Feld. Klick = diese Acht loopen, Ziehen oder ⇧-Klick = mehrere,
  // Klick auf die aktive Auswahl = Loop aus.
  const eTrack = h('div.track.eights');
  const eInfo = h('span.time', '');
  const eightRow = h('div.tl-row', h('span.label', '8er'), eTrack, eInfo);
  const timeline = h('div.timeline', h('div.tl-row', h('span.label', 'Video'), vTrack, vTime), eightRow, songRow);

  scrub(vTrack, r => { video.currentTime = r * dur(); });
  scrub(sTrack, r => {
    if (rec.songOffset == null || !song?.duration) return;
    const t = r * song.duration - rec.songOffset;
    if (t >= 0 && t <= dur()) video.currentTime = t;
  });

  const markerTime = type => rec.markers.find(m => m.type === type)?.t ?? null;

  // ── Achten ──
  // Liste der Achten im Video: [{ i, a, b }] (a/b in Sekunden, auf die Videolänge beschnitten)
  function eights() {
    if (!P.bpm) return [];
    const E = (8 * 60) / P.bpm, d = dur();
    if (!d || E < 1) return [];
    const out = [];
    // Ein angeschnittenes Stück vor der ersten „1“ ist Auftakt und bekommt keine Nummer
    for (let n = Math.floor(-P.anchor / E), i = 1; P.anchor + n * E < d; n++) {
      const a = Math.max(0, P.anchor + n * E), b = Math.min(d, P.anchor + (n + 1) * E);
      if (b - a <= 0.15) continue;
      const pickup = P.anchor + n * E < 0;
      out.push({ i: pickup ? null : i++, a, b });
    }
    return out;
  }
  let eSel = null; // { from, to } Indizes während des Ziehens
  function renderEights() {
    const list = eights();
    eightRow.hidden = !list.length;
    if (!list.length) return;
    const d = dur();
    const { a: la, b: lb } = loopRange();
    const looped = P.loopOn && (P.loopIn != null || P.loopOut != null);
    const lo = eSel ? Math.min(eSel.from, eSel.to) : null, hi = eSel ? Math.max(eSel.from, eSel.to) : null;
    eTrack.replaceChildren(...list.map((x, k) => {
      const inLoop = looped && x.a >= la - 0.05 && x.b <= lb + 0.05;
      const picking = eSel && k >= lo && k <= hi;
      return h(`div.cell${inLoop ? '.sel' : ''}${picking ? '.pick' : ''}`, {
        'data-k': k,
        style: { left: `${(x.a / d) * 100}%`, width: `${((x.b - x.a) / d) * 100}%` },
        title: `${x.i ? `Acht ${x.i}` : 'Auftakt'} · ${fmt(x.a, true)}–${fmt(x.b, true)}`,
      }, x.i && (x.b - x.a) / d > 0.035 ? String(x.i) : '');
    }));
    const selCells = list.filter(x => looped && x.a >= la - 0.05 && x.b <= lb + 0.05);
    const lbl = x => x.i ?? 'Auftakt';
    eInfo.textContent = selCells.length ? (selCells.length === 1 ? (selCells[0].i ? `Acht ${selCells[0].i}` : 'Auftakt') : `Achten ${lbl(selCells[0])}–${lbl(selCells.at(-1))}`) : '';
  }
  const cellAt = e => {
    const el = document.elementFromPoint(e.clientX, eTrack.getBoundingClientRect().top + 4);
    return el?.closest?.('.cell') ? Number(el.closest('.cell').dataset.k) : null;
  };
  let eAnchor = null;
  eTrack.addEventListener('pointerdown', e => {
    const k = cellAt(e);
    if (k == null || e.button !== 0) return;
    eTrack.setPointerCapture?.(e.pointerId);
    const from = e.shiftKey && eAnchor != null ? eAnchor : k;
    eSel = { from, to: k };
    renderEights();
  });
  eTrack.addEventListener('pointermove', e => {
    if (!eSel) return;
    if (!(e.buttons & 1)) { eSel = null; renderEights(); return; }
    const k = cellAt(e);
    if (k != null && k !== eSel.to) { eSel.to = k; renderEights(); }
  });
  eTrack.addEventListener('pointerup', () => {
    if (!eSel) return;
    const list = eights();
    const lo = Math.min(eSel.from, eSel.to), hi = Math.max(eSel.from, eSel.to);
    eSel = null;
    if (!list[lo] || !list[hi]) { renderEights(); return; }
    const a = list[lo].a, b = list[hi].b;
    const same = P.loopOn && P.loopIn != null && Math.abs(P.loopIn - a) < 0.05 && Math.abs(P.loopOut - b) < 0.05;
    if (same) { P.loopIn = P.loopOut = null; P.loopOn = false; } // erneuter Klick = Loop aus
    else { P.loopIn = a; P.loopOut = b; P.loopOn = true; video.currentTime = a; eAnchor = lo; }
    update();
  });
  eTrack.addEventListener('pointercancel', () => { eSel = null; renderEights(); });
  const loopRange = () => ({
    a: P.loopIn ?? markerTime('start') ?? 0,
    b: P.loopOut ?? markerTime('end') ?? dur(),
  });

  function renderStatic() {
    const d = dur() || 1;
    const pct = t => `${(t / d) * 100}%`;
    const { a, b } = loopRange();
    const parts = [];
    if (P.loopIn != null || P.loopOut != null || P.loopOn) {
      parts.push(h(`div.loop${P.loopOn ? '.on' : ''}`, { style: { left: pct(a), width: `${((b - a) / d) * 100}%` } }));
    }
    if (P.countOn && P.bpm) {
      const eight = (8 * 60) / P.bpm;
      for (let n = Math.ceil(-P.anchor / eight), t; (t = P.anchor + n * eight) <= d; n++) parts.push(h('div.grid1', { style: { left: pct(t) } }));
    }
    for (const m of rec.markers) parts.push(h(`div.mk.${m.type}`, { style: { left: pct(m.t) }, title: `${MARKER_TYPES[m.type].label} ${fmt(m.t, true)} ${m.text || ''}` }));
    vStatic.replaceChildren(...parts);
    renderEights();

    // Song-Zeitleiste
    songRow.hidden = !song;
    if (!song) return;
    if (rec.songOffset == null || !song.duration) {
      sStatic.replaceChildren();
      sPh.hidden = true;
      sTime.textContent = '';
      sTrack.title = 'Startpunkt im Song rechts unter SONG eintragen';
      return;
    }
    sPh.hidden = false;
    const sd = song.duration;
    const sp = t => `${(t / sd) * 100}%`;
    const sParts = [h('div.seg', { style: { left: sp(rec.songOffset), width: `${(d / sd) * 100}%` } })];
    for (const m of rec.markers.filter(m => m.type === 'start' || m.type === 'end')) {
      sParts.push(h(`div.mk.${m.type}`, { style: { left: sp(rec.songOffset + m.t) } }));
    }
    sStatic.replaceChildren(...sParts);
    sTrack.title = `Video läuft im Song von ${fmt(rec.songOffset)} bis ${fmt(rec.songOffset + d)}`;
  }

  // ── Bedienleiste ──
  const ctl = (label, attrs = {}) => h('button.ctl', { type: 'button', ...attrs }, label);
  // Feste Breite für Schalter mit wechselndem Text (Mono-Schrift: Zeichen × Laufweite), damit nichts springt
  const fixed = (el, chars) => { el.classList.add('fixed'); el.style.width = `calc(${chars}ch + ${chars * 0.08}em + 20px)`; return el; };
  const bPlay = ctl('▶', { class: 'ctl play fixed', title: 'Play/Pause (Leertaste)', onclick: () => togglePlay() });
  const bMirror = ctl('Spiegeln', { title: 'Spiegeln (M)', onclick: () => { P.mirror = !P.mirror; update(); } });
  const bRate = fixed(ctl('', { title: 'Tempo ([ / ])', onclick: e => popover(e.currentTarget, ratePop) }), 5);
  const bVol = fixed(ctl('', { title: 'Lautstärke', onclick: e => popover(e.currentTarget, volPop) }), 7);
  const bImg = ctl('Bild', { title: 'Helligkeit/Kontrast', onclick: e => popover(e.currentTarget, imgPop) });
  const bIn = ctl('In', { title: 'Loop-Anfang setzen (I)', onclick: () => setIn() });
  const bOut = ctl('Out', { title: 'Loop-Ende setzen (O)', onclick: () => setOut() });
  const bLoop = ctl('Loop', { title: 'Loop an/aus (L)', onclick: () => { P.loopOn = !P.loopOn; update(); } });
  const bClear = ctl('×', { title: 'In/Out löschen', onclick: () => { P.loopIn = P.loopOut = null; P.loopOn = false; update(); } });
  const bCount = ctl('8er', { title: '8er-Count an/aus (C)', onclick: () => { P.countOn = !P.countOn; update(); } });
  const bBpm = fixed(ctl('', { title: 'Takt einstellen', onclick: e => popover(e.currentTarget, countPop) }), 9);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
  };
  const bFull = ctl('Vollbild', { title: 'Vollbild (F)', onclick: toggleFull });
  stage.addEventListener('dblclick', toggleFull);
  const bMark = ctl('+ Marker', { title: 'Marker setzen', onclick: e => popover(e.currentTarget, markPop) });
  const toggleAudio = () => {
    if (!songBlob) { toast('Erst unter SONG eine Songdatei laden'); return; }
    if (P.audio !== 'song' && rec.songOffset == null) { toast('Erst den Startpunkt im Song setzen (Startpunkt erkennen)'); return; }
    P.audio = P.audio === 'song' ? 'video' : 'song';
    update();
    syncSong(true);
  };
  const bAudio = fixed(ctl('', { title: 'Ton: Video oder Song (A)', onclick: toggleAudio }), 10);
  const timeView = h('span.timeview', '');
  const controls = h('div.controls', { style: { position: 'relative' } },
    bPlay, h('span.ctl-sep'), bMirror, bRate, bVol, bImg, h('span.ctl-sep'), bIn, bOut, bLoop, bClear,
    h('span.ctl-sep'), bCount, bBpm, h('span.ctl-sep'), bAudio, bMark, bFull, timeView);

  function update() {
    applyVideo();
    bMirror.classList.toggle('on', P.mirror);
    bRate.textContent = `${P.rate.toFixed(2)}×`;
    bRate.classList.toggle('on', P.rate !== 1);
    bVol.textContent = P.muted ? 'Stumm' : `Vol ${Math.round(P.volume * 100)}`;
    bImg.classList.toggle('on', P.brightness !== 100 || P.contrast !== 100);
    bIn.classList.toggle('on', P.loopIn != null);
    bOut.classList.toggle('on', P.loopOut != null);
    bLoop.classList.toggle('on', P.loopOn);
    bClear.hidden = P.loopIn == null && P.loopOut == null;
    bCount.classList.toggle('on', P.countOn);
    bBpm.textContent = P.bpm ? `${Math.round(P.bpm * 10) / 10} BPM` : 'BPM ?';
    bAudio.hidden = !songBlob;
    bAudio.textContent = songMode() ? 'Ton: Song' : 'Ton: Video';
    bAudio.classList.toggle('on', songMode());
    renderStatic();
    persist();
  }

  // ── Popover ──
  let pop = null;
  function closePop() { pop?.remove(); pop = null; }
  const refreshPop = () => pop?.rebuild();
  function popover(btn, build) {
    if (pop && pop.dataset.for === btn.textContent) { closePop(); return; }
    closePop();
    pop = h('div.pop', build());
    pop.dataset.for = btn.textContent;
    pop.rebuild = () => pop.replaceChildren(...build().flat());
    controls.append(pop);
    pop.style.bottom = `${controls.clientHeight - btn.offsetTop + 6}px`;
    pop.style.left = `${Math.max(0, Math.min(btn.offsetLeft, controls.clientWidth - pop.offsetWidth))}px`;
  }
  const onDocClick = e => { if (pop && !pop.contains(e.target) && !controls.contains(e.target)) closePop(); };
  document.addEventListener('pointerdown', onDocClick);

  const slider = (label, min, max, step, get, set, fmtV) => {
    const val = h('span', fmtV(get()));
    const input = h('input', { type: 'range', min, max, step, value: get() });
    input.addEventListener('input', () => { set(Number(input.value)); val.textContent = fmtV(get()); update(); });
    return [h('div.prow', h('span', label), val), input];
  };
  const small = (label, onclick, on) => h(`button.btn.small${on ? '.primary' : ''}`, { type: 'button', onclick }, label);

  const ratePop = () => [
    ...slider('Tempo', 0.25, 1.5, 0.05, () => P.rate, v => { P.rate = v; }, v => `${v.toFixed(2)}×`),
    h('div.btns', [0.5, 0.75, 0.9, 1].map(v => small(`${v}×`, () => { P.rate = v; update(); closePop(); }))),
    h('div.note', 'Tonhöhe bleibt gleich.'),
  ];
  const volPop = () => [
    ...slider('Lautstärke', 0, 1, 0.05, () => P.volume, v => { P.volume = v; P.muted = false; }, v => `${Math.round(v * 100)}`),
    h('div.btns', small(P.muted ? 'Ton an' : 'Stumm', () => { P.muted = !P.muted; update(); closePop(); })),
  ];
  const imgPop = () => [
    ...slider('Helligkeit', 50, 200, 5, () => P.brightness, v => { P.brightness = v; }, v => `${v}%`),
    ...slider('Kontrast', 50, 200, 5, () => P.contrast, v => { P.contrast = v; }, v => `${v}%`),
    h('div.btns', small('Zurücksetzen', () => { P.brightness = P.contrast = 100; update(); closePop(); })),
  ];
  const markPop = () => [
    h('div.btns', Object.entries(MARKER_TYPES).map(([type, m]) => small(`${m.label} (${m.key})`, () => { addMarker(type); closePop(); }))),
    h('div.note', 'Setzt den Marker an der aktuellen Position. Start/Ende gibt es je einmal und begrenzen den Loop, solange kein In/Out gesetzt ist.'),
  ];
  const countPop = () => {
    const bpmIn = h('input.bpm-input', { type: 'number', step: '0.1', min: '40', max: '240', value: P.bpm ? Math.round(P.bpm * 10) / 10 : '' });
    bpmIn.addEventListener('change', () => { const v = Number(bpmIn.value); if (v >= 40 && v <= 240) { P.bpm = v; P.manualBeat = true; update(); } });
    return [
      h('div.prow', h('span', 'Tempo (BPM)'), bpmIn),
      h('div.btns',
        small('÷2', () => { if (P.bpm) { P.bpm /= 2; P.manualBeat = true; update(); bpmIn.value = Math.round(P.bpm * 10) / 10; } }),
        small('×2', () => { if (P.bpm) { P.bpm *= 2; P.manualBeat = true; update(); bpmIn.value = Math.round(P.bpm * 10) / 10; } }),
        small('−10 ms', () => { P.anchor -= 0.01; P.manualBeat = true; update(); }),
        small('+10 ms', () => { P.anchor += 0.01; P.manualBeat = true; update(); })),
      h('div.btns',
        small('Hier ist die 1 (1)', () => setOne()),
        small('Tap (T)', () => tap())),
      h('div.btns',
        small(P.click ? 'Klick an' : 'Klick aus', () => { P.click = !P.click; update(); refreshPop(); }, P.click),
        small('Neu analysieren', () => { closePop(); P.manualBeat = false; runAnalysis(true); })),
      h('div.prow', h('span', 'Anzeige')),
      h('div.btns', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']].map(([k, l]) =>
        small(l, () => { C.size = k; saveCountView(C); update(); refreshPop(); }, C.size === k))),
      h('div.btns', [['tl', '↖'], ['tr', '↗'], ['c', '·'], ['bl', '↙'], ['br', '↘']].map(([k, l]) =>
        small(l, () => { C.pos = k; saveCountView(C); update(); refreshPop(); }, C.pos === k))),
      h('div.btns',
        small(C.plus ? 'Halbe „+“ an' : 'Halbe „+“ aus', () => { C.plus = !C.plus; saveCountView(C); update(); refreshPop(); }, C.plus),
        small(C.show ? 'Zähler sichtbar' : 'Zähler ausgeblendet', () => { C.show = !C.show; saveCountView(C); update(); refreshPop(); }, C.show)),
      h('div.note', 'Ausgeblendet zählt der Count weiter (z. B. nur mit Klick).'),
      h('div.note', 'Zählt nicht richtig? Bei der „1“ einer Acht pausieren und „Hier ist die 1“ drücken. Oder ab einer „1“ mindestens viermal im Takt T tippen.',
        song?.bpm ? ` Deezer kennt ${Math.round(song.bpm)} BPM für das Original.` : ''),
    ];
  };

  // ── Aktionen ──
  function togglePlay() {
    if (video.paused) { ensureAudio(); video.play(); } else video.pause();
  }
  function setIn() {
    P.loopIn = video.currentTime;
    if (P.loopOut != null && P.loopOut <= P.loopIn) P.loopOut = null;
    update();
  }
  function setOut() {
    P.loopOut = video.currentTime;
    if (P.loopIn != null && P.loopIn >= P.loopOut) P.loopIn = null;
    P.loopOn = true;
    video.currentTime = loopRange().a;
    update();
  }
  function setOne() {
    if (!P.bpm) { toast('Erst Tempo setzen (Tap oder BPM)'); return; }
    const beat = 60 / P.bpm;
    // Beat-Raster behalten, die nächstgelegene Zählzeit wird zur „1“
    const k = Math.round((video.currentTime - P.anchor) / beat);
    P.anchor += k * beat;
    P.manualBeat = true;
    P.countOn = true;
    update();
    toast('„1“ gesetzt');
  }
  let taps = [];
  function tap() {
    const t = video.currentTime;
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1].wall > 2500) taps = [];
    taps.push({ t, wall: now });
    if (taps.length >= 4) {
      const iv = [];
      for (let i = 1; i < taps.length; i++) iv.push(taps[i].t - taps[i - 1].t);
      iv.sort((a, b) => a - b);
      const med = iv[Math.floor(iv.length / 2)];
      if (med > 0.2 && med < 1.5) {
        P.bpm = 60 / med;
        P.anchor = taps[0].t;
        P.manualBeat = true;
        P.countOn = true;
        update();
        status.textContent = `TAP ${taps.length} · ${Math.round(P.bpm)} BPM`;
      }
    } else {
      status.textContent = `TAP ${taps.length}/4`;
    }
    clearTimeout(tap.timer);
    tap.timer = setTimeout(() => { status.textContent = ''; }, 2500);
  }
  function addMarker(type) {
    const t = video.currentTime;
    if (type === 'start' || type === 'end') rec.markers = rec.markers.filter(m => m.type !== type);
    const m = { id: uid(), t, type, text: '' };
    rec.markers.push(m);
    rec.markers.sort((a, b) => a.t - b.t);
    update();
    // Gedankenstützen direkt benennen
    if (type === 'memo') { menuFor = m.id; renaming = true; } else { menuFor = null; }
    renderMarkers();
  }

  // ── Klick-Sound ──
  let ac = null;
  function ensureAudio() {
    if (!ac) try { ac = new AudioContext(); } catch { /* ohne Klick */ }
    if (ac?.state === 'suspended') ac.resume();
  }
  function click(accent, soft = false) {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.frequency.value = accent ? 1760 : soft ? 800 : 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((soft ? 0.1 : 0.3) * (P.muted ? 1 : Math.max(P.volume, 0.3)), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.08);
  }

  // ── Beat-Analyse ──
  async function runAnalysis(force) {
    status.textContent = 'ANALYSIERE TAKT …';
    try {
      const r = await analyzeBeat(blob, song?.bpm);
      P.bpm = r.bpm;
      P.anchor = r.anchor;
      choreo.bpm = r.bpm;
      db.put('choreos', choreo);
      status.textContent = `${Math.round(r.bpm)} BPM ERKANNT · „1“ PRÜFEN`;
      if (force) P.countOn = true;
    } catch (e) {
      console.warn(e);
      if (!P.bpm && song?.bpm) { P.bpm = song.bpm; P.anchor = 0; }
      status.textContent = 'TAKT NICHT ERKANNT · TAPPEN (T)';
    }
    rec.beatTried = true;
    update();
    setTimeout(() => { status.textContent = ''; }, 4000);
  }

  // ── Session-Zeit ──
  let session = null;
  async function saveSession() {
    if (deleted || !session || session.seconds < 5) return;
    await db.put('sessions', { ...session, seconds: Math.round(session.seconds) });
    choreo.lastPracticed = Date.now();
    await db.put('choreos', choreo);
    statLine.textContent = statText();
  }
  const sessionTimer = setInterval(saveSession, 10000);
  const onHide = () => { if (document.hidden) saveSession(); };
  document.addEventListener('visibilitychange', onHide);

  // ── Render-Schleife ──
  let raf, lastTick = performance.now(), lastT = 0;
  const eightBars = [...countEight.children];
  function loop() {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const t = video.currentTime;
    const d = dur() || 1;

    if (!video.paused && dt < 1) {
      session ||= { id: uid(), choreoId: choreo.id, recordingId: rec.id, start: Date.now(), seconds: 0 };
      session.seconds += dt;
    }

    if (P.loopOn && !video.paused) {
      const { a, b } = loopRange();
      if (b - a > 0.2 && t >= b) video.currentTime = a;
    }

    vFill.style.width = vPh.style.left = `${(t / d) * 100}%`;
    setText(vTime, fmt(t, true));
    setText(timeView, `${fmt(t, true)} / ${fmt(d, true)}`);
    setText(bPlay, video.paused ? '▶' : '❚❚');
    if (songMode() && !video.paused) syncSong();
    if (song?.duration && rec.songOffset != null) {
      const st = rec.songOffset + t;
      sPh.style.left = `${(st / song.duration) * 100}%`;
      setText(sTime, `${fmt(st)} / ${fmt(song.duration)}`);
    }

    if (P.countOn && P.bpm) {
      // in Halbschlägen zählen: gerade = Zählzeit, ungerade = „+“
      const k = Math.floor(((t - P.anchor) * P.bpm * 2) / 60 + 0.12);
      const beat = Math.floor(k / 2);
      const half = ((k % 2) + 2) % 2 === 1;
      const n = (((beat % 8) + 8) % 8) + 1;
      if (k !== lastK) {
        countNum.textContent = n;
        countPlus.classList.toggle('off', !half);
        countBox.classList.toggle('one', n === 1 && !half);
        eightBars.forEach((el, i) => el.classList.toggle('on', i < n));
        if (P.click && !video.paused && lastK != null && k - lastK === 1 && Math.abs(t - lastT) < 0.5) {
          if (!half) click(n === 1);
          else if (C.plus) click(false, true);
        }
        lastK = k;
      }
    }
    lastT = t;
  }

  // ── Tastatur ──
  function onKey(e) {
    if (e.key === 'Escape') { closePop(); document.activeElement?.blur(); return; }
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': () => togglePlay(),
      arrowleft: () => { video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 0.2 : 2)); },
      arrowright: () => { video.currentTime = Math.min(dur(), video.currentTime + (e.shiftKey ? 0.2 : 2)); },
      m: () => { P.mirror = !P.mirror; update(); },
      '[': () => { P.rate = Math.max(0.25, Math.round((P.rate - 0.05) * 100) / 100); update(); },
      ']': () => { P.rate = Math.min(1.5, Math.round((P.rate + 0.05) * 100) / 100); update(); },
      i: () => setIn(),
      o: () => setOut(),
      l: () => { P.loopOn = !P.loopOn; update(); },
      c: () => { P.countOn = !P.countOn; update(); },
      t: () => tap(),
      1: () => setOne(),
      s: () => addMarker('start'),
      e: () => addMarker('end'),
      n: () => addMarker('memo'),
      h: () => addMarker('highlight'),
      a: () => toggleAudio(),
      f: () => toggleFull(),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  }
  document.addEventListener('keydown', onKey);

  // ── Seitenleiste ──
  const ratingBox = h('div.rating');
  const ratingHint = h('div.label', { style: { marginTop: '6px' } });
  function renderRating() {
    const cur = choreo.ratings?.length ? choreo.ratings[choreo.ratings.length - 1].value : null;
    ratingBox.replaceChildren(...[1, 2, 3, 4, 5].map(v => h(`button${v === cur ? '.on' : ''}`, {
      type: 'button', title: RATING_HINT[v],
      onclick: async () => {
        choreo.ratings ||= [];
        const today = new Date().toDateString();
        const last = choreo.ratings[choreo.ratings.length - 1];
        if (last && new Date(last.ts).toDateString() === today) Object.assign(last, { value: v, ts: Date.now() });
        else choreo.ratings.push({ ts: Date.now(), value: v });
        await db.put('choreos', choreo);
        renderRating();
      },
    }, v)));
    ratingHint.textContent = cur ? `${cur}/5 · ${RATING_HINT[cur]}` : '1 = noch gar nicht · 5 = sitzt';
  }

  // Klick auf einen Marker öffnet ein kleines Menü: Umbenennen · Hierhin · Löschen
  const markerList = h('ul.markers');
  let menuFor = null, renaming = false;
  function renderMarkers() {
    markerList.replaceChildren(...(rec.markers.length ? rec.markers.map(m => {
      // Der Marker trägt seinen Namen selbst; ohne Namen steht dort der Typ
      const kind = h('span.kind', { style: { background: MARKER_TYPES[m.type].color, color: m.type === 'start' || m.type === 'end' ? 'var(--bg)' : '#000' } });
      const editing = menuFor === m.id && renaming;
      const nameEl = editing ? h('div.name', kind) : h('button.name', { type: 'button', title: 'Marker bearbeiten', onclick: () => { menuFor = menuFor === m.id ? null : m.id; renaming = false; renderMarkers(); } }, kind);
      const li = h('li',
        h('button.t', { type: 'button', title: 'Hierhin springen', onclick: () => { video.currentTime = m.t; } }, fmt(m.t, true)),
        nameEl);
      if (editing) {
        const input = h('input', { type: 'text', value: m.text || MARKER_TYPES[m.type].label, placeholder: MARKER_TYPES[m.type].label });
        fitInput(input);
        const commit = () => {
          const v = input.value.trim();
          m.text = v && v.toUpperCase() !== MARKER_TYPES[m.type].label ? v : '';
          saveRec(); menuFor = null; renaming = false; renderMarkers(); renderStatic();
        };
        input.addEventListener('keydown', e => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { menuFor = null; renaming = false; renderMarkers(); }
        });
        input.addEventListener('blur', () => { if (menuFor === m.id && renaming) commit(); });
        kind.append(input);
        requestAnimationFrame(() => { input.focus(); input.select(); });
      } else {
        kind.textContent = m.text || MARKER_TYPES[m.type].label;
      }
      if (menuFor === m.id && !renaming) {
        li.append(h('div.menu',
          small('Umbenennen', () => { renaming = true; renderMarkers(); }),
          small('Hierhin', () => { video.currentTime = m.t; menuFor = null; renderMarkers(); }),
          small('Auf jetzt setzen', () => { m.t = video.currentTime; rec.markers.sort((a, b) => a.t - b.t); menuFor = null; update(); renderMarkers(); }),
          small('Löschen', () => { rec.markers = rec.markers.filter(x => x !== m); menuFor = null; update(); renderMarkers(); })));
      }
      return li;
    }) : [h('li.muted', { style: { display: 'block' } }, 'Noch keine Marker. Taste S/E/N/H oder „+ Marker“.')]));
  }

  const notesIn = h('textarea', { placeholder: 'Outfit, Gedankenstützen, Anmerkungen vom Coach …' }, rec.notes || '');
  notesIn.addEventListener('input', () => { rec.notes = notesIn.value; saveRec(); });

  const offsetIn = h('input', { type: 'text', placeholder: '0:00', value: rec.songOffset != null ? fmt(rec.songOffset, true) : '' });
  offsetIn.addEventListener('change', () => { rec.songOffset = parseTime(offsetIn.value); update(); });
  const picker = songPicker({
    song,
    getBlob: () => blob,
    onChange: async (s, offset) => {
      // neuer Song → Titel folgt wieder dem Songtitel
      Object.assign(choreo, { song: s, songKey: songKeyOf(s), title: null });
      await db.put('choreos', choreo);
      if (offset != null) rec.songOffset = offset;
      // Takt mit der Song-BPM als Hilfe neu schätzen, solange er nicht von Hand korrigiert wurde
      if (s.bpm && !P.manualBeat && Math.round(s.bpm) !== Math.round(P.bpm || 0)) { rec.beatTried = false; P.bpm = null; }
      rec.player = { ...P };
      await db.put('recordings', rec);
      go(location.hash); // neu aufbauen, damit Titel und Song-Zeitleiste stimmen
    },
    onOffset: offset => {
      rec.songOffset = offset;
      offsetIn.value = fmt(offset, true);
      update();
      syncSong(true);
    },
    align: prior => (songBlob ? alignToSong(blob, songBlob, { prior }) : null),
  });

  // Songdatei laden / entfernen
  const songFileIn = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.aac,.wav,.flac,.aiff', hidden: true });
  const songFileRow = h('div', { style: { marginTop: '12px' } });
  async function setSongFile(file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|flac|aiff?)$/i.test(file.name)) { toast('Bitte eine Audiodatei wählen'); return; }
    // Erst prüfen, ob wirklich Ton drin ist (z. B. als .mp3 gespeicherte Webseite nach Download-Fehler)
    songFileRow.querySelector('.label')?.replaceChildren('Prüfe Songdatei …');
    const problem = await checkAudio(file);
    if (problem) { toast(problem, 8000); renderSongFile(); return; }
    await db.put('videos', file, songKey);
    songBlob = file;
    loadSongAudio();
    renderSongFile();
    update();
    picker.detectStart(); // Startpunkt direkt per Abgleich bestimmen
  }
  function renderSongFile() {
    songFileRow.hidden = !song;
    songFileRow.replaceChildren(songFileIn, songBlob
      ? h('div.actions',
        h('span.label', `♪ ${songBlob.name || 'Songdatei'}`),
        h('button.linkbtn', { type: 'button', onclick: () => songFileIn.click() }, 'Ersetzen'),
        h('button.linkbtn', {
          type: 'button',
          onclick: async () => {
            if (!confirm('Songdatei aus dieser Choreo entfernen?')) return;
            await db.del('videos', songKey);
            songBlob = null;
            P.audio = 'video';
            loadSongAudio();
            renderSongFile();
            update();
          },
        }, 'Entfernen'))
      : h('div',
        h('button.btn.small', { type: 'button', onclick: () => songFileIn.click() }, 'Songdatei laden'),
        h('div.label', { style: { marginTop: '6px' } }, 'mp3, m4a, wav · zum Trainieren auf den Song und für einen exakten Startpunkt. Auch per Drag & Drop.')));
  }
  songFileIn.addEventListener('change', () => setSongFile(songFileIn.files[0]));
  renderSongFile();

  const statText = () => {
    const secs = sessions.reduce((a, s) => a + s.seconds, 0) + (session?.seconds || 0);
    return `Geübt ${fmtDuration(secs)} · zuletzt ${relDate(choreo.lastPracticed)}`;
  };
  const statLine = h('div.label', statText());

  const recIndex = recs.findIndex(r => r.id === rec.id);
  let songSection;
  const titleEdits = [];
  const titleEdit = () => {
    const el = inlineEdit(recTitle(rec, recIndex), async v => {
      rec.title = v;
      await db.put('recordings', rec);
      titleEdits.forEach(x => x.setText(v));
    });
    titleEdits.push(el);
    return el;
  };
  root.append(h('div.train', { style: { '--cc': `#${color}` } },
    h('div',
      h('div.crumbs',
        h('a.tag', { href: `#/class/${cls.id}`, style: { background: `#${color}`, color: textOn(color) } }, classTitle(cls).toUpperCase()),
        h('span.label', classMeta(cls)),
        h('span.label', titleEdit(), ` · ${recIndex + 1}/${recs.length} · ${fmtRecDate(rec.recordedAt)}`),
        h('h1.wide', inlineEdit((choreo.title || song?.title || 'Ohne Song').toUpperCase(), async v => { choreo.title = v; await db.put('choreos', choreo); }), song?.artist ? h('span.muted', { style: { fontWeight: 600 } }, ` — ${song.artist.toUpperCase()}`) : '')),
      stage, timeline, controls),
    h('aside.side',
      h('section', h('span.label', 'Wie sitzt sie?'), ratingBox, ratingHint, h('div', { style: { marginTop: '8px' } }, statLine)),
      h('section', h('span.label', 'Marker'), markerList),
      h('section', h('span.label', 'Notizen'), notesIn),
      songSection = h('section', h('span.label', 'Song'),
        picker.el,
        song ? h('label.field', { style: { marginTop: '10px' } }, h('span', 'Video beginnt im Song bei'), offsetIn) : null,
        songFileRow),
      h('section', h('span.label', 'Aufnahmen'),
        h('ul.recs', recs.map((r, i) => h('li',
          r.id === rec.id
            ? h('span', { style: { fontWeight: 600 } }, '▸ ', titleEdit())
            : h('a', { href: `#/train/${r.id}` }, recTitle(r, i)),
          h('span.muted', `${fmtRecDate(r.recordedAt)} · ${r.duration ? fmt(r.duration) : ''}`)))),
        h('div.actions', { style: { marginTop: '8px' } },
          h('a.linkbtn', { href: `#/upload?choreo=${choreo.id}` }, '+ Aufnahme hinzufügen'),
          h('button.linkbtn', {
            onclick: async () => {
              const last = recs.length === 1;
              if (!confirm(last
                ? 'Das ist die einzige Aufnahme. Aufnahme samt Video und damit die ganze Choreo löschen?'
                : `„${recTitle(rec, recIndex)}“ samt Video löschen?`)) return;
              deleted = true;
              video.pause();
              await deleteRecording(rec.id);
              if (last) await deleteChoreo(choreo.id);
              toast(last ? 'Choreo gelöscht' : 'Aufnahme gelöscht');
              const next = recs.find(r => r.id !== rec.id);
              go(next ? `#/train/${next.id}` : `#/class/${cls.id}`, { replace: true });
            },
          }, 'Aufnahme löschen'))),
      h('section', h('span.label', 'Tasten'),
        h('div.keys', [
          ['␣', 'Play/Pause'], ['← →', '±2 s (⇧ ±0,2)'], ['M', 'Spiegeln'], ['[ ]', 'Tempo'],
          ['I / O', 'Loop In/Out'], ['L', 'Loop'], ['C', '8er-Count'], ['T', 'Tap-Tempo'],
          ['1', 'Hier ist die 1'], ['S / E', 'Start/Ende'], ['N', 'Gedanke'], ['H', 'Highlight'], ['F', 'Vollbild'], ['A', 'Ton Video/Song'],
        ].map(([k, d]) => h('div', h('kbd', k), ' ', d))))),
  ));

  video.addEventListener('loadedmetadata', () => {
    if (!rec.duration && video.duration) rec.duration = video.duration;
    // Querformat füllt die Breite, Hochformat wird in der Höhe begrenzt
    stage.classList.toggle('portrait', video.videoHeight > video.videoWidth);
    renderStatic();
  });
  // Songdatei per Drag & Drop auf den Song-Bereich
  songSection.addEventListener('dragover', e => { if (song) e.preventDefault(); });
  songSection.addEventListener('drop', e => { if (!song) return; e.preventDefault(); setSongFile(e.dataTransfer.files[0]); });
  update();
  renderRating();
  renderMarkers();
  raf = requestAnimationFrame(loop);
  if (!P.bpm && !rec.beatTried) setTimeout(() => runAnalysis(false), 300);

  return async () => {
    cancelAnimationFrame(raf);
    clearInterval(sessionTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDocClick);
    document.removeEventListener('visibilitychange', onHide);
    video.pause();
    songAudio.pause();
    await saveSession();
    if (!deleted) {
      rec.player = { ...P };
      await db.put('recordings', rec);
    }
    URL.revokeObjectURL(url);
    if (songUrl) URL.revokeObjectURL(songUrl);
    ac?.close();
  };
}

// Nur schreiben, wenn sich der Text ändert (sonst Neuzeichnen in jedem Frame)
function setText(el, v) {
  if (el.textContent !== v) el.textContent = v;
}

// Klick/Ziehen auf einer Zeitleiste → Position 0..1
// Springen nur bei Klick oder Ziehen mit gedrückter Taste. Bloßes Hovern ändert nichts, auch wenn
// das Loslassen verloren geht (außerhalb des Fensters, Zeigerfang verloren).
function scrub(track, onRatio) {
  let dragging = false;
  const at = e => {
    const r = track.getBoundingClientRect();
    onRatio(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  const stop = () => { dragging = false; };
  track.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true;
    track.setPointerCapture?.(e.pointerId);
    at(e);
  });
  track.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (!(e.buttons & 1)) { stop(); return; } // Taste nicht mehr gedrückt
    at(e);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, stop);
}
