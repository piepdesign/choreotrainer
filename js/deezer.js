// Songsuche über die freie Deezer-API (kein Key). Deezer sendet keine CORS-Header,
// daher JSONP über ein Script-Tag.

let counter = 0;

function jsonp(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const cb = `__dz${Date.now()}_${counter++}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('Deezer antwortet nicht')); }, timeout);
    function cleanup() { clearTimeout(timer); delete window[cb]; script.remove(); }
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Deezer nicht erreichbar')); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.append(script);
  });
}

const toSong = t => ({
  source: 'deezer',
  id: String(t.id),
  title: t.title,
  artist: t.artist?.name || '',
  album: t.album?.title || '',
  cover: t.album?.cover_medium || t.album?.cover || '',
  duration: t.duration || null,
  bpm: t.bpm || null,
  preview: t.preview || '', // 30-s-Hörprobe (mp3), Adresse läuft nach einiger Zeit ab
});

export async function searchSongs(q) {
  if (!q || q.trim().length < 2) return [];
  const res = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(q.trim())}&limit=8`);
  return (res.data || []).map(toSong);
}

// Detailabruf liefert (manchmal) BPM
export async function songDetails(id) {
  const t = await jsonp(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
  return t?.error ? null : toSong(t);
}
