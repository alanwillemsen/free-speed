// Library of finished stroke-capture sessions. A stopped capture used to
// auto-download its JSON; instead it lands here so past rows are browsable on
// the Sessions page, with download/share on demand. Recordings are stored as
// JSON Blobs — byte-identical to the downloaded file format, so Download from
// the library produces exactly the file the old auto-download did, and files
// already on disk stay importable.
//
// Summary records live in a separate store from the blobs so listing sessions
// never loads multi-MB recordings. Separate IndexedDB from sessionStore: the
// mere presence of data in freespeed-session signals an interrupted capture
// (its crash-recovery contract), which a library of finished rows would break.

const DB_NAME = 'freespeed-library';
const DB_VERSION = 1;
const META_STORE = 'meta';             // keyPath 'id': session summary records
const RECORDING_STORE = 'recordings';  // id → JSON Blob of the full recording

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
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECORDING_STORE)) db.createObjectStore(RECORDING_STORE);
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

let persistRequested = false;

// Save a finished session. Throws on failure — the caller falls back to a
// download so a row is never lost to quota/private-mode storage failures.
// id = startedAt, so stopping the same capture twice overwrites rather than
// duplicating the session.
export async function saveSession(recording, summary) {
  const id = recording.startedAt;
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const db = await openDB();
  const t = db.transaction([META_STORE, RECORDING_STORE], 'readwrite');
  const metaStore = t.objectStore(META_STORE);
  const record = { ...summary, id, bytes: blob.size };
  // Preserve a user-assigned name across re-saves: opening a session re-runs the
  // pipeline and saves again (idempotent on the startedAt key), which must not
  // wipe a rename made from the Sessions list.
  if (record.name == null) {
    const existing = await new Promise((resolve) => {
      const req = metaStore.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (existing?.name) record.name = existing.name;
  }
  metaStore.put(record);
  t.objectStore(RECORDING_STORE).put(blob, id);
  await done(t);
  // Ask the browser not to evict the library under storage pressure — once,
  // after the first save proves there's something worth keeping.
  if (!persistRequested) {
    persistRequested = true;
    try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }
  }
}

// All session summaries, newest first. [] on any failure — the Sessions page
// just shows its empty state.
export async function listSessions() {
  let db;
  try { db = await openDB(); } catch { return []; }
  const rows = await new Promise((resolve) => {
    const req = db.transaction([META_STORE], 'readonly').objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function getRecordingBlob(id) {
  let db;
  try { db = await openDB(); } catch { return null; }
  return new Promise((resolve) => {
    const req = db.transaction([RECORDING_STORE], 'readonly').objectStore(RECORDING_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// Set (or clear, with '') the display name on a session summary. Only touches
// the lightweight meta record — the recording blob is left untouched.
export async function renameSession(id, name) {
  const db = await openDB();
  const t = db.transaction([META_STORE], 'readwrite');
  const store = t.objectStore(META_STORE);
  const existing = await new Promise((resolve) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  if (existing) {
    const trimmed = (name || '').trim();
    if (trimmed) existing.name = trimmed;
    else delete existing.name;
    store.put(existing);
  }
  return done(t);
}

export async function deleteSession(id) {
  const db = await openDB();
  const t = db.transaction([META_STORE, RECORDING_STORE], 'readwrite');
  t.objectStore(META_STORE).delete(id);
  t.objectStore(RECORDING_STORE).delete(id);
  return done(t);
}

// { usage, quota } in bytes, or null where the Storage API is unavailable —
// the Sessions page omits its storage line silently.
export async function estimateUsage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.usage != null && est.quota != null) return { usage: est.usage, quota: est.quota };
  } catch { /* ignore */ }
  return null;
}

// --- One-shot open-handoff to the Stroke Analysis page ---
// Opening a session hands its Blob to the analysis instance in module memory
// (same rationale as replayHandoff: both page instances share one JS context,
// and the blob stays unparsed until the analysis page's deferred "Replaying…"
// flow reads it). A refresh clears it harmlessly — the session is still in
// the library.

let pendingOpen = null;

// `meta` (optional) carries the session's { name, startedAt } so the review
// page can title its bar with the name/datetime the Sessions list showed.
export function putOpen(blob, meta = null) {
  pendingOpen = { blob, meta };
}

// Returns the pending { blob, meta } (or null) and clears it.
export function takeOpen() {
  const p = pendingOpen;
  pendingOpen = null;
  return p;
}
