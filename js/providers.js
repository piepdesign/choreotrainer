// Song im bevorzugten Musikprovider öffnen. Ohne Schlüssel: exakt bei Deezer (Track-ID) und
// Apple Music (freie iTunes-Suche), sonst die Suche im Provider. Eine Anmeldung übernimmt der
// Provider selbst (Browser bzw. App), die App speichert nur die Wahl.
import { h, isTouch, onHold } from './util.js';
import { brandIcon } from './brand-icons.js';
import { searchSongs, songDetails } from './deezer.js';
import { settings, saveSettings } from './settings.js';

export const PROVIDERS = [
  ['spotify', 'Spotify'],
  ['apple', 'Apple Music'],
  ['tidal', 'Tidal'],
  ['ytmusic', 'YouTube Music'],
  ['deezer', 'Deezer'],
  ['amazon', 'Amazon Music'],
];
export const providerName = id => PROVIDERS.find(p => p[0] === id)?.[1] || '';

const clean = s => String(s || '').replace(/\(.*?\)|\[.*?\]|feat\..*$/gi, '').replace(/\s+/g, ' ').trim();
const simple = s => clean(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

// Suchbegriff: Titel zuerst, dann Interpret; ohne Klammern/feat., Kommas und Sonderzeichen als Leerzeichen
// (sonst zerlegen manche Suchen den Begriff, z. B. „Tyler, The Creator“)
const query = song => [clean(song.title), clean(song.artist)].filter(Boolean).join(' ').replace(/[,&/+]/g, ' ').replace(/\s+/g, ' ').trim();
// Original bevorzugen: Versionen nur, wenn der eingetragene Titel sie selbst nennt
const VERSION = /instrumental|karaoke|acapella|a cappella|remix|sped up|slowed|live|cover|tribute|re ?record/i;
// passt ein Treffer (Titel + Interpret) zum eingetragenen Song?
function matches(song, title, artist, extra = '') {
  const t = simple(song.title), a = simple(song.artist).split(' ').filter(w => w.length > 2)[0] || simple(song.artist);
  return simple(title).startsWith(t) && (!a || simple(artist).includes(a))
    && (VERSION.test(song.title) || !VERSION.test(`${title} ${extra}`));
}

// Apple Music: exakter Titel über die freie iTunes-Suche. Die Suche im deutschen Katalog sortiert teils schlecht,
// daher drei Anläufe: freie Suche, Suche nach Interpret (Titel gefiltert), US-Katalog (nur wenn der Titel auch in DE
// existiert). Kein passender Interpret → Suchseite statt eines falschen gleichnamigen Songs.
const itunes = async params => {
  const res = await fetch(`https://itunes.apple.com/search?entity=song&limit=200&${params}`);
  return (await res.json()).results || [];
};
async function appleUrl(song) {
  const q = query(song);
  const tries = [
    () => itunes(`country=de&term=${encodeURIComponent(q)}`),
    () => itunes(`country=de&attribute=artistTerm&term=${encodeURIComponent(clean(song.artist).replace(/[,&]/g, ' '))}`),
    async () => {
      const us = (await itunes(`country=us&term=${encodeURIComponent(q)}`)).find(r => matches(song, r.trackName, r.artistName, r.collectionName || ''));
      if (!us) return [];
      const de = await (await fetch(`https://itunes.apple.com/lookup?id=${us.trackId}&country=de`)).json();
      return de.results || [];
    },
  ];
  for (const run of tries) {
    try {
      const hit = (await run()).find(r => matches(song, r.trackName, r.artistName, r.collectionName || ''));
      if (hit?.trackId) return `https://music.apple.com/de/song/${hit.trackId}`;
    } catch { /* nächster Anlauf */ }
  }
  return `https://music.apple.com/de/search?term=${encodeURIComponent(q)}`;
}

// Deezer: eigene Track-ID oder per freier Deezer-Suche (Titel + Interpret) den exakten Titel
async function deezerUrl(song) {
  if (song.source === 'deezer' && song.id) return `https://www.deezer.com/track/${song.id}`;
  try {
    const hit = (await searchSongs(query(song))).find(x => matches(song, x.title, x.artist));
    if (hit?.id) return `https://www.deezer.com/track/${hit.id}`;
  } catch { /* dann Suche */ }
  return `https://www.deezer.com/search/${encodeURIComponent(query(song))}`;
}

export async function providerUrl(provider, song) {
  const e = encodeURIComponent(query(song));
  switch (provider) {
    case 'deezer': return deezerUrl(song);
    case 'apple': return appleUrl(song);
    // ohne Schlüssel keine exakten Titel-Links: Suche mit Titel + Interpret, Treffer steht oben
    case 'spotify': return `https://open.spotify.com/search/${e}`;
    case 'tidal': return `https://listen.tidal.com/search?q=${e}`;
    case 'ytmusic': return `https://music.youtube.com/search?q=${e}`;
    case 'amazon': return `https://music.amazon.de/search/${e}`;
    default: return null;
  }
}

// App-Link zur Web-Adresse, damit sich das installierte Programm öffnet (null = keine Mac-App)
// Tidal: geprüft im Programmcode der App. Alles nach tidal:// wird als Seitenpfad angesteuert und dabei von der
// App selbst noch einmal kodiert (encodeURI). Deshalb Wörter mit „+“ verbinden (bleibt erhalten, wird zu Leerzeichen)
// und nur einfache Buchstaben verwenden, sonst kommt nur ein Bruchstück an (z. B. „tyler“).
export function appUrl(provider, webUrl, song) {
  const q = query(song);
  switch (provider) {
    case 'spotify': return `spotify:search:${encodeURIComponent(q)}`;
    case 'apple': return webUrl.replace(/^https:/, 'music:');
    case 'tidal': return `tidal://search?q=${q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).join('+')}`;
    case 'deezer': return webUrl.replace(/^https:\/\//, 'deezer://');
    default: return null; // YouTube Music, Amazon Music: im Browser
  }
}

// Klick auf Cover/Titel → App (falls installiert), sonst Web-Version im neuen Tab
export async function openSong(song) {
  if (!song?.title) return;
  let provider = settings().provider;
  if (!provider) {
    provider = await askProvider();
    if (!provider) return;
  }
  // Ohne Mac-App gleich der Browser. Fenster sofort öffnen, sonst blockt der Pop-up-Blocker (Ziel kommt ggf. asynchron)
  if (!['spotify', 'apple', 'tidal', 'deezer'].includes(provider)) {
    const win = window.open('about:blank', '_blank');
    const url = await providerUrl(provider, song);
    if (win) { win.opener = null; win.location.href = url; } else location.href = url;
    return;
  }
  const web = await providerUrl(provider, song);
  const app = appUrl(provider, web, song);
  // App versuchen. Verliert die Seite nicht den Fokus (keine App da), Web-Version im neuen Tab.
  let left = false;
  const onLeave = () => { left = true; };
  addEventListener('blur', onLeave, { once: true });
  document.addEventListener('visibilitychange', onLeave, { once: true });
  location.href = app;
  setTimeout(() => {
    removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onLeave);
    if (!left) window.open(web, '_blank', 'noopener');
  }, 1800);
}

// Auswahl beim ersten Mal, wird gemerkt (im Profil änderbar)
export function askProvider() {
  return new Promise(resolve => {
    const close = val => { box.remove(); resolve(val); };
    const box = h('div.modal', { onclick: e => { if (e.target === box) close(null); } },
      h('div.modal-card',
        h('h2.wide', 'WO HÖRST DU MUSIK?'),
        h('p.label', 'Songs öffnen sich künftig dort. Angemeldet bist du direkt beim Anbieter, die App speichert nur deine Wahl. Ändern kannst du sie im Profil.'),
        h('div.chips', PROVIDERS.map(([id, name]) => h('button.btn.provider-btn', {
          type: 'button',
          onclick: async () => { await saveSettings({ provider: id }); close(id); },
        }, h('i.brand', { html: brandIcon(id, 16) }), name))),
        h('button.linkbtn', { type: 'button', onclick: () => close(null) }, 'Abbrechen')));
    document.body.append(box);
  });
}

// Macht ein Element (Cover, Titel) zum Link in den Provider
export function songLink(el, song) {
  if (!song?.title) return el;
  el.classList.add('song-link');
  el.title = 'Im Musikprovider öffnen';
  el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); stopPreview(); openSong(song); });
  if (el.tagName !== 'IMG') return el;
  // Cover in eine Hülle, damit der Rahmen beim Abspielen als Negativ über dem Bild liegen kann
  const wrap = h('span.cover-wrap', el);
  previewOnHover(wrap, song);
  return wrap;
}

// ── Hörprobe beim Hovern über ein Cover ──
// Deezer liefert zu fast jedem Titel eine freie 30-s-Hörprobe (ohne Key, unabhängig vom gewählten Provider).
// Die Adressen sind signiert und laufen ab, daher frisch holen und nur kurz merken.
const previewCache = new Map();
const norm = s => clean(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
async function previewUrl(song) {
  const key = song.source === 'deezer' && song.id ? `dz:${song.id}` : `q:${norm(song.artist)}|${norm(song.title)}`;
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.url;
  let url = '';
  try {
    if (song.source === 'deezer' && song.id) url = (await songDetails(song.id))?.preview || '';
    if (!url) {
      const list = await searchSongs([clean(song.artist), clean(song.title)].filter(Boolean).join(' '));
      const t = norm(song.title);
      url = (list.find(x => x.preview && norm(x.title).startsWith(t)) || list.find(x => x.preview))?.preview || '';
    }
  } catch { /* keine Hörprobe */ }
  previewCache.set(key, { url, t: Date.now() });
  return url;
}

// Lautstärke der Hörprobe je Einstellung (on = ältere Einstellung)
const PREVIEW_VOLUME = { off: 0, low: 0.25, mid: 0.55, on: 0.55, high: 0.9 };
const player = new Audio();
player.preload = 'none';
// iOS spielt Ton nur nach einer Berührung ab. Beim ersten Tippen den Player einmal stumm „freischalten“,
// damit die Hörprobe später beim Halten spielen darf.
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
addEventListener('touchend', () => {
  if (player.src) return;
  player.src = SILENT;
  player.play().then(() => player.pause()).catch(() => {});
}, { once: true, capture: true });
let owner = null, fadeTimer = null;
function fadeTo(target, ms, done) {
  clearInterval(fadeTimer);
  const start = player.volume, t0 = performance.now();
  fadeTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    player.volume = start + (target - start) * k;
    if (k >= 1) { clearInterval(fadeTimer); done?.(); }
  }, 30);
}
export function stopPreview() {
  const el = owner;
  owner = null;
  el?.classList.remove('previewing');
  if (!player.paused) fadeTo(0, 200, () => player.pause());
}
function previewOnHover(el, song) {
  let timer = null, wanted = false;
  // Maus: Überfahren, Touch: Halten (kurzes Tippen öffnet weiterhin den Musikprovider)
  const start = delay => {
    const level = PREVIEW_VOLUME[settings().hoverPreview] ?? PREVIEW_VOLUME.mid;
    if (!level) return; // in den Einstellungen abgeschaltet
    wanted = true;
    timer = setTimeout(async () => {
      const url = await previewUrl(song);
      if (!url || !wanted) return;
      stopPreview();
      owner = el;
      if (player.src !== url) player.src = url;
      player.currentTime = 0; // Hörprobe von Anfang an
      player.volume = 0;
      try {
        await player.play();
        if (owner !== el) return;
        el.classList.add('previewing');
        fadeTo(level, 300);
      } catch { owner = null; } // ohne vorherigen Klick auf der Seite blockt der Browser den Ton
    }, delay);
  };
  const stop = () => { wanted = false; clearTimeout(timer); if (owner === el) stopPreview(); };
  el.addEventListener('mouseenter', () => { if (!isTouch()) start(250); }); // kurz warten: Überfahren spielt nichts
  el.addEventListener('mouseleave', () => { if (!isTouch()) stop(); });
  onHold(el, () => start(0), stop);
}
player.addEventListener('ended', () => { owner?.classList.remove('previewing'); owner = null; });
