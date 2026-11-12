// Gleicher Song in mehreren Choreos (z. B. zwei Classes tanzen je eine eigene Choreo zum selben Song).
// Der Song steht weiter als Kopie in jeder Choreo, verbunden wird über songKey. Was zum Song gehört (Daten, Fassung,
// Songdatei, Takt), lässt sich teilen. Was zur Choreo gehört (Marker, Loop, Status, Übungszeit), nie.
import { db } from './db.js';
import { songKeyOf, sameSong } from './song.js';

const norm = s => String(s || '').trim().toLowerCase();

// Choreos mit demselben Song: gleicher Schlüssel (Deezer-ID bzw. Interpret|Titel) oder gleicher Titel und
// passender Interpret (z. B. einmal über Deezer gewählt, einmal von Hand eingetippt).
export function fitsSong(c, song) {
  if (!c.song || !song) return false;
  const artist = norm(song.artist), other = norm(c.song.artist);
  return c.songKey === songKeyOf(song) || (sameSong(c.song, song) && (!artist || !other || other.includes(artist) || artist.includes(other)));
}

// → [{ choreo, klass, recs }] (ohne exceptId)
export async function sameSongChoreos(song, exceptId = null) {
  const out = [];
  for (const c of (await db.all('choreos')).filter(c => c.id !== exceptId && fitsSong(c, song))) {
    const klass = await db.get('classes', c.classId);
    if (klass) out.push({ choreo: c, klass, recs: (await db.byIndex('recordings', 'choreoId', c.id)).length });
  }
  return out;
}

// Songdatei der Choreo, sonst die einer anderen Choreo mit demselben Song (keine Kopie, spart Speicher).
// → { blob, from } · from = Choreo, von der die Datei kommt (null = eigene), blob null = keine
export async function songFileFor(choreo) {
  const own = await db.get('videos', `song:${choreo.id}`);
  if (own) return { blob: own, from: null };
  if (!choreo.song) return { blob: null, from: null };
  for (const c of (await db.all('choreos')).filter(c => c.id !== choreo.id && fitsSong(c, choreo.song))) {
    const blob = await db.get('videos', `song:${c.id}`);
    if (blob) return { blob, from: c };
  }
  return { blob: null, from: null };
}

// Vor dem Löschen einer Choreo: Ihre Songdatei an eine andere Choreo mit demselben Song ohne eigene Datei weitergeben,
// damit sie dort nicht verloren geht. → die übernehmende Choreo oder null
export async function handOverSongFile(choreo) {
  const blob = choreo?.song && await db.get('videos', `song:${choreo.id}`);
  if (!blob) return null;
  const others = (await db.all('choreos')).filter(c => c.id !== choreo.id && fitsSong(c, choreo.song));
  if (!others.length) return null;
  for (const c of others) if (await db.get('videos', `song:${c.id}`)) return null; // dort liegt schon eine, die gilt dann für alle
  await db.put('videos', blob, `song:${others[0].id}`);
  return others[0];
}
