// Startpunkt per Abgleich: Wo im Song beginnt das Video? Tonspur des Videos gegen die Songdatei
// kreuzkorrelieren. Funktioniert auch bei Samples, weil der eigene Song verglichen wird.
//
// Merkmale: Onset-Stärke in 6 Frequenzbändern (Bass … Höhen). Nur der Gesamtpegel reicht nicht:
// Pop/Hip-Hop wiederholt das Schlagzeug alle 4 Takte, erst Stimme und Melodie machen die Stelle eindeutig.
// Suche grob über den ganzen Song (~46 ms), dann fein um die besten Kandidaten (~11,6 ms).
// Grenze: Spielt der Kurs den Song verlangsamt, passt nichts zusammen.
import { decodeAudio } from './audio.js';

const SR = 11025;
const N = 512; // FFT-Größe (~46 ms)
const HOP = 128; // fein: ~11,6 ms
const COARSE = 4; // grob: 4 feine Frames zusammengefasst
const FPS = SR / HOP;
const BANDS = [[40, 150], [150, 400], [400, 800], [800, 1600], [1600, 3200], [3200, 5400]];

// Radix-2-FFT in place
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// Prüft eine Songdatei, bevor sie gespeichert wird. → null (ok) oder verständliche Fehlermeldung
export async function checkAudio(file) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  if (text.startsWith('<!doctype') || text.startsWith('<html') || text.startsWith('<?xml') || text.startsWith('{')) {
    return `„${file.name}“ ist keine Audiodatei, sondern eine Webseite (${Math.round(file.size / 1024)} KB). Vermutlich ist der Download fehlgeschlagen.`;
  }
  try {
    const audio = await new OfflineAudioContext(1, 1, SR).decodeAudioData(await file.arrayBuffer());
    if (audio.duration < 5) return `„${file.name}“ ist nur ${audio.duration.toFixed(1)} s lang, das ist kein ganzer Song.`;
    return null;
  } catch {
    return `„${file.name}“ kann der Browser nicht lesen. Möglich: Apple Lossless (ALAC), AIFF, kopiergeschützt (.m4p) oder beschädigt. Bitte als mp3, m4a (AAC), wav oder flac laden.`;
  }
}

async function decode(blob, label) {
  try {
    return await decodeAudio(blob, SR);
  } catch {
    throw new Error(label === 'song'
      ? 'Die Songdatei lässt sich nicht lesen. Bitte unter SONG ersetzen (mp3, m4a, wav oder flac).'
      : 'Die Tonspur des Videos lässt sich nicht lesen.');
  }
}

// → Float32Array[bands] mit normierter Onset-Stärke je Frame
async function features(blob, label) {
  const audio = await decode(blob, label);
  const x = audio.getChannelData(0);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const binOf = hz => Math.round((hz * N) / SR);
  const bands = BANDS.map(([lo, hi]) => [binOf(lo), Math.max(binOf(lo) + 1, binOf(hi))]);
  const out = BANDS.map(() => new Float32Array(frames));
  const prev = new Float32Array(BANDS.length);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    bands.forEach(([a, b], k) => {
      let s = 0;
      for (let i = a; i < b; i++) s += re[i] * re[i] + im[i] * im[i];
      const l = Math.log(1e-9 + s);
      out[k][f] = f ? Math.max(0, l - prev[k]) : 0;
      prev[k] = l;
    });
  }
  for (const e of out) normalize(e);
  return { bands: out, duration: audio.duration };
}

function normalize(e) {
  let m = 0;
  for (const v of e) m += v;
  m /= e.length || 1;
  let sd = 0;
  for (let i = 0; i < e.length; i++) { e[i] -= m; sd += e[i] * e[i]; }
  sd = Math.sqrt(sd / (e.length || 1)) || 1;
  for (let i = 0; i < e.length; i++) e[i] /= sd;
}

function downsample(bands, k) {
  return bands.map(e => {
    const out = new Float32Array(Math.floor(e.length / k));
    for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += e[i * k + j]; out[i] = s / k; }
    normalize(out);
    return out;
  });
}

// Korrelation aller Bänder für Lag L (Videoframe 0 liegt auf Songframe L)
function corr(V, S, L, minOverlap) {
  const a = Math.max(0, -L), b = Math.min(V[0].length, S[0].length - L);
  if (b - a < minOverlap) return -Infinity;
  let sum = 0;
  for (let k = 0; k < V.length; k++) {
    const v = V[k], s = S[k];
    for (let i = a; i < b; i++) sum += v[i] * s[i + L];
  }
  return sum / ((b - a) * V.length);
}

// → { offset, confidence, songDuration } · offset in Sekunden (negativ: Video beginnt vor dem Song)
// prior: grober Startpunkt (z. B. von Shazam). Dann wird nur in ±3 s darum gesucht und verfeinert.
export async function alignToSong(videoBlob, songBlob, { prior = null, onProgress = () => {} } = {}) {
  onProgress('Lese Tonspuren …');
  const [v, s] = await Promise.all([features(videoBlob, 'video'), features(songBlob, 'song')]);
  onProgress('Gleiche ab …');
  const Vc = downsample(v.bands, COARSE), Sc = downsample(s.bands, COARSE);
  const lenV = Vc[0].length, lenS = Sc[0].length;
  const minOverlap = Math.min(lenV, lenS) * 0.5;

  let from = -Math.floor(lenV / 2), to = lenS - Math.floor(minOverlap);
  if (prior != null) {
    const p = Math.round((prior * FPS) / COARSE), w = Math.round((3 * FPS) / COARSE);
    from = Math.max(from, p - w); to = Math.min(to, p + w);
  }
  const coarse = [];
  for (let L = from; L < to; L++) coarse.push([L, corr(Vc, Sc, L, minOverlap)]);
  coarse.sort((a, b) => b[1] - a[1]);
  if (!coarse.length || !isFinite(coarse[0][1])) return null;

  // Sicherheit: bester Grobwert gegen den besten Wert außerhalb ±1 s
  const guard = Math.round(FPS / COARSE);
  const second = coarse.find(([L]) => Math.abs(L - coarse[0][0]) > guard)?.[1] ?? 0;

  // Fein: um die drei besten Grob-Kandidaten
  const tops = [];
  for (const c of coarse) { if (tops.every(t => Math.abs(t[0] - c[0]) > guard)) tops.push(c); if (tops.length === 3) break; }
  const minFine = Math.min(v.bands[0].length, s.bands[0].length) * 0.5;
  let best = { L: 0, score: -Infinity }, scores = new Map();
  for (const [Lc] of tops) {
    for (let L = Lc * COARSE - COARSE * 2; L <= Lc * COARSE + COARSE * 2; L++) {
      const sc = corr(v.bands, s.bands, L, minFine);
      scores.set(L, sc);
      if (sc > best.score) best = { L, score: sc };
    }
  }
  const y0 = scores.get(best.L - 1) ?? best.score, y2 = scores.get(best.L + 1) ?? best.score;
  const d = y0 - 2 * best.score + y2;
  const frac = d ? (0.5 * (y0 - y2)) / d : 0;
  return {
    offset: (best.L + frac) / FPS,
    confidence: second > 0 ? coarse[0][1] / second : 10,
    songDuration: s.duration,
  };
}
