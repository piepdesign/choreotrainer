// Profil: Name, ausführliche Auswertung (Heatmap, Übungszeit, Status, Choreos, Classes, Einheiten)
// und Präferenzen. Diagramme als schlankes SVG: Mengen in Graustufen (eine Skala), Identität über
// Class-Farben, Werte immer in Textfarbe, Tooltip auf jedem Datenpunkt.
import { db, deleteAllData } from './db.js';
import { h, tt, isTouch, fmt, fmtDuration, relDate, fmtRecDate, classTitle, stripe, byClassOrder, WEEKDAYS, textOn, plural } from './util.js';
import { loadAll, dots, choreoCard, recTitle, nextClass, importInto } from './hub.js';
import { songLink } from './providers.js';
import { baseStats, latestRating, choreoLength, weekStart, dayKey } from './stats.js';
import { settings, saveSettings, applyTheme, resetSettings, BASE_STATS } from './settings.js';
import { classManager } from './classform.js';
import { go, toast, replaceHash } from './app.js';
import { preferences, toggle, confirmDialog } from './ui.js';
import { storageState, askPersist, isInstalled, isIOS, canPromptInstall, promptInstall, exportBackup, readBackup, restoreBackup, missingVideos, relinkVideos, videoBytes, deleteRecordings, freeStorage } from './backup.js';

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

// Senkrechte Balken (eine Reihe). items: [{ label, value, tip, now, parts: [{ color, label, value }] }]
// Mit parts wird jeder Balken nach Class gestapelt und eingefärbt (Reihenfolge wie die Classes).
function bars(items, { height = 120, unit = 'min' } = {}) {
  const u = v => (Array.isArray(unit) ? plural(v, ...unit) : `${v} ${unit}`);
  const maxV = Math.max(1, ...items.map(i => i.value));
  const w = 100 / items.length;
  const top = items.reduce((b, i, k) => (i.value > (items[b]?.value ?? -1) ? k : b), 0);
  const scale = v => (v / maxV) * (height - 14);
  return h('div.chart',
    svg('svg', { viewBox: `0 0 100 ${height}`, preserveAspectRatio: 'none', class: 'bars', height },
      svg('line', { x1: 0, x2: 100, y1: height - 0.5, y2: height - 0.5, class: 'baseline' }),
      items.map((i, k) => {
        const x = k * w + w * 0.18, bw = w * 0.64;
        const parts = (i.parts || []).filter(p => p.value);
        let y = height;
        const segs = parts.length
          ? parts.map((p, j) => {
            const ph = scale(p.value);
            y -= ph;
            // 1,5 px Fläche zwischen gestapelten Segmenten
            return svg('rect', { x, y, width: bw, height: Math.max(0.5, ph - (j ? 1.5 : 0)), class: `bar seg${i.now ? ' now' : ''}`, style: `fill:#${p.color}` });
          })
          : i.value ? [svg('rect', { x, y: height - scale(i.value), width: bw, height: scale(i.value), rx: 1.2, class: `bar${i.now ? ' now' : ''}` })] : [];
        const detail = parts.length > 1 ? ` · ${parts.map(p => `${p.label} ${p.value}`).join(' · ')}` : parts.length === 1 ? ` · ${parts[0].label}` : '';
        return svg('g', { 'data-tip': `${i.tip ?? `${i.label}: ${u(i.value)}`}${detail}` },
          svg('rect', { x: k * w, y: 0, width: w, height, class: 'hit' }), segs);
      })),
    // Achsenbeschriftung als HTML (verzerrt nicht)
    // bei vielen Balken nur jede dritte Beschriftung (die letzte immer), Rest per Tooltip
    h('div.xlabels', items.map((i, k) => h('span', { class: k === top && i.value ? 'peak' : null },
      items.length <= 8 || (items.length - 1 - k) % 3 === 0 ? i.label : ''))),
    h('div.label.chart-note', items[top]?.value ? `Höchstwert: ${items[top].label} · ${u(items[top].value)}` : 'Noch keine Daten'));
}

// Waagrechte Balken mit Namen. items: [{ label, value, color, tip }]
function hbars(items, unit = 'min') {
  const maxV = Math.max(1, ...items.map(i => i.value));
  return h('div.hbars', items.map(i => h('div.hbar', { 'data-tip': i.tip ?? `${i.label}: ${i.value} ${unit}` },
    h('span.hb-label', i.color ? h('i.swatch', { style: { background: `#${i.color}` } }) : null, i.label),
    h('span.hb-track', h('span.hb-fill', { style: { width: `${(i.value / maxV) * 100}%`, background: i.color ? `#${i.color}` : null } })),
    h('span.hb-val', `${i.value} ${unit}`))));
}

// Kalender-Heatmap: so viele Wochen, wie in die Breite passen, × 7 Tage, aktuelle Woche markiert
// Farbe = Class, die an dem Tag am meisten geübt wurde, Deckkraft = Minuten
function heatmap(sessions, choreoTitle, colorOf) {
  const byDay = new Map();
  for (const s of sessions) {
    const k = dayKey(s.start);
    const e = byDay.get(k) || { sec: 0, choreos: new Set(), byColor: new Map() };
    e.sec += s.seconds;
    e.choreos.add(choreoTitle(s.choreoId));
    const c = colorOf(s.choreoId);
    if (c) e.byColor.set(c, (e.byColor.get(c) || 0) + s.seconds);
    byDay.set(k, e);
  }
  const mainColor = e => [...(e?.byColor || [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  const gap = 3, left = 30, top = 22, target = 16; // Zielgröße einer Zelle
  const thisWeek = weekStart();
  const level = sec => (sec <= 0 ? 0 : sec < 600 ? 1 : sec < 1200 ? 2 : sec < 2400 ? 3 : 4);
  const monthNames = ['JAN', 'FEB', 'MÄR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];
  // In echter Pixelbreite zeichnen, damit die Beschriftung klein und gleich groß bleibt (kein Mitskalieren)
  // Volle Breite: so viele Wochen, wie bei ~16 px Zellen hineinpassen (13 bis 53), Zellen genau auf Breite gestreckt.
  // Die betrachtete Woche (Start: diese Woche) steht in der Mitte, davor Vergangenheit, danach Zukunft.
  let shift = 0; // Wochen relativ zu heute (Navigation)
  let range = '';
  function draw(width) {
    const weeks = Math.max(13, Math.min(53, Math.floor((width - left) / (target + gap))));
    const step = (width - left) / weeks;
    const cellW = step - gap, cell = Math.min(cellW, 22), vstep = cell + gap; // Höhe gedeckelt, Breite füllt
    const center = thisWeek + shift * 7 * DAY;
    const first = center - Math.floor((weeks - 1) / 2) * 7 * DAY;
    const fmtM = t => `${monthNames[new Date(t).getMonth()]} ${new Date(t).getFullYear()}`;
    range = `${fmtM(first)} – ${fmtM(first + (weeks * 7 - 1) * DAY)}`;
    const curIdx = Math.round((thisWeek - first) / (7 * DAY));
    const W = width, H = top + 7 * vstep;
    const months = [];
    const nodes = [];
    for (let w = 0; w < weeks; w++) {
      const ws = first + w * 7 * DAY;
      const m = new Date(ws + 3 * DAY).getMonth();
      if (!months.length || months.at(-1).m !== m) months.push({ m, x: left + w * step });
      for (let d = 0; d < 7; d++) {
        const day = dayKey(ws + d * DAY + DAY / 2);
        if (day > Date.now()) {
          nodes.push(svg('rect', { x: left + w * step, y: top + d * vstep, width: cellW, height: cell, rx: 2, class: 'hm future' }));
          continue;
        }
        const e = byDay.get(day);
        const sec = e?.sec || 0;
        const date = new Date(day).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        const col = sec ? mainColor(e) : null;
        nodes.push(svg('rect', {
          x: left + w * step, y: top + d * vstep, width: cellW, height: cell, rx: 2,
          class: `hm l${level(sec)}${ws === thisWeek ? ' cur' : ''}`,
          style: col ? `fill:#${col}` : null,
          'data-tip': sec ? `${date}: ${min(sec) || '<1'} min · ${[...e.choreos].join(', ')}` : `${date}: nicht geübt`,
        }));
      }
    }
    // Monatsnamen nicht überlappen lassen (erste Spalte kann sehr kurz sein)
    const shown = months.filter((m, i) => i === months.length - 1 || months[i + 1].x - m.x >= 30);
    return svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'heatmap' },
      shown.map(m => svg('text', { x: m.x, y: 12, class: 'axis' }, monthNames[m.m])),
      ['M', 'D', 'M', 'D', 'F', 'S', 'S'].map((d, k) => svg('text', { x: 0, y: top + k * vstep + cell / 2 + 4, class: 'axis' }, d)),
      // Rahmen um die aktuelle Woche (nur wenn sichtbar)
      curIdx >= 0 && curIdx < weeks ? svg('rect', { x: left + curIdx * step - 2, y: top - 2, width: cellW + 4, height: 7 * vstep + 1, rx: 3, class: 'curweek' }) : null,
      nodes);
  }
  const plot = h('div.heat-plot');
  const rangeEl = h('span.label.heat-range');
  let lastW = 0;
  const redraw = () => { plot.replaceChildren(draw(lastW)); rangeEl.textContent = range; todayBtn.disabled = shift === 0; };
  const ro = new ResizeObserver(() => {
    if (!plot.isConnected) { ro.disconnect(); return; }
    const w = plot.clientWidth;
    if (!w || Math.abs(w - lastW) < 4) return; // versteckter Reiter: erst beim Zeigen zeichnen
    lastW = w;
    redraw();
  });
  ro.observe(plot);
  // Navigation: Monat = 4 Wochen, Jahr = 52 Wochen
  const nav = (label, title, weeks) => h('button.ctl', { type: 'button', title, onclick: () => { shift += weeks; redraw(); } }, label);
  const todayBtn = h('button.ctl', { type: 'button', title: 'Zurück zu heute', onclick: () => { shift = 0; redraw(); } }, 'Heute');
  return h('div.chart.heat',
    h('div.heat-nav',
      nav('«', 'Ein Jahr zurück', -52), nav('‹', 'Einen Monat zurück', -4), todayBtn, nav('›', 'Einen Monat vor', 4), nav('»', 'Ein Jahr vor', 52),
      rangeEl),
    plot,
    h('div.legend',
      h('span.label', 'Weniger'),
      h('span.hm-keys', [0, 1, 2, 3, 4].map(l => h(`i.hm-key.l${l}`, { title: ['nicht geübt', '1–9 min', '10–19 min', '20–39 min', 'ab 40 min'][l] }))),
      h('span.label', 'Mehr'),
      h('span.label.legend-sep', 'Minuten pro Tag: 1–9 · 10–19 · 20–39 · ab 40')));
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

// Sortierbare Tabelle: Klick auf eine Spaltenüberschrift sortiert, zweiter Klick dreht die Richtung
// cols: [{ label, value: r => Zahl|Text, cell: r => Inhalt, dir: 1|-1 (Startrichtung) }]
function sortTable(cols, rows, { sort = 0, cls = '', href = null, key = null } = {}) {
  let si = sort, sd = cols[sort].dir ?? 1;
  try { const saved = key && JSON.parse(localStorage.getItem(key)); if (saved && cols[saved.i]) { si = saved.i; sd = saved.d; } } catch { /* egal */ }
  const box = h(`div.p-table${cls}`);
  const cmp = (x, y) => (typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? ''), 'de') : (x ?? -Infinity) - (y ?? -Infinity));
  function render() {
    const sorted = [...rows].sort((a, b) => cmp(cols[si].value(a), cols[si].value(b)) * sd);
    box.replaceChildren(
      h('div.p-row.head', cols.map((c, i) => h(`button.sort${i === si ? '.on' : ''}`, {
        type: 'button', title: 'Sortieren',
        onclick: () => {
          if (si === i) sd = -sd; else { si = i; sd = c.dir ?? 1; }
          try { if (key) localStorage.setItem(key, JSON.stringify({ i: si, d: sd })); } catch { /* egal */ }
          render();
        },
      }, c.label, h('i.sort-dir', i === si ? (sd > 0 ? '↑' : '↓') : '')))),
      ...(sorted.length ? sorted.map(r => {
        const link = href?.(r);
        return h(link ? 'a.p-row' : 'div.p-row', { href: link || null }, cols.map(c => h('span', c.cell(r))));
      }) : [h('p.empty', 'Keine Einträge.')]));
  }
  render();
  return box;
}

export async function renderProfile(root, section) {
  const all = await loadAll();
  const s = settings();
  const now = Date.now();
  const titleOf = c => c?.title || c?.song?.title || 'Ohne Song';

  // ── Filter nach Class: gilt für alle Auswertungen, Listen und Diagramme ──
  let filter = '';
  try { filter = localStorage.getItem('ct-profile-class') || ''; } catch { /* egal */ }
  if (!all.classById[filter]) filter = '';
  const classes = all.classes.filter(c => !filter || c.id === filter).sort(byClassOrder);
  const choreos = all.choreos.filter(c => !filter || c.classId === filter);
  const ids = new Set(choreos.map(c => c.id));
  const recordings = all.recordings.filter(r => ids.has(r.choreoId));
  const sessions = all.sessions.filter(x => ids.has(x.choreoId));
  const { classById, recsByChoreo } = all;
  const data = { ...all, classes, choreos, recordings, sessions };
  const real = sessions.filter(x => x.seconds >= 5);
  const values = baseStats(data);
  const choreoById = Object.fromEntries(all.choreos.map(c => [c.id, c]));
  const choreoTitle = id => titleOf(choreoById[id]);
  const classOf = id => classById[choreoById[id]?.classId];
  const colorOf = id => classOf(id)?.color;
  const urls = [];
  // Minuten einer Liste von Einheiten, aufgeteilt nach Class (für gestapelte Balken)
  const parts = list => classes.map(c => ({
    color: c.color, label: classTitle(c),
    value: min(list.filter(x => choreoById[x.choreoId]?.classId === c.id).reduce((t, x) => t + x.seconds, 0)),
  }));

  // ── Kopf ──
  const since = Math.min(...[...all.choreos.map(c => c.created), ...all.sessions.map(x => x.start)].filter(Boolean), now);
  const head = h('section.p-head',
    h('span.label', 'Profil'),
    // Name nur zur Anzeige, geändert wird er in den Einstellungen unter Konto
    h('h1.wide.p-name', (s.name || 'Dein Name').toUpperCase()),
    h('p.label', all.choreos.length ? `Dabei seit ${new Date(since).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })} · ${plural(all.choreos.length, 'Choreo', 'Choreos')} · ${plural(all.classes.length, 'Class', 'Classes')}` : 'Noch keine Daten'));

  // Reiter: immer nur ein Bereich sichtbar. Alte Abschnittsadressen (z. B. aus Base-Kacheln) zeigen auf den passenden Reiter.
  // Einstellungen sind eine eigene Seite (#/settings, Zahnrad in der Kopfleiste)
  const TABS = [['overview', 'Übersicht'], ['time', 'Übungszeit'], ['status', 'Status'], ['choreos', 'Choreos']];
  const ALIAS = { classes: 'overview', sessions: 'time', prefs: 'settings', account: 'settings' };
  const settingsPage = (ALIAS[section] || section) === 'settings';
  let current = ALIAS[section] || (TABS.some(t => t[0] === section) ? section : 'overview');
  const nav = h('nav.p-nav', { role: 'tablist' }, TABS.map(([id, label]) => h('a', {
    href: `#/profile/${id}`, role: 'tab', 'data-tab': id,
    onclick: e => { e.preventDefault(); showTab(id, true); },
  }, label)));

  const setFilter = id => {
    try { localStorage.setItem('ct-profile-class', id); } catch { /* egal */ }
    go(location.hash, { keep: true });
  };
  const filterRow = all.classes.length > 1 ? h('div.p-filter',
    h('span.label', 'Class'),
    h('div.optgroup', [['', 'Alle', null], ...all.classes.sort(byClassOrder).map(c => [c.id, classTitle(c), c.color])].map(([id, label, color]) =>
      h(`button.opt${id === filter ? '.on' : ''}`, { type: 'button', onclick: () => setFilter(id) },
        color ? h('i.swatch', { style: { background: `#${color}` } }) : h('i.dot'), label)))) : null;

  // Block innerhalb eines Reiters; ohne Titel, wenn er dem Reiter entspricht
  const sect = (id, title, ...body) => h('section.p-sec', { id: `p-${id}` }, title ? h('h2.p-group', title) : null, ...body);

  // ── Übersicht: Kennzahlen + Heatmap ──
  const lastS = real.reduce((m, x) => (x.start > (m?.start || 0) ? x : m), null);
  const overview = sect('overview', null,
    h('div.stats',
      tile('Zuletzt', values.last.value, lastS ? `${choreoTitle(lastS.choreoId)} · ${min(lastS.seconds)} min` : ''),
      tile('Serie', values.streak.value, 'Tage in Folge'),
      tile('Tage geübt', String(new Set(real.filter(x => x.start > now - 182 * DAY).map(x => dayKey(x.start))).size), 'in den letzten 26 Wochen'),
      tile('Dauer gesamt', values.duration.value, values.duration.hint)),
    heatmap(real, choreoTitle, colorOf));

  // ── Übungszeit ──
  const ws = weekStart();
  const weeksBack = 12;
  const perWeek = Array.from({ length: weeksBack }, (_, i) => {
    const a = ws - (weeksBack - 1 - i) * 7 * DAY, b = a + 7 * DAY;
    const list = real.filter(x => x.start >= a && x.start < b);
    const d = new Date(a);
    return { label: `${d.getDate()}.${d.getMonth() + 1}.`, value: min(list.reduce((t, x) => t + x.seconds, 0)), parts: parts(list), now: i === weeksBack - 1, tip: `Woche ab ${d.toLocaleDateString('de-DE')}: ${min(list.reduce((t, x) => t + x.seconds, 0))} min` };
  });
  const perWeekday = WEEKDAYS.map((d, k) => {
    const list = real.filter(x => (new Date(x.start).getDay() + 6) % 7 === k);
    return { label: d, value: min(list.reduce((t, x) => t + x.seconds, 0)), parts: parts(list) };
  });
  const slots = [['Morgen', 5, 12], ['Mittag', 12, 17], ['Abend', 17, 22], ['Nacht', 22, 29]];
  const perSlot = slots.map(([label, a, b]) => {
    const list = real.filter(x => { const hh = new Date(x.start).getHours(); const hx = hh < 5 ? hh + 24 : hh; return hx >= a && hx < b; });
    return { label, value: min(list.reduce((t, x) => t + x.seconds, 0)), parts: parts(list) };
  });
  const perChoreo = choreos.map(c => ({
    label: titleOf(c), color: classById[c.classId]?.color,
    value: min(real.filter(x => x.choreoId === c.id).reduce((t, x) => t + x.seconds, 0)),
  })).filter(i => i.value).sort((a, b) => b.value - a.value).slice(0, 8);
  const totalSec = real.reduce((t, x) => t + x.seconds, 0);
  const monthSec = real.filter(x => x.start > now - 30 * DAY).reduce((t, x) => t + x.seconds, 0);
  const rates = real.filter(x => x.avgRate);
  const time = sect('time', null,
    h('div.stats',
      tile('Diese Woche', values.week.value),
      tile('30 Tage', fmtDuration(monthSec)),
      tile('Gesamt', values.total.value),
      tile('Ø pro Einheit', real.length ? fmtDuration(totalSec / real.length) : '—', plural(real.length, 'Einheit', 'Einheiten')),
      tile('Ø Tempo', rates.length ? `${(rates.reduce((t, x) => t + x.avgRate, 0) / rates.length).toFixed(2).replace('.', ',')}×` : '—', 'Wiedergabetempo beim Üben')),
    h('div.p-grid',
      h('div', h('h3.p-sub', 'Minuten pro Woche'), bars(perWeek)),
      h('div', h('h3.p-sub', 'Nach Wochentag'), bars(perWeekday)),
      h('div', h('h3.p-sub', 'Nach Tageszeit'), bars(perSlot)),
      h('div.span-all', h('h3.p-sub', 'Nach Choreo'), perChoreo.length ? hbars(perChoreo) : h('p.empty', 'Noch keine Übungszeit.'))));

  // ── Status ──
  const rated = choreos.filter(c => latestRating(c));
  const dist = [1, 2, 3, 4, 5].map(v => {
    const list = rated.filter(c => latestRating(c) === v);
    return {
      label: String(v), value: list.length, tip: `Status ${v}: ${plural(list.length, 'Choreo', 'Choreos')}`,
      parts: classes.map(c => ({ color: c.color, label: classTitle(c), value: list.filter(x => x.classId === c.id).length })),
    };
  });
  const statusOf = c => latestRating(c) || 0;
  const status = sect('status', null,
    h('div.p-grid',
      h('div.p-big', h('b.wide', values.status.value), h('span.label', `aus ${plural(rated.length, 'bewerteten Choreo', 'bewerteten Choreos')}`), dots(rated.length ? Math.round(rated.reduce((t, c) => t + latestRating(c), 0) / rated.length) : 0)),
      h('div', h('h3.p-sub', 'Verteilung'), bars(dist, { height: 90, unit: ['Choreo', 'Choreos'] }))),
    sortTable([
      { label: 'Choreo', value: c => titleOf(c), cell: c => [h('i.swatch', { style: { background: `#${classById[c.classId]?.color || 'ccc'}` } }), titleOf(c)] },
      { label: 'Status', value: statusOf, cell: c => dots(latestRating(c)) },
      { label: 'Verlauf', value: c => c.ratings?.length || 0, cell: c => sparkline(c.ratings), dir: -1 },
      { label: 'Zuletzt bewertet', value: c => c.ratings?.at(-1)?.ts || 0, cell: c => h('span.label', c.ratings?.length ? relDate(c.ratings.at(-1).ts) : 'nie'), dir: -1 },
    ], choreos, { sort: 1, key: 'ct-sort-status', href: c => ((recsByChoreo[c.id] || []).length ? `#/train/${recsByChoreo[c.id].at(-1).id}` : null) }),
    h('p.label', `Spaltenüberschrift ${tt('anklicken', 'antippen')} zum Sortieren. Standard: die wackligsten zuerst.`));

  // ── Choreos: Galerie / Liste ──
  let view = 'gallery', gsort = 'recent';
  try { view = localStorage.getItem('ct-choreo-view') || 'gallery'; gsort = localStorage.getItem('ct-choreo-sort') || 'recent'; } catch { /* egal */ }
  const choreoBox = h('div');
  const secOf = c => real.filter(x => x.choreoId === c.id).reduce((t, x) => t + x.seconds, 0);
  const lenOf = c => choreoLength(recsByChoreo[c.id] || []) || 0;
  const GSORT = {
    recent: ['Zuletzt geübt', (a, b) => (b.lastPracticed || b.created) - (a.lastPracticed || a.created)],
    title: ['Titel', (a, b) => titleOf(a).localeCompare(titleOf(b), 'de')],
    status: ['Status', (a, b) => statusOf(a) - statusOf(b)],
    time: ['Übungszeit', (a, b) => secOf(b) - secOf(a)],
    length: ['Länge', (a, b) => lenOf(b) - lenOf(a)],
  };
  const sortSel = h('select.inline-select', Object.entries(GSORT).map(([k, [l]]) => h('option', { value: k, selected: k === gsort }, l)));
  sortSel.addEventListener('change', () => { gsort = sortSel.value; try { localStorage.setItem('ct-choreo-sort', gsort); } catch { /* egal */ } renderChoreos(); });
  const sortWrap = h('label.inline-sort', h('span.label', 'Sortieren'), sortSel);
  function renderChoreos() {
    sortWrap.hidden = view !== 'gallery';
    if (view === 'gallery') {
      const list = [...choreos].sort(GSORT[gsort]?.[1] || GSORT.recent[1]);
      choreoBox.replaceChildren(list.length ? h('div.cards', list.map(c => choreoCard(c, classById[c.classId], recsByChoreo[c.id] || [], urls))) : h('p.empty', 'Noch keine Choreos.'));
    } else {
      choreoBox.replaceChildren(sortTable([
        // klein und quadratisch: Song-Cover (Hover = Hörprobe) und Standbild des Videos (zu klein für eine Vorschau)
        { label: 'Choreo', value: c => titleOf(c), cell: c => [
          c.song?.cover ? songLink(h('img.sq-cover', { src: c.song.cover, alt: '' }), c.song) : h('i.sq-cover.blank'),
          recsByChoreo[c.id]?.at(-1)?.thumb ? h('img.sq-thumb', { src: recsByChoreo[c.id].at(-1).thumb, alt: '' }) : h('i.sq-thumb.blank'),
          h('span.sq-title', titleOf(c))] },
        { label: 'Class', value: c => (classById[c.classId] ? classTitle(classById[c.classId]) : ''), cell: c => [h('i.swatch', { style: { background: `#${classById[c.classId]?.color || 'ccc'}` } }), classById[c.classId] ? classTitle(classById[c.classId]) : '—'] },
        { label: 'Status', value: statusOf, cell: c => dots(latestRating(c)) },
        { label: 'Länge', value: lenOf, cell: c => (lenOf(c) ? fmt(lenOf(c)) : '—'), dir: -1 },
        { label: 'Geübt', value: secOf, cell: c => fmtDuration(secOf(c)), dir: -1 },
        { label: 'Zuletzt', value: c => c.lastPracticed || 0, cell: c => h('span.label', relDate(c.lastPracticed)), dir: -1 },
      ], choreos, { sort: 5, cls: '.wide6', key: 'ct-sort-choreos', href: c => ((recsByChoreo[c.id] || []).length ? `#/train/${recsByChoreo[c.id].at(-1).id}` : null) }));
    }
    viewSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  }
  const viewSeg = h('div.seg', [['gallery', 'Galerie'], ['list', 'Liste']].map(([v, l]) => h('button.ctl', { type: 'button', 'data-v': v, onclick: () => { view = v; try { localStorage.setItem('ct-choreo-view', v); } catch { /* egal */ } renderChoreos(); } }, l)));
  const choreoSec = sect('choreos', null, h('div.actions.p-tools', viewSeg, sortWrap, h('span.label', `${choreos.length} insgesamt`)), choreoBox);
  renderChoreos();

  // ── Classes ──
  const classSec = sect('classes', 'Classes',
    // rechte Angaben als eigene Spalten; Wochentag/Uhrzeit stehen schon links, daher nur „in 4 Tagen“
    h('div.stripes', { style: { '--rc': 3 } }, classes.map(c => {
      const mine = choreos.filter(x => x.classId === c.id);
      const sec = real.filter(x => mine.some(m => m.id === x.choreoId)).reduce((t, x) => t + x.seconds, 0);
      const nc = nextClass(c)?.split(' · ').at(-1) || '';
      return stripe(c, [plural(mine.length, 'CHOREO', 'CHOREOS'), fmtDuration(sec).toUpperCase(), nc.toUpperCase()]);
    })));
  const manageSec = sect('manage', 'Classes verwalten', classManager(() => go('#/settings', { keep: true })));

  // ── Einheiten ──
  const recent = [...real].sort((a, b) => b.start - a.start).slice(0, 50);
  const sessionSec = sect('sessions', 'Einheiten',
    recent.length ? sortTable([
      { label: 'Wann', value: x => x.start, cell: x => new Date(x.start).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), dir: -1 },
      { label: 'Choreo', value: x => choreoTitle(x.choreoId), cell: x => [h('i.swatch', { style: { background: `#${colorOf(x.choreoId) || 'ccc'}` } }), choreoTitle(x.choreoId)] },
      { label: 'Dauer', value: x => x.seconds, cell: x => fmtDuration(x.seconds), dir: -1 },
      { label: 'Tempo', value: x => x.avgRate || 0, cell: x => (x.avgRate ? `${x.avgRate.toFixed(2).replace('.', ',')}×` : '—'), dir: -1 },
      { label: 'Loops', value: x => x.loops ?? -1, cell: x => (x.loops != null ? String(x.loops) : '—'), dir: -1 },
    ], recent, { sort: 0, cls: '.wide5', key: 'ct-sort-sessions' }) : h('p.empty', 'Noch keine Einheiten. Gezählt wird, sobald ein Video läuft.'),
    recent.length ? h('p.label', recent.length === 1 ? 'Eine Einheit.' : `Die letzten ${recent.length} Einheiten.`) : null);

  // ── Präferenzen und Konto ──
  const prefs = sect('prefs', 'Präferenzen',
    preferences(s, async patch => { if (patch.theme) applyTheme(patch.theme); await saveSettings(patch); }, baseStats(all)));

  const nameIn = h('input.caps', { type: 'text', value: (s.name || '').toUpperCase(), placeholder: 'DEIN NAME' });
  const saveName = async () => { if (!nameIn.value.trim()) return; await saveSettings({ name: nameIn.value.trim().toUpperCase() }); toast('Name gespeichert'); go('#/settings', { keep: true }); };
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
  // Kacheln: Überschrift, Bedienelemente, Knopf. Keine Erklärtexte; was Zurücksetzen/Löschen bewirkt, sagt das Bestätigungsfenster.
  const accRow = (title, body, button) => h('div.acc-card', h('span.acc-title', title), body?.length ? h('div.acc-text', body) : null, button);
  const stateLine = text => h('p.acc-lead', text); // Zustand (keine Erklärung), z. B. Belegung
  // Konto: Profil, Tutorial, Neustart, ganz zuletzt das endgültige Löschen
  const account = sect('account', 'Konto',
    h('div.acc',
      // Name + Helfer*in in einer Kachel; Helfer*in wirkt sofort (Knopf unten rechts für Bug-Meldungen und Ideen)
      accRow('Profil', [
        h('label.field', h('span', 'Name'), nameIn),
        toggle('Helfer*in', !!s.tester, v => saveSettings({ tester: v })),
      ], h('button.btn.small', { type: 'button', onclick: saveName }, 'Speichern')),
      accRow('Tutorial', [],
        h('button.btn.small', {
          type: 'button',
          onclick: async () => { await saveSettings({ tourDone: false, tourTrainDone: false }); go('#/'); },
        }, 'Starten')),
      accRow('Neustart', [],
        h('button.btn.small', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog({ title: 'NEUSTART', text: 'Setzt Name, Präferenzen und Panel-Anordnung zurück, das Intro startet neu. Classes, Choreos, Videos und Statistiken bleiben.', ok: 'Zurücksetzen', danger: false }))) return;
            await resetSettings(); location.hash = '#/'; location.reload();
          },
        }, 'Zurücksetzen')),
      accRow('Werkseinstellungen', [],
        h('button.btn.small.danger', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog({ title: 'ALLES LÖSCHEN', text: 'Löscht in diesem Browser alle Classes, Choreos, Videos, Songdateien, Einheiten und das Profil. Lässt sich nicht rückgängig machen.', ok: 'Alles löschen', typeToConfirm: settings().name || 'LÖSCHEN' }))) return;
            await deleteAllData();
            location.hash = '#/';
            location.reload();
          },
        }, 'Alles löschen'))));

  // ── Daten: erst Sichern/Einspielen, dann Zustand (Speicher, App), zuletzt Löschen ──
  const dataBox = h('div.acc');
  const mb = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
  const pick = (accept, multiple, onFiles) => {
    const input = h('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  };
  let withVideos = true; // Sicherung mit Videos (Standard) oder nur die Eingaben
  async function renderData() {
    const [st, missing, vBytes] = await Promise.all([storageState(), missingVideos(), videoBytes()]);
    const last = settings().lastBackup;
    const installed = isInstalled();
    // Gelöschte Videos gibt der Browser erst frei, wenn die Seite neu geladen wurde (vorher halten Verweise sie fest)
    const pending = (st.idb ?? st.usage ?? 0) - vBytes;
    const cards = [
      accRow('Sicherung', [toggle(`Mit Videos${vBytes ? ` (${mb(vBytes)})` : ''}`, withVideos, v => { withVideos = v; }),
          last ? h('p.acc-note', `Zuletzt ${relDate(last)}`) : null],
        h('button.btn.small', {
          type: 'button',
          onclick: async () => {
            try {
              const r = await exportBackup({ videos: withVideos });
              await saveSettings({ lastBackup: Date.now() });
              toast(`Gesichert: ${plural(r.counts.choreos, 'Choreo', 'Choreos')}, ${plural(r.counts.recordings, 'Aufnahme', 'Aufnahmen')}${r.videos ? `, ${plural(r.videos, 'Datei', 'Dateien')} (${mb(r.bytes)})` : ''}`, 4000);
              renderData();
            } catch (e) { console.error(e); toast(`Sichern fehlgeschlagen: ${e.message}`, 5000); }
          },
        }, 'Sichern')),
      accRow('Wiederherstellen', [],
        h('button.btn.small', {
          type: 'button',
          // nur .ctbackup; am Handy ohne Filter (iPhone graut unbekannte Endungen sonst aus), geprüft wird nach dem Wählen
          onclick: () => pick(isTouch() ? '' : '.ctbackup', false, async ([file]) => {
            try {
              const b = await readBackup(file);
              const n = b.data.choreos?.length || 0, r = b.data.recordings?.length || 0, v = b.videos.length;
              if (!(await confirmDialog({ title: 'WIEDERHERSTELLEN', text: `Spielt die Sicherung vom ${new Date(b.exportedAt).toLocaleDateString('de-DE')} ein: ${plural(n, 'Choreo', 'Choreos')}, ${plural(r, 'Aufnahme', 'Aufnahmen')}, ${v ? plural(v, 'Video/Songdatei', 'Videos/Songdateien') : 'ohne Videos'}. Gleiche Einträge werden ersetzt, alles andere bleibt.`, ok: 'Einspielen', danger: false }))) return;
              await restoreBackup(b, (i, all) => toast(`Stelle Videos wieder her … ${i} / ${all}`, 60000));
              toast('Wiederhergestellt', 2500);
              setTimeout(() => location.reload(), 600); // Einstellungen und Ansichten frisch laden
            } catch (e) { console.error(e); toast(e.message, 5000); }
          }),
        }, 'Datei wählen')),
      accRow('Importieren', [],
        h('button.btn.small', { type: 'button', onclick: () => importInto() }, 'Datei wählen')),
    ];
    if (missing.length) cards.push(accRow(`${plural(missing.length, 'Video', 'Videos')} fehlen`, [],
      h('button.btn.small', {
        type: 'button',
        onclick: () => pick('video/*', true, async files => {
          toast('Ordne zu …', 1500);
          const r = await relinkVideos(files, missing);
          toast(`${plural(r.matched, 'Video', 'Videos')} zugeordnet${r.unmatched.length ? `, nicht erkannt: ${r.unmatched.join(', ')}` : ''}`, 6000);
          renderData();
        }),
      }, 'Zuordnen')));
    cards.push(accRow('Speicher', [
        stateLine(st.usage != null ? `${mb(st.usage)} belegt · ${st.persisted ? 'dauerhaft' : 'nicht dauerhaft'}` : (st.persisted ? 'dauerhaft' : 'nicht dauerhaft')),
        pending > 20e6 ? h('p.acc-note', `${mb(pending)} noch nicht freigegeben`) : null],
      pending > 20e6 ? h('button.btn.small', { type: 'button', onclick: freeStorage }, 'Freigeben')
        : !st.persisted && st.supported ? h('button.btn.small', {
          type: 'button',
          onclick: async () => { toast((await askPersist()) ? 'Speicher ist jetzt dauerhaft' : 'Der Browser lehnt ab. Als App installiert klappt es meist.', 4000); renderData(); },
        }, 'Dauerhaft anfordern') : null));
    cards.push(accRow('App', installed ? [stateLine('installiert')] : [],
      installed ? null : h('button.btn.small', {
        type: 'button',
        onclick: async () => {
          if (canPromptInstall()) { await promptInstall(); renderData(); return; }
          // ohne Installations-Angebot des Browsers: kurz zeigen, wie es geht
          await confirmDialog({ title: 'INSTALLIEREN', text: isIOS() ? 'In Safari: Teilen › Zum Home-Bildschirm. Die App hat dort einen eigenen Speicher, danach die Sicherung einspielen.' : 'Im Browser-Menü „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.', ok: 'OK', danger: false, cancel: false });
        },
      }, 'Installieren')));
    cards.push(accRow('Aufnahmen löschen', [],
      h('button.btn.small.danger', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'AUFNAHMEN LÖSCHEN', text: `Löscht alle Choreos mit Aufnahmen, Videos und Songdateien (${mb(vBytes)}) sowie die Einheiten und gibt den Speicher frei. Classes, Profil und Präferenzen bleiben. Lässt sich nicht rückgängig machen.`, ok: 'Löschen' }))) return;
          await deleteRecordings();
          freeStorage();
        },
      }, 'Löschen')));
    dataBox.replaceChildren(...cards);
    // Freigabe läuft im Hintergrund: Kachel alle 5 s neu prüfen, bis der Speicher frei ist (höchstens 2 min)
    clearTimeout(recheck);
    if (pending > 20e6 && dataBox.isConnected && rechecks++ < 24) recheck = setTimeout(renderData, 5000);
  }
  let recheck = null, rechecks = 0;
  if (settingsPage) { renderData(); addEventListener('ct-install', renderData); }
  const dataSec = sect('data', 'Daten', dataBox);

  const panes = {
    overview: h('div.p-tab', overview, classSec),
    time: h('div.p-tab', time, sessionSec),
    status: h('div.p-tab', status),
    choreos: h('div.p-tab', choreoSec),
  };
  if (settingsPage) {
    root.append(h('section.p-head', h('h1.wide.p-name', 'EINSTELLUNGEN')), h('div.p-tab.p-settings', prefs, manageSec, dataSec, account));
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); removeEventListener('ct-install', renderData); };
  }
  function showTab(id, user = false) {
    current = id;
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== id;
    nav.querySelectorAll('a').forEach(a => { const on = a.dataset.tab === id; a.classList.toggle('on', on); a.setAttribute('aria-selected', String(on)); });
    if (user) {
      replaceHash(`#/profile/${id}`);
      // Reiterleiste oben halten, Inhalt beginnt direkt darunter
      const top = nav.getBoundingClientRect().top + scrollY - 64;
      if (scrollY > top) scrollTo(0, top);
    }
  }
  root.append(head, nav, filterRow || '', ...Object.values(panes));
  showTab(current);
  const removeTip = attachTooltip(root);
  return () => { removeTip(); urls.forEach(u => URL.revokeObjectURL(u)); };
}

function tile(label, value, hint) {
  return h('div.stat', h('span.label', label), h('b', value), hint ? h('span.label.hint', hint) : null);
}
