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
import { traceCourse, extendCourse, STEP_M } from './course';
import { loadMarks, subscribeMarks } from './courseMarks';
import { bearingDeg } from './geo';

const BANK_CASING = { color: '#111827', weight: 9, opacity: 0.85, interactive: false };
const BANK_CORE = { color: '#ffd60a', weight: 4.5, opacity: 1, interactive: false };
const DIVIDER_CASING = { color: '#111827', weight: 8, opacity: 0.85, interactive: false };
// noClip: Leaflet normally clips a polyline to the viewport, which makes the
// rendered path START at the screen edge — the dash pattern then phases from
// a point that moves with every pan, crawling the dashes alongside the boat.
// Unclipped, the path starts at its true (fixed) first vertex and the
// dashOffset ground-anchor below can actually hold the pattern still.
const DIVIDER_CORE = { color: '#ffffff', weight: 4, opacity: 1, dashArray: '10 14', interactive: false, noClip: true };

// Divider dashes are road markings: fixed ground lengths, phase pinned to a
// ground anchor via dashOffset. Without the pin the SVG pattern phases from
// the polyline's first vertex, so every extension at the 'behind' end shifts
// every dash on screen.
const DASH_M = 10;
const DASH_GAP_M = 14;
const MIN_DASH_PX = 5; // zoomed out past this, ground-sized dashes smear —
// fall back to the plain pixel pattern (individual dashes are moot out there)

const OFF_COURSE_M = 150; // farther than this from the divider: new waterway
const END_GUARD = 30; // stations (~750 m): extend when the boat gets this close to an end
const FETCH_RETRY_MS = 60000;
const MEMORY_CAP = 120;

// Track coverage (cover()): review maps grow the course until it spans the
// whole recorded track, not just the stretch around one fix.
const COVER_TOL_M = 100; // a track point this close to the divider is covered
const COVER_SAMPLE_M = 150; // spacing of the coverage targets along the track
const COVER_MAX_STATIONS = 1200; // ~30 km — station ceiling while covering

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

// `onStatus` (optional) hears about the water fetch behind the course:
// 'loading' while a fetch the drawn course is waiting on is in flight,
// 'error' after one fails (retried automatically after FETCH_RETRY_MS, or
// immediately via retry()), 'ready' once a course is drawn, null when there
// is simply no course here (fix off water, no heading yet). Background
// fetches for an already-drawn course never surface — the lines just grow.
export function createCourseOverlay(map, onStatus = null) {
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

  let dashOrigin = null; // ground point a dash boundary stays pinned to
  let dashChainM = 0; // metres along the drawn divider from its start to dashOrigin
  const ll = (p) => ({ lat: p[0], lon: p[1] });

  // Ground-anchored dash pattern (see DASH_M above): sizes in pixels for the
  // current zoom, phase chosen so the pattern sits still at dashOrigin no
  // matter where the polyline now starts. Re-run on zoom and on every redraw.
  const applyDash = () => {
    if (!dashOrigin) return;
    // Pixels per ground metre at the course's latitude, straight from the map.
    const a = map.latLngToLayerPoint(dashOrigin);
    const b = map.latLngToLayerPoint([dashOrigin[0] + 100 / 111320, dashOrigin[1]]);
    const ppm = Math.hypot(a.x - b.x, a.y - b.y) / 100;
    if (DASH_M * ppm < MIN_DASH_PX) {
      cores[2].setStyle({ dashArray: DIVIDER_CORE.dashArray, dashOffset: null });
      return;
    }
    const periodPx = (DASH_M + DASH_GAP_M) * ppm;
    const offset = (periodPx - ((dashChainM * ppm) % periodPx)) % periodPx;
    cores[2].setStyle({
      dashArray: `${DASH_M * ppm} ${DASH_GAP_M * ppm}`,
      dashOffset: String(offset),
    });
  };

  const setAll = (course) => {
    const paths = course
      ? [course.left, course.right, warpThroughBuoys(course.center, centerBuoys())]
      : [[], [], []];
    paths.forEach((latlngs, i) => {
      casings[i].setLatLngs(latlngs);
      cores[i].setLatLngs(latlngs);
    });
    // Re-measure how far dashOrigin now sits from the divider's (possibly
    // just-moved) start. Geometry around the anchor is stable across
    // extensions, so this distance grows by exactly the prepended length.
    const div = paths[2];
    if (div.length > 1) {
      if (!dashOrigin) dashOrigin = [div[0][0], div[0][1]];
      let best = Infinity, chain = 0, acc = 0;
      for (let i = 0; i < div.length; i++) {
        if (i > 0) acc += moveM(ll(div[i - 1]), ll(div[i]));
        const d = moveM(ll(div[i]), ll(dashOrigin));
        if (d < best) { best = d; chain = acc; }
      }
      // A fresh trace on other water: the old anchor is nowhere near — re-pin.
      if (best > 100) { dashOrigin = [div[0][0], div[0][1]]; chain = 0; }
      dashChainM = chain;
      applyDash();
    } else {
      dashOrigin = null;
      dashChainM = 0;
    }
  };
  map.on('zoomend', applyDash);

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
  let status = null;
  let coverPts = null; // sampled track fixes the course must reach (cover())
  let stationCap = null; // raised station cap while covering a long track

  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    onStatus?.(s);
  };

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
    setStatus('ready');
    ensureCover();
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
    let c = traceCourse(water, last.lat, last.lon, last.heading, memory);
    // A recording's anchor fix is often the dock — reeds, GPS scatter, water
    // the tracer rejects. With coverage targets on hand, fall back to seeding
    // from the nearest track samples in this cell; the coverage loop then
    // grows the course out to the rest of the track from wherever it took.
    if (!c && coverPts) {
      for (let i = coverPts.length - 1; i >= 0 && !c; i--) {
        const p = coverPts[i];
        if (p.heading == null || cellKeyFor(p.lat, p.lon) !== water.key) continue;
        c = traceCourse(water, p.lat, p.lon, p.heading, memory);
      }
    }
    if (c) {
      deadEnds = { ahead: false, behind: false };
      adopt(c);
    }
  };

  // Keep the water geometry for the boat's cell on hand for (re)tracing.
  // Failures back off FETCH_RETRY_MS before an automatic retry; retry()
  // (the user's tap) clears the backoff and calls this straight away.
  const ensureWater = () => {
    if (destroyed || !last) return;
    const key = cellKeyFor(last.lat, last.lon);
    if (water?.key === key || pendingKey === key || Date.now() - failedAt <= FETCH_RETRY_MS) return;
    pendingKey = key;
    if (!course) setStatus('loading');
    waterForCell(last.lat, last.lon).then(
      (w) => {
        pendingKey = null;
        if (destroyed) return;
        water = w;
        ensureTraced();
        // Water arrived but no course came of it (fix off the mapped water,
        // heading still unknown): nothing to indicate, the trace will happen
        // on a later fix.
        if (!course) setStatus(null);
      },
      () => {
        pendingKey = null;
        failedAt = Date.now();
        if (!destroyed && !course) setStatus('error');
      }
    );
  };

  // Extend one end of the course by EXTEND_M. Shared by the live path (the
  // boat approaching an end) and track coverage; adopt() re-runs the
  // coverage check after each successful step, so covering propels itself.
  const requestExtend = (end) => {
    if (extending || !course || deadEnds[end]) return;
    const n = course.center.length;
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
        const c = extendCourse(w, course.stations, end, memory, stationCap ?? undefined);
        if (!c) {
          deadEnds[end] = true; // the water really stops there
          ensureCover(); // coverage may still owe the other end
          return;
        }
        if (c.trimmed) {
          deadEnds[end === 'ahead' ? 'behind' : 'ahead'] = false;
          // Station ceiling reached: growing one end now eats the other, so
          // full coverage is off the table — stop before it ping-pongs.
          coverPts = null;
        }
        adopt(c);
      },
      () => { extending = false; } // offline: retried on a later fix
    );
  };

  const maybeExtend = () => {
    if (extending || !course || !last) return;
    const { idx } = nearest(last);
    const n = course.center.length;
    if (idx >= n - END_GUARD && !deadEnds.ahead) requestExtend('ahead');
    else if (idx < END_GUARD && !deadEnds.behind) requestExtend('behind');
  };

  // One coverage step: find a target the course hasn't reached and extend the
  // end it lies beyond. Targets whose nearest station sits mid-course are on
  // water the ends can never reach (a tributary detour) and stay uncovered;
  // once nothing actionable remains the targets are dropped.
  const ensureCover = () => {
    if (destroyed || !course || !coverPts || extending) return;
    const n = course.center.length;
    for (const p of coverPts) {
      const { idx, dist } = nearest(p);
      if (dist <= COVER_TOL_M) continue;
      const end = idx < END_GUARD ? 'behind' : idx >= n - END_GUARD ? 'ahead' : null;
      if (!end || deadEnds[end]) continue;
      requestExtend(end);
      return;
    }
    coverPts = null;
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

      ensureWater();

      if (course) {
        // Rowed off the traced waterway? Start over. Otherwise the lines
        // stay exactly where they are; only the far ends may grow.
        if (nearest(last).dist > OFF_COURSE_M) {
          course = null;
          deadEnds = { ahead: false, behind: false };
          setAll(null);
          setStatus(pendingKey != null ? 'loading' : null);
        } else {
          maybeExtend();
          ensureCover(); // resumes coverage stalled by an offline fetch
          return;
        }
      }

      ensureTraced();
    },
    // Review maps: grow the course until it spans this whole track (array of
    // {lat, lon} fixes, oldest first). The track is sampled into sparse
    // targets and the course extends end over end until every target is
    // reached (or a dead end / other water rules it out). Idempotent —
    // re-covering an already-spanned track does nothing.
    cover(points) {
      if (destroyed || !points || points.length < 2) return;
      const pts = [];
      let lenM = 0;
      let prevAll = null;
      for (const p of points) {
        if (p?.lat == null) continue;
        const q = { lat: p.lat, lon: p.lon };
        if (prevAll) lenM += moveM(prevAll, q);
        prevAll = q;
        const kept = pts[pts.length - 1];
        if (!kept || moveM(kept, q) >= COVER_SAMPLE_M) pts.push(q);
      }
      if (prevAll && pts[pts.length - 1] !== prevAll) pts.push(prevAll);
      if (pts.length < 2) return;
      // Direction of travel at each sample — trace-seed fallback (see
      // ensureTraced) needs a heading to march from.
      pts.forEach((q, i) => {
        q.heading = bearingDeg(pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i + 1)]);
      });
      coverPts = pts;
      // Room for the whole track plus the usual trace margin at both ends,
      // never below extendCourse's own default cap (400) or a cap already
      // raised by an earlier cover().
      stationCap = Math.min(
        COVER_MAX_STATIONS,
        Math.max(stationCap ?? 0, 400, Math.ceil(lenM / STEP_M) + 8 * END_GUARD)
      );
      ensureTraced(); // an anchor whose trace failed may now seed from the track
      ensureCover();
    },
    // Immediate re-fetch after a failure, without waiting out the backoff.
    retry() {
      failedAt = 0;
      ensureWater();
    },
    destroy() {
      destroyed = true;
      unsubMarks();
      map.off('zoomend', applyDash);
      [...casings, ...cores].forEach((l) => l.remove());
    },
  };
}
