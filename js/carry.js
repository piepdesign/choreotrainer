// Neue Aufnahme zu einer bestehenden Choreo: Marker, Loop, 8er (Tempo und „1“), Start/Ende und Ansicht der zuletzt
// gespeicherten Aufnahme übernehmen. Aufnahmen beginnen an verschiedenen Stellen im Song und sind verschieden lang,
// deshalb wird jede Zeit über die gemeinsame Songposition umgerechnet, nicht über die Länge.
// Versatz (wo liegt der Anfang der neuen Aufnahme in der alten?), der Reihe nach:
//  1. Tonspuren der beiden Videos gegeneinander abgleichen (gleiche Musik im Kurs, auf ~12 ms genau)
//  2. Startpunkte im Song (Shazam oder Songdatei) beider Aufnahmen: Versatz = neuer Start − alter Start
// Klappt beides nicht, werden nur zeitunabhängige Werte übernommen (Spiegeln, Tempo der Wiedergabe, Count an/aus).
// Nicht übernommen: Status/Bewertung (gehört zur Choreo, bleibt wie er ist), Notizen, Titel, Übungszeiten, Bild
// (Helligkeit/Kontrast hängen am Video), Lautstärke.
import { db, uid } from './db.js';
import { alignToSong } from './align.js';
import { needsCapture } from './audio.js';

// gleiche Schwellen wie beim Abgleich mit der Songdatei (song.js)
const MIN_CONF = 1.25, MIN_PEAK = 0.12;

const hasContent = r => r.markers?.length || r.player?.bpm || r.player?.loopIn != null || r.player?.loopOut != null;

// zuletzt gespeicherte Aufnahme der Choreo mit etwas zum Übernehmen
export async function carrySource(choreoId, exceptId = null) {
  const recs = (await db.byIndex('recordings', 'choreoId', choreoId)).filter(r => r.id !== exceptId && hasContent(r));
  recs.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return recs[0] || null;
}

// → { shift, how } · neue Zeit = alte Zeit − shift
async function offsetBetween(src, rec, blob) {
  const srcBlob = await db.get('videos', src.id).catch(() => null);
  if (srcBlob && !needsCapture(srcBlob) && !needsCapture(blob)) {
    try {
      const r = await alignToSong(blob, srcBlob);
      if (r && r.confidence >= MIN_CONF && r.peak >= MIN_PEAK) return { shift: r.offset, how: 'audio' };
    } catch (e) { console.warn('Abgleich der Aufnahmen', e); }
  }
  if (src.songOffset != null && rec.songOffset != null) return { shift: rec.songOffset - src.songOffset, how: 'song' };
  return null;
}

// Überträgt in rec (noch nicht gespeichert). blob = Video der neuen Aufnahme. → Zusammenfassung oder null
// beatOnly: nur den Takt (Tempo und „1“), z. B. von einer anderen Choreo zum selben Song. Marker, Loop und Ansicht
// gehören zur jeweiligen Choreo und bleiben weg.
export async function carryOver(src, rec, blob, { beatOnly = false } = {}) {
  if (!src) return null;
  const off = await offsetBetween(src, rec, blob);
  const d = rec.duration || Infinity;
  const inside = t => t >= 0 && t <= d;
  const p = src.player || {}, P = {};
  // zeitunabhängig
  for (const k of beatOnly ? ['bpm', 'manualBeat'] : ['bpm', 'manualBeat', 'countOn', 'click', 'mirror', 'rate']) if (p[k] !== undefined) P[k] = p[k];
  const out = { from: src.title, how: off?.how || null, markers: 0, loop: false, beat: !!p.bpm };
  if (off && beatOnly) {
    if (p.bpm) { const E = 480 / p.bpm, a = (p.anchor || 0) - off.shift; P.anchor = Math.round((((a % E) + E) % E) * 1000) / 1000; }
    if (rec.songOffset == null && src.songOffset != null) rec.songOffset = Math.round((src.songOffset + off.shift) * 100) / 100;
  } else if (off) {
    const map = t => Math.round((t - off.shift) * 1000) / 1000;
    rec.markers = (src.markers || []).map(m => ({ ...m, id: uid(), t: map(m.t) })).filter(m => inside(m.t));
    out.markers = rec.markers.length;
    if (p.bpm) {
      // „1“ verschieben und in die erste Acht legen (gleiche Phase, Count zählt gleich)
      const E = 480 / p.bpm, a = map(p.anchor || 0);
      P.anchor = Math.round((((a % E) + E) % E) * 1000) / 1000;
    }
    const lin = p.loopIn != null ? map(p.loopIn) : null, lout = p.loopOut != null ? map(p.loopOut) : null;
    // Loop nur, wenn er in der neuen Aufnahme liegt (angeschnitten: auf die Aufnahme kürzen)
    if ((lin == null || lin < d) && (lout == null || lout > 0) && (lin != null || lout != null)) {
      P.loopIn = lin == null ? null : Math.max(0, lin);
      P.loopOut = lout == null ? null : Math.min(d, lout);
      if (P.loopIn != null && P.loopOut != null && P.loopOut - P.loopIn < 0.2) { P.loopIn = P.loopOut = null; }
      else { P.loopOn = !!p.loopOn; out.loop = true; }
    }
    // Startpunkt im Song fehlt bei der neuen Aufnahme: aus der alten ableiten
    if (rec.songOffset == null && src.songOffset != null) rec.songOffset = Math.round((src.songOffset + off.shift) * 100) / 100;
    if (rec.fileOffset === undefined && src.fileOffset != null && off.how === 'audio') rec.fileOffset = src.fileOffset + off.shift;
    if (p.audio === 'song' && rec.fileOffset !== null) P.audio = 'song';
  } else {
    // ohne Versatz liegt die „1“ nicht fest: Takt lieber neu ermitteln lassen
    delete P.bpm; delete P.manualBeat;
    out.beat = false;
  }
  if (P.bpm) rec.beatTried = true; // übernommener Takt soll nicht von der automatischen Analyse überschrieben werden
  rec.player = { ...rec.player, ...P };
  rec.carriedFrom = { id: src.id, how: out.how };
  return out;
}
