// Intro beim ersten Öffnen: Wortmarke → Name → Classes → Präferenzen → App (nur im Browser) → „wird vorbereitet“.
// Läuft einmal (auch für bestehende Nutzer*innen, vorhandene Classes sind vorbelegt).
// Navigation unten fest: „<“ zurück, „Später“, „>“ weiter. Gleiche Größe und Stelle in jedem Schritt.
import { h, isTouch, tt } from './util.js';
import { settings, saveSettings, applyTheme, BASE_STATS } from './settings.js';
import { classManager } from './classform.js';
import { preferences } from './ui.js';
import { loadAll } from './hub.js';
import { baseStats } from './stats.js';
import { db } from './db.js';
import { isInstalled, isIOS, installApp } from './backup.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const arrow = dir => `<svg viewBox="0 0 14 24" width="14" height="24" aria-hidden="true"><path d="${dir === 'next' ? 'M2 2l10 10-10 10' : 'M12 2 2 12l10 10'}" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

export async function runIntro() {
  const box = h('div.intro');
  const stage = h('div.intro-stage');
  const back = h('button.intro-arrow', { type: 'button', 'aria-label': 'Zurück', html: arrow('back') });
  const later = h('button.linkbtn.intro-later', { type: 'button' }, 'Später');
  const next = h('button.intro-arrow', { type: 'button', 'aria-label': 'Weiter', html: arrow('next') });
  const nav = h('div.intro-nav', back, later, next);
  // Navigation direkt unter dem Inhalt (statt am Bildschirmrand), beides zusammen mittig
  box.append(h('div.intro-frame', stage, nav));
  document.body.append(box);
  document.body.classList.add('intro-open');

  const show = async (node, { navVisible = true } = {}) => {
    box.classList.remove('in');
    await wait(220);
    stage.replaceChildren(node);
    nav.hidden = !navVisible;
    void box.offsetWidth; // Übergang neu starten
    box.classList.add('in');
  };

  // 1 · Wortmarke: Buchstaben weich einblenden, danach 1 s stehen lassen
  // Wortmarke: in Animation und Ladebildschirm gleich aufgebaut (zwei Zeilen, © 0,55 em), nur die Größe unterscheidet sich
  const letters = (text, offset) => [...text].map((ch, i) => h('span', { style: { animationDelay: `${(i + offset) * 50}ms` } }, ch));
  const mark = cls => h(`h1.wide.intro-mark${cls}`,
    h('span.line', letters('CHOREO—', 0)),
    h('span.line', letters('TRAINER', 7), h('sup', '©')));
  await show(h('div.intro-step.center', mark('')), { navVisible: false });
  await wait(13 * 50 + 750 + 1000);

  const state = { name: settings().name || '', provider: settings().provider, theme: settings().theme, baseStats: [...settings().baseStats], hoverPreview: settings().hoverPreview, tester: settings().tester, appHint: settings().appHint, appChoice: null };

  // Ein Schritt = { render(), canGo(), skippable }
  const steps = [
    {
      render() {
        const input = h('input.intro-input', { type: 'text', autofocus: true, value: state.name, placeholder: 'DEIN NAME', autocomplete: 'off', spellcheck: 'false' });
        const sync = () => { state.name = input.value.trim().toUpperCase(); refreshNav(); };
        input.addEventListener('input', sync);
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && state.name) go(1); });
        // Cursor sofort ins Feld (mehrfach, weil der Browser den Fokus während des Übergangs teils verwirft)
        const focus = () => { if (input.isConnected && document.activeElement !== input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } };
        [0, 260, 500, 900].forEach(ms => setTimeout(focus, ms));
        addEventListener('focus', focus); // Fenster bekommt den Fokus erst später (z. B. nach dem Neuladen)
        // Tippen landet immer im Feld: hat das Feld (noch) keinen Fokus, Zeichen selbst einsetzen.
        // Nur mit echter Tastatur; auf Handys kommt jedes Zeichen über die Bildschirmtastatur selbst an
        // (das frühere „nachträglich einsetzen, falls verschluckt“ hat dort Buchstaben verdoppelt).
        const grab = e => {
          if (!input.isConnected) { removeEventListener('keydown', grab, true); removeEventListener('focus', focus); return; }
          if (isTouch() || document.activeElement === input) return;
          if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
          e.preventDefault();
          focus();
          input.value += e.key;
          sync();
        };
        addEventListener('keydown', grab, true);
        // breite Linie bleibt, das Feld selbst ist so breit wie der Inhalt: Cursor steht direkt vor „DEIN NAME“
        return h('div.intro-step.center', h('h1.wide', 'HI, WIE HEISST DU?'), h('label.intro-field', input));
      },
      canGo: () => !!state.name,
    },
    {
      render() {
        const manager = classManager(() => refreshNav());
        return h('div.intro-step',
          h('h1.wide', `WILLKOMMEN, ${state.name.toUpperCase()}.`),
          h('p.intro-lead', 'Welche Classes besuchst du regelmäßig?'),
          manager);
      },
      canGo: async () => (await db.all('classes')).length > 0,
      skippable: true,
    },
    {
      render() {
        return h('div.intro-step',
          h('h1.wide', 'DEINE PRÄFERENZEN'),
          h('p.intro-lead', '(Alles später im Profil änderbar)'),
          preferences(state, patch => { Object.assign(state, patch); if (patch.theme) applyTheme(patch.theme); refreshNav(); },
            loadAll().then(baseStats), { baseLabel: false, tester: true, hints: true }));
      },
      canGo: () => !!state.provider,
      skippable: true,
    },
    // Als App installieren? Nur, solange sie im Browser läuft. „Im Browser“ schaltet den Hinweis in der Base ab.
    ...(isInstalled() ? [] : [{
      render() {
        // Symbole im Stil der Präferenz-Kacheln: Home-Bildschirm mit Pfeil bzw. Browserfenster
        const ICON = {
          install: '<rect x="8" y="2.5" width="10" height="21" rx="1.5"/><path d="M13 7v8M9.8 12l3.2 3.2 3.2-3.2M11 20.5h4"/>',
          browser: '<rect x="2.5" y="4.5" width="21" height="17" rx="1.5"/><path d="M2.5 9h21M5.5 6.8h.01M8 6.8h.01"/>',
        };
        const svg = id => `<svg viewBox="0 0 26 26" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${ICON[id]}</svg>`;
        const choice = (id, label, onPick) => h(`button${state.appChoice === id ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(state.appChoice === id),
          onclick: async e => {
            state.appChoice = id;
            tiles.querySelectorAll('button').forEach(b => { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
            await onPick();
            refreshNav();
          },
        }, h('i.brand', { html: svg(id) }), h('span', label));
        const tiles = h('div.provider-tiles.app-choice', { role: 'radiogroup' },
          choice('install', 'Installieren', async () => { state.appHint = true; await installApp(); }),
          choice('browser', 'Im Browser nutzen', () => { state.appHint = false; }));
        return h('div.intro-step',
          h('h1.wide', 'ALS APP NUTZEN?'),
          h('p.intro-lead', 'Installiert startet ChoreoTrainer vom Home-Bildschirm, auch ohne Internet, und der Browser räumt deine Daten nicht von sich aus.'),
          tiles,
          isIOS() ? h('p.intro-lead', 'Am iPhone hat die installierte App einen eigenen Speicher. Am besten jetzt installieren und dort weitermachen.') : null,
          h('p.intro-lead', '(Jederzeit unter Einstellungen › App)'));
      },
      canGo: () => true,
      skippable: true,
    }]),
  ];

  let index = 0, skipPrefs = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  async function refreshNav() {
    const s = steps[index];
    back.hidden = index === 0;
    later.hidden = !s.skippable;
    next.hidden = !(await s.canGo());
  }
  async function go(delta) {
    // beim Verlassen speichern, was eingetragen ist
    if (index === 0) await saveSettings({ name: state.name });
    if (index === 2 && !skipPrefs) await saveSettings({ provider: state.provider, theme: state.theme, baseStats: state.baseStats, hoverPreview: state.hoverPreview, tester: state.tester });
    if (index === 3) await saveSettings({ appHint: state.appHint });
    skipPrefs = false;
    index += delta;
    if (index >= steps.length) { resolveDone(); return; }
    await show(steps[index].render());
    refreshNav();
  }
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  later.addEventListener('click', () => {
    if (index === 2) skipPrefs = true; // Präferenzen überspringen: nichts speichern, weiter zum nächsten Schritt
    go(1);
  });
  await show(steps[0].render());
  refreshNav();
  await done;

  // 5 · Übergang, mind. 3 s, damit alles lädt und der Text gelesen werden kann
  await show(h('div.intro-step.center',
    h('p.intro-lead', `Einen Moment ${state.name.toUpperCase()}, dein`),
    mark('.static'),
    h('p.intro-lead', 'wird vorbereitet …'),
    h('div.intro-bar', h('i'))), { navVisible: false });
  await saveSettings({ introDone: true });
  await wait(3000);
  box.classList.add('out');
  await wait(450);
  box.remove();
  document.body.classList.remove('intro-open');
}
