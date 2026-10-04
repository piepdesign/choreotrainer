// Datensicherung: dauerhafter Speicher, App-Installation, Sicherung als Datei.
// Die Sicherung enthält alle Eingaben (Classes, Choreos, Aufnahmen samt Markern/Notizen/Status, Einheiten, Profil),
// aber keine Videos und Songdateien: die sind groß und liegen ohnehin noch auf dem Gerät. Nach dem Wiederherstellen
// werden die Videos über Dateiname, Größe und Länge wieder ihren Aufnahmen zugeordnet.
import { db, untracked } from './db.js';

const STORES = ['classes', 'choreos', 'recordings', 'sessions'];
const FORMAT = 'choreotrainer-sicherung';

// ── Speicher ──
export async function storageState() {
  const s = navigator.storage;
  const persisted = s?.persisted ? await s.persisted().catch(() => false) : false;
  const est = s?.estimate ? await s.estimate().catch(() => null) : null;
  return { supported: !!s?.persist, persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
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
export async function exportBackup() {
  const data = {};
  for (const s of STORES) data[s] = await db.all(s);
  data.settings = (await db.get('settings', 'profile')) || {};
  const backup = { format: FORMAT, version: 1, exportedAt: Date.now(), data };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const name = `choreotrainer-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { name, counts: Object.fromEntries(STORES.map(s => [s, data[s].length])) };
}

export async function readBackup(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error('Die Datei ist keine ChoreoTrainer-Sicherung.'); }
  if (backup?.format !== FORMAT || !backup.data) throw new Error('Die Datei ist keine ChoreoTrainer-Sicherung.');
  return backup;
}

// Einträge mit gleicher ID werden überschrieben, alles andere bleibt. Nicht im Rückgängig-Verlauf.
export async function restoreBackup(backup) {
  await untracked(async () => {
    for (const s of STORES) for (const v of backup.data[s] || []) if (v?.id) await db.put(s, v);
    if (backup.data.settings && typeof backup.data.settings === 'object') {
      const cur = (await db.get('settings', 'profile')) || {};
      await db.put('settings', { ...cur, ...backup.data.settings }, 'profile');
    }
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
