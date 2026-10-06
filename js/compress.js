// Videos beim Hochladen verkleinern, damit mehr Aufnahmen in den Browser-Speicher passen.
// Umgerechnet wird im Browser (WebCodecs, Bibliothek Mediabunny unter vendor/mediabunny, MPL-2.0, wird erst hier
// geladen): höchstens 1080p (lange Seite 1920 px), Bildrate wie im Original bis 60 fps (wichtig für Zeitlupe), H.264,
// alle 1 s ein Schlüsselbild (schnelles Springen und Loopen). Der Ton wird unverändert übernommen, damit Songerkennung
// und Abgleich gleich bleiben. Geht es nicht (Browser kann es nicht, Video schon klein), bleibt das Original.
let lib = null;
const load = () => (lib ||= import('../vendor/mediabunny/mediabunny.min.mjs'));

const MAX_SIDE = 1920;
const BITRATE_1080P60 = 8e6;

// Liefert { promise, cancel }. promise ergibt { file, reason }: file = kleinere Datei oder null (dann das Original
// verwenden), reason = kurzer Grund dafür (wird beim Upload angezeigt).
// Am Handy: Bildschirm bleibt währenddessen an (Sperre hält die Umrechnung an). Steht sie still (kein Fortschritt,
// z. B. Gerät kann das Video nicht dekodieren), wird abgebrochen und das Original genommen statt endlos zu warten.
const STALL_MS = 25000;
export function compressVideo(file, onProgress = () => {}) {
  let conversion = null, cancelled = false, lock = null, watchdog = 0, stalled = false;
  const keep = reason => ({ file: null, reason });
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { stalled = true; conversion?.cancel().catch(() => {}); }, STALL_MS); };
  const promise = (async () => {
    if (!('VideoEncoder' in window)) return keep('Browser kann es nicht');
    navigator.wakeLock?.request('screen').then(l => { lock = l; if (cancelled) l.release(); }).catch(() => {});
    arm();
    const M = await load();
    const input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return keep('kein Videobild gefunden');
    if (cancelled) return keep('abgebrochen');
    const stats = await track.computePacketStats(120);
    const fps = stats.averagePacketRate || 30;
    const w0 = track.displayWidth, h0 = track.displayHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const width = even(w0 * k), height = even(h0 * k);
    const frameRate = fps > 61 ? 60 : undefined; // Zeitlupen-Aufnahmen (120/240 fps) auf 60
    const bitrate = Math.round(BITRATE_1080P60 * (width * height) / (1920 * 1080) * ((frameRate || fps) > 40 ? 1 : 0.75));
    if (k === 1 && stats.averageBitrate && stats.averageBitrate <= bitrate * 1.3) return keep('schon klein genug');
    if (!(await M.canEncodeVideo('avc', { width, height, bitrate }))) return keep('Gerät kann kein H.264 erzeugen');
    if (!(await track.canDecode())) return keep('Gerät kann dieses Videoformat nicht lesen');
    // fastStart aus: Inhaltsverzeichnis am Dateiende. Für lokale Wiedergabe egal, spart aber eine zweite Kopie
    // des ganzen Videos im Arbeitsspeicher (am iPhone sonst Absturzgefahr bei langen Videos)
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target: new M.BufferTarget() });
    conversion = await M.Conversion.init({
      input, output,
      video: { width, height, fit: 'contain', codec: 'avc', bitrate, keyFrameInterval: 1, ...(frameRate ? { frameRate } : {}) },
    });
    if (!conversion.isValid) return keep('Format wird nicht unterstützt');
    if (cancelled) return keep('abgebrochen');
    let last = -1;
    conversion.onProgress = p => { if (p > last + 0.001) { last = p; arm(); } onProgress(p); };
    onProgress(0);
    arm();
    await conversion.execute();
    const buf = output.target.buffer;
    if (!buf || buf.byteLength > file.size * 0.9) return keep('lohnt sich nicht');
    return { file: new File([buf], `${file.name.replace(/\.[^.]+$/, '')}.mp4`, { type: 'video/mp4', lastModified: file.lastModified }), reason: null };
  })().catch(e => {
    if (stalled) return keep('kam nicht voran');
    if (!cancelled) console.warn('Komprimieren nicht möglich, Original wird gespeichert', e);
    return keep(cancelled ? 'abgebrochen' : 'Fehler beim Umrechnen');
  }).finally(() => { clearTimeout(watchdog); lock?.release().catch(() => {}); });
  return { promise, cancel: () => { cancelled = true; clearTimeout(watchdog); conversion?.cancel().catch(() => {}); } };
}
