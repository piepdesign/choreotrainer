// IndexedDB-Schicht. Alles bleibt lokal im Browser.
// Stores: classes, choreos, recordings (Metadaten), videos (Blobs, key = recordingId), sessions,
// settings (Profil + Präferenzen, key-value, ab Version 2)

const DB_NAME = 'choreotrainer';
const DB_VERSION = 2;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      // bestehende Daten bleiben erhalten, nur Fehlendes wird angelegt
      if (e.oldVersion < 1) {
        db.createObjectStore('classes', { keyPath: 'id' });
        db.createObjectStore('choreos', { keyPath: 'id' }).createIndex('classId', 'classId');
        db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('choreoId', 'choreoId');
        db.createObjectStore('videos');
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('choreoId', 'choreoId');
      }
      if (e.oldVersion < 2) db.createObjectStore('settings');
    };
    // andere offene Tabs mit alter Version blockieren das Upgrade nicht dauerhaft
    req.onblocked = () => console.warn('Datenbank-Upgrade wartet auf andere ChoreoTrainer-Tabs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

const raw = {
  async get(name, id) { return wrap((await store(name)).get(id)); },
  async put(name, value, key) { return wrap((await store(name, 'readwrite')).put(value, key)); },
  async del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); },
};

// ── Rückgängig / Wiederherstellen ──
// Jede Änderung an Inhalten wird mit Vorher/Nachher gemerkt. Änderungen kurz hintereinander
// (z. B. Choreo samt Aufnahmen und Videos löschen) bilden einen Schritt. Nicht mitgezählt:
// neue Übungszeiten, Einstellungen und automatisch geschriebene Werte (Länge, Takt-Analyse, Lautstärke).
const UNDO_STORES = new Set(['classes', 'choreos', 'recordings', 'videos', 'sessions']);
const IGNORE = { choreos: ['lastPracticed', 'bpm'], recordings: ['beatTried', 'duration'] };
const IGNORE_PLAYER = ['volume', 'muted', 'audio'];
const undoStack = [], redoStack = [];
let group = null, groupTimer = null, paused = 0;

const isBlob = v => v instanceof Blob;
function comparable(name, v) {
  if (v === undefined || isBlob(v)) return v;
  const c = { ...v };
  for (const k of IGNORE[name] || []) delete c[k];
  if (c.player) { c.player = { ...c.player }; for (const k of IGNORE_PLAYER) delete c.player[k]; }
  return JSON.stringify(c);
}
const snap = v => (v === undefined || isBlob(v) ? v : structuredClone(v));

function closeGroup() {
  clearTimeout(groupTimer);
  if (group?.length) { undoStack.push(group); if (undoStack.length > 50) undoStack.shift(); }
  group = null;
}
async function track(name, key, after) {
  if (paused || !UNDO_STORES.has(name) || key == null) return;
  if (name === 'sessions' && after !== undefined) return; // Einheiten nur beim Löschen merken (kommen beim Rückgängig mit zurück)
  const before = await raw.get(name, key);
  if (before === after || (!isBlob(before) && !isBlob(after) && comparable(name, before) === comparable(name, after))) return;
  group ||= [];
  const known = group.find(e => e.name === name && e.key === key);
  if (known) known.after = snap(after);
  else group.push({ name, key, before: snap(before), after: snap(after) });
  redoStack.length = 0;
  clearTimeout(groupTimer);
  groupTimer = setTimeout(closeGroup, 700);
}

export const db = {
  async all(name) { return wrap((await store(name)).getAll()); },
  get: raw.get,
  async put(name, value, key) {
    await track(name, key ?? value?.id, value);
    return raw.put(name, value, key);
  },
  async del(name, id) {
    await track(name, id, undefined);
    return raw.del(name, id);
  },
  async byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); },
};

// Während fn läuft, wird nichts gemerkt (z. B. Ansicht speichert beim Verlassen ihren Stand)
export async function untracked(fn) {
  closeGroup();
  paused++;
  try { return await fn(); } finally { paused--; }
}

async function apply(entries, side) {
  for (const e of side === 'before' ? [...entries].reverse() : entries) {
    const v = e[side];
    const keyed = e.name === 'videos'; // Videos haben einen externen Schlüssel
    if (v === undefined) await raw.del(e.name, e.key);
    else await raw.put(e.name, v, keyed ? e.key : undefined);
  }
}
// true, wenn es etwas zum Rückgängigmachen bzw. Wiederherstellen gab
export async function undo() {
  closeGroup();
  const g = undoStack.pop();
  if (!g) return false;
  await untracked(() => apply(g, 'before'));
  redoStack.push(g);
  return true;
}
export async function redo() {
  closeGroup();
  const g = redoStack.pop();
  if (!g) return false;
  await untracked(() => apply(g, 'after'));
  undoStack.push(g);
  return true;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// Kaskadierendes Löschen
export async function deleteRecording(id) {
  await db.del('videos', id);
  await db.del('recordings', id);
}

export async function deleteChoreo(id) {
  for (const r of await db.byIndex('recordings', 'choreoId', id)) await deleteRecording(r.id);
  for (const s of await db.byIndex('sessions', 'choreoId', id)) await db.del('sessions', s.id);
  await db.del('videos', `song:${id}`); // Songdatei der Choreo
  await db.del('choreos', id);
}

export async function deleteClass(id) {
  for (const c of await db.byIndex('choreos', 'classId', id)) await deleteChoreo(c.id);
  await db.del('classes', id);
}

// Browser bitten, die Daten nicht automatisch zu räumen
export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* egal */ }
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// Alles löschen (Konto → Löschen): Verbindung schließen, ganze Datenbank entfernen
export async function deleteAllData() {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* egal */ }
}
