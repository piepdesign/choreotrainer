// Tutorial: führt Schritt für Schritt durch die App. Der Rest der Seite wird abgedunkelt, die markierte Stelle
// bleibt frei. Weiter geht es nur per Klick auf die markierte Stelle (nicht auf einen Weiter-Knopf).
// Teil 1 (Base, Profil, Einstellungen) läuft nach dem Intro, Teil 2 beim ersten Öffnen einer Choreo.
import { tr } from './i18n.js';
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
// Ein Punkt = ein Satz: mit Icon/Knopf davor ([ico, Satz]) oder als reiner Satz (String)
const fill = (el, content) => !content ? el.replaceChildren() : el.replaceChildren(Array.isArray(content)
  ? h('dl.tour-list', content.flatMap(item => typeof item === 'string' ? [h('dd.tour-say', item)]
    : item[0] == null ? [h('dd.tour-note', ...[item[1]].flat())] // ohne Icon: Zusatz über die volle Breite, leiser
      : [h('dt', item[0]), h('dd', ...[item[1]].flat())]))
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
  const skip = h('button.linkbtn', { type: 'button' }, tr('Überspringen'));
  const card = h('div.tour-card', { role: 'dialog', 'aria-live': 'polite' },
    h('div.tour-top', num, skip), title, text, h('p.label.tour-hint', tt(tr('Klicke auf die markierte Stelle'), tr('Tippe auf die markierte Stelle'))));
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

  // Klicks außerhalb der markierten Stelle und der Karte sperren; Klick auf die Stelle führt weiter.
  // „Auf der Stelle“ auch nach Lage, nicht nur nach Element: Über der Zeitleiste liegen z. B. Abspielkopf und
  // Marker-Striche, die laufend neu gezeichnet werden. Dann kam der Klick teils nicht an (Element ersetzt) oder
  // galt als daneben. block-Schritte gehen deshalb schon beim Loslassen weiter.
  const within = e => { if (!target || e.clientX == null || (!e.clientX && !e.clientY)) return false; const r = target.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  const guard = e => {
    if (card.contains(e.target)) return;
    if (target && (target.contains(e.target) || within(e))) {
      // block: auch Drücken/Ziehen nicht an die Seite weitergeben (z. B. keinen Loop über die Achten setzen)
      if (step.block) { e.preventDefault(); e.stopPropagation(); }
      if (e.type === 'click' || (e.type === 'pointerup' && step.block)) {
        const done = resolveStep; resolveStep = null;
        setTimeout(() => done?.(), step.block ? 0 : 60);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onKey = e => { if (e.key === 'Escape') end(true); };
  ['click', 'pointerdown', 'pointerup', 'mousedown', 'dblclick'].forEach(t => addEventListener(t, guard, true));
  addEventListener('keydown', onKey, true);
  let stopped = false;
  function end() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    ['click', 'pointerdown', 'pointerup', 'mousedown', 'dblclick'].forEach(t => removeEventListener(t, guard, true));
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
      target = null; // solange die nächste Stelle gesucht wird, gelten keine Klicks auf die vorige
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
function confirmBox({ title, text, button = tr('Los geht’s'), skip = false }) {
  return new Promise(resolve => {
    const ok = h('button.btn.primary', { type: 'button' }, button);
    const no = skip ? h('button.linkbtn', { type: 'button' }, tr('Überspringen')) : null;
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
const markerList = () => document.querySelector('.panel-sec[data-k="marker"] .markers');
const markerOptions = on => markerList()?.showOptions?.(on); // Optionen des ersten Markers ein-/ausblenden
const narrow = () => matchMedia('(max-width: 1000px)').matches; // Panel liegt dann unter dem Video
const panelOpen = () => {
  const t = document.querySelector('.train');
  if (t?.classList.contains('panel-closed')) document.querySelector('.panel-btn')?.click();
};

// Tastenkürzel nur am Rechner; geschütztes Leerzeichen + nowrap, damit es nicht mitten im Kürzel umbricht
const key = k => tt(h('span.tour-kbd', ` (${k})`), '');

// Hinweis in der Begrüßung beider Teile
const REPEAT = tr('Das Tutorial kannst du jederzeit unter Einstellungen › Konto wiederholen.');

// Grundsatz der Texte: nur die Funktion, jeder Punkt ein Satz. Die Geste wird nur genannt, wenn die Funktion an ihr
// hängt (Doppelklick = Vollbild, Ziehen = mehrere Achten), nicht fürs bloße Öffnen.
export function mainTour() {
  return runTour([
    { route: /^#\/?$/, target: '.dropzone', block: true, title: tr('Neue Choreo'), text: [
      tr('Legt aus einem Kursvideo eine neue Choreo an.'),
      tr('Importieren übernimmt eine exportierte Class oder Choreo.')] },
    { route: /^#\/?$/, target: '.stats', block: true, title: tr('Statistiken'), text: [
      tr('Die Kacheln zeigen Kennzahlen zu deinem Üben.'),
      tr('Jede Kachel führt zur passenden Auswertung im Profil.')] },
    { route: /^#\/?$/, target: '.stripes', block: true, when: () => !!document.querySelector('.stripes .stripe'), title: 'Classes', text: [
      tr('Jeder Streifen ist eine Class und führt zu ihren Choreos.'),
      tt(tr('Ziehen sortiert die Classes.'), tr('Halten und Ziehen sortiert die Classes.'))] },
    { target: '[data-nav="profile"]', title: tr('Profil'), text: [tr('Zeigt Übungszeit, Status und alle Choreos.')] },
    { route: /^#\/profile/, target: '.p-nav', title: tr('Reiter'), text: [tr('Wechseln zwischen Übersicht, Übungszeit, Status und Choreos.')] },
    { target: '[data-nav="settings"]', title: tr('Einstellungen'), text: () => [[svgIco(document.querySelector('[data-nav="settings"] svg')?.outerHTML), tr('Musikprovider, Hörprobe, Base, Classes, Daten, App und Konto.')]] },
    { route: /^#\/settings/, target: '.theme-toggle', block: true, title: tr('Ansicht'), text: [
      [svgIco(themeIcon('light')), tr('Hell')],
      [svgIco(themeIcon('dark')), tr('Dunkel')],
      [svgIco(themeIcon('system')), tr('System')]] },
    // schmale Handys: „BASE“ ist ausgeblendet, dort führt die Wortmarke zurück
    { target: () => [document.querySelector('[data-nav="hub"]'), document.querySelector('.wordmark')].find(visible), title: 'Base', text: [tr('Führt zurück zur Startseite.')] },
  ], {
    start: { title: tr('TUTORIAL'), text: [[ico('part1'), REPEAT]] },
    finish: { title: tr('GESCHAFFT!'), text: [[ico('part2'), tr('Zeigt die Trainingsansicht, sobald du deine erste Choreo öffnest.')]] },
    onEnd: () => saveSettings({ tourDone: true }),
  });
}

export function trainTour() {
  const sec = k => `.panel-sec[data-k="${k}"]`;
  return runTour([
    { target: '.stage', block: true, below: true, title: tr('Video'), text: [
      tr('Startet und pausiert das Video.'),
      tt(tr('Doppelklick schaltet auf Vollbild.'), tr('Doppelt tippen schaltet auf Vollbild.'))] },
    { target: '.timeline .tl-row:first-child .track', block: true, title: tr('Zeitleiste'), text: [
      tr('Springt an die gewählte Stelle.'),
      tr('Die Striche zeigen Marker und Loop.')] },
    // ohne Tempo ist die 8er-Zeile ausgeblendet: Schritt dann gleich auslassen (statt 8 s mit der alten Karte zu warten)
    { target: '.track.eights', block: true, when: () => visible(document.querySelector('.track.eights')), title: tr('8er-Count'), text: [
      tr('Jedes Feld loopt seine Acht.'),
      tr('Ziehen über mehrere Felder loopt mehrere Achten.')] },
    // Bedienleiste: je Gruppe ein Schritt, von links nach rechts
    { target: '.controls > .ctl-group:nth-child(1)', block: true, title: tr('Wiedergabe'), text: [
      [ico('play'), [tr('Startet und pausiert.'), key(tr('Leertaste'))]],
      [ico('tempo'), [tr('Ändert das Tempo, die Tonhöhe bleibt.'), key('↑ ↓')]],
      [ico('vol2'), tr('Regelt die Lautstärke.')],
      [ico('note'), [tr('Schaltet den Ton zwischen Video und Songdatei um.'), key('A')]]] },
    { target: '.controls > .ctl-group:nth-child(2)', block: true, title: 'Loop', text: [
      [chip('In'), [tr('Setzt den Anfang.'), key('I')]],
      [chip('Out'), [tr('Setzt das Ende.'), key('O')]],
      [chip('Loop'), [tr('Wiederholt den Abschnitt.'), key('L')]],
      [chip('×'), tr('Löscht In / Out.')],
      [null, tr('Ohne In / Out loopt er zwischen Start- und Ende-Marker.')]] },
    { target: '.controls > .ctl-group:nth-child(3)', block: true, title: 'Count', text: [
      [chip(tr('8er')), tr('Blendet den Zähler ein oder aus.')],
      [chip('BPM'), tr('Tempo, Klick und Anzeige.')],
      [chip('1'), [tr('Setzt den Anfangscount an die aktuelle Stelle.'), key('1')]],
      [chip('Tap'), [tr('Tippt die BPM im Takt ein.'), key('T')]]] },
    { target: '.controls > .ctl-group:nth-child(4)', block: true, title: tr('Bild'), text: [
      [ico('mirror'), [tr('Spiegelt das Video.'), key('M')]],
      [ico('image'), tr('Regelt Helligkeit und Kontrast.')],
      [ico('marker'), tr('Setzt Markierungen.')]] },
    { target: '.controls > .ctl-group:nth-child(5)', block: true, title: tr('Ansicht'), text: [
      [ico('fitWidth'), tr('Volle Breite')],
      [ico('fitAll'), tr('Ganzes Bild')],
      [ico('full'), [tr('Vollbild'), key('F')]]] },
    // Panel: erst der Knopf, dann jeder Abschnitt
    { target: '.panel-btn', block: true, title: narrow() ? 'Panel' : tr('Seitenpanel'), text: () => [
      [ico('panelOpen'), [narrow() ? tr('Blendet das Panel unter dem Video ein und aus.') : tr('Blendet das Seitenpanel ein und aus.'), key('P')]],
      [ico('grip'), tt(tr('Ziehen verschiebt einen Abschnitt.'), tr('Halten und Ziehen verschiebt einen Abschnitt.'))],
      [chip('▾'), tr('Klappt einen Abschnitt auf und zu.')]] },
    { target: sec('song'), block: true, side: true, before: panelOpen, title: tr('Song'), text: [
      tr('Erkennen findet den Song im Video, Ändern sucht ihn von Hand.'),
      tt(tr('Das Cover öffnet den Song beim Musikprovider, Darüberfahren spielt eine Hörprobe.'), tr('Das Cover öffnet den Song beim Musikprovider, Halten spielt eine Hörprobe.')),
      tr('Der Startpunkt legt fest, wo im Song das Video beginnt.'),
      tr('Eine Songdatei lässt sich als Tonquelle laden.')] },
    // Optionen-Icons am ersten Marker eingeblendet; gibt es noch keinen, nur für diesen Schritt ein Beispiel-Marker
    { target: sec('marker'), block: true, side: true, before: () => { panelOpen(); markerOptions(true); }, title: tr('Marker'), text: [
      tr('Die Zeit springt zum Marker, der Name zeigt seine Optionen.'),
      [ico('rename'), tr('Umbenennen')],
      [ico('jump'), tr('Hierhin springen')],
      [ico('setNow'), tr('Auf jetzt setzen')],
      [ico('trash'), tr('Löschen')]] },
    { target: sec('notes'), block: true, side: true, before: () => { panelOpen(); markerOptions(false); }, title: tr('Notizen'), text: [
      tr('Eigene Notizen zur Aufnahme, speichern automatisch.')] },
    { target: sec('status'), block: true, side: true, before: panelOpen, title: tr('Status'), text: [
      tr('Bewertet von 1 bis 5, wie gut du die Choreo kannst.')] },
    { target: sec('recs'), block: true, side: true, before: panelOpen, title: tr('Aufnahmen'), text: [
      tr('Chronik aller Aufnahmen der Choreo, nach Datum, zum Wechseln.'),
      tr('Der Name der aktuellen Aufnahme ist umbenennbar.'),
      tr('Hinzufügen lädt ein weiteres Video zur Choreo.'),
      tr('Löschen entfernt die aktuelle Aufnahme samt Video.'),
      tr('Exportieren speichert die Choreo als Datei zum Teilen oder Sichern.')] },
    { target: sec('keys'), block: true, side: true, before: panelOpen, when: () => !!document.querySelector(sec('keys')), title: tr('Tasten'), text: [
      tr('Alle Tastenkürzel.')] },
  ], {
    scope: /^#\/train\//,
    start: { title: tr('TRAININGSANSICHT'), text: [[ico('part2'), REPEAT]] },
    finish: { title: tr('VIEL SPASS BEIM ÜBEN!') },
    onEnd: () => saveSettings({ tourTrainDone: true }),
  });
}

// Startet den passenden Teil, wenn er noch nicht gesehen wurde
// Wartet, bis kein Fenster (Installieren, Musikprovider …) mehr offen ist, damit sich nichts überlagert
const busy = () => !!document.querySelector('.modal') || document.body.classList.contains('intro-open');
async function whenFree(ms) {
  await wait(ms);
  while (busy()) await wait(300);
  await wait(300); // kurz Luft nach dem Schließen
}
export function maybeTour(hash) {
  if (active || document.body.classList.contains('intro-open')) return;
  const s = settings();
  if (!s.tourDone && /^#?\/?$/.test(hash)) whenFree(500).then(() => { if (!active && /^#?\/?$/.test(location.hash)) mainTour(); });
  else if (s.tourDone && !s.tourTrainDone && /^#\/train\//.test(hash)) whenFree(900).then(() => { if (!active && /^#\/train\//.test(location.hash)) trainTour(); });
}
