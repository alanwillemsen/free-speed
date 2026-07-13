// Leaflet layer bundle for the river course: both shores (smoothed to cross
// over bays) and the mid-channel divider, traced from OSM water data (see
// utils/water.js and utils/course.js). Every line is drawn twice — a
// near-black casing under a bright core — so it stays readable over pale day
// tiles in full sun and over the inverted night basemap, whose CSS filter
// only touches the tile pane, never these vectors.
//
// The shore doesn't move, so neither do the lines: the course is traced ONCE
// from the first steady fix and kept. As the boat nears an end of the traced
// stretch, the course is extended there (far off screen); on-screen geometry
// is never recomputed. Only rowing away from the course entirely (another
// waterway) starts a fresh trace.
import L from 'leaflet';
import { waterForCell, cellKeyFor } from './water';
import { traceCourse, extendCourse } from './course';
import { loadMarks, subscribeMarks } from './courseMarks';

const BANK_CASING = { color: '#111827', weight: 9, opacity: 0.85, interactive: false };
const BANK_CORE = { color: '#ffd60a', weight: 4.5, opacity: 1, interactive: false };
const DIVIDER_CASING = { color: '#111827', weight: 8, opacity: 0.85, interactive: false };
const DIVIDER_CORE = { color: '#ffffff', weight: 4, opacity: 1, dashArray: '10 14', interactive: false };

const OFF_COURSE_M = 150; // farther than this from the divider: new waterway
const END_GUARD = 30; // stations (~750 m): extend when the boat gets this close to an end
const FETCH_RETRY_MS = 60000;
const MEMORY_CAP = 120;

const moveM = (a, b) =>
  Math.hypot(
    (a.lat - b.lat) * 111320,
    (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  );

// --- User-placed course marks reshape the traced course ---
// Centre buoys pull the drawn divider through themselves (the racing line is
// where the buoys float, not the geometric middle); course-end lines clip the
// traced geometry (dam, shallows — nothing to row past them).

const WARP_STATIONS = 8; // taper half-width, ~200 m at 25 m station spacing
const WARP_CAPTURE_M = 120; // buoys farther from the divider belong to another stretch

// Pull the divider polyline through each buoy: move the nearest vertex onto
// the buoy and taper the offset over WARP_STATIONS neighbours with a cosine
// window. Sequential per buoy, and each works on the already-warped line, so
// every buoy ends up exactly on the divider even when windows overlap.
function warpThroughBuoys(center, buoys) {
  if (buoys.length === 0 || center.length < 2) return center;
  const out = center.map((p) => p.slice());
  for (const b of buoys) {
    let bi = -1, bd = Infinity;
    out.forEach(([la, lo], i) => {
      const d = moveM({ lat: la, lon: lo }, b);
      if (d < bd) { bd = d; bi = i; }
    });
    if (bd > WARP_CAPTURE_M) continue;
    const dLat = b.lat - out[bi][0];
    const dLon = b.lon - out[bi][1];
    const from = Math.max(0, bi - WARP_STATIONS);
    const to = Math.min(out.length - 1, bi + WARP_STATIONS);
    for (let j = from; j <= to; j++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (j - bi)) / WARP_STATIONS);
      out[j][0] += dLat * w;
      out[j][1] += dLon * w;
    }
  }
  return out;
}

// Segment intersection on [lat, lon] pairs, planar with lon scaled by
// cos(lat) — fine at river scale.
function segIntersects(a1, a2, b1, b2) {
  const k = Math.cos((a1[0] * Math.PI) / 180);
  const cross = (o, p, q) =>
    (p[1] - o[1]) * k * (q[0] - o[0]) - (p[0] - o[0]) * (q[1] - o[1]) * k;
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function createCourseOverlay(map) {
  // Casings first: within the overlay pane, SVG paint order is add order.
  const casings = [
    L.polyline([], BANK_CASING).addTo(map),
    L.polyline([], BANK_CASING).addTo(map),
    L.polyline([], DIVIDER_CASING).addTo(map),
  ];
  const cores = [
    L.polyline([], BANK_CORE).addTo(map),
    L.polyline([], BANK_CORE).addTo(map),
    L.polyline([], DIVIDER_CORE).addTo(map),
  ];
  let marks = loadMarks();
  const centerBuoys = () => marks.filter((m) => m.type === 'center');
  const endLines = () => marks.filter((m) => m.type === 'end');

  const setAll = (course) => {
    const paths = course
      ? [course.left, course.right, warpThroughBuoys(course.center, centerBuoys())]
      : [[], [], []];
    paths.forEach((latlngs, i) => {
      casings[i].setLatLngs(latlngs);
      cores[i].setLatLngs(latlngs);
    });
  };

  let destroyed = false;
  let water = null;
  let pendingKey = null;
  let failedAt = 0;
  let last = null; // latest fix, heading held through stationary spells
  let settled = true; // heading not actively swinging (mid-turn fixes mislead)
  let course = null; // the fixed course geometry currently drawn
  let memory = null; // split classifications (island hysteresis)
  let extending = false;
  let deadEnds = { ahead: false, behind: false };

  // Nearest divider vertex to the fix — cheap at 25 m vertex spacing.
  const nearest = (fix) => {
    let idx = -1, dist = Infinity;
    course.center.forEach(([la, lo], i) => {
      const d = moveM(fix, { lat: la, lon: lo });
      if (d < dist) { dist = d; idx = i; }
    });
    return { idx, dist };
  };

  // Cut the course where the divider crosses a do-not-pass line, keeping the
  // side the boat is on, and dead-end that direction so it never re-extends.
  // center/left/right/stations are index-aligned per station, so one pair of
  // slice indices clips them all consistently.
  const clipToEnds = (c) => {
    const lines = endLines();
    const n = c.center.length;
    if (lines.length === 0 || n < 2 || !last) return c;
    let boatIdx = 0, best = Infinity;
    c.center.forEach(([la, lo], i) => {
      const d = moveM(last, { lat: la, lon: lo });
      if (d < best) { best = d; boatIdx = i; }
    });
    let lo = 0, hi = n - 1;
    for (const line of lines) {
      const q1 = [line.lat, line.lon];
      const q2 = [line.lat2, line.lon2];
      for (let k = 0; k < n - 1; k++) {
        if (!segIntersects(c.center[k], c.center[k + 1], q1, q2)) continue;
        if (k < boatIdx) {
          if (k + 1 > lo) { lo = k + 1; deadEnds.behind = true; }
        } else if (k < hi) {
          hi = k;
          deadEnds.ahead = true;
        }
      }
    }
    if (lo === 0 && hi === n - 1) return c;
    if (hi - lo < 1) return c; // boat pinched between two lines — leave uncut
    const cut = (arr) => arr.slice(lo, hi + 1);
    return { ...c, center: cut(c.center), left: cut(c.left), right: cut(c.right), stations: cut(c.stations) };
  };

  const adopt = (c) => {
    course = clipToEnds(c);
    memory = {
      islands: [...(memory?.islands ?? []), ...c.memory.islands].slice(-MEMORY_CAP),
      nonIslands: [...(memory?.nonIslands ?? []), ...c.memory.nonIslands].slice(-MEMORY_CAP),
    };
    setAll(course);
  };

  // Marks changed while we're live: re-clip against the current lines (a new
  // line may cross mid-course) and redraw the warped divider. Dead ends are
  // recomputed from scratch so deleting a line lets the course grow again.
  const unsubMarks = subscribeMarks((m) => {
    if (destroyed) return;
    marks = m;
    deadEnds = { ahead: false, behind: false };
    if (course) {
      course = clipToEnds(course);
      setAll(course);
    }
  });

  // Trace from the latest fix — on the first update the water is still being
  // fetched, so this is also called when the fetch resolves; otherwise a
  // review map (which only updates on user interaction) would end up tracing
  // from whatever stroke the user happens to tap next.
  const ensureTraced = () => {
    if (destroyed || course || !water || !last || last.heading == null || !settled) return;
    const c = traceCourse(water, last.lat, last.lon, last.heading, memory);
    if (c) {
      deadEnds = { ahead: false, behind: false };
      adopt(c);
    }
  };

  const maybeExtend = () => {
    if (extending || !course || !last) return;
    const { idx } = nearest(last);
    const n = course.center.length;
    let end = null;
    if (idx >= n - END_GUARD && !deadEnds.ahead) end = 'ahead';
    else if (idx < END_GUARD && !deadEnds.behind) end = 'behind';
    if (!end) return;
    // Fetch the cell of a point past the tip, so an extension across a cell
    // border gets the neighbouring geometry.
    const tip = end === 'ahead' ? course.center[n - 1] : course.center[0];
    const prev = end === 'ahead' ? course.center[n - 2] : course.center[1];
    const beyond = [tip[0] + (tip[0] - prev[0]) * 12, tip[1] + (tip[1] - prev[1]) * 12];
    extending = true;
    waterForCell(beyond[0], beyond[1]).then(
      (w) => {
        extending = false;
        if (destroyed || !course) return;
        const c = extendCourse(w, course.stations, end, memory);
        if (!c) {
          deadEnds[end] = true; // the water really stops there
          return;
        }
        if (c.trimmed) deadEnds[end === 'ahead' ? 'behind' : 'ahead'] = false;
        adopt(c);
      },
      () => { extending = false; } // offline: retried on a later fix
    );
  };

  return {
    update(boat) {
      if (destroyed || boat?.lat == null) return;
      const heading = boat.heading ?? last?.heading ?? null;
      settled =
        last?.heading == null ||
        heading == null ||
        Math.abs(((heading - last.heading + 540) % 360) - 180) < 12;
      last = { lat: boat.lat, lon: boat.lon, heading };

      // Keep the water geometry for the boat's cell on hand for (re)tracing.
      const key = cellKeyFor(boat.lat, boat.lon);
      if (water?.key !== key && pendingKey !== key && Date.now() - failedAt > FETCH_RETRY_MS) {
        pendingKey = key;
        waterForCell(boat.lat, boat.lon).then(
          (w) => {
            pendingKey = null;
            if (destroyed) return;
            water = w;
            ensureTraced();
          },
          () => { pendingKey = null; failedAt = Date.now(); }
        );
      }

      if (course) {
        // Rowed off the traced waterway? Start over. Otherwise the lines
        // stay exactly where they are; only the far ends may grow.
        if (nearest(last).dist > OFF_COURSE_M) {
          course = null;
          deadEnds = { ahead: false, behind: false };
          setAll(null);
        } else {
          maybeExtend();
          return;
        }
      }

      ensureTraced();
    },
    destroy() {
      destroyed = true;
      unsubMarks();
      [...casings, ...cores].forEach((l) => l.remove());
    },
  };
}
