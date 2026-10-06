// Tempo- und Beat-Schätzung aus der Tonspur des Videos, komplett im Browser.
// Ergebnis: { bpm, anchor } – anchor ist die Zeit (s) eines Beats im Video.
// Welcher Beat die „1“ einer Acht ist, kann die Automatik nicht wissen → Tap-Korrektur im Player.
import { tr } from './i18n.js';
import { decodeAudio } from './audio.js';

const SR = 22050;
const HOP = 256;
const FPS = SR / HOP;

export async function analyzeBeat(blob, priorBpm) {
  if (blob.size > 1.2e9) throw new Error(tr('Datei zu groß für die Analyse'));
  const audio = await decodeAudio(blob, SR); // auf Handys ggf. per Mithören
  const env = onsetEnvelope(mixdown(audio));
  if (env.length < FPS * 8) throw new Error(tr('Audio zu kurz'));

  const coarse = coarseTempo(env, priorBpm);
  let { bpm, phase } = pickMetrical(env, coarse);

  // Deezer-BPM nur übernehmen, wenn sie zur Aufnahme passt (Kurse spielen Songs oft verlangsamt)
  if (priorBpm) {
    for (const p of [priorBpm, priorBpm * 2, priorBpm / 2]) {
      if (Math.abs(bpm - p) / p < 0.02) ({ bpm, phase } = refine(env, p, 0.002));
    }
  }
  return { bpm: Math.round(bpm * 100) / 100, anchor: phase / FPS };
}

function mixdown(audio) {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const a = audio.getChannelData(0), b = audio.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}

// Energie-Flux (Vollband + Bass), lokal mittelwertbereinigt
function onsetEnvelope(x) {
  const n = Math.floor(x.length / HOP);
  const full = new Float32Array(n), low = new Float32Array(n);
  const a = Math.exp((-2 * Math.PI * 180) / SR);
  let lp = 0;
  for (let f = 0; f < n; f++) {
    let ef = 0, el = 0;
    for (let i = f * HOP, end = i + HOP; i < end; i++) {
      const s = x[i];
      lp = a * lp + (1 - a) * s;
      ef += s * s;
      el += lp * lp;
    }
    full[f] = Math.log(1e-10 + ef);
    low[f] = Math.log(1e-10 + el);
  }
  const flux = new Float32Array(n);
  for (let f = 1; f < n; f++) {
    flux[f] = Math.max(0, full[f] - full[f - 1]) + 1.5 * Math.max(0, low[f] - low[f - 1]);
  }
  // gleitenden Mittelwert (~0,5 s) abziehen
  const w = Math.round(FPS * 0.25);
  const env = new Float32Array(n);
  let sum = 0;
  for (let f = 0; f < n; f++) {
    sum += flux[f];
    if (f - 2 * w - 1 >= 0) sum -= flux[f - 2 * w - 1];
    const c = f - w;
    if (c >= 0) env[c] = Math.max(0, flux[c] - sum / (2 * w + 1));
  }
  return env;
}

function coarseTempo(env, prior) {
  const n = env.length;
  const minLag = Math.floor((60 * FPS) / 190);
  const maxLag = Math.ceil((60 * FPS) / 65);
  const ac = new Float32Array(maxLag * 2 + 2);
  for (let L = minLag; L <= Math.min(maxLag * 2, n - 1); L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
    ac[L] = s / (n - L);
  }
  let best = 0, bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * FPS) / L;
    // Tanzmusik liegt meist um 90–130 BPM; leichte Gewichtung dorthin
    let weight = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.7) ** 2);
    if (prior) for (const p of [prior, prior * 2, prior / 2]) if (Math.abs(bpm - p) / p < 0.04) weight *= 1.3;
    const score = (ac[L] + 0.5 * (ac[2 * L] || 0)) * weight;
    if (score > bestScore) { bestScore = score; best = L; }
  }
  // Parabel-Interpolation für Zwischenwerte
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
  const d = y0 - 2 * y1 + y2;
  const lag = best + (d ? (0.5 * (y0 - y2)) / d : 0);
  return (60 * FPS) / lag;
}

// Autokorrelation verwechselt gern Dreiergruppen oder halbe/doppelte Zeit mit dem Grundschlag
// (z. B. 78 statt 117 BPM bei Hip-Hop mit Swing). Darum Verwandte des Ergebnisses prüfen und den
// nehmen, bei dem pro Schlag im Mittel die meiste Onset-Energie auf dem Raster liegt.
function pickMetrical(env, bpm0) {
  let best = null;
  for (const f of [1, 1.5, 2 / 3, 2, 0.5]) {
    const b = bpm0 * f;
    if (b < 60 || b > 190) continue;
    const r = refine(env, b, 0.015);
    const beats = Math.max(1, Math.floor((env.length - r.phase) / ((60 * FPS) / r.bpm)));
    const weight = Math.exp(-0.5 * (Math.log2(r.bpm / 110) / 0.8) ** 2);
    const score = (r.score / beats) * weight;
    if (!best || score > best.score) best = { bpm: r.bpm, phase: r.phase, score };
  }
  return refine(env, best.bpm, 0.01);
}

// Feinsuche: Tempo ±spread und Phase, maximiert die Onset-Energie auf dem Beat-Raster
function refine(env, bpm0, spread = 0.03) {
  const n = env.length;
  const peak = i => {
    const k = Math.round(i);
    return Math.max(env[k - 1] || 0, env[k] || 0, env[k + 1] || 0);
  };
  let best = { bpm: bpm0, phase: 0, score: -Infinity };
  const steps = 120;
  for (let s = 0; s <= steps; s++) {
    const bpm = bpm0 * (1 - spread + (2 * spread * s) / steps);
    const period = (60 * FPS) / bpm;
    for (let ph = 0; ph < period; ph += 1) {
      let score = 0;
      for (let i = ph; i < n; i += period) score += peak(i);
      if (score > best.score) best = { bpm, phase: ph, score };
    }
  }
  return best;
}
