// Classes ohne Video anlegen, bearbeiten, löschen. Genutzt im Intro und im Profil.
import { db, uid, deleteClass } from './db.js';
import { classPickers } from './ui.js';
import { chooseFile, importExport, importSummary } from './share.js';
import { h, PALETTE, textOn, WEEKDAYS, CLASS_TITLES, CLASS_LEVELS, classTitle, classCells, byClassOrder } from './util.js';

const norm = s => String(s || '').trim().toLowerCase();
const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];

// Liste + Formular. onChange() nach jeder Änderung.
// Die Vorschau der gerade eingetragenen Class steht als letzte Zeile in der Liste (beim Bearbeiten an Stelle der
// Class), darunter die Felder, ganz unten „Class hinzufügen“ und „importieren“ wie in Base und Profil.
// opts gehen ans Formular (Intro: ohne Import, mit „Fertig“). el.form = das Formular (z. B. für form.commit()).
export function classManager(onChange, opts = {}) {
  const list = h('div.cm-list');
  const form = classForm(async () => { await refresh(); onChange?.(); }, opts);
  form.onClear = () => refresh();
  async function refresh() {
    const classes = (await db.all('classes')).sort(byClassOrder);
    const choreos = await db.all('choreos');
    list.replaceChildren(...classes.map(c => {
      const n = choreos.filter(x => x.classId === c.id).length;
      const row = h('div.cm-row', { style: { background: `#${c.color}`, color: textOn(c.color) } },
        ...classCells(c),
        h('span.cm-actions',
          h('button.linkbtn', { type: 'button', onclick: () => { list.querySelectorAll('.cm-row[hidden]').forEach(r => { r.hidden = false; }); form.edit(c); row.hidden = true; list.insertBefore(form.preview, row); } }, 'Bearbeiten'),
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
      return row;
    }), form.preview);
    return classes;
  }
  const el = h('div.class-manager', list, form, form.actions);
  el.refresh = refresh;
  el.form = form;
  refresh();
  return el;
}

// Formular. onSaved(cls) nach Anlegen/Speichern. el.edit(cls) lädt eine Class zum Bearbeiten.
// done: Knopf „Fertig“ (übernimmt die eingetragene Class, falls ausgefüllt, dann done()); der Speichern-Knopf heißt
// dann „Weitere Class“ (übernimmt und leert das Formular für die nächste).
// el.hasDraft(): Mindestangabe (Style) eingetragen · el.commit(): eingetragene Class speichern (ohne Meldung bei Doppel)
export function classForm(onSaved, { heading = true, withImport = true, done = null } = {}) {
  const f = {
    ...classPickers([], { styles: CLASS_TITLES, levels: CLASS_LEVELS }),
    weekday: h('select', h('option', { value: '' }, '—'), WEEKDAYS.map(d => h('option', d))),
    time: h('input', { type: 'time' }),
  };
  // eigene Styles/Levels/Coaches aus gespeicherten Classes nachladen
  db.all('classes').then(cs => { for (const k of ['category', 'level', 'coach']) f[k].setOptions(cs.map(c => c[k])); nextColor = PALETTE[cs.length % PALETTE.length]; draw(); });
  let color = null, editing = null, nextColor = PALETTE[0];
  const swatches = h('div.chips', PALETTE.map(p => h('button.chip', {
    type: 'button', 'data-hex': p, style: { background: `#${p}`, color: textOn(p) },
    onclick: () => pick(p), title: 'Farbe', 'aria-label': 'Farbe',
  })));
  const picker = h('input', { type: 'color', value: '#7a2cff' });
  const custom = h('label.chip.custom', { title: 'Eigene Farbe' }, h('span', 'Eigene'), picker);
  picker.addEventListener('input', () => pick(picker.value.replace('#', '').toUpperCase()));
  swatches.append(custom);
  function pick(hex) {
    color = hex;
    swatches.querySelectorAll('.chip').forEach(x => x.classList.toggle('sel', !!hex && x.dataset.hex === hex));
    custom.classList.toggle('sel', !!hex && !PALETTE.includes(hex));
    draw();
  }
  // Live-Vorschau: so sieht die Class als Streifen aus, während sie eingetragen wird.
  // Leere Angaben als blasser Platzhalter: STYLE # · TAG · HH:MM · COACH
  const preview = h('div.cm-row.cm-draft');
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, String(el.value || '').trim()]));
  function draw() {
    const v = values();
    const hex = color || editing?.color || nextColor;
    Object.assign(preview.style, { background: `#${hex}`, color: textOn(hex) });
    const part = (val, ph) => (val ? String(val).toUpperCase() : h('span.ph', ph));
    preview.replaceChildren(
      h('span.cc-title', part(v.category, 'STYLE'), ' ', part(v.level, '#')),
      ...[[v.weekday, 'TAG'], [v.time, 'HH:MM'], [v.coach, 'COACH']].map(([val, ph]) => h('span.cc-meta', part(val, ph))),
      h('span.cc-gap'));
  }
  const title = h('span.label', 'Neue Class');
  const msg = h('span.label');
  const field = (label, input) => h('label.field', h('span', label), input);
  const clear = () => {
    for (const el of Object.values(f)) el.value = '';
    editing = null;
    pick(null);
    title.textContent = 'Neue Class';
    saveBtn.textContent = addLabel;
    cancelBtn.hidden = true;
    if (doneBtn) doneBtn.hidden = false;
    draw();
    el.onClear?.();
  };
  const addLabel = done ? 'Weitere Class' : 'Class hinzufügen';
  // quiet: Doppel ohne Meldung übergehen (Weiter/Fertig: die Class gibt es dann ja schon)
  async function save({ quiet = false } = {}) {
      const vals = values();
      if (!vals.category) { if (!quiet) { msg.textContent = 'Bitte mindestens den Style angeben'; f.category.focus(); } return null; }
      const all = (await db.all('classes')).sort(byClassOrder);
      if (all.some(c => c.id !== editing?.id && KEYS.every(k => norm(c[k]) === norm(vals[k])))) { if (quiet) clear(); else msg.textContent = 'Diese Class gibt es schon'; return null; }
      let klass;
      if (editing) {
        klass = { ...editing, ...vals, color: color || editing.color };
        msg.textContent = `${classTitle(klass)} gespeichert`;
      } else {
        klass = { id: uid(), ...vals, color: color || PALETTE[all.length % PALETTE.length], order: all.length, created: Date.now() };
        nextColor = PALETTE[(all.length + 1) % PALETTE.length];
        msg.textContent = `${classTitle(klass)} angelegt`;
      }
      await db.put('classes', klass);
      clear();
      await onSaved?.(klass);
      return klass;
  }
  const saveBtn = h('button.btn.small', { type: 'button', onclick: () => save() }, addLabel);
  const doneBtn = done ? h('button.btn.small.primary', { type: 'button', onclick: async () => { if (values().category) await save({ quiet: true }); done(); } }, 'Fertig') : null;
  const cancelBtn = h('button.linkbtn', { type: 'button', hidden: true, onclick: () => { clear(); msg.textContent = ''; } }, 'Abbrechen');
  // Class (oder Choreo) aus einer Export-Datei übernehmen
  const importBtn = h('button.linkbtn.small-link', {
    type: 'button',
    onclick: async () => {
      const file = await chooseFile();
      if (!file) return;
      try {
        const r = await importExport(file);
        if (!r) return;
        msg.textContent = importSummary(r);
        onSaved?.(await db.get('classes', r.classId));
      } catch (e) { msg.textContent = e.message; }
    },
  }, 'importieren');

  // Knöpfe wie in Base und Profil: „Class hinzufügen“, daneben klein „importieren“. Die Verwaltung setzt sie
  // unter das Formular (el.actions), sonst stehen sie darin. Ebenso die Vorschau (el.preview): in der Liste bzw. oben.
  const actions = h('div.actions.add-row', doneBtn, saveBtn, withImport ? importBtn : null, cancelBtn, msg);
  const el = h('div.classform',
    heading ? title : null,
    preview,
    h('div.row', field('Style', f.category), field('Level', f.level), field('Wochentag', f.weekday), field('Uhrzeit', f.time), field('Coach', f.coach)),
    h('div', { style: { marginTop: '14px' } }, h('span.label.color-label', 'Farbe'), swatches),
    actions);
  el.preview = preview;
  el.actions = actions;
  el.addEventListener('input', draw);
  el.addEventListener('change', draw);
  draw();
  el.edit = cls => {
    editing = cls;
    for (const k of KEYS) f[k].value = cls[k] || '';
    pick(cls.color);
    title.textContent = `${classTitle(cls)} bearbeiten`;
    saveBtn.textContent = 'Speichern';
    cancelBtn.hidden = false;
    if (doneBtn) doneBtn.hidden = true;
    msg.textContent = '';
    draw();
    f.category.focus();
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  el.cancelIf = id => { if (editing?.id === id) clear(); };
  el.hasDraft = () => !!values().category;
  el.commit = () => save({ quiet: true });
  return el;
}
