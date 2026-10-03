// Intro beim ersten Öffnen: Wortmarke → Name → Classes → Präferenzen → „wird vorbereitet“.
// Läuft einmal (auch für bestehende Nutzer*innen, vorhandene Classes sind vorbelegt).
// Navigation unten fest: „<“ zurück, „Später“, „>“ weiter. Gleiche Größe und Stelle in jedem Schritt.
import { h } from './util.js';
import { settings, saveSettings, applyTheme, BASE_STATS } from './settings.js';
import { PROVIDERS } from './providers.js';
import { classManager } from './classform.js';
import { db } from './db.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const arrow = dir => `<svg viewBox="0 0 14 24" width="14" height="24" aria-hidden="true"><path d="${dir === 'next' ? 'M2 2l10 10-10 10' : 'M12 2 2 12l10 10'}" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

export async function runIntro() {
  const box = h('div.intro');
  const stage = h('div.intro-stage');
  const back = h('button.intro-arrow', { type: 'button', 'aria-label': 'Zurück', html: arrow('back') });
  const later = h('button.linkbtn.intro-later', { type: 'button' }, 'Später');
  const next = h('button.intro-arrow', { type: 'button', 'aria-label': 'Weiter', html: arrow('next') });
  const nav = h('div.intro-nav', back, later, next);
  box.append(stage, nav);
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
  const letters = (text, offset) => [...text].map((ch, i) => h('span', { style: { animationDelay: `${(i + offset) * 50}ms` } }, ch));
  await show(h('div.intro-step.center',
    h('h1.wide.intro-mark',
      h('span.line', letters('CHOREO—', 0)),
      h('span.line', letters('TRAINER', 7), h('sup', '©')))), { navVisible: false });
  await wait(13 * 50 + 750 + 1000);

  const state = { name: settings().name || '', provider: settings().provider, openIn: settings().openIn, theme: settings().theme, baseStats: [...settings().baseStats] };

  // Ein Schritt = { render(), canGo(), skippable }
  const steps = [
    {
      render() {
        const input = h('input.intro-input', { type: 'text', value: state.name, placeholder: 'DEIN NAME', autocomplete: 'given-name' });
        input.addEventListener('input', () => { state.name = input.value.trim(); refreshNav(); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && state.name) go(1); });
        setTimeout(() => input.focus(), 260);
        return h('div.intro-step.center', h('h1.wide', 'HI, WIE HEISST DU?'), input);
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
        const chips = (opts, get, set) => {
          const el = h('div.chips', opts.map(([id, label]) => h(`button.btn${get() === id ? '.primary' : ''}`, {
            type: 'button',
            onclick: e => { set(id); el.querySelectorAll('.btn').forEach(b => b.classList.remove('primary')); e.currentTarget.classList.add('primary'); refreshNav(); },
          }, label)));
          return el;
        };
        const stats = h('div.p-checks', BASE_STATS.map(([id, label]) => {
          const cb = h('input', { type: 'checkbox', checked: state.baseStats.includes(id) });
          cb.addEventListener('change', () => {
            const cur = new Set(state.baseStats);
            if (cb.checked) cur.add(id); else cur.delete(id);
            state.baseStats = BASE_STATS.map(x => x[0]).filter(x => cur.has(x));
          });
          return h('label.p-check', cb, label);
        }));
        return h('div.intro-step',
          h('h1.wide', 'DEINE PRÄFERENZEN'),
          h('p.intro-lead', 'Wo hörst du Musik? Erkannte Songs öffnen sich dort.'),
          chips(PROVIDERS, () => state.provider, v => { state.provider = v; }),
          chips([['app', 'In der App öffnen'], ['web', 'Im Browser öffnen']], () => state.openIn, v => { state.openIn = v; }),
          h('p.intro-lead', 'Ansicht'),
          chips([['system', 'Wie System'], ['light', 'Hell'], ['dark', 'Dunkel']], () => state.theme, v => { state.theme = v; applyTheme(v); }),
          h('p.intro-lead', 'Kennzahlen in deiner Base'),
          stats,
          h('p.label', 'Alles später im Profil änderbar.'));
      },
      canGo: () => !!state.provider,
      skippable: true,
    },
  ];

  let index = 0;
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
    if (index === 2) await saveSettings({ provider: state.provider, openIn: state.openIn, theme: state.theme, baseStats: state.baseStats });
    index += delta;
    if (index >= steps.length) { resolveDone(); return; }
    await show(steps[index].render());
    refreshNav();
  }
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  later.addEventListener('click', () => {
    if (index === 2) { index = steps.length; resolveDone(); return; } // Präferenzen überspringen: nichts speichern
    go(1);
  });
  await show(steps[0].render());
  refreshNav();
  await done;

  // 5 · Übergang, mind. 3 s, damit alles lädt und der Text gelesen werden kann
  await show(h('div.intro-step.center',
    h('p.intro-lead', `Einen Moment ${state.name}, dein`),
    h('h1.wide', 'CHOREO—TRAINER', h('sup', '©')),
    h('p.intro-lead', 'wird vorbereitet …'),
    h('div.intro-bar', h('i'))), { navVisible: false });
  await saveSettings({ introDone: true });
  await wait(3000);
  box.classList.add('out');
  await wait(450);
  box.remove();
  document.body.classList.remove('intro-open');
}
