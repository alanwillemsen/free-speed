// Water geometry for the course overlay. OpenStreetMap's tiles already *draw*
// the river, but the actual bank polygons are data we can query: the Overpass
// API returns every natural=water / waterway=riverbank area near a point. The
// rings (outer banks and island holes alike) are converted once into a local
// planar frame in metres so the channel tracer can do cheap segment math, and
// cached — in memory for the session, in localStorage across sessions — so a
// stretch of river is fetched from Overpass roughly once a month.

// Main instance first, community mirror as fallback — the public servers
// shed load with 429/504s now and then, and the rower wants the course now.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_PREFIX = 'freespeed_water_v1:';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

// Fetch cell: water is fetched for a fixed grid cell around the boat rather
// than a boat-centred bbox, so the cache key is stable while rowing inside it.
// 0.02° ≈ 2.2 km of latitude; the padding keeps the tracer supplied with
// geometry when the boat rows near a cell edge.
const CELL_DEG = 0.02;
const PAD_DEG = 0.012;

export const cellKeyFor = (lat, lon) =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

// Planar frame helpers: equirectangular around an origin — centimetre-accurate
// over the few kilometres a fetch cell spans, which is all the tracer needs.
const M_PER_DEG_LAT = 111320;

export function makeFrame(originLat, originLon) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  return {
    originLat,
    originLon,
    toXY: (lat, lon) => [(lon - originLon) * mPerDegLon, (lat - originLat) * M_PER_DEG_LAT],
    toLatLon: ([x, y]) => [originLat + y / M_PER_DEG_LAT, originLon + x / mPerDegLon],
  };
}

// --- Overpass response → closed rings ---------------------------------------

// Multipolygon members arrive as separate ways that only form rings once
// chained end-to-end by shared endpoints. Coordinates come straight from
// Overpass, so shared nodes compare exactly.
const ptKey = (p) => `${p.lat},${p.lon}`;

function assembleRings(segments) {
  const rings = [];
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  while (pool.length > 0) {
    const ring = pool.pop();
    let extended = true;
    while (extended && ptKey(ring[0]) !== ptKey(ring[ring.length - 1])) {
      extended = false;
      const tail = ptKey(ring[ring.length - 1]);
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        if (ptKey(seg[0]) === tail) {
          ring.push(...seg.slice(1));
        } else if (ptKey(seg[seg.length - 1]) === tail) {
          for (let j = seg.length - 2; j >= 0; j--) ring.push(seg[j]);
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    // Drop unclosed leftovers (ways clipped at the bbox edge): a broken ring
    // would leak "inside" parity across the whole cross-section.
    if (ring.length >= 4 && ptKey(ring[0]) === ptKey(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function parseOverpass(json) {
  const rings = [];
  for (const el of json.elements ?? []) {
    if (el.type === 'way' && el.geometry) {
      rings.push(...assembleRings([el.geometry]));
    } else if (el.type === 'relation' && el.members) {
      // Outer and inner rings both count: the tracer's even-odd rule makes
      // holes (islands) read as land automatically.
      const segs = el.members
        .filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner'))
        .map((m) => m.geometry);
      rings.push(...assembleRings(segs));
    }
  }
  return rings;
}

// --- Fetch + cache -----------------------------------------------------------

function cellBBox(lat, lon) {
  const south = Math.floor(lat / CELL_DEG) * CELL_DEG - PAD_DEG;
  const west = Math.floor(lon / CELL_DEG) * CELL_DEG - PAD_DEG;
  return [south, west, south + CELL_DEG + 2 * PAD_DEG, west + CELL_DEG + 2 * PAD_DEG];
}

async function fetchRings(lat, lon) {
  const bbox = cellBBox(lat, lon).join(',');
  const query =
    `[out:json][timeout:25];(` +
    `way["natural"="water"](${bbox});relation["natural"="water"](${bbox});` +
    `way["waterway"="riverbank"](${bbox});relation["waterway"="riverbank"](${bbox});` +
    `);out geom;`;
  let err;
  for (const url of OVERPASS_URLS) {
    try {
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      // Overpass 406s requests with a bare default user agent (node tooling);
      // browsers send a real one — and must not set this header, since a
      // non-safelisted header would force a CORS preflight.
      if (typeof navigator === 'undefined') headers['User-Agent'] = 'free-speed-rowing-app';
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return parseOverpass(await res.json());
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, rings } = JSON.parse(raw);
    if (Date.now() - t > CACHE_TTL_MS) return null;
    return rings;
  } catch {
    return null;
  }
}

function writeCache(key, rings) {
  const entry = JSON.stringify({ t: Date.now(), rings });
  try {
    localStorage.setItem(CACHE_PREFIX + key, entry);
  } catch {
    // Quota: drop all cached water (it's only a re-fetch away) and retry once.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(CACHE_PREFIX + key, entry);
    } catch { /* still full — in-memory copy will carry the session */ }
  }
}

// Compact storage form: [[lat, lon], ...] rounded to ~1 cm.
const packRings = (rings) => rings.map((r) => r.map((p) => [+p.lat.toFixed(7), +p.lon.toFixed(7)]));

const memory = new Map(); // cellKey → { frame, rings: [[x,y],...][] } | Promise

// Planar water geometry for the fetch cell containing (lat, lon): a frame at
// the cell centre plus every water ring as [x, y] metre coordinates, with a
// per-ring bounding box for the tracer's culling. Concurrent callers for the
// same cell share one in-flight fetch; rejections are not cached, so a failed
// fetch is retried on the next call.
export function waterForCell(lat, lon) {
  const key = cellKeyFor(lat, lon);
  const hit = memory.get(key);
  if (hit) return Promise.resolve(hit);

  const promise = (async () => {
    let packed = readCache(key);
    if (!packed) {
      packed = packRings(await fetchRings(lat, lon));
      writeCache(key, packed);
    }
    const [south, west, north, east] = cellBBox(lat, lon);
    const frame = makeFrame((south + north) / 2, (west + east) / 2);
    const rings = packed.map((ring) => {
      const pts = ring.map(([la, lo]) => frame.toXY(la, lo));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { pts, bbox: [minX, minY, maxX, maxY] };
    });
    const value = { key, frame, rings };
    memory.set(key, value);
    return value;
  })();

  memory.set(key, promise);
  promise.catch(() => memory.delete(key));
  return promise;
}
