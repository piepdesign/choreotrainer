// Einstieg: Router, Theme, globale Helfer
import { renderHub, renderClass } from './hub.js';
import { renderUpload } from './upload.js';
import { renderTrain } from './train.js';
import { requestPersist } from './db.js';
import { h } from './util.js';

export const state = { pendingFile: null };

const view = document.getElementById('view');
let cleanup = null;

const routes = [
  [/^#?\/?$/, () => renderHub(view), 'hub'],
  [/^#\/upload(?:\?(choreo|class)=([\w-]+))?$/, m => renderUpload(view, m[1], m[2]), 'upload'],
  [/^#\/class\/([\w-]+)$/, m => renderClass(view, m[1]), 'hub'],
  [/^#\/train\/([\w-]+)$/, m => renderTrain(view, m[1]), null],
];

// Eigener Verlauf für den „<“-Knopf (überlebt ein Neuladen des Tabs)
const backBtn = document.querySelector('.back-btn');
let trail = [];
try { trail = JSON.parse(sessionStorage.getItem('ct-trail')) || []; } catch { /* leer starten */ }
let replaceNext = false;

function remember(hash) {
  if (replaceNext && trail.length) trail[trail.length - 1] = hash;
  else if (trail[trail.length - 2] === hash) trail.pop();
  else if (trail[trail.length - 1] !== hash) trail.push(hash);
  replaceNext = false;
  trail = trail.slice(-50);
  try { sessionStorage.setItem('ct-trail', JSON.stringify(trail)); } catch { /* egal */ }
  backBtn.hidden = hash === '#/';
}

export function back() {
  location.hash = trail[trail.length - 2] || '#/';
}
backBtn.addEventListener('click', back);

async function route() {
  if (cleanup) { try { await cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const hash = location.hash || '#/';
  for (const [re, fn, nav] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    remember(hash.match(/^#?\/?$/) ? '#/' : hash);
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
    view.replaceChildren();
    window.scrollTo(0, 0);
    try {
      cleanup = (await fn(m)) || null;
    } catch (e) {
      console.error(e);
      view.replaceChildren(h('p.empty', `Fehler: ${e.message}`));
    }
    return;
  }
  location.hash = '#/';
}

// replace: aktuelle Seite im Verlauf ersetzen (z. B. Upload → Training)
export function go(hash, { replace = false } = {}) {
  if (location.hash === hash) { route(); return; }
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

// Hell/Dunkel: ohne gespeicherte Wahl folgt die App dem System
document.querySelector('.theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('ct-theme', next); } catch { /* privat-Modus */ }
});

// Dateien, die irgendwo außerhalb einer Dropzone landen, nicht im Tab öffnen
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());

addEventListener('hashchange', route);
requestPersist();
route();
