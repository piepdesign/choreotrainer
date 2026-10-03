// Tutorial: führt Schritt für Schritt durch die App. Der Rest der Seite wird abgedunkelt, die markierte Stelle
// bleibt frei. Weiter geht es nur per Klick auf die markierte Stelle (nicht auf einen Weiter-Knopf).
// Teil 1 (Base, Profil, Einstellungen) läuft nach dem Intro, Teil 2 beim ersten Öffnen einer Choreo.
import { h } from './util.js';
import { settings, saveSettings } from './settings.js';

let active = false;
export const tourActive = () => active;

const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));

// Wartet, bis das Element des Schritts auf der Seite steht (z. B. nach einem Seitenwechsel), max. 8 s
async function find(step) {
  for (let i = 0; i < 80; i++) {
    if (!step.route || step.route.test(location.hash || '#/')) {
      const el = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
      if (visible(el)) return el;
    }
    await wait(100);
  }
  return null;
}

// steps: [{ target, title, text, route?, block?, when?, before? }]
// block: Klick auf die Stelle löst die eigentliche Aktion nicht aus (z. B. Dateiauswahl), führt nur weiter
export function runTour(steps, { finish, onEnd } = {}) {
  if (active) return Promise.resolve();
  active = true;
  const spot = h('div.tour-spot');
  const num = h('span.label.tour-num');
  const title = h('h3.p-sub.tour-title');
  const text = h('p.tour-text');
  const skip = h('button.linkbtn', { type: 'button' }, 'Überspringen');
  const card = h('div.tour-card', { role: 'dialog', 'aria-live': 'polite' },
    h('div.tour-top', num, skip), title, text, h('p.label.tour-hint', 'Klicke auf die markierte Stelle'));
  const root = h('div.tour', spot, card);
  document.body.append(root);
  document.body.classList.add('touring');

  let target = null, step = null, raf = 0, resolveStep = null;
  const list = steps;

  // Markierung und Textkarte folgen der Stelle (Scrollen, Größe, Umbau der Seite)
  function place() {
    raf = requestAnimationFrame(place);
    if (!target?.isConnected) return;
    const r = target.getBoundingClientRect(), pad = 6;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    const below = r.bottom + pad + gap + ch < innerHeight;
    const top = below ? r.bottom + pad + gap : Math.max(12, r.top - pad - gap - ch);
    const left = Math.min(innerWidth - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2));
    Object.assign(card.style, { left: `${left}px`, top: `${Math.min(top, innerHeight - ch - 12)}px` });
  }

  // Klicks außerhalb der markierten Stelle und der Karte sperren; Klick auf die Stelle führt weiter
  const guard = e => {
    if (card.contains(e.target)) return;
    if (target && target.contains(e.target)) {
      // block: auch Drücken/Ziehen nicht an die Seite weitergeben (z. B. keinen Loop über die Achten setzen)
      if (step.block) { e.preventDefault(); e.stopPropagation(); }
      if (e.type === 'click') {
        const done = resolveStep; resolveStep = null;
        setTimeout(() => done?.(), step.block ? 0 : 60);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onKey = e => { if (e.key === 'Escape') end(true); };
  ['click', 'pointerdown', 'mousedown', 'dblclick'].forEach(t => addEventListener(t, guard, true));
  addEventListener('keydown', onKey, true);
  let stopped = false;
  function end() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    ['click', 'pointerdown', 'mousedown', 'dblclick'].forEach(t => removeEventListener(t, guard, true));
    removeEventListener('keydown', onKey, true);
    root.remove();
    document.body.classList.remove('touring');
    active = false;
    resolveStep?.();
  }
  skip.addEventListener('click', () => { end(); onEnd?.(false); });

  return (async () => {
    place();
    for (let i = 0; i < list.length && !stopped; i++) {
      step = list[i];
      if (step.when && !step.when()) continue; // z. B. noch keine Classes
      await step.before?.();
      target = await find(step);
      if (!target || stopped) continue; // Stelle nicht da (z. B. keine Classes): Schritt auslassen
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      num.textContent = `${i + 1} / ${list.length}`;
      title.textContent = step.title;
      text.textContent = step.text;
      card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
      await new Promise(r => { resolveStep = r; });
    }
    if (stopped) return;
    end();
    if (finish) await confirmBox(finish);
    onEnd?.(true);
  })();
}

// Kurzes Bestätigungsfenster am Ende
function confirmBox({ title, text, button = 'Los geht’s' }) {
  return new Promise(resolve => {
    const ok = h('button.btn.primary', { type: 'button' }, button);
    const box = h('div.modal.tour-done', h('div.modal-card', h('h2.wide', title), h('p', text), h('div.actions', ok)));
    const close = () => { box.remove(); resolve(); };
    ok.addEventListener('click', close);
    box.addEventListener('click', e => { if (e.target === box) close(); });
    document.body.append(box);
    ok.focus();
  });
}

// ── Inhalte ──
const panelOpen = () => {
  const t = document.querySelector('.train');
  if (t?.classList.contains('panel-closed')) document.querySelector('.panel-btn')?.click();
};

export function mainTour() {
  return runTour([
    { route: /^#\/?$/, target: '.dropzone', block: true, title: 'Neue Choreo', text: 'Lege hier ein Video aus dem Kurs ab oder klicke zum Auswählen. Daraus wird eine Choreo zum Üben.' },
    { route: /^#\/?$/, target: '.stats', block: true, title: 'Deine Statistiken', text: 'Kennzahlen zu deinem Üben. Ein Klick auf eine Kachel führt später zur passenden Auswertung im Profil.' },
    { route: /^#\/?$/, target: '.stripes', block: true, when: () => !!document.querySelector('.stripes .stripe'), title: 'Deine Classes', text: 'Jede Class mit eigener Farbe. Klick öffnet die Class mit allen Choreos, Ziehen sortiert die Reihenfolge.' },
    { target: '[data-nav="profile"]', title: 'Profil', text: 'Hier findest du deine Auswertungen: Übungszeit, Status und alle Choreos.' },
    { route: /^#\/profile/, target: '.p-nav', title: 'Reiter', text: 'Wechsle zwischen Übersicht, Übungszeit, Status und Choreos. Klicke auf einen Reiter.' },
    { target: '[data-nav="settings"]', title: 'Einstellungen', text: 'Musikprovider, Hörprobe, Statistiken der Base, Classes verwalten und dein Konto.' },
    { route: /^#\/settings/, target: '.theme-toggle', block: true, title: 'Ansicht', text: 'Hier wechselst du jederzeit zwischen Hell, Dunkel und System.' },
    { target: '[data-nav="hub"]', title: 'Zurück zur Base', text: 'Von der Base aus startest du jede neue Choreo.' },
  ], {
    finish: { title: 'GESCHAFFT!', text: 'Du kennst jetzt die wichtigsten Stellen. Sobald du deine erste Choreo öffnest, zeigt dir ein kurzer zweiter Teil die Trainingsansicht. Wiederholen kannst du das Tutorial in den Einstellungen unter Konto.' },
    onEnd: () => saveSettings({ tourDone: true }),
  });
}

export function trainTour() {
  return runTour([
    { target: '.stage', block: true, title: 'Video', text: 'Klick spielt oder pausiert, Doppelklick öffnet das Vollbild.' },
    { target: '.timeline .tl-row:first-child .track', block: true, title: 'Zeitleiste', text: 'Klicken oder ziehen, um an eine Stelle zu springen. Marker und Loop siehst du hier ebenfalls.' },
    { target: '.track.eights', block: true, title: '8er-Count', text: 'Jedes Feld ist eine Acht. Klick loopt diese Acht, Ziehen markiert mehrere hintereinander.' },
    { target: '.controls .ctl[title^="Loop an/aus"]', block: true, title: 'Loop', text: 'Wiederholt einen Abschnitt: In/Out, sonst zwischen Start- und Ende-Marker (Taste L).' },
    { target: '.controls .ctl[title^="Spiegeln"]', block: true, title: 'Spiegeln', text: 'Spiegelt das Video, damit du wie vor dem Spiegel mittanzt (Taste M).' },
    { target: '.controls .ctl[title^="Tempo"]', block: true, title: 'Tempo', text: 'Langsamer üben, ohne dass sich die Tonhöhe ändert (Pfeiltasten ↑ ↓).' },
    { target: '.controls .ctl[title="Marker setzen"]', block: true, title: 'Marker', text: 'Setze Start, Ende, Gedanken und Highlights an der aktuellen Stelle.' },
    { target: '.panel-btn', block: true, title: 'Seitenpanel', text: 'Ein- und ausblenden. Darin: Song, Marker, Notizen, Status, Aufnahmen und Tasten.' },
    { target: '.panel-sec[data-k="status"]', block: true, before: panelOpen, title: 'Status', text: 'Bewerte von 1 bis 5, wie gut du die Choreo schon kannst. Daraus entsteht dein Verlauf im Profil.' },
  ], {
    finish: { title: 'VIEL SPASS BEIM ÜBEN!', text: 'Alle Tastenkürzel findest du jederzeit im Seitenpanel unter „Tasten“.' },
    onEnd: () => saveSettings({ tourTrainDone: true }),
  });
}

// Startet den passenden Teil, wenn er noch nicht gesehen wurde
export function maybeTour(hash) {
  if (active || document.body.classList.contains('intro-open')) return;
  const s = settings();
  if (!s.tourDone && /^#?\/?$/.test(hash)) setTimeout(() => { if (!active) mainTour(); }, 500);
  else if (s.tourDone && !s.tourTrainDone && /^#\/train\//.test(hash)) setTimeout(() => { if (!active && /^#\/train\//.test(location.hash)) trainTour(); }, 900);
}
