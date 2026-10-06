// Classes ohne Video anlegen, bearbeiten, löschen. Genutzt im Intro und im Profil.
import { db, uid, deleteClass } from './db.js';
import { classPickers, confirmDialog, icon } from './ui.js';
import { chooseFile, importExport, importSummary } from './share.js';
import { h, PALETTE, textOn, WEEKDAYS, CLASS_TITLES, CLASS_LEVELS, classTitle, classCells, byClassOrder } from './util.js';

const norm = s => String(s || '').trim().toLowerCase();
const KEYS = ['category', 'level', 'weekday', 'time', 'coach'];

// Liste + Formular. onChange() nach jeder Änderung.
// Der graue Formularbereich ist nur offen, solange eine Class angelegt oder bearbeitet wird: „Fertig“ übernimmt sie
// und schließt ihn, „Bearbeiten“ öffnet ihn mit dieser Class, „Weitere Class“ unter der Liste mit einer neuen Zeile.
// Die Vorschau steht dabei als Zeile in der Liste (beim Bearbeiten an Stelle der Class). Ohne Classes ist er offen.
// el.form = das Formular (z. B. für form.commit() beim Weiter im Intro)
export function classManager(onChange, { withImport = true } = {}) {
  const list = h('div.cm-list');
  let open = false, first = true;
  const form = classForm(async () => { await refresh(); onChange?.(); }, { done: () => closeForm(), cancel: true });
  form.preview.remove();
  form.hidden = true;
  const msg = h('span.label');
  const moreBtn = h('button.btn.small', { type: 'button', onclick: () => openForm() }, 'Weitere Class');
  // Class (oder Choreo) aus einer Export-Datei übernehmen
  const importBtn = withImport ? h('button.linkbtn.small-link', {
    type: 'button',
    onclick: async () => {
      const file = await chooseFile();
      if (!file) return;
      try {
        const r = await importExport(file);
        if (!r) return;
        msg.textContent = importSummary(r);
        await refresh();
        onChange?.();
      } catch (e) { msg.textContent = e.message; }
    },
  }, 'importieren') : null;
  const addRow = h('div.actions.add-row', moreBtn, importBtn, msg);

  function placePreview() {
    list.querySelectorAll('.cm-row[hidden]').forEach(r => { r.hidden = false; });
    if (!open) { form.preview.remove(); return; }
    const row = form.editingId() && list.querySelector(`.cm-row[data-id="${form.editingId()}"]`);
    if (row) { row.hidden = true; list.insertBefore(form.preview, row); } else list.append(form.preview);
  }
  function openForm(cls = null) {
    if (cls) form.edit(cls); else form.reset();
    open = true; form.hidden = false; addRow.hidden = true; msg.textContent = '';
    placePreview();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeForm() {
    open = false; form.hidden = true; addRow.hidden = false;
    form.reset();
    placePreview();
  }
  async function refresh() {
    const classes = (await db.all('classes')).sort(byClassOrder);
    const choreos = await db.all('choreos');
    list.replaceChildren(...classes.map(c => {
      const n = choreos.filter(x => x.classId === c.id).length;
      return h('div.cm-row', { 'data-id': c.id, style: { background: `#${c.color}`, color: textOn(c.color) } },
        ...classCells(c),
        // Bearbeiten/Löschen als Icons wie bei den Markern
        h('span.cm-actions',
          h('button.mk-act', { type: 'button', title: 'Bearbeiten', 'aria-label': 'Bearbeiten', html: icon('rename'), onclick: () => openForm(c) }),
          h('button.mk-act', {
            type: 'button', title: 'Löschen', 'aria-label': 'Löschen', html: icon('trash'),
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'CLASS LÖSCHEN',
                text: n ? `„${classTitle(c)}“ und ${n} Choreo${n === 1 ? '' : 's'} samt Videos werden gelöscht.` : `„${classTitle(c)}“ wird gelöscht.`,
                ok: 'Löschen',
              });
              if (!ok) return;
              await deleteClass(c.id);
              if (form.editingId() === c.id) closeForm();
              await refresh();
              onChange?.();
            },
          })));
    }));
    placePreview();
    moreBtn.textContent = classes.length ? 'Weitere Class' : 'Neue Class';
    if (first) { first = false; if (!classes.length) openForm(); }
    return classes;
  }
  const el = h('div.class-manager', list, form, addRow);
  el.refresh = refresh;
  el.form = form;
  refresh();
  return el;
}

// Formular. onSaved(cls) nach Anlegen/Speichern. el.edit(cls) lädt eine Class zum Bearbeiten, el.reset() leert.
// done: Knopf „Fertig“ (übernimmt die eingetragene Class, falls ausgefüllt, dann done()).
// more: zusätzlich „Weitere Class“ (übernimmt und leert für die nächste, z. B. im Fenster „Neue Class“).
// cancel: „Abbrechen“ (verwirft und ruft done()). Ohne done: ein Knopf „Class hinzufügen“.
// el.hasDraft(): Mindestangabe (Style) eingetragen · el.commit(): eingetragene Class speichern (ohne Meldung bei Doppel)
export function classForm(onSaved, { heading = true, done = null, more = false, cancel = false } = {}) {
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
    draw();
  };
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
  // Fertig: eingetragene Class übernehmen (gibt es sie schon, bleibt das Formular mit Meldung offen), dann done()
  const doneBtn = done ? h('button.btn.small.primary', { type: 'button', onclick: async () => { if (values().category && !(await save())) return; done(); } }, 'Fertig') : null;
  const saveBtn = !done || more ? h(`button.btn.small${done ? '' : '.primary'}`, { type: 'button', onclick: () => save() }, done ? 'Weitere Class' : 'Class hinzufügen') : null;
  const cancelBtn = cancel ? h('button.linkbtn', { type: 'button', onclick: () => { clear(); msg.textContent = ''; done?.(); } }, 'Abbrechen') : null;
  const actions = h('div.actions', doneBtn, saveBtn, cancelBtn, msg);
  const el = h('div.classform',
    heading ? title : null,
    preview,
    h('div.row', field('Style', f.category), field('Level', f.level), field('Wochentag', f.weekday), field('Uhrzeit', f.time), field('Coach', f.coach)),
    h('div', { style: { marginTop: '14px' } }, h('span.label.color-label', 'Farbe'), swatches),
    actions);
  el.preview = preview;
  el.addEventListener('input', draw);
  el.addEventListener('change', draw);
  draw();
  el.edit = cls => {
    editing = cls;
    for (const k of KEYS) f[k].value = cls[k] || '';
    pick(cls.color);
    title.textContent = `${classTitle(cls)} bearbeiten`;
    msg.textContent = '';
    draw();
    f.category.focus();
  };
  el.reset = () => { clear(); msg.textContent = ''; };
  el.editingId = () => editing?.id || null;
  el.hasDraft = () => !!values().category;
  el.commit = () => save({ quiet: true });
  return el;
}
