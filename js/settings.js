// Profil und Präferenzen (Store „settings“). Einmal laden, danach synchron lesbar.
import { db } from './db.js';

export const BASE_STATS = [
  ['last', 'Zuletzt geübt'],
  ['week', 'Übungszeit Woche'],
  ['total', 'Übungszeit gesamt'],
  ['status', 'Ø Status'],
  ['choreos', 'Choreos'],
  ['duration', 'Dauer gesamt'],
  ['streak', 'Serie'],
  ['classes', 'Classes'],
  ['recordings', 'Aufnahmen'],
  ['sessions', 'Einheiten'],
];
export const DEFAULT_STATS = ['last', 'week', 'total', 'status', 'choreos', 'duration'];

export const PANEL_SECTIONS = ['song', 'marker', 'notes', 'status', 'recs', 'keys'];

const DEFAULTS = {
  name: '',
  introDone: false,
  theme: 'system', // system | light | dark
  provider: null, // spotify | apple | tidal | ytmusic | deezer | amazon
  baseStats: DEFAULT_STATS,
  panel: { open: true, order: PANEL_SECTIONS, collapsed: [] },
  videoFit: 'all',
  hoverPreview: 'mid', // Hörprobe beim Hovern über Cover: off | low | mid | high (früher on = mid)
  tourDone: false, // Tutorial Teil 1 (Base, Profil, Einstellungen) gesehen
  tourTrainDone: false, // Tutorial Teil 2 (Trainingsansicht) gesehen
  tester: false, // Helfer*in: Knopf unten rechts für Bug-Meldungen und Ideen
};

let cache = null;

export async function loadSettings() {
  const stored = (await db.get('settings', 'profile')) || {};
  cache = { ...structuredClone(DEFAULTS), ...stored };
  cache.panel = { ...DEFAULTS.panel, ...(stored.panel || {}) };
  // neue Abschnitte, die es beim Speichern noch nicht gab, hinten anhängen
  cache.panel.order = [...cache.panel.order.filter(k => PANEL_SECTIONS.includes(k)), ...PANEL_SECTIONS.filter(k => !cache.panel.order.includes(k))];
  return cache;
}

export const settings = () => cache || structuredClone(DEFAULTS);

// Alles auf Anfang (Daten bleiben): Name, Präferenzen, Panel, Intro
export async function resetSettings() {
  cache = structuredClone(DEFAULTS);
  await db.put('settings', cache, 'profile');
  return cache;
}

export async function saveSettings(patch) {
  cache = { ...settings(), ...patch };
  await db.put('settings', cache, 'profile');
  dispatchEvent(new CustomEvent('ct-settings', { detail: patch })); // z. B. Tester-Knopf ein-/ausblenden
  return cache;
}

// Theme anwenden: System folgt prefers-color-scheme, sonst fest
export function applyTheme(theme = settings().theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try { localStorage.setItem('ct-theme', theme === 'system' ? '' : theme); } catch { /* egal */ }
}
