// Einstieg: Router, Theme, globale Helfer
import { renderHub, renderClass } from './hub.js';
import { renderUpload } from './upload.js';
import { renderTrain } from './train.js';
import { renderProfile } from './profile.js';
import { runIntro } from './intro.js';
import { requestPersist, undo, redo } from './db.js';
import { loadSettings, settings, saveSettings, applyTheme } from './settings.js';
import { h } from './util.js';
import { stopPreview } from './providers.js';
import { themeIcon, toolIcon } from './ui.js';
import { maybeTour } from './tour.js';

export const state = { pendingFile: null };

const view = document.getElementById('view');
let cleanup = null;

const routes = [
  [/^#?\/?$/, () => renderHub(view), 'hub'],
  [/^#\/upload(?:\?(choreo|class)=([\w-]+))?$/, m => renderUpload(view, m[1], m[2]), 'upload'],
  [/^#\/class\/([\w-]+)$/, m => renderClass(view, m[1]), 'hub'],
  [/^#\/train\/([\w-]+)$/, m => renderTrain(view, m[1]), null],
  [/^#\/profile(?:\/(\w+))?$/, m => renderProfile(view, m[1]), 'profile'],
  [/^#\/settings$/, () => renderProfile(view, 'settings'), 'settings'],
];

// Eigener Verlauf für den „<“-Knopf (überlebt ein Neuladen des Tabs)
const backBtn = document.querySelector('.back-btn');
let trail = [];
try { trail = JSON.parse(sessionStorage.getItem('ct-trail')) || []; } catch { /* leer starten */ }
let replaceNext = false;
let keepScroll = false;
let restoreY = null; // Scrollposition beim Zurückgehen
const scrolls = {}; // Hash → zuletzt gesehene Scrollposition
let current = null;
const save = () => { try { sessionStorage.setItem('ct-trail', JSON.stringify(trail)); } catch { /* egal */ } };

function remember(hash) {
  if (replaceNext && trail.length) trail[trail.length - 1] = hash;
  else if (trail[trail.length - 2] === hash) trail.pop();
  else if (trail[trail.length - 1] !== hash) trail.push(hash);
  replaceNext = false;
  trail = trail.slice(-50);
  save();
  backBtn.hidden = hash === '#/';
}

export function back() {
  const prev = trail[trail.length - 2] || '#/';
  restoreY = scrolls[prev] ?? null;
  location.hash = prev;
}

// Adresse ohne Neuaufbau ändern (z. B. Abschnitt im Profil), Verlauf zieht mit
export function replaceHash(hash) {
  history.replaceState(null, '', hash);
  if (trail.length) trail[trail.length - 1] = hash; else trail.push(hash);
  if (current) scrolls[hash] = scrollY;
  current = hash;
  save();
}
backBtn.addEventListener('click', back);

async function route() {
  stopPreview(); // Hörprobe nicht in die nächste Seite mitnehmen
  if (cleanup) { try { await cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  if (current) scrolls[current] = scrollY;
  const hash = location.hash || '#/';
  for (const [re, fn, nav] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    current = hash.match(/^#?\/?$/) ? '#/' : hash;
    remember(current);
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
    const y = keepScroll ? scrollY : 0;
    const back = restoreY;
    keepScroll = false;
    restoreY = null;
    view.replaceChildren();
    try {
      cleanup = (await fn(m)) || null;
    } catch (e) {
      console.error(e);
      view.replaceChildren(h('p.empty', `Fehler: ${e.message}`));
    }
    window.scrollTo(0, y);
    maybeTour(current); // Tutorial, falls noch nicht gesehen (Teil 1 auf der Base, Teil 2 im Training)
    // zurück: dort weiter, wo man war (nach dem Aufbau, auch gegen Abschnitts-Sprünge der Seite)
    if (back != null) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, back)));
    return;
  }
  location.hash = '#/';
}
// replace: aktuelle Seite im Verlauf ersetzen (z. B. Upload → Training)
// keep: Scrollposition behalten (z. B. nach dem Umsortieren der Classes)
export function go(hash, { replace = false, keep = false } = {}) {
  keepScroll = keep;
  if (location.hash === hash || (hash === '#/' && !location.hash)) { route(); return; }
  replaceNext = replace;
  if (replace) location.replace(hash); else location.hash = hash;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const t = h('div.toast', msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

// Ansicht in der Kopfleiste: Icon zeigt die gewählte Einstellung (System/Hell/Dunkel wie in den Einstellungen),
// Klick öffnet ein kleines Menü mit allen drei
const themeBtn = document.querySelector('.theme-toggle');
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const THEMES = [['light', 'Hell'], ['dark', 'Dunkel'], ['system', 'System']];
const currentTheme = () => { try { return localStorage.getItem('ct-theme') || 'system'; } catch { return 'system'; } };
function syncThemeIcon() {
  const t = currentTheme();
  themeBtn.innerHTML = themeIcon(t);
  themeBtn.title = `Ansicht: ${THEMES.find(x => x[0] === t)[1]}`;
}
new MutationObserver(syncThemeIcon).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
darkMq.addEventListener('change', syncThemeIcon);
syncThemeIcon();

// Hell/Dunkel: Umschalten in der Kopfleiste wird zur neuen Standardansicht (auch im Profil einstellbar)
let themeMenu = null;
const closeThemeMenu = () => { themeMenu?.remove(); themeMenu = null; };
themeBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (themeMenu) { closeThemeMenu(); return; }
  const cur = currentTheme();
  themeMenu = h('div.theme-menu', { role: 'menu' }, THEMES.map(([id, label]) => h(`button${id === cur ? '.on' : ''}`, {
    type: 'button', role: 'menuitemradio', 'aria-checked': String(id === cur),
    onclick: () => { applyTheme(id); saveSettings({ theme: id }); syncThemeIcon(); closeThemeMenu(); },
  }, h('i', { html: themeIcon(id, 16) }), label)));
  themeBtn.after(themeMenu);
});
addEventListener('pointerdown', e => { if (themeMenu && !themeMenu.contains(e.target) && e.target !== themeBtn && !themeBtn.contains(e.target)) closeThemeMenu(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeThemeMenu(); });

// ── Helfer*in: Knopf unten rechts, klappt „Bug“ und „Idee“ aus, beide öffnen eine vorbereitete Mail ──
const FEEDBACK_TO = 'sagmal@piep.design';
const mail = (subject, intro) => `mailto:${FEEDBACK_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${intro}\n\n• `)}`;
const FEEDBACK = [
  ['bug', 'Bug melden', mail('Bug Report: CHOREO–TRAINER©', 'Folgender Bug ist mir aufgefallen:')],
  ['idea', 'Idee oder Wunsch', mail('Idee/Wunsch: CHOREO–TRAINER©', 'Folgende Idee oder Wunsch habe ich:')],
];
let testerFab = null;
function syncTester() {
  const on = !!settings().tester;
  if (!on) { testerFab?.remove(); testerFab = null; return; }
  if (testerFab) return;
  const main = h('button.fab-main', { type: 'button', title: 'Bug melden oder Idee schicken', 'aria-label': 'Helfer-Menü', 'aria-expanded': 'false', html: toolIcon('clipboard') });
  testerFab = h('div.tester-fab',
    ...FEEDBACK.map(([id, label, href], i) => h('a.fab-action', { href, title: label, 'aria-label': label, style: { '--i': i + 1 }, html: toolIcon(id), onclick: () => setTimeout(close, 300) })),
    main);
  const close = () => { testerFab?.classList.remove('open'); main.setAttribute('aria-expanded', 'false'); };
  main.addEventListener('click', () => { const open = testerFab.classList.toggle('open'); main.setAttribute('aria-expanded', String(open)); });
  addEventListener('pointerdown', e => { if (testerFab && !testerFab.contains(e.target)) close(); });
  document.body.append(testerFab);
}
addEventListener('ct-settings', e => { if ('tester' in (e.detail || {})) syncTester(); });

// Dateien, die irgendwo außerhalb einer Dropzone landen, nicht im Tab öffnen
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());

addEventListener('hashchange', route);
requestPersist();

// ⌘Z / Strg+Z rückgängig, ⌘⇧Z / Strg+⇧Z wiederherstellen. In Textfeldern gilt das eigene Rückgängig des Feldes.
let undoBusy = false;
addEventListener('keydown', async e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.body.classList.contains('intro-open')) return;
  e.preventDefault();
  if (undoBusy) return;
  undoBusy = true;
  try {
    // Erst die Ansicht ihren Stand sichern lassen (noch ausstehende Änderung zählt als letzter Schritt),
    // dann zurückdrehen und neu aufbauen
    if (cleanup) { const c = cleanup; cleanup = null; await c(); }
    const done = await (e.shiftKey ? redo() : undo());
    toast(done ? (e.shiftKey ? 'Wiederhergestellt' : 'Rückgängig gemacht') : (e.shiftKey ? 'Nichts zum Wiederherstellen' : 'Nichts zum Rückgängigmachen'), 1600);
    keepScroll = true;
    await route();
  } catch (err) {
    console.error(err);
    toast(`Rückgängig fehlgeschlagen: ${err.message}`);
  } finally {
    undoBusy = false;
  }
});

// Start: Einstellungen laden, beim ersten Öffnen das Intro, dann die Seite
(async () => {
  try { await loadSettings(); } catch (e) { console.error(e); }
  applyTheme();
  if (!settings().introDone) await runIntro();
  document.documentElement.classList.remove('booting');
  syncTester();
  route();
})();
