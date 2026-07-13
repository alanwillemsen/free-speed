// Replays an exported session against the course overlay's logic: trace the
// course once from the first steady fix, extend it as the boat nears an end,
// retrace only when the boat leaves the traced waterway. Reports how often
// the on-screen geometry actually changed and how far the divider moved at
// the boat when it did — with the fixed-course model this should be near zero
// outside extensions.
//
//   node scripts/replay-course.mjs <exported-session.json>
//
// Overpass responses are cached in scripts/water-cache.json so repeat runs
// are offline and fast.
import fs from 'node:fs';

const sessionPath = process.argv[2];
if (!sessionPath) {
  console.error('usage: node scripts/replay-course.mjs <exported-session.json>');
  process.exit(1);
}

// water.js expects a browser; back its localStorage with a JSON file.
const CACHE_FILE = new URL('./water-cache.json', import.meta.url).pathname;
const store = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; fs.writeFileSync(CACHE_FILE, JSON.stringify(store)); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
};
const { waterForCell, makeFrame } = await import('../src/utils/water.js');
const { traceCourse, extendCourse } = await import('../src/utils/course.js');
const { bearingDeg } = await import('../src/utils/geo.js');

const gps = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).gps;
console.log(`${gps.length} GPS fixes`);
const frame = makeFrame(gps[0].lat, gps[0].lon);
const xy = (p) => frame.toXY(p.lat, p.lon);

// Signed cross-track distance from q to a polyline: positive = port side.
function crossTrack(q, line) {
  let best = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2));
    const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
    if (!best || d < best.d) best = { d, s: Math.sign(dx * (q[1] - a[1]) - dy * (q[0] - a[0])) * d };
  }
  return best;
}

const OFF_COURSE_M = 150, END_GUARD = 30;
let course = null, memory = null, lastH = null;
const deadEnds = { ahead: false, behind: false };
let retraces = 0, extensions = 0;
const changeAtBoat = [], sides = [];

for (let i = 8; i < gps.length; i += 2) {
  const p = gps[i];
  if ((p.speed ?? 0) < 1.5) continue;
  const heading = bearingDeg(gps[i - 8], p);
  const settled = lastH == null || Math.abs(((heading - lastH + 540) % 360) - 180) < 12;
  lastH = heading;
  const q = xy(p);

  if (course) {
    const line = course.center.map(([la, lo]) => frame.toXY(la, lo));
    const near = crossTrack(q, line);
    if (near && near.d <= OFF_COURSE_M) {
      sides.push(near.s);
      // near an end? extend (course changes, measure divider shift at boat)
      let bestIdx = 0, bestD = Infinity;
      line.forEach((v, k) => {
        const d = Math.hypot(q[0] - v[0], q[1] - v[1]);
        if (d < bestD) { bestD = d; bestIdx = k; }
      });
      const n = line.length;
      const end = bestIdx >= n - END_GUARD && !deadEnds.ahead
        ? 'ahead'
        : bestIdx < END_GUARD && !deadEnds.behind ? 'behind' : null;
      if (end) {
        const tip = end === 'ahead' ? course.center[n - 1] : course.center[0];
        const prev = end === 'ahead' ? course.center[n - 2] : course.center[1];
        const beyond = [tip[0] + (tip[0] - prev[0]) * 12, tip[1] + (tip[1] - prev[1]) * 12];
        const w = await waterForCell(beyond[0], beyond[1]);
        const c = extendCourse(w, course.stations, end, memory);
        if (!c) {
          deadEnds[end] = true;
        } else {
          extensions++;
          const after = crossTrack(q, c.center.map(([la, lo]) => frame.toXY(la, lo)));
          if (after) changeAtBoat.push(Math.abs(after.s - near.s));
          course = c;
          memory = c.memory;
          if (c.trimmed) deadEnds[end === 'ahead' ? 'behind' : 'ahead'] = false;
        }
      }
      continue;
    }
    course = null;
    deadEnds.ahead = deadEnds.behind = false;
  }
  if (!settled) continue;
  const water = await waterForCell(p.lat, p.lon);
  const c = traceCourse(water, p.lat, p.lon, heading, memory);
  if (c) { course = c; memory = c.memory; retraces++; }
}

console.log(`${retraces} traces (1 = never lost the course), ${extensions} extensions`);
const stat = (name, arr) => {
  arr.sort((a, b) => a - b);
  if (!arr.length) return console.log(`${name}: n=0`);
  const q = (f) => arr[Math.floor(f * (arr.length - 1))].toFixed(2);
  console.log(`${name}: n=${arr.length} median ${q(0.5)} p90 ${q(0.9)} max ${q(1)}`);
};
stat('divider shift at boat when course changed (m)', changeAtBoat);
const port = sides.filter((s) => s > 2).length;
const stbd = sides.filter((s) => s < -2).length;
console.log(`boat side of divider: port ${port}, starboard ${stbd}, near-line ${sides.length - port - stbd}`);
