// Persistent coach-link identity and roster (localStorage).
//
// The dual-phone coach link (see usePeerLink) used to mint a throwaway 5-digit
// code every session, so a coach could never reconnect to the same rower on a
// later day. This store gives each phone a *stable* peer id (generated once and
// kept) and lets a coach remember the rowers they've paired with — name, id, and
// when they were last seen — so re-linking is "tap the name", not "re-scan a QR".
//
// Two namespaces:
//   identity — this phone's own stable id + the name it advertises.
//   roster   — rowers a coach has saved (coach-side only). Keyed by peer id.

const IDENTITY_KEY = 'freespeed-identity';
const ROSTER_KEY = 'freespeed-roster';
const ROLE_KEY = 'freespeed-role';
const ID_PREFIX = 'freespeed-';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — identity just won't persist this session */
  }
}

// 6 lowercase base36 chars after the shared prefix: ~2 billion-wide namespace on
// the public broker, so collisions (and name-guessing hijacks) are negligible.
function mintId() {
  let s = '';
  while (s.length < 6) s += Math.random().toString(36).slice(2);
  return ID_PREFIX + s.slice(0, 6);
}

// This phone's stable identity, created on first use and persisted thereafter.
export function getIdentity() {
  const stored = readJSON(IDENTITY_KEY, null);
  if (stored?.id) return { id: stored.id, name: stored.name || '' };
  const identity = { id: mintId(), name: '' };
  writeJSON(IDENTITY_KEY, identity);
  return identity;
}

export function setName(name) {
  const identity = getIdentity();
  identity.name = name;
  writeJSON(IDENTITY_KEY, identity);
  return identity;
}

// Remember whether this phone is used as the rower (in the boat) or the coach
// (watching), so the link defaults to the same role next session. Defaults to
// rower — the common case, and the one that auto-starts capture.
export function getRole() {
  const r = readJSON(ROLE_KEY, null);
  return r === 'coach' || r === 'rower' ? r : 'rower';
}

export function setRole(role) {
  if (role === 'coach' || role === 'rower') writeJSON(ROLE_KEY, role);
}

// --- Coach-side roster ---

export function getRoster() {
  const list = readJSON(ROSTER_KEY, []);
  return Array.isArray(list) ? list : [];
}

// Remember (or refresh) a rower the coach just connected to. `name` is what the
// rower advertises; an existing coach-set `label` is preserved across updates.
export function saveRower({ id, name }) {
  if (!id) return getRoster();
  const list = getRoster();
  const existing = list.find((r) => r.id === id);
  if (existing) {
    if (name) existing.name = name;
    existing.lastSeen = Date.now();
  } else {
    list.push({ id, name: name || '', label: '', lastSeen: Date.now() });
  }
  writeJSON(ROSTER_KEY, list);
  return list;
}

// Coach's local override for how a rower shows in the list (blank → use name).
export function relabelRower(id, label) {
  const list = getRoster();
  const r = list.find((x) => x.id === id);
  if (r) {
    r.label = label;
    writeJSON(ROSTER_KEY, list);
  }
  return list;
}

export function removeRower(id) {
  const list = getRoster().filter((r) => r.id !== id);
  writeJSON(ROSTER_KEY, list);
  return list;
}

// Friendly display name for a roster entry: coach label wins, then the rower's
// own name, then a short fragment of the id as a last resort.
export function displayName(r) {
  return r.label?.trim() || r.name?.trim() || r.id.replace(ID_PREFIX, '');
}
