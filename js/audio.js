// Tonspur eines Videos (oder einer Songdatei) als Samples in gewünschter Abtastrate.
// Weg 1: decodeAudioData (schnell, liest die ganze Datei). Klappt auf Handys oft nicht: Safari/iOS kann
// .mov-Videos so nicht entschlüsseln, und große Videos sprengen dort den Speicher.
// Weg 2 (Ersatz): Video unsichtbar abspielen und den Ton über Web Audio mitschneiden. Doppelte Geschwindigkeit
// ohne Tonhöhenkorrektur: Der Ton ist nur gestaucht, die Samples werden danach auf die Zielrate umgerechnet.

const MOBILE_LIMIT = 150e6; // ab dieser Größe auf Handys gleich Weg 2 (Speicher)
const RATE = 2; // Abspielgeschwindigkeit beim Mitschneiden

const touch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

// gibt ein Objekt wie AudioBuffer zurück: { duration, sampleRate, numberOfChannels, getChannelData(c) }
export async function decodeAudio(blob, sampleRate, onProgress = () => {}) {
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
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  document.body.append(v);
  let ctx = null;
  try {
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error('Die Tonspur des Videos lässt sich nicht lesen.'));
    });
    const dur = v.duration;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    if (ctx.state !== 'running') throw new Error('Ton blockiert: bitte auf „Aus Video erkennen“ tippen, dann startet das Mithören.');
    const src = ctx.createMediaElementSource(v);
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
    v.playbackRate = RATE;
    v.muted = false;
    v.volume = 1;
    const tick = setInterval(() => onProgress(`Höre Tonspur ab … ${Math.round((v.currentTime / dur) * 100)} %`), 500);
    try {
      await v.play();
      await new Promise((resolve, reject) => {
        v.onended = resolve;
        v.onerror = () => reject(new Error('Wiedergabe abgebrochen'));
        setTimeout(() => reject(new Error('Mithören dauert zu lange')), (dur / RATE + 30) * 1000);
      });
    } finally {
      clearInterval(tick);
    }
    proc.disconnect(); src.disconnect();
    // zusammensetzen und von der effektiven Rate (Kontext-Rate / Tempo) auf die Zielrate umrechnen
    const raw = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { raw.set(c, o); o += c.length; }
    const effRate = ctx.sampleRate / RATE;
    const ratio = effRate / sampleRate;
    const outLen = Math.floor(raw.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio, k = Math.floor(x), f = x - k;
      out[i] = raw[k] * (1 - f) + (raw[k + 1] ?? raw[k]) * f;
    }
    return { duration: outLen / sampleRate, sampleRate, numberOfChannels: 1, length: outLen, getChannelData: () => out };
  } finally {
    ctx?.close();
    v.pause();
    v.remove();
    URL.revokeObjectURL(url);
  }
}
