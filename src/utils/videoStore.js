// Persistence for a coach's video recording. Two jobs:
//   1. Crash recovery — MediaRecorder chunks are appended as they arrive so a
//      reload / tab-reap doesn't lose the footage mid-piece (mirrors the sample
//      persistence in sessionStore).
//   2. Hand-off — the assembled bundle Blob is parked here so the coach can jump
//      straight into the analyzer without a download-then-reload round-trip.
//
// Separate IndexedDB from sessionStore so a schema bump here can't disturb the
// stroke-sample recovery DB.

const DB_NAME = 'freespeed-video';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';   // autoIncrement: Blob chunks of the in-progress recording
const META_STORE = 'meta';      // key 'header': { mime, startedAt, video anchor, ... }
const HANDOFF_STORE = 'handoff'; // key 'bundle': { blob, meta } parked for the analyzer
const HEADER_KEY = 'header';
const BUNDLE_KEY = 'bundle';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(HANDOFF_STORE)) db.createObjectStore(HANDOFF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Start a fresh recording: wipe prior chunks and store the header.
export async function begin(header) {
  const db = await openDB();
  const t = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
  t.objectStore(CHUNK_STORE).clear();
  const meta = t.objectStore(META_STORE);
  meta.clear();
  meta.put(header || {}, HEADER_KEY);
  return done(t);
}

export async function appendChunk(blob) {
  if (!blob || !blob.size) return;
  const db = await openDB();
  const t = db.transaction([CHUNK_STORE], 'readwrite');
  t.objectStore(CHUNK_STORE).add(blob);
  return done(t);
}

// Reconstruct the recorded video Blob + header from stored chunks, or null.
export async function load() {
  let db;
  try { db = await openDB(); } catch { return null; }
  const header = await new Promise((resolve) => {
    const req = db.transaction([META_STORE], 'readonly').objectStore(META_STORE).get(HEADER_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!header) return null;
  const chunks = await new Promise((resolve) => {
    const req = db.transaction([CHUNK_STORE], 'readonly').objectStore(CHUNK_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  if (!chunks.length) return null;
  const blob = new Blob(chunks, { type: header.mime || 'video/webm' });
  return { header, blob };
}

// Drop the in-progress recording (clean stop / after recovery / discard).
export async function clear() {
  let db;
  try { db = await openDB(); } catch { return; }
  const t = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
  t.objectStore(CHUNK_STORE).clear();
  t.objectStore(META_STORE).clear();
  return done(t);
}

// --- Analyzer hand-off (the assembled bundle, kept across a route change) ---

export async function putHandoff(blob, meta) {
  const db = await openDB();
  const t = db.transaction([HANDOFF_STORE], 'readwrite');
  t.objectStore(HANDOFF_STORE).put({ blob, meta }, BUNDLE_KEY);
  return done(t);
}

export async function takeHandoff() {
  let db;
  try { db = await openDB(); } catch { return null; }
  const rec = await new Promise((resolve) => {
    const req = db.transaction([HANDOFF_STORE], 'readonly').objectStore(HANDOFF_STORE).get(BUNDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  // One-shot: clear after read so a refresh doesn't re-open it.
  try {
    const db2 = await openDB();
    const t = db2.transaction([HANDOFF_STORE], 'readwrite');
    t.objectStore(HANDOFF_STORE).delete(BUNDLE_KEY);
    await done(t);
  } catch { /* ignore */ }
  return rec;
}
