// Intro beim ersten Öffnen: Wortmarke → Name → Classes → Präferenzen → „Base wird vorbereitet“.
// Läuft einmal (auch für bestehende Nutzer*innen, vorhandene Classes sind vorbelegt).
import { db } from './db.js';
import { h, stripe, byClassOrder } from './util.js';
import { settings, saveSettings, applyTheme } from './settings.js';
import { PROVIDERS } from './providers.js';
import { classForm } from './classform.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function runIntro() {
  const box = h('div.intro');
  document.body.append(box);
  document.body.classList.add('intro-open');
  let name = settings().name || '';

  const show = async node => {
    box.classList.remove('in');
    await wait(220);
    box.replaceChildren(node);
    void box.offsetWidth; // Übergang neu starten
    box.classList.add('in');
  };
  // „>“ erscheint erst, wenn etwas eingegeben bzw. gewählt ist
  const nextBtn = (onclick, visible) => h('button.next', { type: 'button', 'aria-label': 'Weiter', hidden: !visible, onclick }, '>');

  // 1 · Wortmarke (≤ 2 s)
  await show(h('div.intro-step.center',
    h('h1.wide.intro-mark',
      h('span.line', [...'CHOREO—'].map((ch, i) => h('span', { style: { animationDelay: `${i * 50}ms` } }, ch))),
      h('span.line', [...'TRAINER'].map((ch, i) => h('span', { style: { animationDelay: `${(i + 7) * 50}ms` } }, ch)), h('sup', '©')))));
  await wait(1900);

  // 2 · Name
  name = await new Promise(resolve => {
    const input = h('input.intro-input', { type: 'text', value: name, placeholder: 'Dein Name', autocomplete: 'given-name' });
    const go = () => { if (input.value.trim()) resolve(input.value.trim()); };
    const next = nextBtn(go, !!name);
    input.addEventListener('input', () => { next.hidden = !input.value.trim(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    show(h('div.intro-step.center', h('h1.wide', 'HI, WIE HEISST DU?'), h('div.intro-row', input, next)))
      .then(() => input.focus());
  });
  await saveSettings({ name });

  // 3 · Classes
  await new Promise(async resolve => {
    const list = h('div.stripes.intro-classes');
    const next = nextBtn(resolve, false);
    const refresh = async () => {
      const classes = (await db.all('classes')).sort(byClassOrder);
      list.replaceChildren(...classes.map(c => stripe(c, '', () => {})));
      next.hidden = !classes.length;
    };
    await show(h('div.intro-step',
      h('h1.wide', `WILLKOMMEN ${name.toUpperCase()},`),
      h('p.intro-lead', 'welche Classes besuchst du regelmäßig?'),
      list,
      classForm(refresh),
      h('div.intro-nav', h('button.linkbtn', { type: 'button', onclick: resolve }, 'Später'), next)));
    refresh();
  });

  // 4 · Präferenzen
  await new Promise(async resolve => {
    const s = settings();
    let provider = s.provider, theme = s.theme;
    const next = nextBtn(async () => { await saveSettings({ provider, theme }); resolve(); }, !!provider);
    const providerChips = h('div.chips', PROVIDERS.map(([id, label]) => h(`button.btn${id === provider ? '.primary' : ''}`, {
      type: 'button',
      onclick: e => {
        provider = id;
        providerChips.querySelectorAll('.btn').forEach(b => b.classList.remove('primary'));
        e.currentTarget.classList.add('primary');
        next.hidden = false;
      },
    }, label)));
    const themeChips = h('div.chips', [['system', 'Wie System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([id, label]) => h(`button.btn${id === theme ? '.primary' : ''}`, {
      type: 'button',
      onclick: e => {
        theme = id;
        applyTheme(id);
        themeChips.querySelectorAll('.btn').forEach(b => b.classList.remove('primary'));
        e.currentTarget.classList.add('primary');
        next.hidden = false;
      },
    }, label)));
    await show(h('div.intro-step',
      h('h1.wide', 'DEINE PRÄFERENZEN'),
      h('p.intro-lead', 'Wo hörst du Musik? Erkannte Songs öffnen sich dort.'),
      providerChips,
      h('p.intro-lead', 'Ansicht'),
      themeChips,
      h('p.label', 'Alles später im Profil änderbar.'),
      h('div.intro-nav', h('button.linkbtn', { type: 'button', onclick: resolve }, 'Später'), next)));
  });

  // 5 · Übergang
  await show(h('div.intro-step.center',
    h('p.intro-lead', `Einen Moment ${name}, deine`),
    h('h1.wide', 'CHOREO—TRAINER', h('sup', '©'), ' BASE'),
    h('p.intro-lead', 'wird vorbereitet …'),
    h('div.intro-bar', h('i'))));
  await saveSettings({ introDone: true });
  await wait(1400);
  box.classList.add('out');
  await wait(450);
  box.remove();
  document.body.classList.remove('intro-open');
}
