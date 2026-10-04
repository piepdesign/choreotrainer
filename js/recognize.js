// Songerkennung aus der Tonspur: Fingerabdruck per vibra (WebAssembly, im Browser),
// Abfrage über den lokalen Durchreicher /api/shazam (server.py). Inoffiziell, kann jederzeit brechen.
import { searchSongs, songDetails } from './deezer.js';
import { decodeAudio } from './audio.js';

const SR = 16000;
const SNIPPET = 10; // Sekunden je Versuch
let runtime;

function loadVibra() {
  if (runtime) return runtime;
  if (window.Module?.ccall && window.Module.HEAPU8) return (runtime = Promise.resolve()); // schon geladen
  runtime = new Promise((resolve, reject) => {
    window.Module = { locateFile: p => `vendor/vibra/${p}`, onRuntimeInitialized: resolve };
    const s = document.createElement('script');
    s.src = 'vendor/vibra/vibra.js';
    s.onerror = () => { runtime = null; reject(new Error('Erkennungsmodul fehlt')); };
    document.head.append(s);
    setTimeout(() => reject(new Error('Erkennungsmodul startet nicht')), 15000);
  });
  return runtime;
}

function signature(pcm) {
  const M = window.Module;
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const ptr = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const sig = M.ccall('GetFloatPcmSignature', 'number', ['number', 'number', 'number', 'number', 'number'], [ptr, bytes.length, SR, 32, 1]);
  M._free(ptr);
  const uri = M.ccall('GetFingerprint', 'string', ['number'], [sig]);
  const samplems = M.ccall('GetSampleMs', 'number', ['number'], [sig]);
  if (typeof M._FreeFingerprint === 'function') M.ccall('FreeFingerprint', null, ['number'], [sig]);
  return { uri, samplems };
}

// Lokal (server.py): eigener Durchreicher unter /api/shazam.
// Online (GitHub Pages) oder wenn lokal kein server.py läuft: öffentlicher Durchreicher des
// vibra-Entwicklers. Fremder Dienst, kann jederzeit wegfallen. Er bekommt nur den Fingerabdruck, kein Audio.
const REMOTE = 'https://vercel-proxy-rust-three.vercel.app/api/shazam';
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);

async function askLocal(sig) {
  const res = await fetch('api/shazam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig) });
  if (!res.ok && res.status !== 502) return null; // kein server.py (z. B. 404/501) → online versuchen
  return res.json();
}

async function askRemote(sig) {
  const res = await fetch(`${REMOTE}?uri=${encodeURIComponent(sig.uri)}&samplems=${sig.samplems}`);
  return res.json();
}

const wait = ms => new Promise(r => setTimeout(r, ms));
// Läuft lokal server.py? (sonst gehen Anfragen über den öffentlichen Durchreicher)
let localOk = null;
async function localAvailable() {
  if (localOk != null) return localOk;
  try { const r = await fetch('api/shazam', { method: 'POST', body: '{}' }); localOk = r.status !== 404 && r.status !== 501 && r.status !== 405; } catch { localOk = false; }
  return localOk;
}

async function ask(sig) {
  let data = null;
  try {
    if (IS_LOCAL && !window.ctForceRemote) data = await askLocal(sig);
    data ??= await askRemote(sig);
  } catch {
    throw new Error('Erkennungsdienst nicht erreichbar');
  }
  if (data.error) throw new Error('Shazam nicht erreichbar');
  return data;
}

// Ganze Tonspur in überlappenden Abschnitten abfragen. Ein einzelner Abschnitt kann täuschen:
// Songs mit Samples (z. B. Kingpin ↔ J Dilla „In The Night“) werden je nach Stelle als Original
// oder als Sample-Quelle erkannt. → Treffer je Song sammeln, mit Zeitposition je Abschnitt.
export async function scanTrack(blob, onProgress = () => {}) {
  onProgress('Lade Erkennung …');
  await loadVibra();
  onProgress('Lese Tonspur …');
  const audio = await decodeAudio(blob, SR, onProgress); // auf Handys ggf. per Mithören
  const pcm = audio.getChannelData(0);
  const dur = audio.duration;
  const step = Math.min(12, Math.max(5, dur / 20));
  const starts = [];
  for (let t = 0; t <= Math.max(0, dur - SNIPPET * 0.6); t += step) starts.push(Math.min(t, Math.max(0, dur - SNIPPET)));

  const byKey = new Map();
  let done = 0, answered = 0, lastError = null;
  const failed = [];
  const one = async start => {
    const slice = pcm.subarray(Math.floor(start * SR), Math.floor(Math.min(dur, start + SNIPPET) * SR));
    let data;
    try {
      data = await ask(signature(slice));
      if (data.retryms) throw new Error('Shazam bremst');
    } catch (e) { lastError = e; failed.push(start); return; }
    answered++;
    onProgress(`Scanne Tonspur … ${++done}/${starts.length}`);
    const track = data.track;
    if (!track?.title) return;
    const key = String(track.key || `${track.subtitle}|${track.title}`);
    const entry = byKey.get(key) || { track, hits: 0, offsets: [] };
    entry.hits++;
    const m = data.matches?.[0]?.offset;
    if (typeof m === 'number') entry.offsets.push(m - start);
    byKey.set(key, entry);
  };
  // Lokal (server.py): drei Anfragen gleichzeitig. Online über den öffentlichen Durchreicher: einzeln mit Pause,
  // der bremst sonst sofort („Shazam bremst“). Steht ein Song klar vorn, wird früher aufgehört.
  const remote = window.ctForceRemote || !IS_LOCAL || !(await localAvailable()); // ctForceRemote: zum Testen
  const clearWinner = () => {
    const hits = [...byKey.values()].map(e => e.hits).sort((a, b) => b - a);
    return (hits[0] || 0) >= 4 && hits[0] - (hits[1] || 0) >= 3;
  };
  if (remote) {
    for (const start of starts) {
      await one(start);
      if (clearWinner() && byKey.size) break;
      await wait(700);
    }
  } else {
    for (let k = 0; k < starts.length; k += 3) await Promise.all(starts.slice(k, k + 3).map(one));
  }
  // Abgelehnte Abschnitte (Shazam bremst bei vielen Anfragen kurz hintereinander) nachholen: einzeln,
  // mit wachsender Pause (2 s, 4 s, 8 s). Sonst zählen sie als „nicht erkannt“ und verzerren die Mehrheit.
  for (let round = 0; failed.length && round < 3 && !clearWinner(); round++) {
    const retry = failed.splice(0);
    onProgress(`Shazam bremst kurz, frage erneut … (${round + 1}/3)`);
    await wait(2000 * 2 ** round);
    for (const start of retry) { await one(start); if (remote) await wait(900); }
  }
  if (!answered && lastError) throw lastError;

  const candidates = [...byKey.values()].sort((a, b) => b.hits - a.hits);
  return { candidates, segments: answered };
}

// Median ist robust gegen einzelne Ausreißer-Treffer
export const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// → { song, offset, alternatives } oder null. Gewinner = Song mit den meisten Abschnitts-Treffern.
export async function recognizeSong(blob, onProgress = () => {}) {
  const { candidates, segments } = await scanTrack(blob, onProgress);
  if (!candidates.length) return null;
  const best = candidates[0];
  const offset = median(best.offsets);
  return {
    song: await enrich(best.track),
    offset: offset == null ? null : Math.max(0, offset),
    hits: best.hits,
    segments,
    alternatives: candidates.slice(1).map(c => {
      const o = median(c.offsets);
      return { title: c.track.title, artist: c.track.subtitle || '', key: c.track.key, hits: c.hits, offset: o == null ? null : Math.max(0, o) };
    }),
  };
}

// Shazam-Treffer mit Deezer abgleichen, damit Länge/BPM/Cover wie bei der manuellen Suche vorliegen
export async function enrich(track) {
  const title = track.title;
  const artist = track.subtitle || '';
  const fallback = { source: 'shazam', id: String(track.key || ''), title, artist, cover: track.images?.coverart || '', duration: null, bpm: null };
  try {
    const norm = s => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
    const hits = await searchSongs(`${artist} ${title}`);
    const hit = hits.find(h => norm(h.title).startsWith(norm(title)) && norm(artist).includes(norm(h.artist).split(' ')[0]))
      || hits.find(h => norm(h.title).startsWith(norm(title)));
    if (!hit) return fallback;
    if (!hit.bpm) {
      const d = await songDetails(hit.id).catch(() => null);
      if (d?.bpm) hit.bpm = d.bpm;
    }
    return hit;
  } catch {
    return fallback;
  }
}
