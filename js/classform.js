// Formular „Class anlegen“ ohne Video. Genutzt im Intro und im Profil.
import { db, uid } from './db.js';
import { h, PALETTE, textOn, WEEKDAYS, CLASS_TITLES, CLASS_LEVELS, classTitle, classMeta, byClassOrder } from './util.js';

const norm = s => String(s || '').trim().toLowerCase();

// onAdded(cls) nach dem Speichern
export function classForm(onAdded) {
  const f = {
    category: h('input', { type: 'text', list: 'dl-cf-cat', placeholder: 'Hip Hop' }),
    level: h('input', { type: 'text', list: 'dl-cf-lvl', placeholder: 'Lvl 2' }),
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', d))),
    time: h('input', { type: 'time' }),
    coach: h('input', { type: 'text', placeholder: 'Name' }),
  };
  let color = null;
  const swatches = h('div.chips', PALETTE.map(p => h('button.chip', {
    type: 'button', 'data-hex': p, style: { background: `#${p}`, color: textOn(p) },
    onclick: () => pick(p),
  }, p)));
  const picker = h('input', { type: 'color', value: '#7a2cff' });
  const custom = h('label.chip.custom', { title: 'Eigene Farbe' }, h('span', 'Eigene'), picker);
  picker.addEventListener('input', () => pick(picker.value.replace('#', '').toUpperCase()));
  swatches.append(custom);
  function pick(hex) {
    color = hex;
    swatches.querySelectorAll('.chip').forEach(x => x.classList.toggle('sel', x.dataset.hex === hex));
    custom.classList.toggle('sel', !PALETTE.includes(hex));
  }
  const msg = h('span.label');
  const field = (label, input) => h('label.field', h('span', label), input);
  const addBtn = h('button.btn.small', {
    type: 'button',
    onclick: async () => {
      const cls = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
      if (!cls.category) { msg.textContent = 'Bitte mindestens den Class-Namen angeben'; f.category.focus(); return; }
      const all = (await db.all('classes')).sort(byClassOrder);
      if (all.some(c => ['category', 'level', 'weekday', 'time', 'coach'].every(k => norm(c[k]) === norm(cls[k])))) {
        msg.textContent = 'Diese Class gibt es schon'; return;
      }
      const klass = { id: uid(), ...cls, color: color || PALETTE[all.length % PALETTE.length], order: all.length, created: Date.now() };
      await db.put('classes', klass);
      for (const el of Object.values(f)) el.value = '';
      color = null;
      pick(null);
      msg.textContent = `${classTitle(klass)} angelegt`;
      onAdded?.(klass);
    },
  }, '+ Class hinzufügen');

  return h('div.classform',
    h('datalist', { id: 'dl-cf-cat' }, CLASS_TITLES.map(v => h('option', { value: v }))),
    h('datalist', { id: 'dl-cf-lvl' }, CLASS_LEVELS.map(v => h('option', { value: v }))),
    h('div.row', field('Class', f.category), field('Level', f.level), field('Wochentag', f.weekday), field('Uhrzeit', f.time), field('Coach', f.coach)),
    h('div', { style: { marginTop: '12px' } }, h('span.label', 'Farbe (sonst automatisch)'), swatches),
    h('div.actions', addBtn, msg));
}

export const classLine = c => `${classTitle(c)}${classMeta(c) ? ' · ' + classMeta(c) : ''}`;
