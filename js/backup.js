// Datensicherung: dauerhafter Speicher, App-Installation, Sicherung als Datei.
// Die Sicherung enthält alle Eingaben (Classes, Choreos, Aufnahmen samt Markern/Notizen/Status, Einheiten, Profil)
// und wahlweise die Videos und Songdateien. Ohne Videos werden sie nach dem Wiederherstellen über Dateiname, Größe
// und Länge wieder ihren Aufnahmen zugeordnet.
import { db, untracked, deleteChoreo, releaseUndoVideos } from './db.js';

const STORES = ['classes', 'choreos', 'recordings', 'sessions'];
const FORMAT = 'choreotrainer-sicherung';

// ── Speicher ──
export async function storageState() {
  const s = navigator.storage;
  const persisted = s?.persisted ? await s.persisted().catch(() => false) : false;
  const est = s?.estimate ? await s.estimate().catch(() => null) : null;
  return { supported: !!s?.persist, persisted, usage: est?.usage ?? null, quota: est?.quota ?? null, idb: est?.usageDetails?.indexedDB ?? null };
}
// Gelöschte Videos wirklich freigeben: Solange die Seite offen ist, halten Verweise (Rückgängig, Vorschauen) die
// Dateien fest, der Browser löscht sie erst nach dem Neuladen (in Chrome gemessen: danach binnen etwa 30 s).
export function freeStorage() {
  releaseUndoVideos();
  try { sessionStorage.setItem('ct-freed', '1'); } catch { /* egal */ }
  location.reload();
}
export function freedNotice() {
  try { if (!sessionStorage.getItem('ct-freed')) return false; sessionStorage.removeItem('ct-freed'); return true; } catch { return false; }
}
export async function askPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// ── App-Installation ──
let installPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; dispatchEvent(new Event('ct-install')); });
addEventListener('appinstalled', () => { installPrompt = null; askPersist(); dispatchEvent(new Event('ct-install')); });
export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canPromptInstall = () => !!installPrompt;
export async function promptInstall() {
  if (!installPrompt) return false;
  const p = installPrompt;
  installPrompt = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  dispatchEvent(new Event('ct-install'));
  return outcome === 'accepted';
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').then(async reg => {
    await navigator.serviceWorker.ready;
    // schon geladene Dateien (vor dem ersten Start des Service Workers) nachträglich für offline merken
    const urls = [location.href.split('#')[0], ...performance.getEntriesByType('resource').map(e => e.name)];
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ cache: urls });
  }).catch(e => console.warn('Service Worker nicht registriert', e));
}

// ── Sicherung ──
// Eine Datei „.ctbackup“ (mit oder ohne Videos): 8 Zeichen Kennung „CTBACKUP“, 8 Byte Länge des
// Kopfes (JSON, UTF-8), Kopf, danach die Videos und Songdateien unverändert hintereinander. Der Kopf nennt je Datei
// Schlüssel, Name, Typ, Größe und Position. Die Videos werden nicht in den Arbeitsspeicher geladen, sondern direkt
// aus der Datenbank in die Datei geschrieben (und beim Wiederherstellen direkt aus der Datei gelesen).
const MAGIC = 'CTBACKUP';

async function collect() {
  const data = {};
  for (const s of STORES) data[s] = await db.all(s);
  data.settings = (await db.get('settings', 'profile')) || {};
  return data;
}
async function videoBlobs() {
  const out = [];
  for (const key of await db.keys('videos')) { const b = await db.get('videos', key); if (b) out.push([key, b]); }
  return out;
}
export async function videoBytes() { return (await videoBlobs()).reduce((a, [, b]) => a + b.size, 0); }

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Datei bauen bzw. lesen (gemeinsam für Sicherung und Export von Class/Choreo). blobs: [[Schlüssel, Blob]]
export function packFile(head, blobs, name) {
  let offset = 0;
  const files = blobs.map(([key, b]) => { const f = { key, name: b.name || '', type: b.type || '', size: b.size, offset }; offset += b.size; return f; });
  const bytes = new TextEncoder().encode(JSON.stringify({ ...head, files }));
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(bytes.length), true);
  download(new Blob([MAGIC, len, bytes, ...blobs.map(([, b]) => b)], { type: 'application/octet-stream' }), name);
  return { files: files.length, bytes: offset };
}
// Liefert den Kopf; head.videos = [[Schlüssel, File]] als Ausschnitte der Datei (nichts wird kopiert). null = keine CT-Datei
export async function unpackFile(file) {
  if (!/\.ctbackup$/i.test(file.name || '')) return null;
  if (new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) !== MAGIC) return null;
  const len = Number(new DataView(await file.slice(8, 16).arrayBuffer()).getBigUint64(0, true));
  if (!(len > 0 && 16 + len <= file.size)) return null;
  let head;
  try { head = JSON.parse(new TextDecoder().decode(await file.slice(16, 16 + len).arrayBuffer())); } catch { return null; }
  if (!head?.data) return null;
  const base = 16 + len;
  head.videos = (head.files || []).filter(f => base + f.offset + f.size <= file.size)
    .map(f => [f.key, new File([file.slice(base + f.offset, base + f.offset + f.size)], f.name || f.key, { type: f.type })]);
  return head;
}

export async function exportBackup({ videos = true } = {}) {
  const data = await collect();
  const date = new Date().toISOString().slice(0, 10);
  const counts = Object.fromEntries(STORES.map(s => [s, data[s].length]));
  const blobs = videos ? await videoBlobs() : []; // „Ohne Videos“: gleiche Datei, nur ohne angehängte Dateien
  const r = packFile({ format: FORMAT, version: 2, exportedAt: Date.now(), data }, blobs, `choreotrainer-sicherung-${date}.ctbackup`);
  return { counts, videos: r.files, bytes: r.bytes };
}

export async function readBackup(file) {
  const head = await unpackFile(file);
  if (head?.format === 'choreotrainer-export') throw new Error('Das ist ein Export einer Class bzw. Choreo. Bitte unter „Importieren“ einspielen.');
  if (head?.format !== FORMAT) throw new Error('Bitte eine ChoreoTrainer-Sicherung (.ctbackup) wählen.');
  return head;
}

// Speicher freigeben: alle Choreos mit Aufnahmen, Videos, Songdateien und Einheiten löschen.
// Classes, Profil und Präferenzen bleiben. Nicht im Rückgängig-Verlauf (sonst hielte der Verlauf die Videos fest).
export async function deleteRecordings() {
  await untracked(async () => {
    for (const c of await db.all('choreos')) await deleteChoreo(c.id);
    for (const key of await db.keys('videos')) await db.del('videos', key); // übrig gebliebene Dateien ohne Choreo
    for (const s of await db.all('sessions')) await db.del('sessions', s.id);
  });
}

// Einträge mit gleicher ID werden überschrieben, alles andere bleibt. Nicht im Rückgängig-Verlauf.
export async function restoreBackup(backup, onProgress = () => {}) {
  await untracked(async () => {
    for (const s of STORES) for (const v of backup.data[s] || []) if (v?.id) await db.put(s, v);
    if (backup.data.settings && typeof backup.data.settings === 'object') {
      const cur = (await db.get('settings', 'profile')) || {};
      await db.put('settings', { ...cur, ...backup.data.settings }, 'profile');
    }
    let i = 0;
    for (const [key, f] of backup.videos || []) { onProgress(++i, backup.videos.length); await db.put('videos', f, key); }
  });
}

// Aufnahmen, deren Video in diesem Browser fehlt (z. B. nach dem Wiederherstellen)
export async function missingVideos() {
  const have = new Set(await db.keys('videos'));
  return (await db.all('recordings')).filter(r => !have.has(r.id));
}

const durationOf = file => new Promise(resolve => {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  const done = d => { URL.revokeObjectURL(url); resolve(d); };
  v.preload = 'metadata';
  v.onloadedmetadata = () => done(v.duration);
  v.onerror = () => done(null);
  setTimeout(() => done(null), 8000);
  v.src = url;
});

// Gewählte Videos den fehlenden Aufnahmen zuordnen: erst Name + Größe, dann Name, dann Größe, dann Länge (±0,5 s;
// Handys wandeln Videos beim Auswählen teils um, dann stimmen Name und Größe nicht mehr)
export async function relinkVideos(files, missing) {
  const open = [...missing], matched = [], unmatched = [];
  const take = (file, rec) => { open.splice(open.indexOf(rec), 1); matched.push([file, rec]); };
  const rest = [];
  for (const f of files) {
    const rec = open.find(r => r.fileName === f.name && r.size === f.size)
      || open.find(r => r.fileName === f.name)
      || open.find(r => r.size === f.size);
    if (rec) take(f, rec); else rest.push(f);
  }
  for (const f of rest) {
    const d = await durationOf(f);
    const rec = d != null && open.find(r => r.duration && Math.abs(r.duration - d) < 0.5);
    if (rec) take(f, rec); else unmatched.push(f);
  }
  await untracked(async () => { for (const [f, rec] of matched) await db.put('videos', f, rec.id); });
  return { matched: matched.length, unmatched: unmatched.map(f => f.name), stillMissing: open.length };
}
