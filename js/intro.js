// Intro beim ersten Öffnen: Wortmarke → Name → Classes → Präferenzen → App (nur im Browser) → „wird vorbereitet“.
// Läuft einmal (auch für bestehende Nutzer*innen, vorhandene Classes sind vorbelegt).
// Navigation unten fest: „<“ zurück, „Später“, „>“ weiter. Gleiche Größe und Stelle in jedem Schritt.
import { tr, lang, LANGS, setLang } from './i18n.js';
import { h, isTouch, tt } from './util.js';
import { settings, saveSettings, applyTheme, BASE_STATS } from './settings.js';
import { classManager } from './classform.js';
import { preferences } from './ui.js';
import { loadAll } from './hub.js';
import { baseStats } from './stats.js';
import { db } from './db.js';
import { isInstalled, isIOS, installApp } from './backup.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const GLOBE = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.6 2.4 2.6 12.6 0 15M10 2.5c-2.6 2.4-2.6 12.6 0 15"/></svg>';
const arrow = dir => `<svg viewBox="0 0 14 24" width="14" height="24" aria-hidden="true"><path d="${dir === 'next' ? 'M2 2l10 10-10 10' : 'M12 2 2 12l10 10'}" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

export async function runIntro() {
  const box = h('div.intro');
  const stage = h('div.intro-stage');
  const back = h('button.intro-arrow', { type: 'button', 'aria-label': tr('Zurück'), html: arrow('back') });
  const later = h('button.linkbtn.intro-later', { type: 'button' }, tr('Später'));
  const next = h('button.intro-arrow', { type: 'button', 'aria-label': tr('Weiter'), html: arrow('next') });
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
  // Nach einem Sprachwechsel (lädt neu) ohne Wortmarke direkt beim Namen weiter, Eingabe bleibt
  let resume = null;
  try { resume = JSON.parse(sessionStorage.getItem('ct-intro-resume')); sessionStorage.removeItem('ct-intro-resume'); } catch { /* neu */ }
  if (!resume) {
    await show(h('div.intro-step.center', mark('')), { navVisible: false });
    await wait(13 * 50 + 750 + 1000);
  }

  const state = { name: resume?.name ?? (settings().name || ''), provider: settings().provider, theme: settings().theme, baseStats: [...settings().baseStats], hoverPreview: settings().hoverPreview, tester: settings().tester, appHint: settings().appHint, appChoice: null };

  // Ein Schritt = { render(), canGo(), skippable }
  const steps = [
    {
      render() {
        const input = h('input.intro-input', { type: 'text', autofocus: true, value: state.name, placeholder: tr('DEIN NAME'), autocomplete: 'off', spellcheck: 'false' });
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
        // Sprache: Weltkugel mit Kürzel unter dem Namen, klappt die Sprachen aus; Wahl lädt neu (Name bleibt)
        const langBtn = h('button.lang-btn', { type: 'button', title: tr('Sprache'), 'aria-label': tr('Sprache'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: `${GLOBE}<span>${lang.toUpperCase()}</span>` });
        let menu = null;
        const closeMenu = () => { menu?.remove(); menu = null; langBtn.setAttribute('aria-expanded', 'false'); };
        langBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (menu) { closeMenu(); return; }
          menu = h('div.theme-menu.lang-menu', { role: 'menu' }, LANGS.map(([id, name]) => h(`button${id === lang ? '.on' : ''}`, {
            type: 'button', role: 'menuitemradio', 'aria-checked': String(id === lang), lang: id,
            onclick: () => {
              if (id === lang) { closeMenu(); return; }
              try { sessionStorage.setItem('ct-intro-resume', JSON.stringify({ name: input.value.trim().toUpperCase() })); } catch { /* egal */ }
              setLang(id);
            },
          }, h('b', id.toUpperCase()), name)));
          langBtn.after(menu);
          langBtn.setAttribute('aria-expanded', 'true');
        });
        addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !langBtn.contains(e.target)) closeMenu(); });
        // breite Linie bleibt, das Feld selbst ist so breit wie der Inhalt: Cursor steht direkt vor „DEIN NAME“
        return h('div.intro-step.center', h('h1.wide', tr('HI, WIE HEISST DU?')), h('label.intro-field', input), h('div.intro-lang', langBtn));
      },
      canGo: () => !!state.name,
    },
    // Classes: Weiter erscheint, sobald eine Class angelegt oder mindestens der Style eingetragen ist. Weiter
    // übernimmt die eingetragene Class, „Später“ nicht. Import gibt es hier nicht (später in Base/Profil).
    {
      render() {
        classMgr = classManager(() => refreshNav(), { withImport: false });
        classMgr.addEventListener('input', () => refreshNav());
        classMgr.addEventListener('change', () => refreshNav());
        return h('div.intro-step',
          h('h1.wide', tr('WILLKOMMEN, {name}.', { name: state.name.toUpperCase() })),
          h('p.intro-lead', tr('Welche Class(es) besuchst du regelmäßig?')),
          classMgr);
      },
      canGo: async () => !!classMgr?.form.hasDraft() || (await db.all('classes')).length > 0,
      leave: () => classMgr?.form.commit(),
      skippable: true,
    },
    {
      render() {
        return h('div.intro-step',
          h('h1.wide', tr('DEINE PRÄFERENZEN')),
          h('p.intro-lead', tr('(Alles später unter Einstellungen änderbar)')),
          preferences(state, patch => { Object.assign(state, patch); if (patch.theme) applyTheme(patch.theme); refreshNav(); },
            loadAll().then(baseStats), { baseLabel: false, tester: true, hints: true }));
      },
      canGo: () => !!state.provider,
      skippable: true,
    },
    // Als App installieren? Nur, solange sie im Browser läuft. „Im Browser“ schaltet den Hinweis in der Base ab.
    ...(isInstalled() ? [] : [{
      render() {
        // Symbole im Stil der Präferenz-Kacheln, geräteneutral: Herunterladen bzw. Weltkugel (Web)
        const ICON = {
          install: '<path d="M13 3.5v12.5M8.5 11.5 13 16l4.5-4.5"/><path d="M4.5 15.5v5A1.5 1.5 0 0 0 6 22h14a1.5 1.5 0 0 0 1.5-1.5v-5"/>',
          browser: '<circle cx="13" cy="13" r="9.5"/><path d="M3.5 13h19M13 3.5c3.2 3 3.2 16 0 19M13 3.5c-3.2 3-3.2 16 0 19"/>',
        };
        const svg = id => `<svg viewBox="0 0 26 26" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${ICON[id]}</svg>`;
        const choice = (id, label, onPick) => h(`button${state.appChoice === id ? '.on' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(state.appChoice === id),
          onclick: async e => {
            const mark = sel => tiles.querySelectorAll('button').forEach(b => { const on = b === sel; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
            state.appChoice = id;
            mark(e.currentTarget);
            // abgebrochen (z. B. Installations-Fenster des Browsers geschlossen): Auswahl wieder aufheben
            if ((await onPick()) === false) { state.appChoice = null; state.appHint = settings().appHint; mark(null); }
            refreshNav();
          },
        }, h('i.brand', { html: svg(id) }), h('span', label));
        const tiles = h('div.provider-tiles.app-choice', { role: 'radiogroup' },
          choice('install', tr('Installieren'), async () => { state.appHint = true; return installApp(); }),
          choice('browser', tr('Im Browser nutzen'), () => { state.appHint = false; }));
        return h('div.intro-step',
          h('h1.wide', tr('ALS APP NUTZEN?')),
          h('p.intro-lead', tr('Installiert startet ChoreoTrainer wie eine eigene App, auch ohne Internet, und der Browser räumt deine Daten nicht von sich aus.')),
          tiles,
          isIOS() ? h('p.intro-lead', tr('Am iPhone hat die installierte App einen eigenen Speicher. Am besten jetzt installieren und dort weitermachen.')) : null,
          h('p.intro-lead', tr('(Jederzeit unter Einstellungen › App)')));
      },
      canGo: () => !!state.appChoice, // „>“ erst nach einer Wahl (abgebrochene Installation hebt sie wieder auf)
      skippable: true,
    }]),
  ];

  let index = 0, skipPrefs = false, classMgr = null, skipping = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  let navSeq = 0;
  async function refreshNav() {
    const s = steps[index], my = ++navSeq;
    back.hidden = index === 0;
    later.hidden = !s.skippable;
    const ok = await s.canGo();
    if (my === navSeq) next.hidden = !ok; // nur die jüngste Prüfung zählt (ältere können später fertig werden)
  }
  async function go(delta) {
    // beim Verlassen speichern, was eingetragen ist
    if (index === 0) await saveSettings({ name: state.name });
    if (index === 2 && !skipPrefs) await saveSettings({ provider: state.provider, theme: state.theme, baseStats: state.baseStats, hoverPreview: state.hoverPreview, tester: state.tester });
    if (index === 3) await saveSettings({ appHint: state.appHint });
    if (delta > 0 && !skipping) await steps[index].leave?.();
    skipPrefs = skipping = false;
    index += delta;
    if (index >= steps.length) { resolveDone(); return; }
    await show(steps[index].render());
    refreshNav();
  }
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  later.addEventListener('click', () => {
    if (index === 2) skipPrefs = true; // Präferenzen überspringen: nichts speichern, weiter zum nächsten Schritt
    skipping = true; // auch eine eingetragene, noch nicht hinzugefügte Class nicht übernehmen
    go(1);
  });
  await show(steps[0].render());
  refreshNav();
  await done;

  // 5 · Übergang, mind. 3 s, damit alles lädt und der Text gelesen werden kann
  await show(h('div.intro-step.center',
    h('p.intro-lead', tr('Einen Moment {name}, dein', { name: state.name.toUpperCase() })),
    mark('.static'),
    h('p.intro-lead', tr('wird vorbereitet …')),
    h('div.intro-bar', h('i'))), { navVisible: false });
  await saveSettings({ introDone: true });
  await wait(3000);
  box.classList.add('out');
  await wait(450);
  box.remove();
  document.body.classList.remove('intro-open');
}
