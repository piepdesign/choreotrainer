// Kennzahlen aus den gespeicherten Daten. Genutzt von Base (Kacheln) und Profil (Details).
import { tr, tn, num } from './i18n.js';
import { fmtDuration, relDate } from './util.js';

const DAY = 86400000;

export const latestRating = c => (c.ratings?.length ? c.ratings[c.ratings.length - 1].value : null);

// Beginn der Kalenderwoche (Montag 0:00)
export function weekStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export const dayKey = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Länge einer Choreo: Start- bis Ende-Marker der neuesten Aufnahme, sonst Loop In/Out, sonst null
export function choreoLength(recs) {
  for (const r of [...(recs || [])].sort((a, b) => b.recordedAt - a.recordedAt)) {
    const s = r.markers?.find(m => m.type === 'start')?.t, e = r.markers?.find(m => m.type === 'end')?.t;
    if (s != null && e != null && e > s) return e - s;
    const a = r.player?.loopIn, b = r.player?.loopOut;
    if (a != null && b != null && b > a) return b - a;
  }
  return null;
}

// Tage in Folge mit Übung (mind. 30 s). Heute noch nicht geübt bricht die Serie nicht.
export function practiceStreak(sessions) {
  const days = new Set(sessions.filter(s => s.seconds >= 30).map(s => dayKey(s.start)));
  let d = dayKey(Date.now());
  if (!days.has(d)) d -= DAY;
  let n = 0;
  while (days.has(d)) { n++; d = dayKey(d - DAY / 2); }
  return n;
}

const fmtMin = sec => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);

// → { id: { value, hint } } für alle Kacheln
export function baseStats({ classes, choreos, recordings, sessions, recsByChoreo }) {
  const total = sessions.reduce((s, x) => s + x.seconds, 0);
  const ws = weekStart();
  const week = sessions.filter(s => s.start >= ws).reduce((s, x) => s + x.seconds, 0);
  const last = sessions.reduce((m, s) => Math.max(m, s.start), 0);
  const rated = choreos.map(latestRating).filter(Boolean);
  const avg = rated.length ? num(rated.reduce((a, b) => a + b, 0) / rated.length, 1) : '—';
  const lengths = choreos.map(c => choreoLength(recsByChoreo[c.id]));
  const known = lengths.filter(x => x != null);
  const streak = practiceStreak(sessions);
  return {
    last: { value: relDate(last) },
    week: { value: fmtDuration(week) },
    total: { value: fmtDuration(total) },
    status: { value: avg === '—' ? avg : `${avg} / 5` },
    choreos: { value: String(choreos.length) },
    duration: {
      value: known.length ? fmtMin(known.reduce((a, b) => a + b, 0)) : '—',
      hint: known.length < choreos.length ? tr('{n} von {total} mit Start/Ende', { n: known.length, total: tn(choreos.length, 'Choreo', 'Choreos') }) : tr('aus Start/Ende bzw. In/Out'),
    },
    streak: { value: streak ? tn(streak, 'Tag', 'Tage') : '—' },
    classes: { value: String(classes.length) },
    recordings: { value: String(recordings.length) },
    sessions: { value: String(sessions.filter(s => s.seconds >= 30).length) },
  };
}
