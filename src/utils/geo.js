// Geo helpers for the session map: bearing math and looking up the boat's
// position/direction at a point in session time from the recorded GPS fixes.

// Great-circle initial bearing from `a` to `b`, degrees clockwise from north.
export function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Point reached from (lat, lon) after travelling `distanceM` metres along the
// great circle at initial bearing `bearing` (degrees clockwise from north).
const EARTH_RADIUS_M = 6371000;
export function destinationPoint(lat, lon, bearing, distanceM) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const d = distanceM / EARTH_RADIUS_M;
  const th = toRad(bearing);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(
    Math.sin(th) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2)
  );
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

// Minimum spacing between the two fixes used to derive a travel bearing —
// closer fixes make GPS jitter spin the arrow; farther apart is stale.
const HEADING_MIN_GAP_MS = 1500;
const HEADING_MAX_GAP_MS = 12000;

// The boat's state at sample-clock time `t`: the last GPS fix at or before it
// (positions must be time-ordered), plus a direction of travel. The device's
// own heading (recorded on the fix while moving) wins; otherwise the bearing
// from a fix a few seconds earlier. Returns { lat, lon, heading } with heading
// null when the boat wasn't demonstrably moving, or null outright when the
// nearest fix is too far from `t` to stand in for it (GPS gap / pre-fix stroke).
export function boatFixAt(positions, t, { maxGapMs = 15000 } = {}) {
  if (!positions || positions.length === 0 || t == null) return null;
  let lo = 0, hi = positions.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid].t <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx === -1) idx = 0; // t predates the first fix — use it if close enough
  const p = positions[idx];
  if (Math.abs(p.t - t) > maxGapMs) return null;
  let heading = null;
  for (let j = idx - 1; j >= 0; j--) {
    const q = positions[j];
    if (p.t - q.t < HEADING_MIN_GAP_MS) continue;
    if (p.t - q.t <= HEADING_MAX_GAP_MS && (q.lat !== p.lat || q.lon !== p.lon)) {
      heading = bearingDeg(q, p);
    }
    break;
  }
  if (p.heading != null && !Number.isNaN(p.heading)) heading = p.heading;
  return { lat: p.lat, lon: p.lon, heading };
}
