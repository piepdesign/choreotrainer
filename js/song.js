// Song-Auswahl: Suche (Deezer) + Erkennung aus dem Video (Shazam). Genutzt im Upload und in der Trainingsansicht.
import { tr } from './i18n.js';
import { h, fmt, debounce } from './util.js';
import { searchSongs, songDetails } from './deezer.js';
import { recognizeSong, scanTrack, median, enrich } from './recognize.js';
import { songLink, stopPreview } from './providers.js';
import { prime } from './audio.js';

const norm = s => String(s || '').trim().toLowerCase();
export const songKeyOf = s => (s.source === 'deezer' ? `dz:${s.id}` : `m:${norm(s.artist)}|${norm(s.title)}`);

// Grober Titelvergleich, um zu prüfen, ob Shazam denselben Song erkannt hat
const simple = s => norm(s).replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
// Schwellen für „Songdatei passt zum Video“ (siehe detectStart)
const FILE_MIN_CONF = 1.25, FILE_MIN_PEAK = 0.12;
export const sameSong = (a, b) => {
  const x = simple(a?.title), y = simple(b?.title);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
};
// Fassung im Titel (Remix, Edit, Extended Mix …). Ohne Angabe: Original
const VERSION = /remix|mix|edit|version|rework|bootleg|vip|dub|extended|cover|sped up|slowed/i;
const versionOf = t => (String(t || '').match(/\(([^)]*)\)|\[([^\]]*)\]/g) || []).map(x => x.slice(1, -1)).filter(x => VERSION.test(x)).map(norm).sort().join('|');
// Gleiche Fassung? Ist eine bestimmte Fassung gewählt, zählen nur Treffer genau dieser Fassung (Shazam meldet bei Remixen
// oft das Original; dessen Zeitposition passt nicht zum Remix). Beim Original zählen alle Fassungen wie bisher.
const sameVersion = (hit, chosen) => sameSong(hit, chosen) && (!versionOf(chosen?.title) || versionOf(hit?.title) === versionOf(chosen?.title));
// Tempo gleich (auch halbes/doppeltes Zählen), Toleranz 4 %
const sameTempo = (a, b) => !!a && !!b && [b, b * 2, b / 2].some(x => Math.abs(a - x) / x < 0.04);
const baseTitle = t => String(t || '').replace(/\(.*?\)|\[.*?\]|feat\..*$/gi, '').replace(/\s+/g, ' ').trim();

// getBlob(): aktuelles Video oder null · onChange(song, offset|null) · onOffset(offset): nur Startpunkt
// align(prior): optionaler Abgleich mit der Songdatei → { offset, confidence } oder null
// startField: Eingabefeld für den Startpunkt, steht als Schritt 2 unter dem Song
// tempo(): Tempo des Videos in BPM (oder Promise darauf), für den Hinweis auf andere Fassungen (Remix, verlangsamt)
export function songPicker({ song = null, getBlob, onChange, onOffset, align = null, startField = null, tempo = null }) {
  let current = song;
  let editing = !song;
  let results = [];

  const input = h('input', { type: 'search', placeholder: tr('Titel oder Artist …'), autocomplete: 'off' });
  const suggest = h('div.suggest', { hidden: true });
  const search = h('div.song-search', input, suggest);
  const picked = h('div');
  // prime(): auf dem Handy muss das Mithören direkt im Antippen starten (iOS)
  const recBtn = h('button.btn.small', { type: 'button', onclick: () => { prime(getBlob()); recognize(false); } }, tr('Aus Video erkennen'));
  const startBtn = h('button.btn.small', { type: 'button', title: tr('Startpunkt im Song erkennen'), onclick: () => { prime(getBlob()); detectStart(); } }, tr('Erkennen'));
  const recStatus = h('div.label.song-status');
  const startStatus = h('div.label.song-status');
  const altBox = h('div.actions', { style: { marginTop: '6px' } });
  const versionBox = h('div.song-versions');
  // Reihenfolge wie im Ablauf: 1 Song erkennen/suchen · 2 Startpunkt im Song
  const startStep = h('div.song-step',
    h('div.start-row', h('span.label', tr('Start:')), startField, startBtn),
    startStatus);
  const el = h('div.song-steps',
    h('div.song-step', search, picked, h('div.actions', recBtn), recStatus, altBox, versionBox),
    onOffset ? startStep : null);

  // Weitere Treffer aus dem Scan zur Auswahl anbieten (z. B. Original vs. Sample-Quelle)
  function showAlternatives(r) {
    altBox.replaceChildren(...(r?.alternatives || []).slice(0, 3).map(a => h('button.linkbtn', {
      type: 'button',
      title: tr('Stattdessen diesen Song übernehmen'),
      onclick: async () => {
        altBox.replaceChildren();
        recStatus.textContent = tr('Übernehme …');
        await set(await enrich({ title: a.title, subtitle: a.artist, key: a.key }), a.offset);
        recStatus.textContent = '';
      },
    }, tr('Oder: {song} ({hits}/{n})', { song: [a.artist, a.title].filter(Boolean).join(' — '), hits: a.hits, n: r.segments }))));
  }

  function render() {
    search.hidden = !editing;
    picked.replaceChildren(current && !editing
      ? h('div.song-picked',
        current.cover ? songLink(h('img', { src: current.cover, alt: '' }), current) : h('div.nocover'),
        h('div.song-picked-text', { title: [current.title, current.artist].filter(Boolean).join(' — ') }, songLink(h('strong', current.title), current),
          h('div.label', [current.artist, current.duration && fmt(current.duration), current.bpm && `${Math.round(current.bpm)} BPM`].filter(Boolean).join(' · '))),
        h('button.linkbtn', { type: 'button', onclick: () => { editing = true; render(); input.focus(); } }, tr('Ändern')))
      : current ? h('button.linkbtn', { type: 'button', onclick: () => { editing = false; render(); } }, tr('Abbrechen')) : '');
    recBtn.disabled = !getBlob();
    recBtn.textContent = current ? tr('Erneut erkennen') : tr('Aus Video erkennen');
    recBtn.title = current ? tr('Song noch einmal aus der Tonspur des Videos erkennen') : '';
    startStep.hidden = !current;
    startBtn.disabled = !getBlob();
  }

  // ── Andere Fassung (Remix, Edit …) ──
  // Shazam meldet bei Remixen oft nur das Original. Das Tempo des Videos verrät es häufig (Remix oder verlangsamt gespielt).
  let tempoP = null, tempoFor;
  const videoTempo = () => {
    const b = getBlob();
    if (tempoFor !== b) { tempoFor = b; tempoP = Promise.resolve(tempo && b ? tempo(b) : null).catch(() => null); }
    return tempoP;
  };
  async function offerVersions() {
    versionBox.replaceChildren();
    const s = current;
    if (!s?.title || s.source === 'manual') return;
    const link = h('div.actions', h('button.btn.small', { type: 'button', title: tr('Remix, Edit …'), onclick: () => listVersions(s) }, tr('Andere Fassung')));
    versionBox.replaceChildren(link);
    const v = await videoTempo();
    if (current !== s || !v || !s.bpm || sameTempo(v, s.bpm)) return;
    versionBox.replaceChildren(h('div.hint-text', tr('Video {v} BPM, Song {s} BPM: andere Fassung oder verlangsamt?', { v: Math.round(v), s: Math.round(s.bpm) })), link);
  }
  async function listVersions(s) {
    const base = baseTitle(s.title);
    versionBox.replaceChildren(h('div.label', tr('Suche Fassungen …')));
    const v = await videoTempo();
    const seen = new Set(s.source === 'deezer' ? [s.id] : []), list = [];
    for (const q of [`${base} ${baseTitle(s.artist)}`, `${base} remix`, `${base} mix`]) {
      try {
        for (const x of await searchSongs(q)) if (!seen.has(x.id) && simple(x.title).startsWith(simple(base))) { seen.add(x.id); list.push(x); }
      } catch { /* nächste Suche */ }
    }
    for (const x of list.slice(0, 16)) if (!x.bpm) { const d = await songDetails(x.id).catch(() => null); if (d?.bpm) x.bpm = d.bpm; }
    if (current !== s) return;
    list.sort((a, b) => sameTempo(v, b.bpm) - sameTempo(v, a.bpm));
    if (!list.length) { versionBox.replaceChildren(h('div.hint-text', tr('Keine weiteren Fassungen gefunden.'))); return; }
    versionBox.replaceChildren(
      h('div.versions', ...list.map(x => h('button', { type: 'button', title: tr('Diese Fassung übernehmen'), onclick: () => pickVersion(x) },
        x.cover ? songLink(h('img', { src: x.cover, alt: '' }), x) : h('div'),
        h('div', h('div', x.title), h('div.label', x.artist)),
        h('span.label', [x.duration && fmt(x.duration), x.bpm && `${Math.round(x.bpm)} BPM`, sameTempo(v, x.bpm) && tr('passt zum Tempo')].filter(Boolean).join(' · '))))),
      h('div.actions', h('button.linkbtn', { type: 'button', onclick: () => offerVersions() }, tr('Abbrechen'))));
  }
  async function pickVersion(x) {
    stopPreview();
    versionBox.replaceChildren();
    // Der bisherige Startpunkt gehörte zur alten Fassung: leeren, neu bestimmen (am sichersten per Abgleich mit der Songdatei)
    await set(x, null, { reset: true });
    recStatus.textContent = tr('Fassung übernommen. Start neu erkennen.');
  }

  // Deezer liefert BPM nur im Detailabruf. Erst darauf warten (max. 3 s), dann den Song einmal
  // vollständig melden. Zwei Meldungen hintereinander hatten sich gegenseitig überschrieben.
  async function set(s, offset = null, opts = {}) {
    current = s;
    editing = false;
    input.value = '';
    suggest.hidden = true;
    render();
    if (s.source === 'deezer' && !s.bpm) {
      recStatus.textContent = tr('Lade Songdaten …');
      const d = await Promise.race([songDetails(s.id).catch(() => null), new Promise(r => setTimeout(r, 3000))]);
      if (current !== s) return; // inzwischen anderer Song gewählt
      if (d?.bpm) s.bpm = d.bpm;
      recStatus.textContent = '';
      render();
    }
    onChange?.(s, offset, opts);
    offerVersions();
  }

  const runSearch = debounce(async q => {
    try {
      results = await searchSongs(q);
    } catch (e) {
      results = [];
      suggest.replaceChildren(h('div.label', { style: { padding: '8px' } }, e.message));
      suggest.hidden = false;
      return;
    }
    suggest.replaceChildren(...results.map(s => h('button', { type: 'button', onclick: () => set(s) },
      s.cover ? h('img', { src: s.cover, alt: '' }) : h('div'),
      h('div', h('div', s.title), h('div.label', s.artist)),
      h('span.label', s.duration ? fmt(s.duration) : ''))),
    h('button', { type: 'button', onclick: () => set({ source: 'manual', title: input.value.trim(), artist: '' }) },
      h('div'), h('div.label', tr('„{q}“ ohne Treffer übernehmen', { q: input.value.trim() })), h('span')));
    suggest.hidden = false;
  }, 300);

  input.addEventListener('input', () => { if (input.value.trim().length >= 2) runSearch(input.value); else suggest.hidden = true; });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (results[0]) set(results[0]); }
    if (e.key === 'Escape') suggest.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 200));

  // auto = beim Einladen gestartet: überschreibt keinen Song, der inzwischen von Hand gewählt wurde
  async function recognize(auto) {
    const blob = getBlob();
    if (!blob) return;
    recBtn.disabled = true;
    try {
      const r = await recognizeSong(blob, msg => { recStatus.textContent = msg; });
      if (!r) recStatus.textContent = tr('Kein Treffer · bitte manuell suchen');
      else if (auto && (current || input.value.trim())) recStatus.textContent = tr('Erkannt: {song} (nicht übernommen)', { song: `${r.song.artist} — ${r.song.title}` });
      else {
        await set(r.song, r.offset);
        recStatus.textContent = tr('Erkannt in {hits}/{n} Abschnitten', { hits: r.hits, n: r.segments });
        showAlternatives(r);
      }
    } catch (e) {
      console.warn(e);
      recStatus.textContent = e.message;
    } finally {
      recBtn.disabled = !getBlob();
    }
  }

  // Startpunkt für den EINGETRAGENEN Song suchen. Treffer anderer Songs zählen nicht (bei Samples
  // wäre deren Zeitposition sinnlos). Mit Songdatei: Abgleich der Tonspuren, Shazam nur als Grobwert.
  async function detectStart() {
    const blob = getBlob();
    if (!blob || !current) return;
    startBtn.disabled = recBtn.disabled = true;
    altBox.replaceChildren();
    try {
      let shazam = null, hits = 0, segments = 0, others = [], scanError = null, hasFile = false;
      try {
        const scan = await scanTrack(blob, msg => { startStatus.textContent = msg; });
        segments = scan.segments;
        const mine = scan.candidates.filter(c => sameVersion({ title: c.track.title }, current));
        hits = mine.reduce((a, c) => a + c.hits, 0);
        shazam = median(mine.flatMap(c => c.offsets));
        others = scan.candidates.filter(c => !mine.includes(c));
      } catch (e) {
        scanError = e;
      }
      // align() liefert null, solange keine Songdatei geladen ist
      if (align) startStatus.textContent = tr('Gleiche mit Songdatei ab …');
      const r = align ? await align() : null;
      hasFile = r !== null;
      if (scanError && !hasFile) throw scanError; // ohne Songdatei gibt es keinen anderen Weg
      // Abgleich nur übernehmen, wenn die Datei eindeutig passt (gemessen: passende Datei ≥ 2,9 / Spitzenwert ≥ 0,7,
      // falsche Datei 1,02 / 0,08). Vorher galt jeder Abgleich, sobald Shazam etwas gefunden hatte → falscher Song lief mit.
      const fileOk = r && r.confidence >= FILE_MIN_CONF && r.peak >= FILE_MIN_PEAK;
      if (fileOk) {
        // Position in der Datei (fürs Mitspielen) und im Original (Song-Zeitleiste) getrennt: bei Musikvideo-Fassungen
        // mit Intro oder anderer Länge weichen sie voneinander ab
        const songPos = shazam != null ? Math.max(0, shazam) : r.offset;
        onOffset(songPos, { file: r.offset });
        const diff = shazam != null ? r.offset - shazam : 0;
        startStatus.textContent = Math.abs(diff) > 1.5
          ? tr('In der Songdatei bei {f} (anders geschnitten, zum Mitspielen gilt die Datei)', { f: fmt(r.offset, true) })
          : tr('Per Songdatei abgeglichen');
        return;
      }
      if (shazam != null) {
        onOffset(Math.max(0, shazam), { file: hasFile ? null : undefined });
        startStatus.textContent = hasFile
          ? tr('Erkannt, aber die Songdatei klingt anders als das Video (andere Fassung?). Sie läuft trotzdem ab hier mit.')
          : tr('Erkannt in {hits}/{n} Abschnitten', { hits, n: segments });
      } else {
        const heard = others[0] ? ` ${tr('Gehört wurde: {song}.', { song: [others[0].track.subtitle, others[0].track.title].filter(Boolean).join(' — ') })}` : '';
        // ganze Sätze (Satzbau je Sprache verschieden)
        const hint = align && !hasFile ? tr('Songdatei laden oder Start von Hand eintragen.')
          : tr('Start von Hand eintragen.');
        startStatus.textContent = `${tr('„{title}“ nicht gefunden.', { title: current.title })}${heard} ${hint}`;
      }
    } catch (e) {
      console.warn(e);
      startStatus.textContent = e.message;
    } finally {
      startBtn.disabled = recBtn.disabled = !getBlob();
    }
  }

  render();
  offerVersions();
  return { el, get: () => current, typed: () => input.value.trim(), recognize, detectStart, refresh: render };
}
