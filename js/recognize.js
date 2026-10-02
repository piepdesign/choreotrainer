// Songerkennung aus der Tonspur: Fingerabdruck per vibra (WebAssembly, im Browser),
// Abfrage über den lokalen Durchreicher /api/shazam (server.py). Inoffiziell, kann jederzeit brechen.
import { searchSongs, songDetails } from './deezer.js';

const SR = 16000;
const SNIPPET = 10; // Sekunden je Versuch
let runtime;

function loadVibra() {
  if (runtime) return runtime;
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

async function ask(sig) {
  let data = null;
  try {
    if (IS_LOCAL) data = await askLocal(sig);
    data ??= await askRemote(sig);
  } catch {
    throw new Error('Erkennungsdienst nicht erreichbar');
  }
  if (data.error) throw new Error('Shazam nicht erreichbar');
  return data;
}

// → { song, offset } oder null. offset = Position im Song, an der das Video beginnt
export async function recognizeSong(blob, onProgress = () => {}) {
  onProgress('Lade Erkennung …');
  await loadVibra();
  onProgress('Lese Tonspur …');
  const audio = await new OfflineAudioContext(1, 1, SR).decodeAudioData(await blob.arrayBuffer());
  const pcm = audio.getChannelData(0);
  const dur = audio.duration;

  // mehrere Ausschnitte probieren, Mitte zuerst (Anfang ist oft Ansage/Stille)
  const starts = [0.4, 0.15, 0.65, 0.85, 0]
    .map(p => Math.max(0, Math.min(dur - SNIPPET, p * dur)))
    .filter((s, i, a) => a.findIndex(x => Math.abs(x - s) < 3) === i);

  for (const [i, start] of starts.entries()) {
    onProgress(`Erkenne Song … ${i + 1}/${starts.length}`);
    const slice = pcm.subarray(Math.floor(start * SR), Math.floor(Math.min(dur, start + SNIPPET) * SR));
    const data = await ask(signature(slice));
    const track = data.track;
    if (!track?.title) continue;
    const matchOffset = data.matches?.[0]?.offset;
    const offset = typeof matchOffset === 'number' ? Math.max(0, matchOffset - start) : null;
    return { song: await enrich(track), offset };
  }
  return null;
}

// Shazam-Treffer mit Deezer abgleichen, damit Länge/BPM/Cover wie bei der manuellen Suche vorliegen
async function enrich(track) {
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
