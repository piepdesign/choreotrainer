// Song im bevorzugten Musikprovider öffnen. Ohne Schlüssel: exakt bei Deezer (Track-ID) und
// Apple Music (freie iTunes-Suche), sonst die Suche im Provider. Eine Anmeldung übernimmt der
// Provider selbst (Browser bzw. App), die App speichert nur die Wahl.
import { h } from './util.js';
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

async function appleUrl(song, q) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?entity=song&limit=25&country=de&term=${encodeURIComponent(q)}`);
    const { results = [] } = await res.json();
    const t = simple(song.title), a = simple(song.artist).split(' ')[0];
    // Original bevorzugen: Versionen nur, wenn der eingetragene Titel sie selbst nennt
    const VERSION = /instrumental|karaoke|acapella|a cappella|remix|sped up|slowed|live|cover|tribute|re ?record/i;
    const wanted = VERSION.test(song.title);
    const ok = r => simple(r.trackName).startsWith(t) && (wanted || !VERSION.test(r.trackName + ' ' + (r.collectionName || '')));
    const hit = results.find(r => ok(r) && (!a || simple(r.artistName).includes(a))) || results.find(ok)
      || results.find(r => simple(r.trackName).startsWith(t));
    if (hit?.trackViewUrl) return hit.trackViewUrl;
  } catch { /* dann Suche */ }
  return `https://music.apple.com/de/search?term=${encodeURIComponent(q)}`;
}

export async function providerUrl(provider, song) {
  const q = [clean(song.artist), clean(song.title)].filter(Boolean).join(' ');
  const e = encodeURIComponent(q);
  switch (provider) {
    case 'deezer': return song.source === 'deezer' && song.id ? `https://www.deezer.com/track/${song.id}` : `https://www.deezer.com/search/${e}`;
    case 'apple': return appleUrl(song, q);
    case 'spotify': return `https://open.spotify.com/search/${e}`;
    case 'tidal': return `https://listen.tidal.com/search?q=${e}`;
    case 'ytmusic': return `https://music.youtube.com/search?q=${e}`;
    case 'amazon': return `https://music.amazon.de/search/${e}`;
    default: return null;
  }
}

// App-Link zur Web-Adresse, damit sich das installierte Programm öffnet (null = keine Mac-App)
// Tidal: geprüft im Programmcode der App, alles nach tidal:// wird als Seitenpfad angesteuert.
export function appUrl(provider, webUrl, song) {
  const q = encodeURIComponent([clean(song.artist), clean(song.title)].filter(Boolean).join(' '));
  switch (provider) {
    case 'spotify': return `spotify:search:${q}`;
    case 'apple': return webUrl.replace(/^https:/, 'music:');
    case 'tidal': return `tidal://search?q=${q}`;
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
  if (el.tagName === 'IMG') previewOnHover(el, song);
  return el;
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

const player = new Audio();
player.preload = 'none';
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
  let timer = null;
  el.addEventListener('mouseenter', () => {
    // kurz warten, damit Überfahren mit der Maus nichts abspielt
    timer = setTimeout(async () => {
      const url = await previewUrl(song);
      if (!url || !el.matches(':hover')) return;
      stopPreview();
      owner = el;
      if (player.src !== url) player.src = url;
      player.currentTime = 0; // Hörprobe von Anfang an
      player.volume = 0;
      try {
        await player.play();
        if (owner !== el) return;
        el.classList.add('previewing');
        fadeTo(0.8, 300);
      } catch { owner = null; } // ohne vorherigen Klick auf der Seite blockt der Browser den Ton
    }, 250);
  });
  el.addEventListener('mouseleave', () => { clearTimeout(timer); if (owner === el) stopPreview(); });
}
player.addEventListener('ended', () => { owner?.classList.remove('previewing'); owner = null; });
