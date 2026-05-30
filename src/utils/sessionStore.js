// Crash-recovery persistence for a live capture session.
//
// During capture the raw recording lives only in memory; a reload, crash, or
// (on mobile) a backgrounded-tab reap would lose it. This stores the session
// header plus periodic batches of new samples in IndexedDB so an interrupted
// session can be reconstructed and recovered on the next load.
//
// Layout (single DB, one active session at a time):
//   'meta'    — key 'header': the recording header { version, startedAt, ... }
//   'batches' — autoIncrement: { motion:[], orientation:[], gps:[] } deltas,
//               in insertion order, appended every few seconds during capture.
//
// A clean stop calls clear(), so a leftover DB on load means the session was
// interrupted — that's the signal to offer recovery.

const DB_NAME = 'freespeed-session';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BATCH_STORE = 'batches';
const HEADER_KEY = 'header';

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
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(BATCH_STORE)) {
        db.createObjectStore(BATCH_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Start a fresh session: wipe any prior data and store the header.
export async function begin(header) {
  const db = await openDB();
  const t = tx(db, [META_STORE, BATCH_STORE], 'readwrite');
  t.objectStore(BATCH_STORE).clear();
  const meta = t.objectStore(META_STORE);
  meta.clear();
  // Store the header without its sample arrays — batches carry the samples.
  const { motion, orientation, gps, ...rest } = header || {};
  meta.put(rest, HEADER_KEY);
  return done(t);
}

// Append a delta of new samples accumulated since the last flush.
export async function appendBatch(batch) {
  if (!batch) return;
  const db = await openDB();
  const t = tx(db, [BATCH_STORE], 'readwrite');
  t.objectStore(BATCH_STORE).add({
    motion: batch.motion || [],
    orientation: batch.orientation || [],
    gps: batch.gps || [],
  });
  return done(t);
}

// Reconstruct the full recording from the header + ordered batches, or null if
// no interrupted session is stored.
export async function load() {
  let db;
  try {
    db = await openDB();
  } catch {
    return null;
  }
  const header = await new Promise((resolve) => {
    const req = tx(db, [META_STORE], 'readonly').objectStore(META_STORE).get(HEADER_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!header) return null;

  const batches = await new Promise((resolve) => {
    const req = tx(db, [BATCH_STORE], 'readonly').objectStore(BATCH_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });

  const rec = { ...header, motion: [], orientation: [], gps: [] };
  for (const b of batches) {
    if (b.motion) for (const m of b.motion) rec.motion.push(m);
    if (b.orientation) for (const o of b.orientation) rec.orientation.push(o);
    if (b.gps) for (const g of b.gps) rec.gps.push(g);
  }
  return rec;
}

// Drop the stored session (clean stop, or after recovery / discard).
export async function clear() {
  let db;
  try {
    db = await openDB();
  } catch {
    return;
  }
  const t = tx(db, [META_STORE, BATCH_STORE], 'readwrite');
  t.objectStore(META_STORE).clear();
  t.objectStore(BATCH_STORE).clear();
  return done(t);
}
