// Traces the rowed channel through OSM water polygons: from the boat's fix and
// heading, march up- and downstream re-centring on the water at each step, and
// return the two bank lines plus the mid-channel divider. No hand-drawn course
// is needed — the banks come from the map data, and where an island splits the
// river the trace follows the wider channel (where a two-lane course runs).
//
// All math happens in the planar metre frame produced by utils/water.js.

export const STEP_M = 25; // station spacing along the channel
const TRACE_M = 2000; // initial trace reach, each way. The course is traced
// once and then only ever EXTENDED at its far ends — the shore doesn't move,
// so the drawn lines never do either
const EXTEND_M = 1000; // how much a single extension adds
const MAX_STATIONS = 400; // ~10 km kept; beyond that the far end is trimmed
const S_MAX = 400; // half-length of each cross-section probe
const GAP_MERGE_M = 0.75; // adjacent water polygons share edges; bridge the seam
const MIN_CHANNEL_W = 15; // narrower water than this isn't rowable two-abreast —
// treating it as land keeps the trace out of polder ditches at junctions
const OFF_WATER_TOL_M = 40; // GPS scatter: how far off the water a fix may sit
const MAX_TURN_RAD = 0.45; // per-step direction clamp (~26°): hairpin bends are
// real (25 m stations, so a 90° bend needs ~90 m of river), folding back is not
const BANK_GROW_M = 8; // per-step widening allowance; junction mouths don't count
const THROUGH_GROW_M = 2; // how fast the steering channel may widen per step —
// genuine river widening is gradual; a bay mouth opening at full width is not
const EQUAL_CHANNEL_RATIO = 0.75; // island split: channels this close in width
// (at the island's most even section) are one lane each and the island is the
// divider; below it the minor side reads as a back-channel nobody rows and the
// whole two-lane course lives in the wider side. Calibrated on the user's
// river: the train-bridge island (rowed both sides) measures 0.97-0.99, the
// hospital island (not rowable around) 0.67-0.70 depending on approach.
const ISLAND_CENTERED_F = 0.2; // an island only divides traffic when its land
// sits within this fraction of the river's width from the middle; a bar along
// one shore is just that shore's bank
// Hysteresis: a borderline shoal must not flap between "island that divides
// traffic" and "open channel" as the boat moves. Whatever the previous
// recompute decided about a spot sticks — an island keeps dividing under
// relaxed thresholds, a rejected split needs decisively stronger geometry to
// flip.
const STICKY_RATIO = 0.6;
const STICKY_CENTERED_F = 0.3;
const NONSTICKY_RATIO = 0.85;
const NONSTICKY_CENTERED_F = 0.12;
const STICKY_RADIUS_M = 60;
const MAX_HALF_W = 100; // cap the first station's half-width: past this it's open
// water and a mid-lake "divider" means nothing
const MAX_MISSES = 2; // stations allowed to fail before the trace ends (junction
// mouths and seams in the water polygons)

// Water intervals along the line P + s·n, s ∈ [-S_MAX, S_MAX], by even-odd
// crossing parity over every ring (outer banks and island holes alike).
// Returns sorted [sStart, sEnd] spans.
function crossSectionSpans(rings, px, py, nx, ny) {
  const ax = px - S_MAX * nx, ay = py - S_MAX * ny;
  const bx = px + S_MAX * nx, by = py + S_MAX * ny;
  const secMinX = Math.min(ax, bx), secMaxX = Math.max(ax, bx);
  const secMinY = Math.min(ay, by), secMaxY = Math.max(ay, by);

  const ss = [];
  for (const ring of rings) {
    const [minX, minY, maxX, maxY] = ring.bbox;
    if (maxX < secMinX || minX > secMaxX || maxY < secMinY || minY > secMaxY) continue;
    const pts = ring.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dy = pts[i + 1][1] - pts[i][1];
      const det = dx * ny - dy * nx;
      if (Math.abs(det) < 1e-12) continue;
      const ex = pts[i][0] - px;
      const ey = pts[i][1] - py;
      // Half-open t ∈ [0, 1): a probe through a shared ring vertex counts once.
      const t = (nx * ey - ny * ex) / det;
      if (t < 0 || t >= 1) continue;
      const s = (dx * ey - dy * ex) / det;
      if (s >= -S_MAX && s <= S_MAX) ss.push(s);
    }
  }
  ss.sort((a, b) => a - b);

  const spans = [];
  for (let i = 0; i + 1 < ss.length; i += 2) {
    const prev = spans[spans.length - 1];
    if (prev && ss[i] - prev[1] < GAP_MERGE_M) prev[1] = ss[i + 1];
    else spans.push([ss[i], ss[i + 1]]);
  }
  return spans.filter((sp) => sp[1] - sp[0] >= MIN_CHANNEL_W);
}

// March from `start` along `dir0`, one station every STEP_M. Each station
// probes across the channel, picks its water span, and records the bank
// endpoints and midpoint; the heading then bends toward the channel's own
// direction. Returns stations as { c, l, r } planar points.
// `memory` carries the island hysteresis: islands/nonIslands are planar spots
// classified by the previous recompute; every split seen by this march is
// appended to islandsOut or nonIslandsOut for the next one. `initBanks`
// resumes a march from the end of an existing trace instead of a bare fix.
function march(rings, start, dir0, maxDist, memory, initBanks = null) {
  let px = start[0], py = start[1];
  let dx = dir0[0], dy = dir0[1];
  const stations = [];
  let prevBanks = initBanks;
  let prevThrough = initBanks; // the steering channel: banks that ignore bays
  let prevGap = null; // land gap of the previous station's split, if any
  let prevGapVerdict = false; // ...and whether it divided traffic
  let pending = null; // island being measured along its length
  let misses = 0;

  // The island just ended: judge it by its best (most equal) section. A
  // failed island is demoted — its stations rewritten to the wider channel.
  const finalizePending = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    const near = (list) =>
      list.some((q) => Math.hypot(q[0] - p.mw[0], q[1] - p.mw[1]) < STICKY_RADIUS_M);
    const wasIsland = near(memory.islands);
    const wasOpen = !wasIsland && near(memory.nonIslands);
    const ratioThr = wasIsland ? STICKY_RATIO : wasOpen ? NONSTICKY_RATIO : EQUAL_CHANNEL_RATIO;
    const centeredThr = wasIsland ? STICKY_CENTERED_F : wasOpen ? NONSTICKY_CENTERED_F : ISLAND_CENTERED_F;
    if (globalThis.__COURSE_DEBUG) {
      globalThis.__COURSE_DEBUG.push({
        at: p.mw.slice(),
        stations: p.chans.length,
        bestRatio: p.bestRatio,
        bestOff: p.bestOff,
        verdict: p.bestRatio >= ratioThr && p.bestOff <= centeredThr,
      });
    }
    if (p.bestRatio >= ratioThr && p.bestOff <= centeredThr) {
      memory.islandsOut.push(p.mw);
      return;
    }
    memory.nonIslandsOut.push(p.mw);
    let wA = 0, wB = 0;
    for (const ch of p.chans) {
      wA += Math.hypot(ch.aW[1][0] - ch.aW[0][0], ch.aW[1][1] - ch.aW[0][1]);
      wB += Math.hypot(ch.bW[1][0] - ch.bW[0][0], ch.bW[1][1] - ch.bW[0][1]);
    }
    const side = wA >= wB ? 'aW' : 'bW';
    for (const ch of p.chans) {
      const st = stations[ch.idx];
      if (!st || !st.island) continue;
      const [p0, p1] = ch[side];
      st.r = p0.slice();
      st.l = p1.slice();
      st.c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      st.island = false;
    }
  };

  for (let dist = 0; dist <= maxDist; dist += STEP_M) {
    const nx = -dy, ny = dx; // probe axis: port side is +s
    // Probe a hair ahead of the station: a probe exactly through a ring vertex
    // (common with grid-aligned geometry) breaks crossing parity.
    const spans = crossSectionSpans(rings, px + dx * 0.0137, py + dy * 0.0137, nx, ny);
    let span = null;
    let rawSpan = null; // the true waterline extent — what gets drawn
    let islandMid = null; // divider position when an island splits the lanes
    let islandGap = null; // the island's own lateral extent
    let steer = null; // lateral position the march itself follows

    if (prevBanks == null) {
      // First station: the span under the boat, or the nearest one within
      // GPS-scatter distance of it.
      let bd = OFF_WATER_TOL_M;
      for (const sp of spans) {
        const d = Math.max(sp[0], -sp[1], 0); // distance from s=0 to the span
        if (d < bd) { bd = d; span = sp; }
        if (d === 0) break;
      }
      // A start beside a junction mouth or on open water sees a huge span;
      // the course only makes sense within river-ish reach of the boat.
      if (span) {
        span = [Math.max(span[0], -MAX_HALF_W), Math.min(span[1], MAX_HALF_W)];
        rawSpan = span;
      }
    } else {
      // Continuation: candidate spans laterally overlapping the previous
      // station, widest first.
      const sL = (prevBanks[0][0] - px) * nx + (prevBanks[0][1] - py) * ny;
      const sR = (prevBanks[1][0] - px) * nx + (prevBanks[1][1] - py) * ny;
      const lo = Math.min(sL, sR), hi = Math.max(sL, sR);
      // Overlap with the previous station's (growth-clamped) extent is what
      // keeps the march off parallel waterways across dry land: a span in the
      // window is continuous water, however far it sits from the march line —
      // an island's far channel must not be filtered by lateral distance.
      const cand = [];
      for (const sp of spans) {
        if (sp[1] < lo || sp[0] > hi) continue;
        cand.push(sp);
      }
      cand.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      // Island split. Channels of similar width are one lane each: the outer
      // shores stay the banks and the island itself becomes the divider. A
      // clearly narrower side is a back-channel: the two-lane course lives in
      // the wider span alone (the island is then the wider lane's bank).
      // An island is judged on its WHOLE length, not its tip (where the
      // second channel has barely opened): a fresh central-ish split enters
      // island mode tentatively while both channels are measured; when the
      // island ends, the best (most equal) section decides, and a failed
      // island is demoted — its stations rewritten to the wider channel.
      if (cand.length >= 2) {
        const [a, b] = cand[0][0] < cand[1][0] ? [cand[0], cand[1]] : [cand[1], cand[0]];
        const mid = (a[1] + b[0]) / 2; // centre of the land between the lanes
        const mw = [px + mid * nx, py + mid * ny];
        const continues =
          prevGap &&
          (() => {
            const p0 = (prevGap[0][0] - px) * nx + (prevGap[0][1] - py) * ny;
            const p1 = (prevGap[1][0] - px) * nx + (prevGap[1][1] - py) * ny;
            return Math.max(a[1], Math.min(p0, p1)) <= Math.min(b[0], Math.max(p0, p1));
          })();
        const ratio = Math.min(a[1] - a[0], b[1] - b[0]) / Math.max(a[1] - a[0], b[1] - b[0]);
        const offCentre = Math.abs(mid - (a[0] + b[1]) / 2) / (b[1] - a[0]);
        let island;
        if (continues && pending) {
          island = true; // still measuring this island
        } else if (continues) {
          island = prevGapVerdict; // settled verdict carries along the island
        } else if (ratio >= 0.12 && offCentre <= 0.35) {
          // Plausible enough to measure: tentative island.
          pending = { start: stations.length, chans: [], bestRatio: 0, bestOff: 1, mw };
          island = true;
        } else {
          island = false;
          memory.nonIslandsOut.push(mw);
        }
        if (island && pending) {
          if (ratio > pending.bestRatio) {
            pending.bestRatio = ratio;
            pending.bestOff = offCentre;
          }
          pending.chans.push({
            idx: stations.length, // the station about to be pushed
            aW: [[px + a[0] * nx, py + a[0] * ny], [px + a[1] * nx, py + a[1] * ny]],
            bW: [[px + b[0] * nx, py + b[0] * ny], [px + b[1] * nx, py + b[1] * ny]],
          });
        }
        if (island) {
          span = [a[0], b[1]];
          islandMid = mid;
          islandGap = [a[1], b[0]];
        } else {
          span = cand[0];
        }
        prevGap = [
          [px + a[1] * nx, py + a[1] * ny],
          [px + b[0] * nx, py + b[0] * ny],
        ];
        prevGapVerdict = island;
      } else {
        if (cand.length > 0) span = cand[0];
        prevGap = null;
        finalizePending();
      }
      // The drawn banks are the raw waterline; the GROW clamp below only
      // steadies the marching window, so a junction mouth can't balloon it.
      if (span) {
        rawSpan = span;
        const clamped = [Math.max(span[0], lo - BANK_GROW_M), Math.min(span[1], hi + BANK_GROW_M)];
        if (clamped[1] - clamped[0] < MIN_CHANNEL_W) {
          span = null;
          rawSpan = null;
        } else {
          span = clamped;
          // If the clamp cut the second lane back off, this isn't an island
          // station after all — recentre in the surviving water.
          if (islandMid != null && (islandMid < span[0] + 2 || islandMid > span[1] - 2)) {
            islandMid = null;
            islandGap = null;
            rawSpan = clamped;
          }
        }
      }
    }
    if (!span) {
      // Coast through a couple of bad stations (junction mouths, polygon
      // seams) before declaring the end of the water.
      if (prevBanks == null || ++misses > MAX_MISSES) break;
      px += dx * STEP_M;
      py += dy * STEP_M;
      continue;
    }
    misses = 0;
    if (islandMid == null) finalizePending();

    // Steer by the through-channel: its own state that may only widen
    // THROUGH_GROW_M per step, so a bay opening at full width on one side
    // never bends the march (and with it every cross-section) into itself,
    // while any narrowing snaps it back immediately.
    let tLo = span[0], tHi = span[1];
    if (prevThrough) {
      const pLo = (prevThrough[0][0] - px) * nx + (prevThrough[0][1] - py) * ny;
      const pHi = (prevThrough[1][0] - px) * nx + (prevThrough[1][1] - py) * ny;
      tLo = Math.max(span[0], Math.min(pLo, pHi) - THROUGH_GROW_M);
      tHi = Math.min(span[1], Math.max(pLo, pHi) + THROUGH_GROW_M);
      if (tHi - tLo < MIN_CHANNEL_W) { tLo = span[0]; tHi = span[1]; }
    }
    prevThrough = [[px + tLo * nx, py + tLo * ny], [px + tHi * nx, py + tHi * ny]];
    steer = (tLo + tHi) / 2;

    const mid = islandMid ?? steer;
    const c = [px + mid * nx, py + mid * ny];
    // Drawn banks: the true waterline. The clamped span only feeds the
    // continuation window (prevBanks).
    const l = [px + rawSpan[1] * nx, py + rawSpan[1] * ny];
    const r = [px + rawSpan[0] * nx, py + rawSpan[0] * ny];
    // Island stations pin the divider to the island itself; every other
    // station's divider is recentred later between the smoothed banks
    // (see dividerCenter).
    stations.push({ c, l, r, island: islandMid != null });
    prevBanks = [
      [px + span[1] * nx, py + span[1] * ny],
      [px + span[0] * nx, py + span[0] * ny],
    ];

    // Bend the marching direction toward the centreline, clamped so a noisy
    // station can't fold the trace back on itself.
    if (stations.length >= 2) {
      const a = stations[stations.length - 2].c;
      const vx = c[0] - a[0], vy = c[1] - a[1];
      const len = Math.hypot(vx, vy);
      if (len > 1e-6) {
        const dot = (vx * dx + vy * dy) / len;
        if (dot <= 0) { stations.pop(); break; }
        const turn = Math.atan2((dx * vy - dy * vx) / len, dot);
        const clamped = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, turn));
        const cos = Math.cos(clamped), sin = Math.sin(clamped);
        const ndx = dx * cos - dy * sin;
        const ndy = dx * sin + dy * cos;
        dx = ndx; dy = ndy;
      }
    }
    px = c[0] + dx * STEP_M;
    py = c[1] + dy * STEP_M;
  }
  finalizePending();
  return stations;
}

// A GPS heading is rarely dead along the channel axis, and an oblique first
// cross-section skews the banks and inflates the width. Perpendicular to the
// channel is where a probe sweep around the heading finds its narrowest water
// span — but near a junction a diagonal probe clipping the mouth can fake an
// even narrower one, so the sweep only ranks candidates; the marcher decides.
function axisCandidates(rings, [px, py], dir) {
  const cands = [];
  for (let off = -60; off <= 60; off += 10) {
    const a = (off * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const d = [dir[0] * cos - dir[1] * sin, dir[0] * sin + dir[1] * cos];
    const spans = crossSectionSpans(rings, px + d[0] * 0.0137, py + d[1] * 0.0137, -d[1], d[0]);
    for (const sp of spans) {
      if (sp[0] > OFF_WATER_TOL_M || sp[1] < -OFF_WATER_TOL_M) continue;
      cands.push({ d, w: sp[1] - sp[0] });
      break;
    }
  }
  cands.sort((a, b) => a.w - b.w);
  return cands.length > 0 ? cands.map((c) => c.d) : [dir];
}

const SMOOTH_WINDOW = 8; // ±200 m: the longest bay/tributary mouth the shore
// line will chord straight across

function blur(pts, pinned) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      if (pinned && pinned(i)) continue;
      pts[i] = [
        0.25 * pts[i - 1][0] + 0.5 * pts[i][0] + 0.25 * pts[i + 1][0],
        0.25 * pts[i - 1][1] + 0.5 * pts[i][1] + 0.25 * pts[i + 1][1],
      ];
    }
  }
}

// One shore, smoothed within one regime run: each station's shore point is
// its true waterline point, unless a straight WORLD-SPACE chord between two
// flanking waterline points (up to SMOOTH_WINDOW away each side) crosses this
// station's section closer to the channel — then the chord point wins. That
// bridges bay and tributary mouths with real straight lines over water, while
// a protruding point's own (nearer) waterline always beats any chord, so the
// line can never cross land. World chords make this immune to any wobble in
// the marching centreline.
function smoothSide(stations, pts, runStart, runEnd, out) {
  // A chord may only bridge a POCKET — shore receding decisively behind it
  // (a bay or tributary mouth, depth ≥ ~a quarter of the mouth). A gradual
  // widening is part of the river and the shore line must follow it.
  const chordOK = new Map();
  const pocketBehind = (j, k) => {
    const key = j * 100000 + k;
    let v = chordOK.get(key);
    if (v !== undefined) return v;
    const ax = pts[j][0], ay = pts[j][1];
    let bx = pts[k][0] - ax, by = pts[k][1] - ay;
    const clen = Math.hypot(bx, by);
    v = false;
    if (clen > 1e-6) {
      bx /= clen; by /= clen;
      let depth = 0;
      for (let m = j + 1; m < k; m++) {
        const off = -(pts[m][0] - ax) * by + (pts[m][1] - ay) * bx;
        const cOff = -(stations[m].c[0] - ax) * by + (stations[m].c[1] - ay) * bx;
        if (off * cOff < 0 && Math.abs(off) > depth) depth = Math.abs(off);
      }
      v = depth >= Math.max(10, 0.25 * clen);
    }
    chordOK.set(key, v);
    return v;
  };
  for (let i = runStart; i <= runEnd; i++) {
    const st = stations[i];
    const p = pts[i];
    let dirX = p[0] - st.c[0], dirY = p[1] - st.c[1];
    const dlen = Math.hypot(dirX, dirY);
    if (dlen < 1e-6) { out[i] = p.slice(); continue; }
    dirX /= dlen; dirY /= dlen;
    let bestS = dlen;
    let bestPt = p;
    const jLo = Math.max(runStart, i - SMOOTH_WINDOW);
    const kHi = Math.min(runEnd, i + SMOOTH_WINDOW);
    for (let j = jLo; j < i; j++) {
      for (let k = i + 1; k <= kHi; k++) {
        const ax = pts[j][0], ay = pts[j][1];
        const bx = pts[k][0] - ax, by = pts[k][1] - ay;
        const det = bx * dirY - by * dirX;
        if (Math.abs(det) < 1e-9) continue;
        const fx = ax - st.c[0], fy = ay - st.c[1];
        const t = (dirX * fy - dirY * fx) / det;
        if (t < 0 || t > 1) continue;
        const s = (bx * fy - by * fx) / det;
        if (s >= 0 && s < bestS && pocketBehind(j, k)) {
          bestS = s;
          bestPt = [ax + t * bx, ay + t * by];
        }
      }
    }
    out[i] = bestPt.slice();
  }
}

// One or two stations whose bank sits far closer to the channel than the
// stations flanking them are a measurement artefact (a bridge pier, a shoal
// sliver, an odd section) — bridge them, or they would anchor chords and tent
// the shore into open water.
const LONE_DIP_M = 15;
function despike(pts, stations) {
  const hw = pts.map((p, i) =>
    Math.hypot(p[0] - stations[i].c[0], p[1] - stations[i].c[1])
  );
  const out = pts.map((p) => p.slice());
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 1; i < pts.length - 1; i++) {
    if (hw[i] < Math.min(hw[i - 1], hw[i + 1]) - LONE_DIP_M) {
      out[i] = lerp(pts[i - 1], pts[i + 1], 0.5);
    } else if (
      i + 2 < pts.length &&
      Math.max(hw[i], hw[i + 1]) < Math.min(hw[i - 1], hw[i + 2]) - LONE_DIP_M
    ) {
      out[i] = lerp(pts[i - 1], pts[i + 2], 1 / 3);
      out[i + 1] = lerp(pts[i - 1], pts[i + 2], 2 / 3);
      i++;
    }
  }
  return out;
}

// The drawn course: both shores follow the true waterline except across bay
// and tributary mouths, which they chord straight over (still water); the
// divider is the world midpoint between the two shore points, pinned to the
// island where one divides the lanes. Smoothing runs within stretches of one
// regime (island / no island) so a chord can never bridge across an island.
function smoothCourse(stations) {
  const n = stations.length;
  const rawL = despike(stations.map((s) => s.l), stations);
  const rawR = despike(stations.map((s) => s.r), stations);
  const left = rawL.map((p) => p.slice());
  const right = rawR.map((p) => p.slice());
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || stations[i].island !== stations[runStart].island) {
      smoothSide(stations, rawL, runStart, i - 1, left);
      smoothSide(stations, rawR, runStart, i - 1, right);
      runStart = i;
    }
  }
  const center = stations.map((st, i) =>
    st.island
      ? st.c.slice()
      : [(left[i][0] + right[i][0]) / 2, (left[i][1] + right[i][1]) / 2]
  );
  // Only the divider gets blurred — it lives mid-water, where drifting a few
  // metres is harmless; the shores must stay on the waterline.
  blur(center, (i) => stations[i].island);
  return { left, right, center };
}

function makeMemory(water, prevMemory) {
  const toXY = ([la, lo]) => water.frame.toXY(la, lo);
  return {
    islands: (prevMemory?.islands ?? []).map(toXY),
    nonIslands: (prevMemory?.nonIslands ?? []).map(toXY),
    islandsOut: [],
    nonIslandsOut: [],
  };
}

// Polylines + a portable station list (lat/lon, so it survives moving between
// fetch cells) + the split classifications for hysteresis.
function buildResult(water, stationsXY, memory, trimmed = false) {
  if (stationsXY.length < 6) return null;
  const ll = (p) => water.frame.toLatLon(p);
  const sm = smoothCourse(stationsXY);
  return {
    center: sm.center.map(ll),
    left: sm.left.map(ll),
    right: sm.right.map(ll),
    stations: stationsXY.map((s) => ({ c: ll(s.c), l: ll(s.l), r: ll(s.r), island: !!s.island })),
    memory: {
      islands: memory.islandsOut.map(ll),
      nonIslands: memory.nonIslandsOut.map(ll),
    },
    trimmed,
  };
}

// The course through the water around a fix, traced TRACE_M both ways:
// `center` is the divider, `left`/`right` the smoothed shores, each as
// [lat, lon] arrays ready for a Leaflet polyline. The caller keeps the result
// and only calls extendCourse as the boat nears an end — the geometry itself
// never shifts underfoot. Null when the fix isn't on mapped water or has no
// heading.
export function traceCourse(water, lat, lon, headingDeg, prevMemory = null) {
  if (headingDeg == null || !water || water.rings.length === 0) return null;
  const start = water.frame.toXY(lat, lon);
  const th = (headingDeg * Math.PI) / 180;
  const dir = [Math.sin(th), Math.cos(th)]; // x east, y north
  const memory = makeMemory(water, prevMemory);

  // Best-ranked axis whose march actually travels; a corner-clipped fake axis
  // dies within a few stations and the next candidate takes over.
  let axis = dir, fwd = [], fwdOuts = [[], []];
  for (const d of axisCandidates(water.rings, start, dir).slice(0, 5)) {
    memory.islandsOut = [];
    memory.nonIslandsOut = [];
    const m = march(water.rings, start, d, TRACE_M, memory);
    if (m.length > fwd.length) {
      fwd = m; axis = d;
      fwdOuts = [memory.islandsOut, memory.nonIslandsOut];
    }
    if (m.length >= 8) break;
  }
  if (fwd.length < 2) return null;
  [memory.islandsOut, memory.nonIslandsOut] = fwdOuts;
  const back = march(water.rings, start, [-axis[0], -axis[1]], TRACE_M, memory);
  // The reverse trace runs stern-ward: flip its order and swap its banks.
  let stations = [
    ...back.slice(1).reverse().map((s) => ({ ...s, l: s.r, r: s.l })),
    ...fwd,
  ];
  // A trace seeded BESIDE an island only sees the channel the boat is in —
  // splits are recognised marching into them lengthwise. Re-march the whole
  // stretch from the tail end (2 km away), so every feature, including one
  // right at the seed, is approached properly.
  if (stations.length >= 3) {
    const c0 = stations[0].c, c1 = stations[1].c;
    let ddx = c1[0] - c0[0], ddy = c1[1] - c0[1];
    const dl = Math.hypot(ddx, ddy);
    if (dl > 1e-6) {
      memory.islandsOut = [];
      memory.nonIslandsOut = [];
      const redo = march(
        water.rings,
        c0,
        [ddx / dl, ddy / dl],
        (stations.length + 4) * STEP_M,
        memory
      );
      if (redo.length >= Math.min(stations.length, 8)) stations = redo;
    }
  }
  // A stub of a few stations is noise (a GPS fix in the reeds, a pond edge),
  // not a rowable course — show nothing rather than a confusing squiggle.
  return buildResult(water, stations, memory);
}

// Continues an existing course EXTEND_M past one end ('ahead' = the last
// station, 'behind' = the first). `water` must cover that end — fetch the
// cell of a point just beyond it. Returns the full rebuilt course, or null
// when the water genuinely stops there. Existing geometry is preserved; only
// the far end (off screen) gains stations, and past `maxStations` the
// opposite end is trimmed (review maps covering a long recording raise the
// cap; live maps keep the default).
export function extendCourse(water, stationsLatLon, end, prevMemory = null, maxStations = MAX_STATIONS) {
  if (!water || water.rings.length === 0 || stationsLatLon.length < 2) return null;
  const toXY = ([la, lo]) => water.frame.toXY(la, lo);
  const sts = stationsLatLon.map((s) => ({
    c: toXY(s.c), l: toXY(s.l), r: toXY(s.r), island: !!s.island,
  }));
  const memory = makeMemory(water, prevMemory);
  const ahead = end === 'ahead';
  const tip = ahead ? sts[sts.length - 1] : sts[0];
  const prev = ahead ? sts[sts.length - 2] : sts[1];
  let dx = tip.c[0] - prev.c[0], dy = tip.c[1] - prev.c[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  dx /= len; dy /= len;
  const startPos = [tip.c[0] + dx * STEP_M, tip.c[1] + dy * STEP_M];
  // Marching stern-ward flips port/starboard, both in the seed banks and in
  // the stations that come back.
  const initBanks = ahead ? [tip.l, tip.r] : [tip.r, tip.l];
  const ext = march(water.rings, startPos, [dx, dy], EXTEND_M, memory, initBanks);
  if (ext.length === 0) return null;
  let all = ahead
    ? sts.concat(ext)
    : ext.map((s) => ({ ...s, l: s.r, r: s.l })).reverse().concat(sts);
  let trimmed = false;
  if (all.length > maxStations) {
    trimmed = true;
    all = ahead ? all.slice(all.length - maxStations) : all.slice(0, maxStations);
  }
  return buildResult(water, all, memory, trimmed);
}
