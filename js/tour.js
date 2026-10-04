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
const fill = (el, content) => !content ? el.replaceChildren() : el.replaceChildren(Array.isArray(content)
  ? h('dl.tour-list', content.flatMap(([k, v]) => k == null ? [h('dd.tour-note', ...[v].flat())] : [h('dt', k), h('dd', ...[v].flat())])) // ohne Stichwort: Zusatz über die volle Breite
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
// start: Begrüßung vor dem ersten Schritt (eigenes Fenster mit „Los geht’s“ / „Überspringen“)
export function runTour(steps, opts = {}) {
  if (active) return Promise.resolve();
  if (!opts.start) return tour(steps, opts);
  active = true;
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // offene Menüs schließen
  return confirmBox({ ...opts.start, skip: true }).then(go => {
    active = false;
    if (!go) { opts.onEnd?.(false); return; }
    return tour(steps, opts);
  });
}

function tour(steps, { finish, onEnd, scope = null } = {}) {
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
  // Schritte ohne passende Stelle (z. B. Tasten am Handy) gleich weglassen, damit die Zählung „x / n“ stimmt
  const list = steps.filter(st => !st.when || st.when());

  // Markierung und Textkarte folgen der Stelle (Scrollen, Größe, Umbau der Seite). Die Karte darf die Stelle nie
  // verdecken: unter, über, links oder rechts davon, je nachdem, wo Platz ist.
  const PAD = 6, GAP = 14, M = 12;
  function cardPos(r, cw, ch, side, below) {
    const cx = Math.min(innerWidth - cw - M, Math.max(M, r.left + r.width / 2 - cw / 2));
    const cy = Math.min(innerHeight - ch - M, Math.max(M, r.top));
    const left = r.left - PAD - GAP - cw >= M, right = r.right + PAD + GAP + cw <= innerWidth - M;
    // below: immer mittig unter der Stelle; ist darunter kein Platz, über ihren unteren Rand gelegt (großes Video)
    if (below) return [cx, Math.min(r.bottom + PAD + GAP, innerHeight - ch - M)];
    // side: Abschnitte im Seitenpanel, Karte daneben statt darunter (sonst liegt sie auf den nächsten Abschnitten)
    if (side && left) return [r.left - PAD - GAP - cw, cy];
    if (side && right) return [r.right + PAD + GAP, cy];
    if (r.bottom + PAD + GAP + ch <= innerHeight - M) return [cx, r.bottom + PAD + GAP];
    if (r.top - PAD - GAP - ch >= M - 1) return [cx, r.top - PAD - GAP - ch];
    if (left) return [r.left - PAD - GAP - cw, cy];
    if (right) return [r.right + PAD + GAP, cy];
    return [cx, M];
  }
  function place() {
    raf = requestAnimationFrame(place);
    if (!target?.isConnected) return;
    const r = target.getBoundingClientRect();
    Object.assign(spot.style, { left: `${r.left - PAD}px`, top: `${r.top - PAD}px`, width: `${r.width + PAD * 2}px`, height: `${r.height + PAD * 2}px` });
    const [x, y] = cardPos(r, card.offsetWidth, card.offsetHeight, step?.side, step?.below);
    Object.assign(card.style, { left: `${x}px`, top: `${y}px` });
  }
  // Hohe Stelle ohne Platz daneben (z. B. Song-Abschnitt am Handy): so scrollen, dass sie direkt unter der Karte beginnt
  function reveal() {
    const r = target.getBoundingClientRect(), cw = card.offsetWidth, ch = card.offsetHeight;
    const side = r.left - PAD - GAP - cw >= M || r.right + PAD + GAP + cw <= innerWidth - M;
    const fits = r.height + PAD * 2 + GAP + ch + M * 2 <= innerHeight;
    if (side || (fits && r.height < innerHeight * 0.4)) { target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    target.style.scrollMarginTop = `${M + ch + GAP + PAD}px`;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const t = target;
    setTimeout(() => { t.style.scrollMarginTop = ''; }, 1000);
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
      num.textContent = `${i + 1} / ${list.length}`;
      title.textContent = step.title;
      fill(text, typeof step.text === 'function' ? step.text() : step.text);
      card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
      reveal(); // nach dem Befüllen, damit die Kartengröße stimmt
      await new Promise(r => { resolveStep = r; });
    }
    if (stopped) return;
    end();
    if (finish) await confirmBox(finish);
    onEnd?.(true);
  })();
}

// Kurzes Bestätigungsfenster am Ende
function confirmBox({ title, text, button = 'Los geht’s', skip = false }) {
  return new Promise(resolve => {
    const ok = h('button.btn.primary', { type: 'button' }, button);
    const no = skip ? h('button.linkbtn', { type: 'button' }, 'Überspringen') : null;
    const body = h('div.tour-text'); fill(body, text);
    const box = h('div.modal.tour-done', h('div.modal-card', h('h2.wide', title), body, h('div.actions', ok, no)));
    const close = go => { box.remove(); resolve(go); };
    ok.addEventListener('click', () => close(true));
    no?.addEventListener('click', () => close(false));
    box.addEventListener('click', e => { if (e.target === box) close(!skip); }); // Begrüßung: daneben klicken = überspringen
    document.body.append(box);
    ok.focus();
  });
}

// ── Inhalte ──
const panelOpen = () => {
  const t = document.querySelector('.train');
  if (t?.classList.contains('panel-closed')) document.querySelector('.panel-btn')?.click();
};

// Tastenkürzel nur am Rechner; geschütztes Leerzeichen + nowrap, damit es nicht mitten im Kürzel umbricht
const key = k => tt(h('span.tour-kbd', ` (${k})`), '');
const IO = 'In / Out';

// Hinweis in der Begrüßung beider Teile
const REPEAT = [null, 'Das Tutorial kannst du jederzeit unter Einstellungen › Konto wiederholen.'];

// Grundsatz der Texte: beschreiben, was ein Element tut, nicht die Umstände drumherum
export function mainTour() {
  const tap = tt('Klick', 'Tippen');
  return runTour([
    { route: /^#\/?$/, target: '.dropzone', block: true, title: 'Neue Choreo', text: [
      [tt('Ablegen / Klick', 'Tippen'), 'Legt aus einem Kursvideo eine neue Choreo an']] },
    { route: /^#\/?$/, target: '.stats', block: true, title: 'Statistiken', text: [
      ['Kacheln', 'Zeigen Kennzahlen zu deinem Üben'],
      [tap, 'Öffnet die passende Auswertung im Profil']] },
    { route: /^#\/?$/, target: '.stripes', block: true, when: () => !!document.querySelector('.stripes .stripe'), title: 'Classes', text: [
      ['Streifen', 'Eine Class in ihrer Farbe'],
      [tap, 'Öffnet die Class mit allen Choreos'],
      [tt('Ziehen', 'Halten + Ziehen'), 'Sortiert die Classes']] },
    { target: '[data-nav="profile"]', title: 'Profil', text: [[tap, 'Zeigt Übungszeit, Status und alle Choreos']] },
    { route: /^#\/profile/, target: '.p-nav', title: 'Reiter', text: [[tap, 'Wechselt zwischen Übersicht, Übungszeit, Status und Choreos']] },
    { target: '[data-nav="settings"]', title: 'Einstellungen', text: () => [[svgIco(document.querySelector('[data-nav="settings"] svg')?.outerHTML), 'Musikprovider, Hörprobe, Statistiken der Base, Classes verwalten, Konto']] },
    { route: /^#\/settings/, target: '.theme-toggle', block: true, title: 'Ansicht', text: [
      [svgIco(themeIcon('light')), 'Hell'],
      [svgIco(themeIcon('dark')), 'Dunkel'],
      [svgIco(themeIcon('system')), 'Wie am Gerät eingestellt']] },
    { target: '[data-nav="hub"]', title: 'Base', text: [[tap, 'Führt zurück zur Startseite']] },
  ], {
    start: { title: 'TUTORIAL', text: [
      ['Teil 1', 'Base, Profil und Einstellungen'],
      ['Teil 2', 'Trainingsansicht, beim ersten Öffnen einer Choreo'],
      REPEAT] },
    finish: { title: 'GESCHAFFT!', text: [
      ['Teil 2', 'Zeigt die Trainingsansicht, sobald du deine erste Choreo öffnest']] },
    onEnd: () => saveSettings({ tourDone: true }),
  });
}

export function trainTour() {
  const tap = tt('Klick', 'Tippen');
  const sec = k => `.panel-sec[data-k="${k}"]`;
  return runTour([
    { target: '.stage', block: true, below: true, title: 'Video', text: [
      [tap, 'Play / Pause'],
      [tt('Doppelklick', 'Doppelt tippen'), 'Vollbild']] },
    { target: '.timeline .tl-row:first-child .track', block: true, title: 'Zeitleiste', text: [
      [`${tap} / Ziehen`, 'Springt an die Stelle'],
      ['Striche', 'Zeigen Marker und Loop']] },
    { target: '.track.eights', block: true, title: '8er-Count', text: [
      ['Feld', 'Eine Acht'],
      [tap, 'Loopt diese Acht'],
      ['Ziehen', 'Loopt mehrere Achten']] },
    // Bedienleiste: je Gruppe ein Schritt, von links nach rechts
    { target: '.controls > .ctl-group:nth-child(1)', block: true, title: 'Wiedergabe', text: [
      [ico('play'), ['Play / Pause', key('Leertaste')]],
      [ico('tempo'), ['Ändert das Tempo, die Tonhöhe bleibt', key('↑ ↓')]],
      [ico('vol2'), 'Lautstärke'],
      [ico('note'), ['Schaltet den Ton zwischen Video und Songdatei um', key('A')]]] },
    { target: '.controls > .ctl-group:nth-child(2)', block: true, title: 'Loop', text: [
      [chip('In'), ['Setzt den Anfang', key('I')]],
      [chip('Out'), ['Setzt das Ende', key('O')]],
      [chip('Loop'), ['Wiederholt den Abschnitt', key('L')]],
      [chip('×'), `Löscht ${IO}`],
      [null, `Ohne ${IO} loopt er zwischen Start- und Ende-Marker.`]] },
    { target: '.controls > .ctl-group:nth-child(3)', block: true, title: 'Count', text: [
      [chip('8er'), 'Blendet den Zähler ein oder aus'],
      [chip('BPM'), 'Takt-Menü: Tempo, Verschieben, Klick, Anzeige'],
      [chip('1'), ['Setzt den Anfangscount an der aktuellen Stelle', key('1')]],
      [chip('Tap'), ['BPM selbst im Takt eintippen', key('T')]]] },
    { target: '.controls > .ctl-group:nth-child(4)', block: true, title: 'Bild', text: [
      [ico('mirror'), ['Spiegelt das Video', key('M')]],
      [ico('image'), 'Helligkeit und Kontrast'],
      [ico('marker'), ['Markierungen setzen: Start', key('S'), ', Ende', key('E'), ', Notiz', key('N'), ', Highlight', key('H')]]] },
    { target: '.controls > .ctl-group:nth-child(5)', block: true, title: 'Ansicht', text: [
      [ico('fitWidth'), 'Volle Breite'],
      [ico('fitAll'), 'Ganzes Bild'],
      [ico('full'), ['Vollbild', key('F')]]] },
    // Seitenpanel: erst der Knopf, dann jeder Abschnitt
    { target: '.panel-btn', block: true, title: 'Seitenpanel', text: [
      [ico('panelOpen'), ['Blendet das Seitenpanel ein und aus', key('P')]],
      [ico('grip'), `${tt('Ziehen', 'Halten + Ziehen')} verschiebt einen Abschnitt`],
      [chip('▾'), 'Klappt einen Abschnitt auf und zu']] },
    { target: sec('song'), block: true, side: true, before: panelOpen, title: 'Song', text: [
      ['Erkennen', 'Erkennt den Song aus dem Video'],
      ['Ändern', 'Song von Hand suchen'],
      ['Cover', `Öffnet den Song beim Musikprovider, Hörprobe beim ${tt('Darüberfahren', 'Halten')}`],
      ['Startpunkt', 'Erkennt oder setzt, wo im Song das Video beginnt'],
      ['Songdatei', 'Lädt eine Songdatei als Tonquelle']] },
    { target: sec('marker'), block: true, side: true, before: panelOpen, title: 'Marker', text: [
      ['Zeit', 'Springt zum Marker'],
      ['Name', 'Umbenennen, auf jetzt setzen, Art wechseln, löschen']] },
    { target: sec('notes'), block: true, side: true, before: panelOpen, title: 'Notizen', text: [
      ['Feld', 'Eigene Notizen zur Aufnahme, speichert automatisch']] },
    { target: sec('status'), block: true, side: true, before: panelOpen, title: 'Status', text: [
      ['1 bis 5', 'Bewertet, wie gut du die Choreo kannst'],
      ['Darunter', 'Übungszeit und wann zuletzt geübt']] },
    { target: sec('recs'), block: true, side: true, before: panelOpen, title: 'Aufnahmen', text: [
      ['Liste', 'Wechselt zu einer anderen Aufnahme der Choreo'],
      ['Name', 'Benennt die aktuelle Aufnahme um'],
      ['Hinzufügen', 'Fügt ein weiteres Video hinzu'],
      ['Löschen', 'Löscht die aktuelle Aufnahme']] },
    { target: sec('keys'), block: true, side: true, before: panelOpen, when: () => !!document.querySelector(sec('keys')), title: 'Tasten', text: [
      ['Liste', 'Alle Tastenkürzel']] },
  ], {
    scope: /^#\/train\//,
    start: { title: 'TRAININGSANSICHT', text: [
      ['Teil 2', 'Video, Bedienleiste und Seitenpanel'],
      REPEAT] },
    finish: { title: 'VIEL SPASS BEIM ÜBEN!' }, // Tasten und Seitenpanel kamen schon in den Schritten
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
