// IndexedDB-Schicht. Alles bleibt lokal im Browser.
// Stores: classes, choreos, recordings (Metadaten), videos (Blobs, key = recordingId), sessions

const DB_NAME = 'choreotrainer';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('classes', { keyPath: 'id' });
      db.createObjectStore('choreos', { keyPath: 'id' }).createIndex('classId', 'classId');
      db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('choreoId', 'choreoId');
      db.createObjectStore('videos');
      db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('choreoId', 'choreoId');
    };
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

export const db = {
  async all(name) { return wrap((await store(name)).getAll()); },
  async get(name, id) { return wrap((await store(name)).get(id)); },
  async put(name, value, key) { return wrap((await store(name, 'readwrite')).put(value, key)); },
  async del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); },
  async byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); },
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// Kaskadierendes Löschen
export async function deleteRecording(id) {
  await db.del('videos', id);
  await db.del('recordings', id);
}

export async function deleteChoreo(id) {
  for (const r of await db.byIndex('recordings', 'choreoId', id)) await deleteRecording(r.id);
  for (const s of await db.byIndex('sessions', 'choreoId', id)) await db.del('sessions', s.id);
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
