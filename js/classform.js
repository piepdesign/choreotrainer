// Classes ohne Video anlegen, bearbeiten, löschen. Genutzt im Intro und im Profil.
import { db, uid, deleteClass } from './db.js';
import { h, PALETTE, textOn, WEEKDAYS, CLASS_TITLES, CLASS_LEVELS, classTitle, classMeta, byClassOrder } from './util.js';

const norm = s => String(s || '').trim().toLowerCase();
const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];

// Liste + Formular. onChange() nach jeder Änderung.
export function classManager(onChange) {
  const list = h('div.cm-list');
  const form = classForm(async () => { await refresh(); onChange?.(); });
  async function refresh() {
    const classes = (await db.all('classes')).sort(byClassOrder);
    const choreos = await db.all('choreos');
    list.replaceChildren(...classes.map(c => {
      const n = choreos.filter(x => x.classId === c.id).length;
      return h('div.cm-row', { style: { background: `#${c.color}`, color: textOn(c.color) } },
        h('span.cm-name', `${classTitle(c)}${classMeta(c) ? '  ' + classMeta(c) : ''}`.toUpperCase()),
        h('span.cm-actions',
          h('button.linkbtn', { type: 'button', onclick: () => form.edit(c) }, 'Bearbeiten'),
          h('button.linkbtn', {
            type: 'button',
            onclick: async () => {
              const msg = n
                ? `„${classTitle(c)}“ löschen? Damit verschwinden auch ${n} Choreo${n === 1 ? '' : 's'} samt Videos.`
                : `„${classTitle(c)}“ löschen?`;
              if (!confirm(msg)) return;
              await deleteClass(c.id);
              form.cancelIf(c.id);
              await refresh();
              onChange?.();
            },
          }, 'Löschen')));
    }));
    return classes;
  }
  const el = h('div.class-manager', list, form);
  el.refresh = refresh;
  refresh();
  return el;
}

// Formular. onSaved(cls) nach Anlegen/Speichern. el.edit(cls) lädt eine Class zum Bearbeiten.
export function classForm(onSaved) {
  const f = {
    category: h('input', { type: 'text', list: 'dl-cf-cat', placeholder: 'Hip Hop' }),
    level: h('input', { type: 'text', list: 'dl-cf-lvl', placeholder: 'Lvl 2' }),
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', d))),
    time: h('input', { type: 'time' }),
    coach: h('input', { type: 'text', placeholder: 'Name' }),
  };
  let color = null, editing = null;
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
    swatches.querySelectorAll('.chip').forEach(x => x.classList.toggle('sel', !!hex && x.dataset.hex === hex));
    custom.classList.toggle('sel', !!hex && !PALETTE.includes(hex));
  }
  const title = h('span.label', 'Neue Class');
  const msg = h('span.label');
  const field = (label, input) => h('label.field', h('span', label), input);
  const clear = () => {
    for (const el of Object.values(f)) el.value = '';
    editing = null;
    pick(null);
    title.textContent = 'Neue Class';
    saveBtn.textContent = '+ Class hinzufügen';
    cancelBtn.hidden = true;
  };
  const saveBtn = h('button.btn.small', {
    type: 'button',
    onclick: async () => {
      const vals = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
      if (!vals.category) { msg.textContent = 'Bitte mindestens den Class-Namen angeben'; f.category.focus(); return; }
      const all = (await db.all('classes')).sort(byClassOrder);
      if (all.some(c => c.id !== editing?.id && KEYS.every(k => norm(c[k]) === norm(vals[k])))) { msg.textContent = 'Diese Class gibt es schon'; return; }
      let klass;
      if (editing) {
        klass = { ...editing, ...vals, color: color || editing.color };
        msg.textContent = `${classTitle(klass)} gespeichert`;
      } else {
        klass = { id: uid(), ...vals, color: color || PALETTE[all.length % PALETTE.length], order: all.length, created: Date.now() };
        msg.textContent = `${classTitle(klass)} angelegt`;
      }
      await db.put('classes', klass);
      clear();
      onSaved?.(klass);
    },
  }, '+ Class hinzufügen');
  const cancelBtn = h('button.linkbtn', { type: 'button', hidden: true, onclick: () => { clear(); msg.textContent = ''; } }, 'Abbrechen');

  const el = h('div.classform',
    h('datalist', { id: 'dl-cf-cat' }, CLASS_TITLES.map(v => h('option', { value: v }))),
    h('datalist', { id: 'dl-cf-lvl' }, CLASS_LEVELS.map(v => h('option', { value: v }))),
    title,
    h('div.row', field('Class', f.category), field('Level', f.level), field('Wochentag', f.weekday), field('Uhrzeit', f.time), field('Coach', f.coach)),
    h('div', { style: { marginTop: '12px' } }, h('span.label', 'Farbe (sonst automatisch)'), swatches),
    h('div.actions', saveBtn, cancelBtn, msg));
  el.edit = cls => {
    editing = cls;
    for (const k of KEYS) f[k].value = cls[k] || '';
    pick(cls.color);
    title.textContent = `${classTitle(cls)} bearbeiten`;
    saveBtn.textContent = 'Speichern';
    cancelBtn.hidden = false;
    msg.textContent = '';
    f.category.focus();
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  el.cancelIf = id => { if (editing?.id === id) clear(); };
  return el;
}
