// Tutorial: führt Schritt für Schritt durch die App. Der Rest der Seite wird abgedunkelt, die markierte Stelle
// bleibt frei. Weiter geht es nur per Klick auf die markierte Stelle (nicht auf einen Weiter-Knopf).
// Teil 1 (Base, Profil, Einstellungen) läuft nach dem Intro, Teil 2 beim ersten Öffnen einer Choreo.
import { h, tt } from './util.js';
import { settings, saveSettings } from './settings.js';
import { icon, themeIcon } from './ui.js';

let active = false;
export const tourActive = () => active;

const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));
// Text eines Schritts: Liste aus [Stichwort, Erklärung] (zum schnellen Erfassen) oder einfacher Satz
// Stichwort als Icon bzw. Knopf, so wie er in der App aussieht
const ico = name => h('span.tour-ico', { html: icon(name) });
const svgIco = svg => h('span.tour-ico', { html: svg || '' });
const chip = text => h('span.tour-chip', text);
const fill = (el, content) => el.replaceChildren(Array.isArray(content)
  ? h('dl.tour-list', content.flatMap(([k, v]) => k == null ? [h('dd.tour-note', v)] : [h('dt', k), h('dd', v)])) // ohne Stichwort: Zusatz über die volle Breite
  : content);

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
// scope: Teil gilt nur auf diesen Seiten; wer sie verlässt, beendet ihn (ohne ihn als gesehen zu markieren)
export function runTour(steps, { finish, onEnd, scope = null } = {}) {
  if (active) return Promise.resolve();
  active = true;
  // offene Menüs (Leiste, Ansicht, Helfer*in) schließen: alle gehen bei Klick daneben zu. Später fängt die Sperre
  // unten solche Klicks ab, ein offenes Menü könnte sonst die markierte Stelle verdecken.
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const spot = h('div.tour-spot');
  const num = h('span.label.tour-num');
  const title = h('h3.p-sub.tour-title');
  const text = h('div.tour-text');
  const skip = h('button.linkbtn', { type: 'button' }, 'Überspringen');
  const card = h('div.tour-card', { role: 'dialog', 'aria-live': 'polite' },
    h('div.tour-top', num, skip), title, text, h('p.label.tour-hint', tt('Klicke auf die markierte Stelle', 'Tippe auf die markierte Stelle')));
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
    removeEventListener('hashchange', onHash);
    root.remove();
    document.body.classList.remove('touring');
    active = false;
    resolveStep?.();
  }
  skip.addEventListener('click', () => { end(); onEnd?.(false); });
  const onHash = () => { if (scope && !scope.test(location.hash)) end(); };
  addEventListener('hashchange', onHash);

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
      fill(text, typeof step.text === 'function' ? step.text() : step.text);
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
    const body = h('div.tour-text'); fill(body, text);
    const box = h('div.modal.tour-done', h('div.modal-card', h('h2.wide', title), body, h('div.actions', ok)));
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
  const tap = tt('Klick', 'Tippen');
  return runTour([
    { route: /^#\/?$/, target: '.dropzone', block: true, title: 'Neue Choreo', text: [
      ['Video', tt('aus dem Kurs hier ablegen oder klicken', 'aus dem Kurs antippen und auswählen')],
      ['Ergebnis', 'eine Choreo zum Üben']] },
    { route: /^#\/?$/, target: '.stats', block: true, title: 'Statistiken', text: [
      ['Kacheln', 'Kennzahlen zu deinem Üben'],
      [tap, 'passende Auswertung im Profil']] },
    { route: /^#\/?$/, target: '.stripes', block: true, when: () => !!document.querySelector('.stripes .stripe'), title: 'Classes', text: [
      ['Farbe', 'eine je Class'],
      [tap, 'Class mit allen Choreos'],
      [tt('Ziehen', 'Halten + Ziehen'), 'Reihenfolge sortieren']] },
    { target: '[data-nav="profile"]', title: 'Profil', text: [['Auswertungen', 'Übungszeit · Status · alle Choreos']] },
    { route: /^#\/profile/, target: '.p-nav', title: 'Reiter', text: [['Wechseln', 'Übersicht · Übungszeit · Status · Choreos']] },
    { target: '[data-nav="settings"]', title: 'Einstellungen', text: () => [[svgIco(document.querySelector('[data-nav="settings"] svg')?.outerHTML), 'Musikprovider · Hörprobe · Statistiken der Base · Classes verwalten · Konto']] },
    { route: /^#\/settings/, target: '.theme-toggle', block: true, title: 'Ansicht', text: [
      [svgIco(themeIcon('light')), 'Hell'],
      [svgIco(themeIcon('dark')), 'Dunkel'],
      [svgIco(themeIcon('system')), 'System, folgt dem Gerät'],
      [null, 'Jederzeit umschaltbar.']] },
    { target: '[data-nav="hub"]', title: 'Base', text: [['Start', 'für jede neue Choreo']] },
  ], {
    finish: { title: 'GESCHAFFT!', text: [
      ['Teil 2', 'zeigt die Trainingsansicht, sobald du deine erste Choreo öffnest'],
      ['Wiederholen', 'Einstellungen › Konto']] },
    onEnd: () => saveSettings({ tourDone: true }),
  });
}

export function trainTour() {
  const tap = tt('Klick', 'Tippen');
  const key = k => tt(` (${k})`, ''); // Tastenkürzel nur am Rechner
  return runTour([
    { target: '.stage', block: true, title: 'Video', text: [
      [tap, 'Play/Pause'],
      [tt('Doppelklick', 'doppelt Tippen'), 'Vollbild']] },
    { target: '.timeline .tl-row:first-child .track', block: true, title: 'Zeitleiste', text: [
      [`${tap} / Ziehen`, 'an eine Stelle springen'],
      ['Zeigt', 'Marker und Loop']] },
    { target: '.track.eights', block: true, title: '8er-Count', text: [
      ['Feld', 'eine Acht'],
      [tap, 'loopt diese Acht'],
      ['Ziehen', 'loopt mehrere hintereinander']] },
    // Bedienleiste: je Gruppe ein Schritt, von links nach rechts
    { target: '.controls > .ctl-group:nth-child(1)', block: true, title: 'Wiedergabe', text: [
      [ico('play'), `Play / Pause${key('Leertaste')}`],
      [ico('tempo'), `Tempo, Tonhöhe bleibt gleich${key('↑ ↓')}`],
      [ico('vol2'), 'Lautstärke'],
      [ico('note'), `Ton von Video oder Songdatei${key('A')}, nur mit Songdatei`]] },
    { target: '.controls > .ctl-group:nth-child(2)', block: true, title: 'Loop', text: [
      [chip('In'), `Anfang an der aktuellen Stelle${key('I')}`],
      [chip('Out'), `Ende an der aktuellen Stelle${key('O')}`],
      [chip('Loop'), `wiederholt den Abschnitt${key('L')}`],
      [chip('×'), 'löscht In / Out'],
      [null, 'Ohne In / Out loopt er zwischen Start- und Ende-Marker.']] },
    { target: '.controls > .ctl-group:nth-child(3)', block: true, title: 'Count', text: [
      [chip('8er'), 'Zähler im Video ein / aus'],
      [chip('BPM'), 'Takt-Menü: Tempo, Verschieben, Klick, Anzeige'],
      [chip('1'), `zählt falsch? Bei der „1“ einer Acht pausieren und ${tt('drücken', 'antippen')}`],
      [chip('Tap'), `oder ab einer „1“ mind. 4× im Takt tippen${key('T')}`]] },
    { target: '.controls > .ctl-group:nth-child(4)', block: true, title: 'Bild', text: [
      [ico('mirror'), `Spiegeln, tanzen wie vor dem Spiegel${key('M')}`],
      [ico('image'), 'Helligkeit, Kontrast'],
      [ico('marker'), 'Marker: Start, Ende, Gedanke, Highlight'],
      [null, 'Start und Ende gibt es je einmal, sie begrenzen den Loop, solange kein In / Out gesetzt ist.']] },
    { target: '.controls > .ctl-group:nth-child(5)', block: true, title: 'Ansicht', text: [
      [ico('fitWidth'), 'volle Breite, oben / unten beschnitten'],
      [ico('fitAll'), 'ganzes Bild'],
      [ico('full'), `Vollbild${key('F')}`]] },
    { target: '.panel-btn', block: true, title: 'Seitenpanel', text: [
      [ico('panelOpen'), `ein- / ausblenden${key('P')}`],
      ['Darin', `Song · Marker · Notizen · Status · Aufnahmen${tt(' · Tasten', '')}`]] },
    { target: '.panel-sec[data-k="status"]', block: true, before: panelOpen, title: 'Status', text: [
      ['1 bis 5', 'wie gut du die Choreo schon kannst'],
      ['Daraus', 'dein Verlauf im Profil']] },
  ], {
    scope: /^#\/train\//,
    finish: { title: 'VIEL SPASS BEIM ÜBEN!', text: [tt(['Tastenkürzel', 'Seitenpanel › Tasten'], ['Song, Marker, Notizen, Status', 'Seitenpanel unter dem Video'])] },
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
