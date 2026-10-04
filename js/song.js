// Song-Auswahl: Suche (Deezer) + Erkennung aus dem Video (Shazam). Genutzt im Upload und in der Trainingsansicht.
import { h, fmt, debounce } from './util.js';
import { searchSongs, songDetails } from './deezer.js';
import { recognizeSong, scanTrack, median, enrich } from './recognize.js';
import { songLink } from './providers.js';
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

// getBlob(): aktuelles Video oder null · onChange(song, offset|null) · onOffset(offset): nur Startpunkt
// align(prior): optionaler Abgleich mit der Songdatei → { offset, confidence } oder null
// startField: Eingabefeld für den Startpunkt, steht als Schritt 2 unter dem Song
export function songPicker({ song = null, getBlob, onChange, onOffset, align = null, startField = null }) {
  let current = song;
  let editing = !song;
  let results = [];

  const input = h('input', { type: 'search', placeholder: 'Titel oder Artist …', autocomplete: 'off' });
  const suggest = h('div.suggest', { hidden: true });
  const search = h('div.song-search', input, suggest);
  const picked = h('div');
  // prime(): auf dem Handy muss das Mithören direkt im Antippen starten (iOS)
  const recBtn = h('button.btn.small', { type: 'button', onclick: () => { prime(getBlob()); recognize(false); } }, 'Aus Video erkennen');
  const startBtn = h('button.btn.small', { type: 'button', onclick: () => { prime(getBlob()); detectStart(); } }, 'Startpunkt erkennen');
  const recStatus = h('div.label.song-status');
  const startStatus = h('div.label.song-status');
  const altBox = h('div.actions', { style: { marginTop: '6px' } });
  // Reihenfolge wie im Ablauf: 1 Song erkennen/suchen · 2 Startpunkt im Song
  const startStep = h('div.song-step',
    h('span.label.step-label', 'Video beginnt im Song bei'),
    startField,
    h('div.actions', startBtn),
    startStatus);
  const el = h('div.song-steps',
    h('div.song-step', search, picked, h('div.actions', recBtn), recStatus, altBox),
    onOffset ? startStep : null);

  // Weitere Treffer aus dem Scan zur Auswahl anbieten (z. B. Original vs. Sample-Quelle)
  function showAlternatives(r) {
    altBox.replaceChildren(...(r?.alternatives || []).slice(0, 3).map(a => h('button.linkbtn', {
      type: 'button',
      title: 'Stattdessen diesen Song übernehmen',
      onclick: async () => {
        altBox.replaceChildren();
        recStatus.textContent = 'Übernehme …';
        await set(await enrich({ title: a.title, subtitle: a.artist, key: a.key }), a.offset);
        recStatus.textContent = a.offset != null ? `Video beginnt bei ${fmt(a.offset, true)} im Song` : '';
      },
    }, `Oder: ${[a.artist, a.title].filter(Boolean).join(' — ')} (${a.hits}/${r.segments})`)));
  }

  function render() {
    search.hidden = !editing;
    picked.replaceChildren(current && !editing
      ? h('div.song-picked',
        current.cover ? songLink(h('img', { src: current.cover, alt: '' }), current) : h('div.nocover'),
        h('div', songLink(h('strong', current.title), current),
          h('div.label', [current.artist, current.duration && fmt(current.duration), current.bpm && `${Math.round(current.bpm)} BPM`].filter(Boolean).join(' · '))),
        h('button.linkbtn', { type: 'button', onclick: () => { editing = true; render(); input.focus(); } }, 'Ändern'))
      : current ? h('button.linkbtn', { type: 'button', onclick: () => { editing = false; render(); } }, 'Abbrechen') : '');
    recBtn.disabled = !getBlob();
    recBtn.textContent = current ? 'Erneut erkennen' : 'Aus Video erkennen';
    recBtn.title = current ? 'Song noch einmal aus der Tonspur des Videos erkennen' : '';
    startStep.hidden = !current;
    startBtn.disabled = !getBlob();
  }

  // Deezer liefert BPM nur im Detailabruf. Erst darauf warten (max. 3 s), dann den Song einmal
  // vollständig melden. Zwei Meldungen hintereinander hatten sich gegenseitig überschrieben.
  async function set(s, offset = null) {
    current = s;
    editing = false;
    input.value = '';
    suggest.hidden = true;
    render();
    if (s.source === 'deezer' && !s.bpm) {
      recStatus.textContent = 'Lade Songdaten …';
      const d = await Promise.race([songDetails(s.id).catch(() => null), new Promise(r => setTimeout(r, 3000))]);
      if (current !== s) return; // inzwischen anderer Song gewählt
      if (d?.bpm) s.bpm = d.bpm;
      recStatus.textContent = '';
      render();
    }
    onChange?.(s, offset);
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
      h('div'), h('div.label', `„${input.value.trim()}“ ohne Treffer übernehmen`), h('span')));
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
      if (!r) recStatus.textContent = 'Kein Treffer · bitte manuell suchen';
      else if (auto && (current || input.value.trim())) recStatus.textContent = `Erkannt: ${r.song.artist} — ${r.song.title} (nicht übernommen)`;
      else {
        await set(r.song, r.offset);
        recStatus.textContent = `Erkannt in ${r.hits}/${r.segments} Abschnitten` + (r.offset != null ? ` · Video beginnt bei ${fmt(r.offset, true)} im Song` : '');
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
        const mine = scan.candidates.filter(c => sameSong({ title: c.track.title }, current));
        hits = mine.reduce((a, c) => a + c.hits, 0);
        shazam = median(mine.flatMap(c => c.offsets));
        others = scan.candidates.filter(c => !mine.includes(c));
      } catch (e) {
        scanError = e;
      }
      // align() liefert null, solange keine Songdatei geladen ist
      if (align) startStatus.textContent = 'Gleiche mit Songdatei ab …';
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
          ? `Video beginnt bei ${fmt(songPos, true)} im Song, in deiner Songdatei bei ${fmt(r.offset, true)} (Datei ist anders geschnitten, z. B. Musikvideo-Fassung; zum Mitspielen gilt die Datei)`
          : `Video beginnt bei ${fmt(r.offset, true)} im Song (Abgleich mit Songdatei)`;
        return;
      }
      if (shazam != null) {
        onOffset(Math.max(0, shazam), { file: hasFile ? null : undefined });
        startStatus.textContent = hasFile
          ? `Video beginnt bei ${fmt(Math.max(0, shazam), true)} im Song (${hits}/${segments} Abschnitte). Die Songdatei passt aber nicht zum Video (anderer Song oder andere Aufnahme), Mitspielen mit der Datei ist deshalb aus. Bitte unten die richtige Datei laden.`
          : `Video beginnt bei ${fmt(Math.max(0, shazam), true)} im Song (${hits}/${segments} Abschnitte)`;
      } else {
        const heard = others[0] ? ` Gehört wurde: ${[others[0].track.subtitle, others[0].track.title].filter(Boolean).join(' — ')}.` : '';
        const hint = align && !hasFile ? 'Lade unten die Songdatei, dann klappt es per Abgleich. Oder trag den ' : hasFile ? 'Auch der Abgleich mit der Songdatei war unsicher (anderer Song oder verlangsamt?). Trag den ' : 'Trag den ';
        startStatus.textContent = `„${current.title}“ nicht in der Tonspur gefunden.${heard} ${hint}Startpunkt von Hand ein.`;
      }
    } catch (e) {
      console.warn(e);
      startStatus.textContent = e.message;
    } finally {
      startBtn.disabled = recBtn.disabled = !getBlob();
    }
  }

  render();
  return { el, get: () => current, typed: () => input.value.trim(), recognize, detectStart, refresh: render };
}
