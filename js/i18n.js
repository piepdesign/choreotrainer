// Sprachen: Deutsch ist die Quelle, alle Texte stehen deutsch im Code und laufen über tr(). Die anderen Sprachen
// liegen als Wörterbuch (deutscher Text → Übersetzung) unter js/lang/, geladen wird nur das gewählte.
// Tanz-Fachjargon bleibt in allen Sprachen englisch (Class, Choreo, Loop, Count, Tap, Style, Level, Coach).
// Die Wahl steht in localStorage („ct-lang“), damit sie vor dem ersten Rendern feststeht (wie das Theme).
// Ohne Wahl: Sprache des Geräts, falls angeboten, sonst Englisch. Wechsel = Seite neu laden.

export const LANGS = [['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano']];
const LOCALES = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT' };
const supported = l => LANGS.some(x => x[0] === l);

function detect() {
  try { const s = localStorage.getItem('ct-lang'); if (supported(s)) return s; } catch { /* privat */ }
  for (const l of navigator.languages || [navigator.language || '']) {
    const k = String(l).slice(0, 2).toLowerCase();
    if (supported(k)) return k;
  }
  return 'en';
}

export const lang = detect();
export const locale = LOCALES[lang];
export const langChosen = () => { try { return supported(localStorage.getItem('ct-lang')); } catch { return false; } };
document.documentElement.lang = lang;

const dict = lang === 'de' ? {} : (await import(`./lang/${lang}.js`)).default;

// tr('Gespeichert') · tr('{n} Choreos', { n: 3 }). Fehlt eine Übersetzung, bleibt der deutsche Text.
export function tr(de, vars) {
  let s = dict[de] ?? de;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}

// Zahl mit Einzahl/Mehrzahl in der gewählten Sprache: tn(2, 'Choreo', 'Choreos') → „2 Choreos“
// (Französisch zählt 0 und 1 als Einzahl)
export const tn = (n, one, many) => `${n} ${(lang === 'fr' ? n <= 1 : n === 1) ? tr(one) : tr(many)}`;

// Dezimalzahl im Format der Sprache (0,9 bzw. 0.9)
export const num = (v, digits) => Number(v).toLocaleString(locale, digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Wochentage: gespeichert wird immer das deutsche Kürzel (Mo … So), angezeigt die Sprache
const DAYS = {
  de: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  fr: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'],
  es: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
  it: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'],
};
export const dayLabel = code => { const i = DAYS.de.indexOf(code); return i < 0 ? (code || '') : DAYS[lang][i]; };

// Sprache wählen: merken und neu laden (Texte, die beim Laden einmal gebaut werden, kommen so mit).
// Die Scrollposition kommt mit (app.js stellt sie nach dem Aufbau wieder her)
export function setLang(l) {
  if (!supported(l)) return;
  try {
    localStorage.setItem('ct-lang', l);
    sessionStorage.setItem('ct-scroll', JSON.stringify({ hash: location.hash || '#/', y: scrollY }));
  } catch { /* privat */ }
  location.reload();
}
