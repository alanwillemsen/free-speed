// User-placed course marks: local knowledge that OSM doesn't have.
//
// Four kinds, all pinned by lat/lon:
//   center — a real-world centre-line buoy (often NOT at the geometric middle
//            of the river, which is exactly why it's worth marking); the
//            traced divider is warped to pass through these (courseOverlay);
//   hazard — a buoy or spot marking very shallow water;
//   end    — the end of the rowable course, a two-point line across the water
//            (dam, shallows): do not pass — the traced course is clipped here;
//   dock   — the dock itself, a true-size rectangle: one long edge from
//            (lat,lon) to (lat2,lon2) plus a signed width `w` in metres
//            (positive = left of the edge direction). Drawn as a geographic
//            polygon, so it scales with the map.
//
// Persistence is localStorage (same pattern as pairStore/water). Sharing is a
// file export/import plus a URL: marks are tiny, so the whole set fits in a
// #course?marks=<base64url> link a coach can text to the crew.
//
// Mark shape: { id, type, lat, lon, lat2?, lon2?, w? }
// (lat2/lon2 for 'end' and 'dock'; w only for 'dock'.)

const STORE_KEY = 'freespeed_marks_v1';

export const MARK_TYPES = {
  center: { label: 'Centre buoy' },
  hazard: { label: 'Shallow hazard' },
  end: { label: 'Course end' },
  dock: { label: 'Dock' },
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const isMark = (m) => {
  if (!m || !MARK_TYPES[m.type] || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return false;
  if (m.type === 'end') return Number.isFinite(m.lat2) && Number.isFinite(m.lon2);
  if (m.type === 'dock')
    return Number.isFinite(m.lat2) && Number.isFinite(m.lon2) && Number.isFinite(m.w) && m.w !== 0;
  return true;
};

export function loadMarks() {
  const list = readJSON(STORE_KEY, []);
  return Array.isArray(list) ? list.filter(isMark) : [];
}

// Cross-component/tab change notification: maps that display marks subscribe
// so an edit shows up without a remount.
const listeners = new Set();

export function saveMarks(marks) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(marks));
  } catch {
    /* private mode / quota — marks just won't persist this session */
  }
  listeners.forEach((fn) => fn(marks));
}

export function subscribeMarks(fn) {
  listeners.add(fn);
  const onStorage = (e) => {
    if (e.key === STORE_KEY) fn(loadMarks());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function makeMark(type, lat, lon, lat2, lon2, w) {
  const mark = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    type,
    lat,
    lon,
  };
  if (type === 'end' || type === 'dock') {
    mark.lat2 = lat2;
    mark.lon2 = lon2;
  }
  if (type === 'dock') mark.w = w;
  return mark;
}

// --- Sharing ---

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const nearM = (aLat, aLon, bLat, bLon, m = 3) =>
  Math.hypot(
    (aLat - bLat) * 111320,
    (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180)
  ) < m;

// Same physical mark? Imports merge instead of piling duplicates when the
// crew re-shares an updated set.
function sameMark(a, b) {
  if (a.type !== b.type) return false;
  if (!nearM(a.lat, a.lon, b.lat, b.lon)) return false;
  if (a.type === 'end') return nearM(a.lat2, a.lon2, b.lat2, b.lon2);
  if (a.type === 'dock') return nearM(a.lat2, a.lon2, b.lat2, b.lon2) && Math.abs(a.w - b.w) < 1;
  return true;
}

export function mergeMarks(existing, incoming) {
  const merged = [...existing];
  let added = 0;
  for (const inc of incoming) {
    if (!isMark(inc)) continue;
    if (merged.some((m) => m.id === inc.id || sameMark(m, inc))) continue;
    merged.push({ ...inc, id: inc.id || makeMark(inc.type).id });
    added++;
  }
  return { marks: merged, added };
}

// Compact wire form: [typeInitial, lat, lon, (lat2, lon2)?, (w)?] per mark,
// JSON, then base64url. ~30 bytes per mark, so even a fully buoyed course is
// a comfortable URL.
export function encodeShareParam(marks) {
  const rows = marks.map((m) => {
    if (m.type === 'dock')
      return [m.type[0], round6(m.lat), round6(m.lon), round6(m.lat2), round6(m.lon2), Math.round(m.w * 10) / 10];
    if (m.type === 'end')
      return [m.type[0], round6(m.lat), round6(m.lon), round6(m.lat2), round6(m.lon2)];
    return [m.type[0], round6(m.lat), round6(m.lon)];
  });
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TYPE_BY_INITIAL = { c: 'center', h: 'hazard', e: 'end', d: 'dock' };

export function decodeShareParam(param) {
  try {
    const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const rows = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => makeMark(TYPE_BY_INITIAL[r?.[0]], r?.[1], r?.[2], r?.[3], r?.[4], r?.[5]))
      .filter(isMark);
  } catch {
    return [];
  }
}
