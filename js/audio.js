// Tonspur eines Videos (oder einer Songdatei) als Samples in gewünschter Abtastrate.
// Weg 1: decodeAudioData (schnell, liest die ganze Datei). Klappt auf Handys oft nicht: Safari/iOS kann
// .mov-Videos so nicht entschlüsseln, und große Videos sprengen dort den Speicher.
// Weg 2 (Ersatz): Video unsichtbar abspielen und den Ton über Web Audio mitschneiden. Doppelte Geschwindigkeit
// ohne Tonhöhenkorrektur: Der Ton ist nur gestaucht, die Samples werden danach auf die Zielrate umgerechnet.

const MOBILE_LIMIT = 150e6; // ab dieser Größe auf Handys gleich Weg 2 (Speicher)
// Abspielgeschwindigkeit beim Mitschneiden. Am Rechner doppelt (ohne Tonhöhenkorrektur, danach umgerechnet).
// Auf Handys normal: iOS ignoriert „Tonhöhe nicht korrigieren“, bei doppeltem Tempo kam der Ton dort eine Oktave
// verfälscht an, Shazam und der Abgleich fanden dann nichts.
const rate = () => (touch() ? 1 : 2);
// Mitgehörter Ton je Datei, damit Startpunkt (Scan + Abgleich) und Takt nicht mehrfach mithören müssen
const heard = new WeakMap();
function resample(raw, fromRate, sampleRate) {
  const ratio = fromRate / sampleRate;
  const outLen = Math.floor(raw.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, k = Math.floor(x), f = x - k;
    out[i] = raw[k] * (1 - f) + (raw[k + 1] ?? raw[k]) * f;
  }
  return { duration: outLen / sampleRate, sampleRate, numberOfChannels: 1, length: outLen, getChannelData: () => out };
}

const touch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

// Muss das Handy mithören (Weg 2)? Dann braucht iOS ein Antippen, bevor Ton laufen darf.
export const needsCapture = blob => touch() && (blob.size > MOBILE_LIMIT || /\.mov$/i.test(blob.name || '') || blob.type === 'video/quicktime');

// iOS gibt Ton nur frei, wenn Wiedergabe direkt im Antippen startet. prime(blob) deshalb synchron im
// Klick-Handler aufrufen (vor jedem await): legt Video und Audio-Kontext an und startet sie kurz.
let primed = null;
export function prime(blob) {
  if (!blob || !touch()) return;
  if (primed?.blob === blob) return;
  dropPrimed();
  const url = URL.createObjectURL(blob);
  const v = makeVideo(url);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});
  // Ton gleich in den (stummen) Audio-Graphen leiten, dann kurz mit Ton anspielen: schaltet das Video für iOS frei
  const src = ctx.createMediaElementSource(v);
  v.muted = false;
  v.play().then(() => v.pause()).catch(() => {});
  primed = { blob, url, v, ctx, src };
}
function dropPrimed() {
  if (!primed) return;
  primed.v.remove(); URL.revokeObjectURL(primed.url); primed.ctx.close().catch(() => {});
  primed = null;
}
function makeVideo(url) {
  const v = document.createElement('video');
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  document.body.append(v);
  return v;
}

// gibt ein Objekt wie AudioBuffer zurück: { duration, sampleRate, numberOfChannels, getChannelData(c) }
export async function decodeAudio(blob, sampleRate, onProgress = () => {}) {
  const known = heard.get(blob);
  if (known) return resample(known.raw, known.rate, sampleRate);
  if (!window.ctForceCapture && !(touch() && blob.size > MOBILE_LIMIT)) { // ctForceCapture: zum Testen des Ersatzwegs
    try {
      return await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(await blob.arrayBuffer());
    } catch (e) {
      if (!/^video\//.test(blob.type) && !/\.(mov|mp4|m4v)$/i.test(blob.name || '')) throw e; // Audiodatei: kein Ersatzweg
    }
  }
  return capture(blob, sampleRate, onProgress);
}

export async function capture(blob, sampleRate, onProgress = () => {}) {
  // vorbereitetes Video/Kontext aus dem Antippen übernehmen (iOS), sonst neu anlegen
  const own = primed?.blob === blob ? primed : null;
  primed = null;
  const url = own?.url || URL.createObjectURL(blob);
  const v = own?.v || makeVideo(url);
  let ctx = own?.ctx || null;
  try {
    if (!(v.readyState >= 1)) await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error('Die Tonspur des Videos lässt sich nicht lesen.'));
    });
    v.currentTime = 0;
    const dur = v.duration;
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    if (ctx.state !== 'running') throw new Error('Ton blockiert: bitte auf den Knopf tippen, dann startet das Mithören.');
    const src = own?.src || ctx.createMediaElementSource(v);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let n = 0;
    proc.onaudioprocess = e => {
      if (v.paused || v.currentTime === 0) return; // erst ab echtem Abspielen, sonst ist alles um die Startverzögerung versetzt
      const c = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(c); n += c.length;
      e.outputBuffer.getChannelData(0).fill(0); // stumm, nur mitschneiden
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    v.preservesPitch = false; v.webkitPreservesPitch = false; v.mozPreservesPitch = false;
    const speed = rate();
    v.playbackRate = speed;
    v.muted = false;
    v.volume = 1;
    const tick = setInterval(() => onProgress(`Höre Tonspur ab … ${Math.round((v.currentTime / dur) * 100)} %`), 500);
    try {
      try { await v.play(); } catch { throw new Error('Ton blockiert: bitte auf den Knopf tippen, dann startet das Mithören.'); }
      await new Promise((resolve, reject) => {
        v.onended = resolve;
        v.onerror = () => reject(new Error('Wiedergabe abgebrochen'));
        setTimeout(() => reject(new Error('Mithören dauert zu lange')), (dur / speed + 30) * 1000);
        // hängt die Wiedergabe (z. B. vom Handy angehalten), nicht ewig warten. Lädt das Video noch (readyState < 3,
        // am iPhone bei großen Dateien mehrere Sekunden) oder hat iOS es pausiert, erst nachladen bzw. weiterspielen,
        // abgebrochen wird nach 20 s ohne Fortschritt (vorher 4 s, das reichte am iPhone oft nicht)
        let last = -1, still = 0;
        const watch = setInterval(() => {
          if (v.ended) { clearInterval(watch); return; }
          if (v.paused) v.play().catch(() => {});
          if (v.currentTime === last) { if (++still >= 40) { clearInterval(watch); reject(new Error('Mithören hängt. Bitte erneut auf den Knopf tippen.')); } } else { still = 0; last = v.currentTime; }
        }, 500);
        v.addEventListener('ended', () => clearInterval(watch), { once: true });
      });
    } finally {
      clearInterval(tick);
    }
    proc.disconnect(); src.disconnect();
    // zusammensetzen und von der effektiven Rate (Kontext-Rate / Tempo) auf die Zielrate umrechnen
    const raw = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { raw.set(c, o); o += c.length; }
    // Kam überhaupt Ton an? (Manche Handy-Browser leiten den Ton eines Videos nicht in Web Audio weiter)
    let e = 0;
    for (let i = 0; i < raw.length; i += 97) e += raw[i] * raw[i];
    if (!raw.length || Math.sqrt(e / Math.ceil(raw.length / 97)) < 1e-4) throw new Error('Beim Mithören kam kein Ton an. Bitte Lautlos-Schalter prüfen oder am Rechner erkennen.');
    const effRate = ctx.sampleRate / speed;
    heard.set(blob, { raw, rate: effRate });
    return resample(raw, effRate, sampleRate);
  } finally {
    ctx?.close();
    v.pause();
    v.remove();
    URL.revokeObjectURL(url);
  }
}
