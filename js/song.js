// Song-Auswahl: Suche (Deezer) + Erkennung aus dem Video (Shazam). Genutzt im Upload und in der Trainingsansicht.
import { h, fmt, debounce } from './util.js';
import { searchSongs, songDetails } from './deezer.js';
import { recognizeSong } from './recognize.js';

const norm = s => String(s || '').trim().toLowerCase();
export const songKeyOf = s => (s.source === 'deezer' ? `dz:${s.id}` : `m:${norm(s.artist)}|${norm(s.title)}`);

// Grober Titelvergleich, um zu prüfen, ob Shazam denselben Song erkannt hat
const simple = s => norm(s).replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
const sameSong = (a, b) => {
  const x = simple(a?.title), y = simple(b?.title);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
};

// getBlob(): aktuelles Video oder null · onChange(song, offset|null) · onOffset(offset): nur Startpunkt
export function songPicker({ song = null, getBlob, onChange, onOffset }) {
  let current = song;
  let editing = !song;
  let results = [];

  const input = h('input', { type: 'search', placeholder: 'Titel oder Artist …', autocomplete: 'off' });
  const suggest = h('div.suggest', { hidden: true });
  const search = h('div.song-search', input, suggest);
  const picked = h('div');
  const recBtn = h('button.btn.small', { type: 'button', onclick: () => recognize(false) }, 'Aus Video erkennen');
  const startBtn = h('button.btn.small', { type: 'button', onclick: () => detectStart() }, 'Startpunkt erkennen');
  const recStatus = h('span.label');
  const el = h('div', search, picked, h('div.actions', { style: { marginTop: '10px' } }, recBtn, startBtn, recStatus));

  function render() {
    search.hidden = !editing;
    picked.replaceChildren(current && !editing
      ? h('div.song-picked',
        current.cover ? h('img', { src: current.cover, alt: '' }) : h('div.nocover'),
        h('div', h('strong', current.title),
          h('div.label', [current.artist, current.duration && fmt(current.duration), current.bpm && `${Math.round(current.bpm)} BPM`].filter(Boolean).join(' · '))),
        h('button.linkbtn', { type: 'button', onclick: () => { editing = true; render(); input.focus(); } }, 'Ändern'))
      : current ? h('button.linkbtn', { type: 'button', onclick: () => { editing = false; render(); } }, 'Abbrechen') : '');
    recBtn.disabled = !getBlob();
    startBtn.hidden = !current || !onOffset;
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
        recStatus.textContent = r.offset != null ? `Erkannt · Video beginnt bei ${fmt(r.offset, true)} im Song` : 'Erkannt';
      }
    } catch (e) {
      console.warn(e);
      recStatus.textContent = e.message;
    } finally {
      recBtn.disabled = !getBlob();
    }
  }

  // Nur ermitteln, wo das Video im (bereits gewählten) Song beginnt. Der Song bleibt unverändert.
  async function detectStart() {
    const blob = getBlob();
    if (!blob || !current) return;
    startBtn.disabled = recBtn.disabled = true;
    try {
      const r = await recognizeSong(blob, msg => { recStatus.textContent = msg; });
      if (!r) recStatus.textContent = 'Startpunkt nicht gefunden · bitte von Hand eintragen';
      else if (r.offset == null) recStatus.textContent = 'Song erkannt, aber ohne Zeitangabe · bitte von Hand eintragen';
      else if (!sameSong(r.song, current)
        && !confirm(`Erkannt wurde „${[r.song.artist, r.song.title].filter(Boolean).join(' — ')}“, eingetragen ist „${current.title}“.\n\nStartpunkt ${fmt(r.offset, true)} trotzdem übernehmen?`)) {
        recStatus.textContent = 'Nicht übernommen';
      } else {
        onOffset(r.offset);
        recStatus.textContent = `Video beginnt bei ${fmt(r.offset, true)} im Song`;
      }
    } catch (e) {
      console.warn(e);
      recStatus.textContent = e.message;
    } finally {
      startBtn.disabled = recBtn.disabled = !getBlob();
    }
  }

  render();
  return { el, get: () => current, typed: () => input.value.trim(), recognize, refresh: render };
}
