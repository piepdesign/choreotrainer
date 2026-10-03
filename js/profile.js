// Profil: Name, ausführliche Auswertung (Heatmap, Übungszeit, Status, Choreos, Classes, Einheiten)
// und Präferenzen. Diagramme als schlankes SVG: Mengen in Graustufen (eine Skala), Identität über
// Class-Farben, Werte immer in Textfarbe, Tooltip auf jedem Datenpunkt.
import { db } from './db.js';
import { h, fmt, fmtDuration, relDate, fmtRecDate, inlineEdit, classTitle, stripe, byClassOrder, WEEKDAYS, textOn } from './util.js';
import { loadAll, dots, choreoCard, recTitle, nextClass } from './hub.js';
import { baseStats, latestRating, choreoLength, weekStart, dayKey } from './stats.js';
import { settings, saveSettings, applyTheme, BASE_STATS } from './settings.js';
import { PROVIDERS } from './providers.js';
import { classForm } from './classform.js';
import { go, toast } from './app.js';

const DAY = 86400000;
const NS = 'http://www.w3.org/2000/svg';
const min = sec => Math.round(sec / 60);

// SVG-Helfer
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
}

// Ein Tooltip für alles mit data-tip
function attachTooltip(root) {
  const tip = h('div.tooltip', { hidden: true });
  document.body.append(tip);
  const move = e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || !root.contains(t)) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    const x = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 12), y = e.clientY - tip.offsetHeight - 10;
    tip.style.left = `${x}px`;
    tip.style.top = `${y < 8 ? e.clientY + 16 : y}px`;
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', () => { tip.hidden = true; });
  return () => tip.remove();
}

// Senkrechte Balken (eine Reihe). items: [{ label, value, tip, now }]
function bars(items, { height = 120, unit = 'min' } = {}) {
  const maxV = Math.max(1, ...items.map(i => i.value));
  const w = 100 / items.length;
  const top = items.reduce((b, i, k) => (i.value > (items[b]?.value ?? -1) ? k : b), 0);
  return h('div.chart',
    svg('svg', { viewBox: `0 0 100 ${height}`, preserveAspectRatio: 'none', class: 'bars', height },
      svg('line', { x1: 0, x2: 100, y1: height - 0.5, y2: height - 0.5, class: 'baseline' }),
      items.map((i, k) => {
        const bh = (i.value / maxV) * (height - 14);
        return svg('g', { 'data-tip': i.tip ?? `${i.label}: ${i.value} ${unit}` },
          svg('rect', { x: k * w, y: 0, width: w, height, class: 'hit' }),
          i.value ? svg('rect', { x: k * w + w * 0.18, y: height - bh, width: w * 0.64, height: bh, rx: 1.2, class: `bar${i.now ? ' now' : ''}` }) : null);
      })),
    // Achsenbeschriftung als HTML (verzerrt nicht)
    // bei vielen Balken nur jede dritte Beschriftung (die letzte immer), Rest per Tooltip
    h('div.xlabels', items.map((i, k) => h('span', { class: k === top && i.value ? 'peak' : null },
      items.length <= 8 || (items.length - 1 - k) % 3 === 0 ? i.label : ''))),
    h('div.label.chart-note', items[top]?.value ? `Höchstwert: ${items[top].label} · ${items[top].value} ${unit}` : 'Noch keine Daten'));
}

// Waagrechte Balken mit Namen. items: [{ label, value, color, tip }]
function hbars(items, unit = 'min') {
  const maxV = Math.max(1, ...items.map(i => i.value));
  return h('div.hbars', items.map(i => h('div.hbar', { 'data-tip': i.tip ?? `${i.label}: ${i.value} ${unit}` },
    h('span.hb-label', i.color ? h('i.swatch', { style: { background: `#${i.color}` } }) : null, i.label),
    h('span.hb-track', h('span.hb-fill', { style: { width: `${(i.value / maxV) * 100}%` } })),
    h('span.hb-val', `${i.value} ${unit}`))));
}

// Kalender-Heatmap: 26 Wochen × 7 Tage, aktuelle Woche markiert
function heatmap(sessions, choreoTitle) {
  const byDay = new Map();
  for (const s of sessions) {
    const k = dayKey(s.start);
    const e = byDay.get(k) || { sec: 0, choreos: new Set() };
    e.sec += s.seconds;
    e.choreos.add(choreoTitle(s.choreoId));
    byDay.set(k, e);
  }
  const weeks = 26, cell = 12, gap = 3;
  const thisWeek = weekStart();
  const first = thisWeek - (weeks - 1) * 7 * DAY;
  const level = sec => (sec <= 0 ? 0 : sec < 600 ? 1 : sec < 1200 ? 2 : sec < 2400 ? 3 : 4);
  const W = 28 + weeks * (cell + gap), H = 18 + 7 * (cell + gap);
  const months = [];
  const nodes = [];
  for (let w = 0; w < weeks; w++) {
    const ws = first + w * 7 * DAY;
    const m = new Date(ws + 3 * DAY).getMonth();
    if (!months.length || months.at(-1).m !== m) months.push({ m, x: 28 + w * (cell + gap) });
    for (let d = 0; d < 7; d++) {
      const day = dayKey(ws + d * DAY + DAY / 2);
      if (day > Date.now()) continue;
      const e = byDay.get(day);
      const sec = e?.sec || 0;
      const date = new Date(day).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
      nodes.push(svg('rect', {
        x: 28 + w * (cell + gap), y: 18 + d * (cell + gap), width: cell, height: cell, rx: 2,
        class: `hm l${level(sec)}${ws === thisWeek ? ' cur' : ''}`,
        'data-tip': sec ? `${date}: ${min(sec) || '<1'} min · ${[...e.choreos].join(', ')}` : `${date}: nicht geübt`,
      }));
    }
  }
  const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  return h('div.chart.heat',
    svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'heatmap' },
      months.map(m => svg('text', { x: m.x, y: 10, class: 'axis' }, monthNames[m.m])),
      ['Mo', 'Mi', 'Fr', 'So'].map(d => svg('text', { x: 0, y: 18 + WEEKDAYS.indexOf(d) * (cell + gap) + 10, class: 'axis' }, d)),
      // Rahmen um die aktuelle Woche
      svg('rect', { x: 28 + (weeks - 1) * (cell + gap) - 2, y: 16, width: cell + 4, height: 7 * (cell + gap) + 1, rx: 3, class: 'curweek' }),
      nodes),
    h('div.legend', h('span.label', 'weniger'), [0, 1, 2, 3, 4].map(l => h(`i.hm-key.l${l}`)), h('span.label', 'mehr'), h('span.label', ' · 1–9 · 10–19 · 20–39 · ab 40 min pro Tag')));
}

// Kleine Verlaufslinie der Status-Bewertungen
function sparkline(ratings) {
  if (!ratings?.length) return h('span.label', '—');
  const pts = ratings.slice(-12);
  const W = 90, H = 22;
  const x = i => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * (W - 6) + 3);
  const y = v => H - 3 - ((v - 1) / 4) * (H - 6);
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'spark' },
    svg('polyline', { points: pts.map((r, i) => `${x(i)},${y(r.value)}`).join(' '), class: 'spark-line' }),
    pts.map((r, i) => svg('circle', { cx: x(i), cy: y(r.value), r: 2.5, class: 'spark-dot', 'data-tip': `${fmtRecDate(r.ts)}: Status ${r.value}` })));
}

export async function renderProfile(root, section) {
  const data = await loadAll();
  const { classes, choreos, recordings, sessions, classById, recsByChoreo } = data;
  const s = settings();
  const real = sessions.filter(x => x.seconds >= 5);
  const now = Date.now();
  const values = baseStats(data);
  const titleOf = c => c?.title || c?.song?.title || 'Ohne Song';
  const choreoById = Object.fromEntries(choreos.map(c => [c.id, c]));
  const choreoTitle = id => titleOf(choreoById[id]);
  const urls = [];

  // ── Kopf ──
  const since = Math.min(...[...choreos.map(c => c.created), ...real.map(x => x.start)].filter(Boolean), now);
  const head = h('section.p-head',
    h('span.label', 'Profil'),
    h('h1.wide.p-name', inlineEdit((s.name || 'Dein Name').toUpperCase(), async v => { await saveSettings({ name: v }); toast('Name gespeichert'); })),
    h('p.label', choreos.length ? `Dabei seit ${new Date(since).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })} · ${choreos.length} Choreos · ${classes.length} Classes` : 'Noch keine Daten'));

  const nav = h('nav.p-nav', [['overview', 'Übersicht'], ['time', 'Übungszeit'], ['status', 'Status'], ['choreos', 'Choreos'], ['classes', 'Classes'], ['sessions', 'Einheiten'], ['prefs', 'Präferenzen']]
    .map(([id, label]) => h('a', { href: `#/profile/${id}`, onclick: e => { e.preventDefault(); document.getElementById(`p-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#/profile/${id}`); } }, label)));

  const sect = (id, title, ...body) => h('section.p-sec', { id: `p-${id}` }, h('div.section-head', h('h2.wide', title)), ...body);

  // ── Übersicht: Zuletzt geübt + Heatmap ──
  const lastS = real.reduce((m, x) => (x.start > (m?.start || 0) ? x : m), null);
  const overview = sect('overview', 'ZULETZT GEÜBT',
    h('div.stats',
      tile('Zuletzt', values.last.value, lastS ? `${choreoTitle(lastS.choreoId)} · ${min(lastS.seconds)} min` : ''),
      tile('Serie', values.streak.value, 'Tage in Folge'),
      tile('Tage geübt (26 Wochen)', String(new Set(real.filter(x => x.start > now - 182 * DAY).map(x => dayKey(x.start))).size)),
      tile('Dauer gesamt', values.duration.value, values.duration.hint)),
    heatmap(real, choreoTitle));

  // ── Übungszeit ──
  const ws = weekStart();
  const weeksBack = 12;
  const perWeek = Array.from({ length: weeksBack }, (_, i) => {
    const a = ws - (weeksBack - 1 - i) * 7 * DAY, b = a + 7 * DAY;
    const sec = real.filter(x => x.start >= a && x.start < b).reduce((t, x) => t + x.seconds, 0);
    const d = new Date(a);
    return { label: `${d.getDate()}.${d.getMonth() + 1}.`, value: min(sec), now: i === weeksBack - 1, tip: `Woche ab ${d.toLocaleDateString('de-DE')}: ${min(sec)} min` };
  });
  const perWeekday = WEEKDAYS.map((d, k) => ({ label: d, value: min(real.filter(x => (new Date(x.start).getDay() + 6) % 7 === k).reduce((t, x) => t + x.seconds, 0)) }));
  const slots = [['Morgen', 5, 12], ['Mittag', 12, 17], ['Abend', 17, 22], ['Nacht', 22, 29]];
  const perSlot = slots.map(([label, a, b]) => ({
    label, value: min(real.filter(x => { const hh = new Date(x.start).getHours(); const hx = hh < 5 ? hh + 24 : hh; return hx >= a && hx < b; }).reduce((t, x) => t + x.seconds, 0)),
  }));
  const perChoreo = choreos.map(c => ({
    label: titleOf(c), color: classById[c.classId]?.color,
    value: min(real.filter(x => x.choreoId === c.id).reduce((t, x) => t + x.seconds, 0)),
  })).filter(i => i.value).sort((a, b) => b.value - a.value).slice(0, 8);
  const totalSec = real.reduce((t, x) => t + x.seconds, 0);
  const monthSec = real.filter(x => x.start > now - 30 * DAY).reduce((t, x) => t + x.seconds, 0);
  const rates = real.filter(x => x.avgRate);
  const time = sect('time', 'ÜBUNGSZEIT',
    h('div.stats',
      tile('Diese Woche', values.week.value),
      tile('30 Tage', fmtDuration(monthSec)),
      tile('Gesamt', values.total.value),
      tile('Ø pro Einheit', real.length ? fmtDuration(totalSec / real.length) : '—', `${real.length} Einheiten`),
      tile('Ø Tempo', rates.length ? `${(rates.reduce((t, x) => t + x.avgRate, 0) / rates.length).toFixed(2).replace('.', ',')}×` : '—', 'Wiedergabetempo beim Üben')),
    h('div.p-grid',
      h('div', h('h3.p-sub', 'Minuten pro Woche'), bars(perWeek)),
      h('div', h('h3.p-sub', 'Nach Wochentag'), bars(perWeekday)),
      h('div', h('h3.p-sub', 'Nach Tageszeit'), bars(perSlot)),
      h('div.span-all', h('h3.p-sub', 'Nach Choreo'), perChoreo.length ? hbars(perChoreo) : h('p.empty', 'Noch keine Übungszeit.'))));

  // ── Status ──
  const rated = choreos.filter(c => latestRating(c));
  const dist = [1, 2, 3, 4, 5].map(v => ({ label: String(v), value: rated.filter(c => latestRating(c) === v).length, tip: `Status ${v}: ${rated.filter(c => latestRating(c) === v).length} Choreos` }));
  const status = sect('status', 'Ø STATUS (1–5)',
    h('div.p-grid',
      h('div.p-big', h('b.wide', values.status.value), h('span.label', `aus ${rated.length} bewerteten Choreos`), dots(rated.length ? Math.round(rated.reduce((t, c) => t + latestRating(c), 0) / rated.length) : 0)),
      h('div', h('h3.p-sub', 'Verteilung'), bars(dist, { height: 90, unit: 'Choreos' }))),
    h('div.p-table',
      h('div.p-row.head', h('span', 'Choreo'), h('span', 'Status'), h('span', 'Verlauf'), h('span', 'Zuletzt bewertet')),
      ...[...choreos].sort((a, b) => (latestRating(a) || 0) - (latestRating(b) || 0)).map(c => h('a.p-row', { href: (recsByChoreo[c.id] || []).length ? `#/train/${recsByChoreo[c.id].at(-1).id}` : null },
        h('span', h('i.swatch', { style: { background: `#${classById[c.classId]?.color || 'ccc'}` } }), titleOf(c)),
        h('span', dots(latestRating(c))),
        h('span', sparkline(c.ratings)),
        h('span.label', c.ratings?.length ? relDate(c.ratings.at(-1).ts) : 'nie')))),
    h('p.label', 'Sortiert nach Status, die wackligsten zuerst.'));

  // ── Choreos: Galerie / Liste ──
  let view = 'gallery';
  try { view = localStorage.getItem('ct-choreo-view') || 'gallery'; } catch { /* egal */ }
  const choreoBox = h('div');
  const allSorted = [...choreos].sort((a, b) => (b.lastPracticed || b.created) - (a.lastPracticed || a.created));
  function renderChoreos() {
    if (view === 'gallery') {
      choreoBox.replaceChildren(allSorted.length ? h('div.cards', allSorted.map(c => choreoCard(c, classById[c.classId], recsByChoreo[c.id] || [], urls))) : h('p.empty', 'Noch keine Choreos.'));
    } else {
      choreoBox.replaceChildren(h('div.p-table.wide6',
        h('div.p-row.head', h('span', 'Choreo'), h('span', 'Class'), h('span', 'Status'), h('span', 'Länge'), h('span', 'Geübt'), h('span', 'Zuletzt')),
        ...allSorted.map(c => {
          const recs = recsByChoreo[c.id] || [];
          const len = choreoLength(recs);
          const sec = real.filter(x => x.choreoId === c.id).reduce((t, x) => t + x.seconds, 0);
          return h('a.p-row', { href: recs.length ? `#/train/${recs.at(-1).id}` : null },
            h('span', titleOf(c)),
            h('span', classById[c.classId] ? classTitle(classById[c.classId]) : '—'),
            h('span', dots(latestRating(c))),
            h('span', len ? fmt(len) : '—'),
            h('span', fmtDuration(sec)),
            h('span.label', relDate(c.lastPracticed)));
        })));
    }
    toggle.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  }
  const toggle = h('div.seg', [['gallery', 'Galerie'], ['list', 'Liste']].map(([v, l]) => h('button.ctl', { type: 'button', 'data-v': v, onclick: () => { view = v; try { localStorage.setItem('ct-choreo-view', v); } catch { /* egal */ } renderChoreos(); } }, l)));
  const choreoSec = sect('choreos', `CHOREOS`, h('div.actions', toggle, h('span.label', `${choreos.length} insgesamt`)), choreoBox);
  renderChoreos();

  // ── Classes ──
  const classSec = sect('classes', 'CLASSES',
    h('div.stripes', classes.sort(byClassOrder).map(c => {
      const mine = choreos.filter(x => x.classId === c.id);
      const sec = real.filter(x => mine.some(m => m.id === x.choreoId)).reduce((t, x) => t + x.seconds, 0);
      const nc = nextClass(c);
      return stripe(c, `${mine.length} CHOREO${mine.length === 1 ? '' : 'S'} · ${fmtDuration(sec).toUpperCase()}${nc ? ' · ' + nc.toUpperCase() : ''}`);
    })),
    classes.length ? h('div.p-grid', h('div.span-all', h('h3.p-sub', 'Übungszeit nach Class'),
      hbars(classes.map(c => ({ label: classTitle(c), color: c.color, value: min(real.filter(x => choreoById[x.choreoId]?.classId === c.id).reduce((t, x) => t + x.seconds, 0)) })).filter(i => i.value)))) : null,
    h('details.p-add', h('summary.linkbtn', '+ Class anlegen'), classForm(() => go('#/profile/classes', { keep: true }))));

  // ── Einheiten ──
  const recent = [...real].sort((a, b) => b.start - a.start).slice(0, 25);
  const sessionSec = sect('sessions', 'TRAININGSEINHEITEN',
    recent.length ? h('div.p-table.wide5',
      h('div.p-row.head', h('span', 'Wann'), h('span', 'Choreo'), h('span', 'Dauer'), h('span', 'Tempo'), h('span', 'Loops')),
      ...recent.map(x => h('div.p-row',
        h('span', new Date(x.start).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('span', choreoTitle(x.choreoId)),
        h('span', fmtDuration(x.seconds)),
        h('span', x.avgRate ? `${x.avgRate.toFixed(2).replace('.', ',')}×` : '—'),
        h('span', x.loops != null ? String(x.loops) : '—')))) : h('p.empty', 'Noch keine Einheiten. Gezählt wird, sobald ein Video läuft.'),
    h('p.label', 'Tempo und Loops werden ab dieser Version mitgeschrieben.'));

  // ── Präferenzen ──
  const chips = (opts, current, onPick) => {
    const box = h('div.chips', opts.map(([id, label]) => h(`button.btn${id === current ? '.primary' : ''}`, {
      type: 'button',
      onclick: e => { box.querySelectorAll('.btn').forEach(b => b.classList.remove('primary')); e.currentTarget.classList.add('primary'); onPick(id); },
    }, label)));
    return box;
  };
  const statBoxes = h('div.p-checks', BASE_STATS.map(([id, label]) => {
    const cb = h('input', { type: 'checkbox', checked: settings().baseStats.includes(id) });
    cb.addEventListener('change', async () => {
      const cur = new Set(settings().baseStats);
      if (cb.checked) cur.add(id); else cur.delete(id);
      await saveSettings({ baseStats: BASE_STATS.map(x => x[0]).filter(x => cur.has(x)) });
    });
    return h('label.p-check', cb, label);
  }));
  const prefs = sect('prefs', 'PRÄFERENZEN',
    h('h3.p-sub', 'Standardansicht'),
    chips([['system', 'Wie System'], ['light', 'Hell'], ['dark', 'Dunkel']], s.theme, async v => { applyTheme(v); await saveSettings({ theme: v }); }),
    h('h3.p-sub', 'Musikprovider'),
    h('p.label', 'Klick auf Cover oder Songtitel öffnet den Song dort. Exakt bei Deezer und Apple Music, sonst die Suche im Provider.'),
    chips(PROVIDERS, s.provider, async v => { await saveSettings({ provider: v }); }),
    h('h3.p-sub', 'Kennzahlen in der Base'),
    statBoxes,
    h('h3.p-sub', 'Intro'),
    h('button.btn.small', { type: 'button', onclick: async () => { await saveSettings({ introDone: false }); location.reload(); } }, 'Intro noch einmal zeigen'));

  root.append(head, nav, overview, time, status, choreoSec, classSec, sessionSec, prefs);
  const removeTip = attachTooltip(root);
  if (section) requestAnimationFrame(() => document.getElementById(`p-${section}`)?.scrollIntoView({ block: 'start' }));
  return () => { removeTip(); urls.forEach(u => URL.revokeObjectURL(u)); };
}

function tile(label, value, hint) {
  return h('div.stat', h('span.label', label), h('b', value), hint ? h('span.label.hint', hint) : null);
}
