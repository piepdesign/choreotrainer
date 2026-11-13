// Song über einen eingefügten Link finden (SoundCloud, Spotify, Deezer). Gedacht für Songs, die Shazam nicht kennt
// (z. B. Edits und kleine Uploads auf SoundCloud). SoundCloud und Spotify liefern Titel/Artist per oEmbed (mit CORS,
// ohne Key), Deezer-Links enthalten die Track-ID direkt. Tracking-Parameter (?si=…, utm_…) werden vorher entfernt.
import { songDetails } from './deezer.js';

const URL_RE = /https?:\/\/[^\s]+/i;
export const looksLikeLink = q => URL_RE.test(String(q || '')) || /^(on\.|m\.)?soundcloud\.com\//i.test(String(q || '').trim());

// Link aus dem Text holen und säubern: ohne Query und Fragment, m.-Subdomain → Hauptadresse
export function cleanLink(q) {
  let s = String(q || '').trim();
  const m = s.match(URL_RE);
  s = m ? m[0] : `https://${s}`;
  let u;
  try { u = new URL(s.replace(/[)\]>.,;!?]+$/, '')); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\.soundcloud\.com$/, 'soundcloud.com');
  return { host, url: `https://${host}${u.pathname.replace(/\/+$/, '')}`, raw: u.href };
}

async function oembed(endpoint, url) {
  const res = await fetch(`${endpoint}?format=json&url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  return res.json();
}

// → { title, artist, cover, url, provider } · { deezer: song } · null (kein unterstützter Link / nicht gefunden)
export async function resolveLink(q) {
  const l = cleanLink(q);
  if (!l) return null;
  if (/(^|\.)deezer\.com$/.test(l.host)) {
    const id = l.url.match(/\/track\/(\d+)/)?.[1];
    const s = id && await songDetails(id).catch(() => null);
    return s ? { deezer: s } : null;
  }
  if (l.host === 'soundcloud.com' || l.host === 'on.soundcloud.com') {
    // Kurzlinks (on.soundcloud.com) löst oEmbed selbst auf, sie brauchen aber ihre volle Adresse
    const d = await oembed('https://soundcloud.com/oembed', l.host === 'on.soundcloud.com' ? l.raw : l.url).catch(() => null);
    if (!d?.title) return null;
    const artist = d.author_name || '';
    // oEmbed-Titel: „TITEL by ARTIST“
    const by = ` by ${artist}`;
    const title = artist && d.title.endsWith(by) ? d.title.slice(0, -by.length) : d.title;
    return { title: title.trim(), artist, cover: d.thumbnail_url || '', url: l.url, provider: 'SoundCloud' };
  }
  if (l.host === 'open.spotify.com' || l.host === 'spotify.link') {
    // Spotify-oEmbed liefert nur den Titel, keinen Artist
    const d = await oembed('https://open.spotify.com/oembed', l.host === 'spotify.link' ? l.raw : l.url).catch(() => null);
    return d?.title ? { title: d.title, artist: '', cover: d.thumbnail_url || '', url: l.url, provider: 'Spotify' } : null;
  }
  return null;
}
