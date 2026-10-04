// Trainingsansicht: Player mit Spiegeln, Tempo, Lautstärke, Bild, Loop, 8er-Count, Markern, Song-Zeitleiste
import { db, uid, deleteRecording, deleteChoreo, untracked } from './db.js';
import { h, holdGate, isTouch, tt, fmt, fmtDate, WEEKDAYS, fmtRecDate, fmtDuration, relDate, parseTime, debounce, inlineEdit, fitInput, classTitle, classMeta, PALETTE, textOn } from './util.js';
import { analyzeBeat } from './beat.js';
import { songPicker, songKeyOf, sameSong } from './song.js';
import { identifyAudio } from './recognize.js';
import { alignToSong, checkAudio } from './align.js';
import { recTitle } from './hub.js';
import { go, toast } from './app.js';
import { settings, saveSettings, PANEL_SECTIONS } from './settings.js';
import { icon } from './ui.js';
import { prime, needsCapture } from './audio.js';

const MARKER_TYPES = {
  start: { label: 'START', color: 'var(--fg)', key: 'S' },
  end: { label: 'ENDE', color: 'var(--fg)', key: 'E' },
  memo: { label: 'NOTIZ', color: 'var(--c4)', key: 'N' }, // Typ-Schlüssel bleibt „memo“ (gespeicherte Daten)
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
  if (!blob) {
    // z. B. nach dem Wiederherstellen einer Sicherung: Video neu wählen, alles andere (Marker, Notizen …) ist da
    const input = h('input', { type: 'file', accept: 'video/*', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      await untracked(() => db.put('videos', f, recId));
      go(`#/train/${recId}`, { replace: true });
    });
    root.append(h('div.empty',
      h('p', 'Das Video zu dieser Aufnahme fehlt in diesem Browser.'),
      h('p.label', [rec.fileName, rec.duration && fmt(rec.duration)].filter(Boolean).join(' · ')),
      h('div.actions', h('button.btn.small', { type: 'button', onclick: () => input.click() }, 'Video wählen')), input));
    return;
  }
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
  // Touch: doppelt Tippen = Vollbild (das erste Tippen wird dabei zurückgenommen)
  let lastTap = 0;
  video.addEventListener('click', () => {
    togglePlay();
    if (!isTouch()) return;
    const now = Date.now();
    if (now - lastTap < 320) { lastTap = 0; togglePlay(); toggleFull(); } else lastTap = now;
  });
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
  // Position des Videos in der Songdatei: eigener Wert aus dem Abgleich (Datei kann anders geschnitten sein als das
  // Original, z. B. Musikvideo), sonst der Startpunkt im Song. null = Datei passt nicht zum Video.
  const filePos = () => (rec.fileOffset !== undefined ? rec.fileOffset : rec.songOffset);
  const songMode = () => P.audio === 'song' && !!songBlob && filePos() != null;
  let lastSeek = 0, lastSync = 0;
  function syncSong(force = false) {
    if (!songMode()) { if (!songAudio.paused) songAudio.pause(); return; }
    songAudio.volume = P.volume;
    songAudio.muted = P.muted;
    const target = filePos() + video.currentTime;
    const outside = target < 0 || (isFinite(songAudio.duration) && target >= songAudio.duration);
    if (outside || video.paused) { if (!songAudio.paused) songAudio.pause(); if (!outside && force) songAudio.currentTime = target; return; }
    // Kleine Abweichungen weich ausgleichen: Song minimal schneller/langsamer (max. ±6 %, Tonhöhe
    // bleibt). Springen nur bei großen Abständen, denn nach jedem Sprung hängt Audio ~50 ms hinterher.
    // Handy: Die Wiedergabe meldet ihre Position dort nur grob und verträgt keine ständigen Tempo-Wechsel.
    // Darum dort kein Nachregeln, nur seltene Sprünge (ab 0,5 s, höchstens alle 3 s). Vorher sprang der Song
    // fast in jedem Bild neu → nach 1–2 s nur noch abgehackte Fetzen.
    const err = target - songAudio.currentTime; // > 0: Song hinkt hinterher
    const now = performance.now();
    const touchMode = isTouch();
    if (force || (touchMode ? Math.abs(err) > 0.5 && now - lastSeek > 3000 : Math.abs(err) > 0.25)) {
      songAudio.currentTime = target;
      lastSeek = now;
      if (songAudio.playbackRate !== P.rate) songAudio.playbackRate = P.rate;
    } else if (!touchMode) {
      const nudge = Math.abs(err) < 0.008 ? 0 : Math.max(-0.06, Math.min(0.06, err * 0.8));
      const r = P.rate * (1 + nudge);
      if (Math.abs(songAudio.playbackRate - r) > 0.002) songAudio.playbackRate = r;
    } else if (songAudio.playbackRate !== P.rate) songAudio.playbackRate = P.rate;
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
  const sTrack = h('div.track');
  const sPh = h('div.ph'), sStatic = h('div');
  sTrack.append(sStatic, sPh);
  const songRow = h('div.tl-row', h('span.label', 'Song'), sTrack);
  // 8er-Zeile: jede Acht ein Feld. Klick = diese Acht loopen, Ziehen oder ⇧-Klick = mehrere,
  // Klick auf die aktive Auswahl = Loop aus.
  const eTrack = h('div.track.eights');
  // Auswahl der Achten steht als Tooltip an der Zeile (Zeitangaben nur noch unten in der Bedienleiste)
  const eightRow = h('div.tl-row', h('span.label', '8er'), eTrack);
  const timeline = h('div.timeline', h('div.tl-row', h('span.label', 'Video'), vTrack), eightRow, songRow);

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
    eTrack.title = selCells.length ? (selCells.length === 1 ? (selCells[0].i ? `Acht ${selCells[0].i}` : 'Auftakt') : `Achten ${lbl(selCells[0])}–${lbl(selCells.at(-1))}`) : '';
  }
  const cellAt = e => {
    const el = document.elementFromPoint(e.clientX, eTrack.getBoundingClientRect().top + 4);
    return el?.closest?.('.cell') ? Number(el.closest('.cell').dataset.k) : null;
  };
  let eAnchor = null;
  eTrack.addEventListener('pointerdown', e => {
    const k = cellAt(e);
    if (k == null || e.button !== 0) return;
    try { eTrack.setPointerCapture(e.pointerId); } catch { /* egal */ }
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
  // Loop an/aus (Knopf und L). Ohne In/Out gelten Start/Ende-Marker; steht die Wiedergabe außerhalb, geht es an den Anfang
  function toggleLoop() {
    P.loopOn = !P.loopOn;
    if (P.loopOn) {
      const { a, b } = loopRange();
      if (video.currentTime < a || video.currentTime >= b) video.currentTime = a;
      if (P.loopIn == null && P.loopOut == null) {
        const s = markerTime('start'), e = markerTime('end');
        toast(s != null || e != null ? `Loop ${fmt(a)}–${fmt(b)} (Start/Ende)` : 'Loop über das ganze Video', 1800);
      }
    }
    update();
  }

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
  const bPlay = h('button.ctl.icon-ctl', { type: 'button', title: tt('Play/Pause (Leertaste)', 'Play/Pause'), 'aria-label': 'Play/Pause', html: icon('play'), onclick: () => togglePlay() });
  const bMirror = h('button.ctl.icon-ctl', { type: 'button', title: tt('Spiegeln (M)', 'Spiegeln'), 'aria-label': 'Spiegeln', html: icon('mirror'), onclick: () => { P.mirror = !P.mirror; update(); } });
  const bRate = h('button.ctl.icon-ctl.rate', { type: 'button', title: 'Tempo', 'aria-label': 'Tempo', html: icon('tempo'), onclick: e => popover(e.currentTarget, ratePop) });
  const bVol = h('button.ctl.icon-ctl', { type: 'button', title: 'Lautstärke', 'aria-label': 'Lautstärke', onclick: e => popover(e.currentTarget, volPop) });
  const bImg = h('button.ctl.icon-ctl', { type: 'button', title: 'Bild: Helligkeit/Kontrast', 'aria-label': 'Bild: Helligkeit/Kontrast', html: icon('image'), onclick: e => popover(e.currentTarget, imgPop) });
  const bIn = ctl('In', { title: 'Loop-Anfang setzen (I)', onclick: () => setIn() });
  const bOut = ctl('Out', { title: 'Loop-Ende setzen (O)', onclick: () => setOut() });
  const bLoop = ctl('Loop', { title: 'Loop an/aus (L) · ohne In/Out zwischen Start und Ende', onclick: () => toggleLoop() });
  const bClear = ctl('×', { title: 'In/Out löschen', onclick: () => { P.loopIn = P.loopOut = null; P.loopOn = false; update(); } });
  // Ohne Tempo zählt nichts: dann beim Einschalten den Takt ermitteln (auf dem Handy muss das im Antippen starten)
  const bCount = ctl('8er', {
    title: '8er-Count an/aus (C)',
    onclick: () => {
      P.countOn = !P.countOn;
      if (P.countOn && !P.bpm) { prime(blob); runAnalysis(true); }
      update();
    },
  });
  // „1“ und „Tap“ direkt in der Leiste (ohne Tastatur sonst nur im Menü erreichbar, das dann das Video verdeckt)
  const bOne = ctl('1', { title: 'Anfangscount: hier ist die 1 (Taste 1)', onclick: () => setOne() });
  const bTap = ctl('Tap', { title: 'Im Takt tippen, ab einer „1“ mindestens viermal (Taste T)', onclick: () => tap() });
  const bBpm = fixed(ctl('', { title: 'Takt einstellen', onclick: e => popover(e.currentTarget, countPop) }), 9);
  bBpm.classList.add('bpm');
  const toggleFull = () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    // iPhone kennt Vollbild nur für das Video selbst (eigener Player, ohne 8er-Overlay)
    if (req) req.call(stage); else video.webkitEnterFullscreen?.();
  };
  const bFull = h('button.ctl.icon-ctl', { type: 'button', title: tt('Vollbild (F)', 'Vollbild'), 'aria-label': 'Vollbild', html: icon('full'), onclick: toggleFull });
  // Video: Breite füllen (Bild wird oben/unten beschnitten) oder komplett zeigen
  let fit = settings().videoFit === 'width' ? 'width' : 'all';
  const bFitW = h('button.ctl.icon-ctl', { type: 'button', title: 'Breite füllen', 'aria-label': 'Breite füllen', html: icon('fitWidth') });
  const bFitA = h('button.ctl.icon-ctl', { type: 'button', title: 'Komplett zeigen', 'aria-label': 'Komplett zeigen', html: icon('fitAll') });
  const setFit = v => {
    fit = v;
    bFitW.classList.toggle('on', v === 'width');
    bFitA.classList.toggle('on', v === 'all');
    stage.classList.toggle('fill', v === 'width');
    saveSettings({ videoFit: v });
    fitStage();
  };
  bFitW.addEventListener('click', () => setFit('width'));
  bFitA.addEventListener('click', () => setFit('all'));
  bFitW.classList.toggle('on', fit === 'width');
  bFitA.classList.toggle('on', fit === 'all');
  stage.classList.toggle('fill', fit === 'width');
  // Breite füllen: Ausschnitt in der Höhe per Ziehen verschieben (je Aufnahme gemerkt). Kurzer Klick bleibt Play/Pause.
  // Überstand = wie viel Bild oben/unten abgeschnitten ist (Video in Breite der Fläche)
  const overflow = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    return vw && vh ? Math.max(0, (stage.clientWidth / vw) * vh - stage.clientHeight) : 0;
  };
  // fitY 0 = oberer Rand sichtbar, 100 = unterer; das Video steht mittig, verschoben wird um den halben Überstand
  const applyPan = () => {
    const on = fit === 'width' && document.fullscreenElement !== stage;
    video.style.setProperty('--pan', on ? `${(((50 - (P.fitY ?? 50)) / 100) * overflow()).toFixed(1)}px` : '0px');
  };
  applyPan();
  document.addEventListener('fullscreenchange', applyPan);
  let panned = false;
  video.draggable = false;
  video.addEventListener('dragstart', e => e.preventDefault());
  stage.addEventListener('pointerdown', e => {
    if (fit !== 'width' || e.button !== 0 || document.fullscreenElement === stage) return;
    if (e.target.closest('.count, button')) return;
    const y0 = e.clientY, start = P.fitY ?? 50;
    const over = overflow();
    if (over < 2) return;
    e.preventDefault(); // keine Textauswahl / natives Ziehen des Videos
    panned = false;
    const move = ev => {
      const dy = ev.clientY - y0;
      if (!panned && Math.abs(dy) < 4) return;
      panned = true;
      stage.classList.add('panning');
      P.fitY = Math.round(Math.min(100, Math.max(0, start - (dy / over) * 100)) * 10) / 10;
      applyPan();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      stage.classList.remove('panning');
      if (panned) persist();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  // nach dem Verschieben kein Play/Pause auslösen
  stage.addEventListener('click', e => { if (panned) { e.stopPropagation(); panned = false; } }, true);
  stage.addEventListener('dblclick', toggleFull);
  const bMark = h('button.ctl.icon-ctl', { type: 'button', title: 'Marker setzen', 'aria-label': 'Marker setzen', html: icon('marker'), onclick: e => popover(e.currentTarget, markPop) });
  const toggleAudio = () => {
    if (!songBlob) { toast('Erst unter SONG eine Songdatei laden'); return; }
    if (P.audio !== 'song' && rec.fileOffset === null) { toast('Die Songdatei passt nicht zum Video. Bitte die richtige Datei laden oder den Startpunkt von Hand eintragen.', 5000); return; }
    if (P.audio !== 'song' && filePos() == null) { toast('Erst den Startpunkt im Song setzen (Startpunkt erkennen)'); return; }
    P.audio = P.audio === 'song' ? 'video' : 'song';
    update();
    syncSong(true);
  };
  const bAudio = h('button.ctl.icon-ctl', { type: 'button', title: 'Ton: Video oder Song', 'aria-label': 'Ton: Video oder Song', html: icon('note'), onclick: toggleAudio });
  const timeView = h('span.timeview', '');
  // Bedienleiste in festen Gruppen, überall gleich: Wiedergabe · Loop · Count · Bild & Ansicht.
  // Breit: eine Zeile, Gruppen durch Linien getrennt. Schmaler: Gruppen untereinander bzw. nebeneinander,
  // Linien zwischen allen Zeilen und Spalten (CSS-Container-Abfrage). Knöpfe einer Gruppe sind gleich breit;
  // erscheinen × oder Ton, wird ihre Gruppe nur enger.
  const group = (...items) => h('div.ctl-group', ...items);
  const controls = h('div.controls', { style: { position: 'relative' } },
    group(bPlay, bRate, bVol, bAudio),
    group(bIn, bOut, bLoop, bClear),
    group(bCount, bBpm, bOne, bTap),
    group(bMirror, bImg, bMark),
    group(bFitW, bFitA, bFull));
  // Zeitangabe als kleine eigene Zeile direkt unter den Zeitleisten
  timeline.append(h('div.tl-time', timeView));

  function update() {
    applyVideo();
    bMirror.classList.toggle('on', P.mirror);
    // Werte nur im Tooltip, die Leiste zeigt Icons; „on“ = vom Normalwert abweichend
    bRate.title = `Tempo ${P.rate.toFixed(2)}×${tt(' (↑ / ↓)', '')}`;
    bRate.classList.toggle('on', P.rate !== 1);
    // abweichendes Tempo zusätzlich als Faktor neben der Stoppuhr
    const rateVal = P.rate !== 1 ? `${P.rate.toFixed(2)}×` : ''; // immer zwei Stellen, z. B. 0.90×
    if (bRate.dataset.val !== rateVal) {
      bRate.innerHTML = icon('tempo') + (rateVal ? `<span class="ctl-val">${rateVal}</span>` : '');
      bRate.dataset.val = rateVal;
      bRate.classList.toggle('has-val', !!rateVal);
    }
    const vol = P.muted ? 0 : Math.round(P.volume * 100);
    const volIcon = vol === 0 ? 'vol0' : vol < 50 ? 'vol1' : 'vol2';
    if (bVol.dataset.icon !== volIcon) { bVol.innerHTML = icon(volIcon); bVol.dataset.icon = volIcon; }
    bVol.title = P.muted ? 'Lautstärke: stumm' : `Lautstärke ${vol} %`;
    bVol.classList.toggle('on', vol === 0);
    bImg.classList.toggle('on', P.brightness !== 100 || P.contrast !== 100);
    bIn.classList.toggle('on', P.loopIn != null);
    bOut.classList.toggle('on', P.loopOut != null);
    bLoop.classList.toggle('on', P.loopOn);
    bClear.hidden = P.loopIn == null && P.loopOut == null;
    bCount.classList.toggle('on', P.countOn);
    bBpm.textContent = P.bpm ? `${Math.round(P.bpm * 10) / 10} BPM` : 'BPM ?';
    bAudio.hidden = !songBlob;
    bAudio.title = `Ton vom ${songMode() ? 'Song' : 'Video'} · umschalten${tt(' (A)', '')}`;
    bAudio.classList.toggle('on', songMode());
    renderStatic();
    persist();
  }

  // ── Popover ──
  let pop = null;
  function closePop() { pop?.remove(); pop = null; }
  const refreshPop = () => pop?.rebuild();
  function popover(btn, build) {
    if (pop && pop.btn === btn) { closePop(); return; } // gleicher Knopf: zu (nicht per Text, die Icon-Knöpfe haben keinen)
    closePop();
    pop = h('div.pop', build());
    pop.btn = btn;
    pop.rebuild = () => pop.replaceChildren(...build().flat());
    controls.append(pop);
    pop.style.bottom = `${controls.clientHeight - btn.offsetTop + 6}px`;
    pop.style.left = `${Math.max(0, Math.min(btn.offsetLeft, controls.clientWidth - pop.offsetWidth))}px`;
    // passt das Menü nach oben nicht auf den Bildschirm (Handy), unter dem Knopf öffnen
    if (pop.getBoundingClientRect().top < 70) {
      pop.style.bottom = '';
      pop.style.top = `${btn.offsetTop + btn.offsetHeight + 6}px`;
      pop.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
    h('div.btns.btns-col', Object.entries(MARKER_TYPES).map(([type, m]) => small(tt(`${m.label} (${m.key})`, m.label), () => { addMarker(type); closePop(); }))),
  ];
  const countPop = () => {
    const bpmIn = h('input.bpm-input', { type: 'number', step: '0.1', min: '40', max: '240', value: P.bpm ? Math.round(P.bpm * 10) / 10 : '' });
    bpmIn.addEventListener('change', () => { const v = Number(bpmIn.value); if (v >= 40 && v <= 240) { P.bpm = v; P.manualBeat = true; update(); } });
    return [
      h('div.pop-head', h('span', 'Tempo (BPM)'), h('button.pop-close', { type: 'button', title: 'Schließen', 'aria-label': 'Schließen', onclick: closePop }, '×')),
      bpmIn,
      h('div.btns',
        small('÷2', () => { if (P.bpm) { P.bpm /= 2; P.manualBeat = true; update(); bpmIn.value = Math.round(P.bpm * 10) / 10; } }),
        small('×2', () => { if (P.bpm) { P.bpm *= 2; P.manualBeat = true; update(); bpmIn.value = Math.round(P.bpm * 10) / 10; } }),
      ),
      h('div.btns',
        // ±10 ms war nicht wahrnehmbar: ganzen Count verschieben (welcher Count die „1“ ist) und fein ±25 ms
        small('« 1 Count', () => shiftAnchor(-1, 'beat')),
        small('1 Count »', () => shiftAnchor(1, 'beat'))),
      h('div.btns',
        small('−25 ms', () => shiftAnchor(-0.025)),
        small('+25 ms', () => shiftAnchor(0.025))),
      h('div.btns',
        small(tt('Anfangscount (1)', 'Anfangscount'), () => setOne()),
        small(tt('Tap (T)', 'Tap'), () => tap())),
      h('div.btns',
        small(P.click ? 'Klick an' : 'Klick aus', () => { P.click = !P.click; update(); refreshPop(); }, P.click),
        small('Neu analysieren', () => { prime(blob); closePop(); P.manualBeat = false; runAnalysis(true); })),
      h('div.prow', h('span', 'Anzeige')),
      h('div.btns', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']].map(([k, l]) =>
        small(l, () => { C.size = k; saveCountView(C); update(); refreshPop(); }, C.size === k))),
      h('div.btns', [['tl', '↖'], ['tr', '↗'], ['c', '·'], ['bl', '↙'], ['br', '↘']].map(([k, l]) =>
        small(l, () => { C.pos = k; saveCountView(C); update(); refreshPop(); }, C.pos === k))),
      h('div.btns',
        small(C.plus ? 'Halbe „+“ an' : 'Halbe „+“ aus', () => { C.plus = !C.plus; saveCountView(C); update(); refreshPop(); }, C.plus),
        small(C.show ? 'Zähler sichtbar' : 'Zähler ausgeblendet', () => { C.show = !C.show; saveCountView(C); update(); refreshPop(); }, C.show)),
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
  // Zählung verschieben: ganze Schläge oder Sekunden; kurz anzeigen, damit man die Wirkung sieht
  function shiftAnchor(n, unit) {
    if (!P.bpm) { toast('Erst Tempo setzen (Tap oder BPM)'); return; }
    P.anchor += unit === 'beat' ? n * (60 / P.bpm) : n;
    P.manualBeat = true;
    update();
    status.textContent = unit === 'beat' ? `„1“ ${n > 0 ? 'EINEN COUNT SPÄTER' : 'EINEN COUNT FRÜHER'}` : `ZÄHLUNG ${n > 0 ? '+' : '−'}25 MS`;
    clearTimeout(shiftAnchor.t);
    shiftAnchor.t = setTimeout(() => { status.textContent = ''; }, 1600);
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
    // wie alle Marker: umbenennen erst über das Marker-Menü
    menuFor = null;
    renaming = false;
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
      status.textContent = tt('TAKT NICHT ERKANNT · TAPPEN (T)', 'TAKT NICHT ERKANNT · TAP IM BPM-MENÜ');
    }
    rec.beatTried = true;
    update();
    setTimeout(() => { status.textContent = ''; }, 4000);
  }

  // ── Session-Zeit ──
  let session = null;
  async function saveSession() {
    if (deleted || !session || session.seconds < 5) return;
    const { rateTime, ...rest } = session;
    await db.put('sessions', { ...rest, seconds: Math.round(session.seconds), avgRate: Math.round((rateTime / session.seconds) * 100) / 100 });
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
      session ||= { id: uid(), choreoId: choreo.id, recordingId: rec.id, start: Date.now(), seconds: 0, rateTime: 0, loops: 0 };
      session.seconds += dt;
      session.rateTime += dt * P.rate; // für Ø Tempo im Profil
    }

    if (P.loopOn && !video.paused) {
      const { a, b } = loopRange();
      if (b - a > 0.2 && t >= b) { video.currentTime = a; if (session) session.loops++; }
    }

    vFill.style.width = vPh.style.left = `${(t / d) * 100}%`;
    const songPos = song?.duration && rec.songOffset != null ? ` · Song ${fmt(rec.songOffset + t)}` : '';
    setText(timeView, `${fmt(t, true)} / ${fmt(d, true)}${songPos}`);
    const playIcon = video.paused ? 'play' : 'pause';
    if (bPlay.dataset.icon !== playIcon) { bPlay.innerHTML = icon(playIcon); bPlay.dataset.icon = playIcon; }
    // im Bildtakt abgleichen, auf dem Handy nur alle 0,4 s
    if (songMode() && !video.paused && (!isTouch() || performance.now() - lastSync > 400)) { lastSync = performance.now(); syncSong(); }
    if (song?.duration && rec.songOffset != null) {
      const st = rec.songOffset + t;
      sPh.style.left = `${(st / song.duration) * 100}%`;
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
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': () => togglePlay(),
      arrowleft: () => { video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 0.2 : 2)); },
      arrowright: () => { video.currentTime = Math.min(dur(), video.currentTime + (e.shiftKey ? 0.2 : 2)); },
      m: () => { P.mirror = !P.mirror; update(); },
      arrowdown: () => { P.rate = Math.max(0.25, Math.round((P.rate - 0.05) * 100) / 100); update(); },
      arrowup: () => { P.rate = Math.min(1.5, Math.round((P.rate + 0.05) * 100) / 100); update(); },
      i: () => setIn(),
      o: () => setOut(),
      l: () => toggleLoop(),
      c: () => { P.countOn = !P.countOn; update(); },
      t: () => tap(),
      1: () => setOne(),
      s: () => addMarker('start'),
      e: () => addMarker('end'),
      n: () => addMarker('memo'),
      h: () => addMarker('highlight'),
      a: () => toggleAudio(),
      p: () => togglePanel(),
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
        kind.classList.add('editing'); // beim Umbenennen neutrale Fläche, damit die Textauswahl auf jeder Markerfarbe sichtbar ist
        kind.append(input);
        // ganzen Namen markieren, damit direkt neu getippt werden kann (auch nach dem Klick-Ende)
        const selectAll = () => { input.focus(); input.select(); };
        requestAnimationFrame(selectAll);
        setTimeout(selectAll, 60);
        input.addEventListener('focus', () => input.select(), { once: true });
      } else {
        kind.textContent = m.text || MARKER_TYPES[m.type].label;
      }
      if (menuFor === m.id && !renaming) {
        li.append(h('div.menu',
          small('Umbenennen', () => { renaming = true; renderMarkers(); }),
          small('Hierhin', () => { video.currentTime = m.t; menuFor = null; renderMarkers(); }),
          small('Auf jetzt setzen', () => { m.t = video.currentTime; rec.markers.sort((a, b) => a.t - b.t); menuFor = null; update(); renderMarkers(); }),
          small('Löschen', () => { rec.markers = rec.markers.filter(x => x !== m); menuFor = null; update(); renderMarkers(); }),
          // Art wechseln, z. B. einen als Notiz angelegten „Ende“-Marker zum echten Ende machen (zählt dann für den Loop)
          h('span.label.menu-sep', 'Art:'),
          ...Object.entries(MARKER_TYPES).filter(([t]) => t !== m.type).map(([t, def]) => small(def.label.charAt(0) + def.label.slice(1).toLowerCase(), () => {
            if (t === 'start' || t === 'end') rec.markers = rec.markers.filter(x => x === m || x.type !== t); // Start/Ende gibt es je einmal
            m.type = t;
            menuFor = null;
            update(); renderMarkers(); renderStatic();
          }))));
      }
      return li;
    }) : [h('li.muted', { style: { display: 'block' } }, tt('Noch keine Marker. Taste S/E/N/H oder Fähnchen in der Leiste.', 'Noch keine Marker. Über das Fähnchen in der Leiste setzen.'))]));
  }

  const notesIn = h('textarea', { placeholder: '5, 6, 7, 8 Anmerkungen …' }, rec.notes || '');
  notesIn.addEventListener('input', () => { rec.notes = notesIn.value; saveRec(); });

  const offsetIn = h('input.offset-in', { type: 'text', placeholder: '0:00', value: rec.songOffset != null ? fmt(rec.songOffset, true) : '' });
  // von Hand: gilt für Song und Datei
  offsetIn.addEventListener('change', () => { rec.songOffset = parseTime(offsetIn.value); delete rec.fileOffset; update(); });
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
    // offset = Position im Song (Original). file = Position in der Songdatei (fürs Mitspielen), null = Datei passt nicht
    onOffset: (offset, { file } = {}) => {
      rec.songOffset = offset;
      if (file !== undefined) rec.fileOffset = file;
      if (rec.fileOffset === null && P.audio === 'song') { P.audio = 'video'; }
      offsetIn.value = fmt(offset, true);
      update();
      syncSong(true);
    },
    align: () => (songBlob ? alignToSong(blob, songBlob) : null),
    startField: offsetIn,
  });

  // Songdatei laden / entfernen
  const songFileIn = h('input', { type: 'file', accept: 'audio/*,audio/flac,audio/x-flac,.mp3,.m4a,.aac,.wav,.flac,.aiff', hidden: true });
  const songFileRow = h('div.song-step');
  async function setSongFile(file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|flac|aiff?)$/i.test(file.name)) { toast('Bitte eine Audiodatei wählen'); return; }
    // Erst prüfen, ob wirklich Ton drin ist (z. B. als .mp3 gespeicherte Webseite nach Download-Fehler)
    songFileRow.querySelector('.label')?.replaceChildren('Prüfe Songdatei …');
    const problem = await checkAudio(file);
    if (problem) { toast(problem, 8000); renderSongFile(); return; }
    // Ist es wirklich dieser Song? (Kurz bei Shazam nachfragen; scheitert das, geht es ohne Prüfung weiter)
    if (song?.title) {
      songFileRow.querySelector('.label')?.replaceChildren('Prüfe, welcher Song in der Datei ist …');
      const found = await identifyAudio(file).catch(() => null);
      if (found && !sameSong(found, song)
        && !confirm(`Die Datei klingt nach „${[found.artist, found.title].filter(Boolean).join(' — ')}“, die Choreo ist aber „${song.title}“. Trotzdem verwenden?`)) {
        renderSongFile();
        return;
      }
    }
    await db.put('videos', file, songKey);
    delete rec.fileOffset; // neue Datei: Position darin bestimmt gleich der Abgleich
    if (P.audio === 'song') P.audio = 'video'; // erst nach bestandener Prüfung wieder mit der Datei abspielen
    songBlob = file;
    loadSongAudio();
    renderSongFile();
    update();
    picker.detectStart(); // Startpunkt direkt per Abgleich bestimmen
  }
  function renderSongFile() {
    songFileRow.hidden = !song;
    songFileRow.replaceChildren(songFileIn, songBlob
      ? h('div', h('span.label.step-label', 'Songdatei'), h('div.actions',
        h('span.label', `♪ ${songBlob.name || 'Songdatei'}`),
        h('button.linkbtn', { type: 'button', onclick: () => songFileIn.click() }, 'Ersetzen'),
        h('button.linkbtn', {
          type: 'button',
          onclick: async () => {
            if (!confirm('Songdatei aus dieser Choreo entfernen?')) return;
            await db.del('videos', songKey);
            songBlob = null;
            delete rec.fileOffset;
            P.audio = 'video';
            loadSongAudio();
            renderSongFile();
            update();
          },
        }, 'Entfernen')))
      : h('div',
        h('span.label.step-label', 'Songdatei (optional)'),
        h('div.actions', h('button.btn.small', { type: 'button', onclick: () => songFileIn.click() }, 'Songdatei laden')),
        h('div.label', { style: { marginTop: '6px' } }, 'Zum Trainieren auf den Song.')));
  }
  songFileIn.addEventListener('change', () => setSongFile(songFileIn.files[0]));
  renderSongFile();

  const statText = () => {
    const secs = sessions.reduce((a, s) => a + s.seconds, 0) + (session?.seconds || 0);
    return `Geübt ${fmtDuration(secs)} · zuletzt ${relDate(choreo.lastPracticed)}`;
  };
  const statLine = h('div.label', statText());

  const recIndex = recs.findIndex(r => r.id === rec.id);
  let songSection, togglePanel = () => {}, stopFit = () => {};
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
  // ── Seitenpanel: Abschnitte zum Zu-/Aufklappen und Umsortieren (Reihenfolge gilt für alle Choreos) ──
  const recsBody = [
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
      }, 'Aufnahme löschen')),
  ];
  const KEYS = [
    ['␣', 'Play/Pause'], ['← →', '±2 s (⇧ ±0,2)'], ['M', 'Spiegeln'], ['↑ ↓', 'Tempo'],
    ['I / O', 'Loop In/Out'], ['L', 'Loop'], ['C', '8er-Count'], ['T', 'Tap-Tempo'],
    ['1', 'Anfangscount'], ['S / E', 'Start/Ende'], ['N', 'Notiz'], ['H', 'Highlight'], ['F', 'Vollbild'], ['A', 'Ton Video/Song'], ['P', 'Seitenpanel'], ['⌘Z', 'Rückgängig'], ['⌘⇧Z', 'Wiederherstellen'],
  ];
  const keysBody = [h('div.keys', { style: { '--rows': Math.ceil(KEYS.length / 2) } }, KEYS.map(([k, d]) => h('div', h('kbd', k), ' ', d)))];
  const SECTIONS = {
    song: ['Song', [picker.el, songFileRow]],
    marker: ['Marker', [markerList]],
    notes: ['Notizen', [notesIn]],
    status: ['Status', [ratingBox, ratingHint, h('div', { style: { marginTop: '8px' } }, statLine)]],
    recs: ['Aufnahmen', recsBody],
    ...(isTouch() ? {} : { keys: ['Tasten', keysBody] }), // ohne Tastatur keine Tastenliste
  };
  const panelState = settings().panel;
  const side = h('aside.side');
  const sectionEls = {};
  for (const key of panelState.order.filter(k => SECTIONS[k])) {
    const [label, body] = SECTIONS[key];
    const collapsed = panelState.collapsed.includes(key);
    const handle = h('span.drag-handle', { 'aria-hidden': 'true', html: icon('grip') });
    const headBtn = h('button.panel-toggle', { type: 'button', 'aria-expanded': String(!collapsed) }, h('span.label', label), h('span.chev', '▾'));
    const sec = h(`section.panel-sec${collapsed ? '.collapsed' : ''}`, { 'data-k': key },
      h('div.panel-head', handle, headBtn),
      h('div.panel-body', ...body));
    headBtn.addEventListener('click', () => {
      if (sec.dataset.dragged) { delete sec.dataset.dragged; return; } // nach dem Ziehen nicht zuklappen
      sec.classList.toggle('collapsed');
      headBtn.setAttribute('aria-expanded', String(!sec.classList.contains('collapsed')));
      savePanel();
    });
    sortableSection(sec, sec.querySelector('.panel-head'));
    sectionEls[key] = sec;
    side.append(sec);
  }
  songSection = sectionEls.song;
  const savePanel = () => saveSettings({ panel: {
    open: !trainEl.classList.contains('panel-closed'),
    order: [...side.querySelectorAll('.panel-sec')].map(x => x.dataset.k),
    collapsed: [...side.querySelectorAll('.panel-sec.collapsed')].map(x => x.dataset.k),
  } });
  // Abschnitt am Griff ziehen und zwischen den anderen ablegen
  // Ganzer Abschnittskopf ist Griff: erst ab 6 px Bewegung wird gezogen, sonst bleibt es ein Klick (auf/zu)
  function sortableSection(sec, head) {
    head.title = 'Klicken: auf/zu · Ziehen: umsortieren';
    const gate = holdGate(); // Touch: erst halten, dann ziehen (Wischen scrollt)
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const y0 = e.clientY;
      let active = false;
      gate.arm(e);
      const move = ev => {
        if (!(ev.buttons & 1) && ev.pointerType !== 'touch') { up(); return; }
        if (!active) {
          const g = gate.gate(ev);
          if (g === null) { up(); return; }
          if (!g) return;
          if (ev.pointerType !== 'touch' && Math.abs(ev.clientY - y0) < 6) return;
          active = true;
          sec.classList.add('dragging');
          document.body.classList.add('dragging-now');
        }
        ev.preventDefault();
        const others = [...side.querySelectorAll('.panel-sec:not(.dragging)')];
        const after = others.find(o => ev.clientY < o.getBoundingClientRect().top + o.offsetHeight / 2);
        if (after !== sec.nextElementSibling) side.insertBefore(sec, after || null);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        gate.done();
        if (!active) return;
        sec.classList.remove('dragging');
        document.body.classList.remove('dragging-now');
        sec.dataset.dragged = '1';
        setTimeout(() => delete sec.dataset.dragged, 0);
        savePanel();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });
  }

  // Aufnahmetag = Class-Tag → Wochentag steht schon beim Class-Tag, nicht noch einmal am Datum
  const sameDay = !!cls.weekday && !!rec.recordedAt && WEEKDAYS[(new Date(rec.recordedAt).getDay() + 6) % 7] === cls.weekday;
  const panelBtn = h('button.ctl.icon-ctl.panel-btn', { type: 'button', title: 'Seitenpanel ein/aus (P)', 'aria-label': 'Seitenpanel ein/aus' });
  const panelIcon = open => { panelBtn.innerHTML = icon(open ? 'panelOpen' : 'panelClosed'); panelBtn.classList.toggle('on', open); };
  // Titel und Interpret einzeilig (zu lang → „…“, beim Darüberfahren läuft er langsam durch), damit das Video mehr
  // Höhe bekommt. Schmale Spalte (Handy): mehrzeilig, dort steht er über dem Video und kostet keine Bildbreite.
  const titleInner = h('span.tt-inner',
    inlineEdit((choreo.title || song?.title || 'Ohne Song').toUpperCase(), async v => { choreo.title = v; await db.put('choreos', choreo); }), song?.artist ? h('span.muted', { style: { fontWeight: 600 } }, ` — ${song.artist.toUpperCase()}`) : '');
  const titleEl = h('h1.wide.train-title', titleInner);
  titleEl.addEventListener('mouseenter', () => {
    const shift = titleEl.scrollWidth - titleEl.clientWidth;
    if (shift <= 2 || titleEl.querySelector('input')) return;
    titleEl.style.setProperty('--shift', `${-shift - 4}px`);
    titleEl.style.setProperty('--dur', `${Math.max(3, shift / 35 + 2)}s`); // ca. 35 px/s, Pausen an den Enden
    titleEl.classList.add('marquee');
  });
  titleEl.addEventListener('mouseleave', () => titleEl.classList.remove('marquee'));
  titleEl.addEventListener('click', () => titleEl.classList.remove('marquee'));
  const crumbs = h('div.crumbs',
    h('a.tag', { href: `#/class/${cls.id}`, style: { background: `#${color}`, color: textOn(color) } }, classTitle(cls).toUpperCase()),
    h('span.label', classMeta(cls)),
    h('span.label', titleEdit(), ` · ${recIndex + 1}/${recs.length} · ${sameDay ? fmtDate(rec.recordedAt) : fmtRecDate(rec.recordedAt)}`),
    panelBtn,
    titleEl);
  const mainCol = h('div.train-main', crumbs, stage, timeline, controls);
  const trainEl = h(`div.train${panelState.open ? '' : '.panel-closed'}`, { style: { '--cc': `#${color}`, '--cc-text': textOn(color) } }, mainCol, side);
  const setPanel = open => {
    trainEl.classList.toggle('panel-closed', !open);
    panelIcon(open);
    savePanel();
    fitStage();
  };
  panelBtn.addEventListener('click', () => setPanel(trainEl.classList.contains('panel-closed')));
  panelIcon(panelState.open);
  togglePanel = () => setPanel(trainEl.classList.contains('panel-closed'));
  root.append(trainEl);

  // Alles auf einen Bildschirm: Video so groß wie möglich, ohne dass Zeitleisten und Leiste herausfallen
  function fitStage() {
    if (document.fullscreenElement === stage) return;
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const w = mainCol.clientWidth;
    const stacked = matchMedia('(max-width: 1000px)').matches;
    let hgt = w / ratio;
    {
      // Auch im schmalen (gestapelten) Layout an der Fensterhöhe begrenzen, sonst gibt es bei
      // „Breite füllen“ nie einen Überstand zum Verschieben
      const used = crumbs.offsetHeight + timeline.offsetHeight + controls.offsetHeight + 34; // + Abstände
      const avail = Math.max(180, (stacked ? innerHeight - 72 : mainCol.clientHeight) - used);
      // Breite füllen: Video so breit wie die Spalte, was über die verfügbare Höhe hinausgeht, wird oben/unten
      // beschnitten (und lässt sich verschieben). Vorher wurde die Fläche auf volle Höhe gezogen, dann schnitt
      // „cover“ bei Querformat links/rechts ab und es gab nichts zu verschieben.
      hgt = Math.min(hgt, avail);
    }
    stage.style.height = `${Math.round(hgt)}px`;
    // Fläche so breit wie das Video, mittig (keine schwarzen Seitenbalken, wenn die Höhe begrenzt)
    stage.style.width = fit === 'width' ? `${w}px` : `${Math.min(w, Math.round(hgt * ratio))}px`;
    stage.classList.toggle('can-pan', fit === 'width' && w / ratio - hgt > 2);
    applyPan();
    // Panel schließt unten mit der Bedienleiste ab
    side.style.height = stacked ? '' : `${Math.round(controls.getBoundingClientRect().bottom - mainCol.getBoundingClientRect().top)}px`;
  }
  const ro = new ResizeObserver(() => fitStage());
  ro.observe(mainCol);
  stopFit = () => ro.disconnect();

  video.addEventListener('loadedmetadata', () => {
    if (!rec.duration && video.duration) rec.duration = video.duration;
    // Querformat füllt die Breite, Hochformat wird in der Höhe begrenzt
    stage.classList.toggle('portrait', video.videoHeight > video.videoWidth);
    renderStatic();
    fitStage();
  });
  // Songdatei per Drag & Drop auf den Song-Bereich
  songSection.addEventListener('dragover', e => { if (song) e.preventDefault(); });
  songSection.addEventListener('drop', e => { if (!song) return; e.preventDefault(); setSongFile(e.dataTransfer.files[0]); });
  update();
  renderRating();
  renderMarkers();
  raf = requestAnimationFrame(loop);
  // Takt automatisch schätzen; auf dem Handy nicht, wenn dafür mitgehört werden muss (geht nur nach Antippen)
  if (!P.bpm && !rec.beatTried) {
    if (needsCapture(blob)) {
      if (song?.bpm) { P.bpm = song.bpm; P.anchor = 0; } // vorläufig Deezer-Tempo, „1“ dann per Knopf setzen
      status.textContent = '8ER ANTIPPEN, DANN WIRD DER TAKT ERMITTELT';
    }
    else setTimeout(() => runAnalysis(false), 300);
  }

  return async () => {
    cancelAnimationFrame(raf);
    stopFit();
    clearInterval(sessionTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', applyPan);
    document.removeEventListener('pointerdown', onDocClick);
    document.removeEventListener('visibilitychange', onHide);
    video.pause();
    songAudio.pause();
    await saveSession();
    if (!deleted) {
      rec.player = { ...P };
      await db.put('recordings', rec);
    }
    deleted = true; // verspätete Speicherungen (Notizen, Player) nicht mehr schreiben
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
    try { track.setPointerCapture(e.pointerId); } catch { /* egal */ }
    at(e);
  });
  track.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (!(e.buttons & 1)) { stop(); return; } // Taste nicht mehr gedrückt
    at(e);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, stop);
}
