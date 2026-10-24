// Stroke-detection signal pipeline, extracted from LiveCapture so the live
// capture path AND the offline video analyzer can derive identical strokes from
// the same raw samples. Everything here is pure (no React refs, no DOM): the
// per-sample engine (`feedSample`) mutates a plain `proc` state object, and
// `deriveStrokes` replays a whole recording through it.

import referenceCurveData from '../data/referenceCurve.json';

// --- Constants ---
export const NUM_POINTS = 33;
const MIN_STROKE_MS = 800;
const MAX_STROKE_MS = 4000;
const AVG_WINDOW_STROKES = 500;   // live rolling average spans the most recent N strokes

// --- Unified boat-speed signal (the single source of truth) ---
// One continuous surge-speed signal drives the rolling graph, catch detection,
// stroke rate, split, and free speed. See streamSurge / feedSample.
//   rel  = integrated surge accel with a high-pass baseline removed (drift-free,
//          relative m/s about the local mean) — this IS the rolling-graph trace.
//   abs  = rel + a slowly-varying GPS-anchored level (absolute instantaneous m/s).
// Adding the slow `level` cannot move a local minimum's location, so catch
// detection is identical with or without GPS, and the graph shape never changes.
export const SURGE_HP_TAU_S = 5;   // drift high-pass time constant (s; > a stroke period)
const GPS_LEVEL_TAU_S = 12;        // slow GPS absolute-level anchor (> SURGE_HP_TAU_S ⇒ low-freq only)
const GPS_STALE_MS = 3000;         // ignore a GPS fix older than this when anchoring `now`
const VSMOOTH_TAU_S = 0.20;        // ~200 ms detection smoother — kills accel noise, keeps the catch dip
const CATCH_PROMINENCE = 0.15;     // m/s peak↔valley hysteresis for a real catch (tune on real data)
const BUF_RETAIN_MS = 10000;       // rolling speed buffer kept for the live graph + stroke means
const CATCH_LOOKBACK_MS = 600;     // the smoothed valley lags the true speed minimum; search back this far
export const CALIBRATION_MS = 6000; // Auto-orientation calibration window (> 1 stroke, so the bow sign reads)
// --- Bow/stern sign evidence (see skewness / updateSignEvidence) ---
const SIGN_SMOOTH_TAU_S = 0.05;    // ~3 Hz smoother on the surge projection before the skewness
const SIGN_EVIDENCE_TAU_S = 15;    // running-moment window for the skewness evidence
const SIGN_MIN_WEIGHT_S = 8;       // no sign opinion until this much motion has been seen
const SIGN_MIN_SKEW = 0.5;         // |skew| below this is too weak to act on
const SIGN_FLIP_HOLD_MS = 5000;    // opposite evidence must persist this long before the sign flips
const ORIENT_WINDOW_MS = 5000;    // rolling window for the direction estimate (a stroke+)
const ORIENT_REEVAL_MS = 1000;    // recompute the motion direction at most this often
const ORIENT_SWITCH_MS = 2500;    // a remount must persist this long before we snap to it
const ORIENT_SWITCH_DEG = 35;     // direction jump beyond this = remount, not drift
const ORIENT_MIN_VAR = 0.5;       // below this variance = no real motion; don't update
export const SPLIT_WINDOW_MS = 5000; // smoothed GPS window for the rowing-band gate / active indicator
// Rowing happens only within this 500m-split band (4:00 .. 1:00 per 500m).
export const MIN_ROW_SPEED = 500 / 240;  // 2.08 m/s — a 4:00 /500m split
export const MAX_ROW_SPEED = 500 / 60;   // 8.33 m/s — a 1:00 /500m split

export const REF_SPEEDS = referenceCurveData.speeds;
export const REF_AVG = REF_SPEEDS.reduce((a, b) => a + b, 0) / REF_SPEEDS.length;
export const PHASE_TIMES = Array.from({ length: NUM_POINTS }, (_, i) => i / (NUM_POINTS - 1));

// --- Signal processing (pure) ---

export function resample(times, values, n) {
  if (times.length < 2) return new Array(n).fill(0);
  const t0 = times[0], t1 = times[times.length - 1];
  const dur = t1 - t0;
  if (dur <= 0) return new Array(n).fill(values[0] || 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + dur * i / (n - 1);
    let j = 0;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const dt = times[j + 1] - times[j];
    const frac = dt > 0 ? (t - times[j]) / dt : 0;
    out.push(values[j] + frac * (values[j + 1] - values[j]));
  }
  return out;
}

// Gravity vector in the device frame from the orientation angles — the same
// model subtractGravity uses. Fallback for attitude tracking when the device
// doesn't report both acceleration variants.
export function gravityFromAngles(beta, gamma) {
  const G = 9.81;
  const betaRad = (beta ?? 0) * Math.PI / 180;
  const gammaRad = (gamma ?? 0) * Math.PI / 180;
  return {
    x: G * Math.sin(gammaRad),
    y: G * Math.sin(betaRad) * Math.cos(gammaRad),
    z: G * Math.cos(betaRad) * Math.cos(gammaRad),
  };
}

export function subtractGravity(accelIncGravity, beta, gamma) {
  const g = gravityFromAngles(beta, gamma);
  return {
    x: (accelIncGravity.x ?? 0) - g.x,
    y: (accelIncGravity.y ?? 0) - g.y,
    z: (accelIncGravity.z ?? 0) - g.z,
  };
}

export function variance(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

// Skewness of a sample set. This is the bow/stern tell-tale: a boat's surge
// acceleration is NEGATIVELY skewed along the bow direction — the catch check is
// a sharp, large deceleration spike while the drive is a broader, lower hump
// (Kleshnev's boat-acceleration curves show it in every class; it measures
// −1.0…−1.3 in our recorded rows). The earlier "largest spike = drive = forward"
// rule got this backwards, inverting every curve.
export function skewness(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;
  let v = 0, c = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - m; v += d * d; c += d * d * d; }
  v /= n; c /= n;
  return v > 1e-12 ? c / Math.pow(v, 1.5) : 0;
}

// Identify the boat's fore-aft (surge) direction as a free 3D unit vector: the
// principal axis of the acceleration cloud — power-iterated dominant eigenvector
// of the 3×3 covariance. The sign (which way is the bow): with `warm` (the
// previous direction) the result is kept continuous with it, so re-estimation
// can never flip the axis — only the skewness evidence (updateSignEvidence) or
// the user does that. Without `warm` (first calibration, offline whole-recording
// estimate) the sign is chosen so the projected acceleration is negatively
// skewed (catch spike pointing sternward).
export function principalDirection(x, y, z, warm) {
  const n = x.length;
  if (n < 2) return null;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; mz += z[i]; }
  mx /= n; my /= n; mz /= n;
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my, dz = z[i] - mz;
    cxx += dx * dx; cyy += dy * dy; czz += dz * dz;
    cxy += dx * dy; cxz += dx * dz; cyz += dy * dz;
  }
  cxx /= n; cyy /= n; czz /= n; cxy /= n; cxz /= n; cyz /= n;
  let vx = warm?.x ?? 1, vy = warm?.y ?? 0, vz = warm?.z ?? 0;
  let lambda = 0;
  for (let it = 0; it < 24; it++) {
    const nx = cxx * vx + cxy * vy + cxz * vz;
    const ny = cxy * vx + cyy * vy + cyz * vz;
    const nz = cxz * vx + cyz * vy + czz * vz;
    const mag = Math.hypot(nx, ny, nz);
    if (mag < 1e-12) break;
    vx = nx / mag; vy = ny / mag; vz = nz / mag;
    lambda = mag;
  }
  let flip = false;
  if (warm) {
    flip = vx * warm.x + vy * warm.y + vz * warm.z < 0;
  } else {
    const proj = new Array(n);
    for (let i = 0; i < n; i++) proj[i] = (x[i] - mx) * vx + (y[i] - my) * vy + (z[i] - mz) * vz;
    flip = skewness(proj) > 0;
  }
  if (flip) { vx = -vx; vy = -vy; vz = -vz; }
  return { dir: { x: vx, y: vy, z: vz }, variance: lambda };
}

export function angleBetween(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * 180 / Math.PI;
}

// Interpolated GPS Doppler speed (m/s) at time `now` from the recent GPS window,
// or null when there's no usable recent fix. Used to anchor the absolute level of
// the fused speed signal. A fix older than GPS_STALE_MS is treated as no anchor so
// a dropped GPS freezes (rather than corrupts) the level.
export function latestGpsSpeed(gpsSpeeds, now) {
  if (!gpsSpeeds || gpsSpeeds.length === 0) return null;
  let prev = null, next = null;
  for (const g of gpsSpeeds) {
    if (g.speed == null || g.speed < 0) continue;
    if (g.time <= now) { if (!prev || g.time > prev.time) prev = g; }
    else if (!next || g.time < next.time) next = g;
  }
  if (!prev) return null;
  if (now - prev.time > GPS_STALE_MS) return null;
  if (next && next.time > prev.time) {
    const f = (now - prev.time) / (next.time - prev.time);
    return prev.speed + f * (next.speed - prev.speed);
  }
  return prev.speed;
}

// One step of the unified surge-speed recursion. Mutates a plain state object
// `{ v, base, level, prevT }` and returns { rel, abs, dt }. `raw` is the surge
// acceleration (already projected onto the fore-aft axis). `gpsNow` is the
// interpolated GPS speed at `now`, or null to run IMU-only (no absolute anchor).
//
// With gpsNow omitted this is byte-for-byte the recursion deriveSpeedSeries has
// always used (v integrated, base a 5 s high-pass, rel = v − base), so the
// rolling graph is unchanged. gpsNow only sets the slow additive `level`.
export function surgeStep(st, raw, now, gpsNow) {
  const dt = st.prevT == null ? 0 : (now - st.prevT) / 1000;
  st.prevT = now;
  if (dt > 0 && dt <= 1) {
    st.v += raw * dt;
    st.base += (1 - Math.exp(-dt / SURGE_HP_TAU_S)) * (st.v - st.base);
  }
  const rel = st.v - st.base;
  if (gpsNow != null && gpsNow > 0 && gpsNow < MAX_ROW_SPEED) {
    if (st.level == null) st.level = gpsNow - rel;                 // seed on first lock
    else if (dt > 0 && dt <= 1) {
      st.level += (1 - Math.exp(-dt / GPS_LEVEL_TAU_S)) * ((gpsNow - rel) - st.level);
    }
  }
  const abs = st.level == null ? null : rel + st.level;
  return { rel, abs, dt };
}

export function windowedGpsSpeed(gpsSpeeds, endTime, windowMs) {
  const start = endTime - windowMs;
  let sum = 0, n = 0;
  for (const g of gpsSpeeds) {
    if (g.time >= start && g.time <= endTime && g.speed > 0 && g.speed < MAX_ROW_SPEED) {
      sum += g.speed;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

export function averageCurves(strokes) {
  if (strokes.length === 0) return null;
  const avg = new Array(NUM_POINTS).fill(0);
  for (const s of strokes) {
    const curve = s.curve ?? s;
    for (let i = 0; i < NUM_POINTS; i++) avg[i] += curve[i];
  }
  for (let i = 0; i < NUM_POINTS; i++) avg[i] /= strokes.length;
  return avg;
}

export function freeSpeedGain(yourCurve, potentialCurve) {
  if (!yourCurve || yourCurve.length === 0) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const meanCube = (a) => a.reduce((s, v) => s + v * v * v, 0) / a.length;
  const yourPower = meanCube(yourCurve);
  const potPower = meanCube(potentialCurve);
  if (yourPower <= 0 || potPower <= 0) return null;
  const scale = Math.cbrt(yourPower / potPower);
  return scale * mean(potentialCurve) - mean(yourCurve);
}

export function freeSpeedSecondsFor(curve) {
  const gain = freeSpeedGain(curve, REF_SPEEDS);
  if (gain == null || !curve || !curve.length) return null;
  const vYou = curve.reduce((a, b) => a + b, 0) / curve.length;
  const vPot = vYou + gain;
  if (vYou > 0 && vPot > 0) return 2000 / vYou - 2000 / vPot;
  return null;
}

// --- Boat attitude (roll / pitch) tracking ---
// Angles come from the gravity vector (the device fusion's estimate when both
// acceleration variants are present: accelIncludingGravity − linearAccel),
// expressed against the boat frame: pitch tilts gravity toward the surge axis,
// roll toward the sway axis (gravity × surge). Strokes are stamped with the
// p5–p95 swing of each, so the sign conventions cancel out. Validated against a
// real session: uncorrelated with the surge signal (r ≈ −0.07), so this reads
// boat attitude, not stroke acceleration.
const ATT_LP_ALPHA = 0.18;    // ~2 Hz low-pass at ~60 Hz — kills mount vibration
const ATT_REF_ALPHA = 0.0006; // ~30 s reference frame for the sway axis

function updateAttitude(proc, gravity, now) {
  const att = proc.att;
  if (!att.gLP) {
    att.gLP = { ...gravity };
    att.gSlow = { ...gravity };
    return;
  }
  att.gLP.x += ATT_LP_ALPHA * (gravity.x - att.gLP.x);
  att.gLP.y += ATT_LP_ALPHA * (gravity.y - att.gLP.y);
  att.gLP.z += ATT_LP_ALPHA * (gravity.z - att.gLP.z);
  att.gSlow.x += ATT_REF_ALPHA * (gravity.x - att.gSlow.x);
  att.gSlow.y += ATT_REF_ALPHA * (gravity.y - att.gSlow.y);
  att.gSlow.z += ATT_REF_ALPHA * (gravity.z - att.gSlow.z);

  const d = proc.direction;
  const gs = att.gSlow;
  let wx = gs.y * d.z - gs.z * d.y;
  let wy = gs.z * d.x - gs.x * d.z;
  let wz = gs.x * d.y - gs.y * d.x;
  const wm = Math.hypot(wx, wy, wz);
  const g = att.gLP;
  const gm = Math.hypot(g.x, g.y, g.z);
  if (wm < 1e-6 || gm < 1e-6) return;
  wx /= wm; wy /= wm; wz /= wm;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const pitch = Math.asin(clamp((g.x * d.x + g.y * d.y + g.z * d.z) / gm)) * 180 / Math.PI;
  const roll = Math.asin(clamp((g.x * wx + g.y * wy + g.z * wz) / gm)) * 180 / Math.PI;
  att.buf.push({ time: now, roll, pitch });
}

// p5–p95 swing of roll and pitch over a stroke's samples, or null when the
// stroke has too few attitude samples to be meaningful.
function strokeAttitudeSwing(buf, t0, t1) {
  const roll = [], pitch = [];
  for (const s of buf) {
    if (s.time >= t0 && s.time <= t1) { roll.push(s.roll); pitch.push(s.pitch); }
  }
  if (roll.length < 10) return null;
  const swing = (vals) => {
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length * 0.95)] - vals[Math.floor(vals.length * 0.05)];
  };
  return { roll: swing(roll), pitch: swing(pitch) };
}

// --- Processing engine ---

// A fresh processing pipeline. `startTime` null → set from the first sample, so
// coach-side / replay calibration spans the right window.
export function makeProc(startTime) {
  return {
    // Unified surge-speed signal state. `speed` runs the recursion (surgeStep) and
    // keeps a rolling buffer of {t, rel, abs} for the live graph + stroke means.
    // `catch` is the local-minimum (catch) detector run on the smoothed speed.
    speed: { v: 0, base: 0, level: null, prevT: null, vSmooth: null, buf: [] },
    catch: { mode: 'seekMin', ext: Infinity, extT: 0 },
    lastBoundaryTime: 0,
    boundaryTimes: [],
    strokes: [],
    strokeCount: 0,
    strokeRate: 0,
    lastStroke: null,
    lastGpsSpeed: null,
    avgCurve: null,
    hasGPS: false,
    lastSampleTime: 0,
    // Boat fore-aft direction (unit vector). Default points along +y until
    // calibration locks it; only read after calibration completes.
    direction: { x: 0, y: 1, z: 0 },
    calibration: { startTime, samples: { x: [], y: [], z: [] }, done: false },
    orient: { window: [], lastEval: 0, pending: null, pendingSince: 0 },
    // Bow/stern sign evidence: running moments of the smoothed surge projection
    // (skewness), when opposite evidence started, and whether the user has
    // pinned the sign by hand (which disables automatic flipping).
    sign: { p: null, m1: 0, m2: 0, m3: 0, w: 0, prevT: null, opposeSince: 0, skew: 0, locked: false },
    // Boat attitude tracking (roll/pitch from the gravity vector, when fed).
    att: { gLP: null, gSlow: null, buf: [] },
    // Set true by feedSample on a remount snap so the caller can re-send the new
    // direction to a linked coach. The caller clears it.
    remounted: false,
  };
}

// Restart the speed integrator and catch detector at `now` (after the surge axis
// changed: a remount snap or a bow/stern flip) so the new axis doesn't inherit a
// jump; the rolling buffer is cleared and the next sample sees dt = 0.
function resetSpeedState(proc, now) {
  proc.speed = { v: 0, base: 0, level: null, vSmooth: null, prevT: now, buf: [] };
  proc.catch = { mode: 'seekMin', ext: Infinity, extT: now };
  proc.lastBoundaryTime = now;
  proc.remounted = true; // caller re-sends direction to a linked coach
}

// Negate the bow direction. Used by the automatic evidence flip and by the
// user's manual flip (which also pins the sign for the rest of the capture).
export function flipDirection(proc, now = proc.lastSampleTime, { lock = false } = {}) {
  const d = proc.direction;
  proc.direction = { x: -d.x, y: -d.y, z: -d.z };
  proc.sign.m1 = -proc.sign.m1; proc.sign.m3 = -proc.sign.m3; proc.sign.skew = -proc.sign.skew;
  proc.sign.p = proc.sign.p == null ? null : -proc.sign.p;
  proc.sign.opposeSince = 0;
  if (lock) proc.sign.locked = true;
  resetSpeedState(proc, now);
}

// Adopt a direction sent by the other end of a link (the rower's calibrated or
// re-read axis). The local sign evidence was about the old axis, so it starts
// over — otherwise a coach whose own evidence was mid-way to flipping would
// flip again after adopting the rower's already-flipped axis and end up
// inverted. A hand-pinned sign (locked) keeps its side: the axis is adopted,
// the sign stays continuous with the current one.
export function adoptDirection(proc, dir, now = proc.lastSampleTime) {
  if (!dir) return;
  let next = { x: dir.x, y: dir.y, z: dir.z };
  const cur = proc.direction;
  let dot = next.x * cur.x + next.y * cur.y + next.z * cur.z;
  if (proc.sign.locked && dot < 0) { next = { x: -next.x, y: -next.y, z: -next.z }; dot = -dot; }
  // A sign flip (dot ≈ −1) or an axis jump both leave the integrator with a jump to inherit.
  const changed = proc.calibration.done && dot < Math.cos(ORIENT_SWITCH_DEG * Math.PI / 180);
  proc.direction = next;
  proc.calibration.done = true;
  proc.sign = { ...proc.sign, p: null, m1: 0, m2: 0, m3: 0, w: 0, prevT: null, opposeSince: 0, skew: 0 };
  if (changed) resetSpeedState(proc, now);
}

// Accumulate bow/stern evidence from the signed surge projection `raw` and flip
// the direction when the evidence says the bow is the other way. Skewness is
// taken on a ~3 Hz-smoothed projection (vibration is symmetric noise that only
// dilutes it) over a ~15 s running window; it must sit beyond ±SIGN_MIN_SKEW on
// the wrong side for SIGN_FLIP_HOLD_MS before anything happens. On 4 recorded
// rows this rule reads the right sign in 99–100% of 8 s windows while rowing;
// its rare misses are at rest / handling, which `moving` gates out.
function updateSignEvidence(proc, raw, now, moving) {
  const sg = proc.sign;
  const dt = sg.prevT == null ? 0 : (now - sg.prevT) / 1000;
  sg.prevT = now;
  if (sg.p == null) { sg.p = raw; return false; }
  if (!(dt > 0 && dt <= 1)) return false;
  sg.p += (1 - Math.exp(-dt / SIGN_SMOOTH_TAU_S)) * (raw - sg.p);
  if (!moving) return false;
  const k = 1 - Math.exp(-dt / SIGN_EVIDENCE_TAU_S);
  const p = sg.p;
  sg.m1 += k * (p - sg.m1);
  sg.m2 += k * (p * p - sg.m2);
  sg.m3 += k * (p * p * p - sg.m3);
  sg.w = Math.min(sg.w + dt, SIGN_EVIDENCE_TAU_S * 4);
  const variance = sg.m2 - sg.m1 * sg.m1;
  if (sg.w < SIGN_MIN_WEIGHT_S || variance < ORIENT_MIN_VAR) { sg.opposeSince = 0; return false; }
  const third = sg.m3 - 3 * sg.m1 * sg.m2 + 2 * sg.m1 ** 3;
  sg.skew = third / Math.pow(variance, 1.5);
  if (sg.locked) return false;
  // Negative skew along the bow is right; a positive one says we're pointing at the stern.
  if (sg.skew > SIGN_MIN_SKEW) {
    if (!sg.opposeSince) sg.opposeSince = now;
    else if (now - sg.opposeSince >= SIGN_FLIP_HOLD_MS) { flipDirection(proc, now); return true; }
  } else {
    sg.opposeSince = 0;
  }
  return false;
}

// Feed one gravity-compensated acceleration sample into the pipeline. Mutates
// `proc` (calibration, orientation tracking, stroke detection, the strokes
// array). Returns the newly completed stroke object, or null. `gpsSpeeds` is the
// recent GPS-speed window (in the same time domain as `now`). `allowWithoutGps`
// records strokes even when no GPS is present (replay / coach-fed data); live
// capture passes false so GPS is required to record.
// `gravity` (optional vector) feeds roll/pitch tracking — pass the device's
// gravity estimate (accelIncludingGravity − linearAccel) when available.
export function feedSample(proc, accelValues, now, gpsSpeeds, { allowWithoutGps = false, gravity = null } = {}) {
  // --- Auto-orientation calibration ---
  if (!proc.calibration.done) {
    proc.calibration.samples.x.push(accelValues.x ?? 0);
    proc.calibration.samples.y.push(accelValues.y ?? 0);
    proc.calibration.samples.z.push(accelValues.z ?? 0);

    if (now - proc.calibration.startTime >= CALIBRATION_MS) {
      const c = proc.calibration.samples;
      const pd = principalDirection(c.x, c.y, c.z);
      if (!pd || pd.variance < ORIENT_MIN_VAR) {
        proc.calibration.startTime = now;
        proc.calibration.samples = { x: [], y: [], z: [] };
        return null;
      }
      proc.direction = pd.dir;
      proc.calibration.done = true;
    }
    return null; // Don't process strokes during calibration
  }

  proc.lastSampleTime = now;

  if (gravity) updateAttitude(proc, gravity, now);

  // --- Continuous orientation tracking ---
  const ori = proc.orient;
  ori.window.push({
    t: now,
    x: accelValues.x ?? 0,
    y: accelValues.y ?? 0,
    z: accelValues.z ?? 0,
  });
  const wcut = now - ORIENT_WINDOW_MS;
  while (ori.window.length && ori.window[0].t < wcut) ori.window.shift();

  if (
    now - ori.lastEval >= ORIENT_REEVAL_MS &&
    ori.window.length >= 20 &&
    now - ori.window[0].t >= ORIENT_WINDOW_MS / 2
  ) {
    ori.lastEval = now;
    const w = ori.window;
    const cand = principalDirection(
      w.map(s => s.x), w.map(s => s.y), w.map(s => s.z), proc.direction
    );
    if (cand && cand.variance >= ORIENT_MIN_VAR) {
      const drift = angleBetween(cand.dir, proc.direction);
      if (drift < ORIENT_SWITCH_DEG) {
        proc.direction = cand.dir;
        ori.pending = null;
      } else {
        const samePending = ori.pending && angleBetween(cand.dir, ori.pending) < ORIENT_SWITCH_DEG / 2;
        if (samePending && now - ori.pendingSince >= ORIENT_SWITCH_MS) {
          // A remount is a new axis; the bow sign on it is re-read from the
          // skewness of the window (there is no continuity to keep).
          proc.direction = principalDirection(
            w.map(s => s.x), w.map(s => s.y), w.map(s => s.z)
          )?.dir ?? cand.dir;
          ori.pending = null;
          // Old sign evidence was about the old axis — start over (keep a user lock).
          proc.sign = { ...proc.sign, p: null, m1: 0, m2: 0, m3: 0, w: 0, prevT: null, opposeSince: 0, skew: 0 };
          resetSpeedState(proc, now);
        } else if (!samePending) {
          ori.pending = cand.dir;
          ori.pendingSince = now;
        }
      }
    }
  }

  let d = proc.direction;
  let raw = (accelValues.x ?? 0) * d.x + (accelValues.y ?? 0) * d.y + (accelValues.z ?? 0) * d.z;

  // --- Bow/stern sign: flip the axis when the acceleration skewness says the
  // "bow" is really the stern. Gated on real boat motion (rowing-band GPS when
  // GPS is present; otherwise the orientation tracker's variance gate). ---
  const gpsNow = latestGpsSpeed(gpsSpeeds, now);
  const hasGpsNow = gpsSpeeds && gpsSpeeds.length > 0;
  const moving = hasGpsNow
    ? (gpsNow != null && gpsNow >= MIN_ROW_SPEED && gpsNow <= MAX_ROW_SPEED)
    : true;
  if (updateSignEvidence(proc, raw, now, moving)) {
    d = proc.direction;
    raw = -raw;
  }

  // --- Unified surge-speed signal (rolling graph + detection + split share this) ---
  const sp = proc.speed;
  const { rel, abs, dt } = surgeStep(sp, raw, now, gpsNow);
  proc.hasGPS = sp.level != null;                     // absolute anchor achieved
  sp.buf.push({ t: now, rel, abs });
  const bcut = now - BUF_RETAIN_MS;
  while (sp.buf.length && sp.buf[0].t < bcut) sp.buf.shift();

  // Smooth the relative signal for a stable minima detector. Detection runs on
  // `rel` (not `abs`): they differ only by the slow additive level, so their
  // minima coincide — and using `rel` avoids the one-time jump at GPS lock.
  if (sp.vSmooth == null) sp.vSmooth = rel;
  else if (dt > 0 && dt <= 1) sp.vSmooth += (1 - Math.exp(-dt / VSMOOTH_TAU_S)) * (rel - sp.vSmooth);
  const vs = sp.vSmooth;

  // --- Catch detection: the local MINIMUM of boat speed where deceleration turns
  // into acceleration (the boat's slowest point, blades in). An alternating
  // peak/valley tracker with prominence hysteresis. In `seekMin` we follow the
  // descending signal to its lowest point; once it climbs back CATCH_PROMINENCE
  // above that low, the low was a catch — emit it (at the valley's timestamp) and
  // flip to `seekMax`, which mirrors to find the drive/recovery peak before the
  // next descent. Strict alternation ⇒ exactly one catch per stroke cycle. ---
  const cat = proc.catch;
  let isCatch = false;
  let boundaryTime = now;
  if (cat.mode === 'seekMin') {
    if (vs < cat.ext) { cat.ext = vs; cat.extT = now; }
    else if (vs - cat.ext >= CATCH_PROMINENCE) {
      isCatch = true;
      // The valley of the smoothed signal is the catch — but the smoother lags
      // the speed by ~VSMOOTH_TAU_S, so place it at the true minimum of the raw
      // speed just behind the smoothed valley.
      boundaryTime = cat.extT;
      let best = null;
      for (let i = sp.buf.length - 1; i >= 0; i--) {
        const s = sp.buf[i];
        if (s.t > cat.extT) continue;
        if (s.t < cat.extT - CATCH_LOOKBACK_MS) break;
        if (!best || s.rel < best.rel) best = s;
      }
      if (best) boundaryTime = best.t;
      cat.mode = 'seekMax'; cat.ext = vs; cat.extT = now;
    }
  } else {
    if (vs > cat.ext) { cat.ext = vs; cat.extT = now; }
    else if (cat.ext - vs >= CATCH_PROMINENCE) {
      cat.mode = 'seekMin'; cat.ext = vs; cat.extT = now;
    }
  }

  let newStroke = null;

  if (isCatch) {
    const elapsed = boundaryTime - proc.lastBoundaryTime;

    if (elapsed >= MIN_STROKE_MS && elapsed <= MAX_STROKE_MS && proc.lastBoundaryTime > 0) {
      const startTime = proc.lastBoundaryTime;
      // This stroke's slice of the continuous speed signal, catch → catch.
      const seg = sp.buf.filter(s => s.t >= startTime && s.t <= boundaryTime);
      const useAbs = sp.level != null && seg.length > 0 && seg.every(s => s.abs != null);

      if (seg.length >= 2) {
        if (proc.boundaryTimes.length &&
            boundaryTime - proc.boundaryTimes[proc.boundaryTimes.length - 1] > MAX_STROKE_MS) {
          proc.boundaryTimes = [];
        }
        proc.boundaryTimes.push(boundaryTime);
        if (proc.boundaryTimes.length > 10) proc.boundaryTimes.shift();
        if (proc.boundaryTimes.length >= 2) {
          // Stroke rate straight from catch-to-catch intervals.
          const ct = proc.boundaryTimes;
          proc.strokeRate = Math.round(60000 / ((ct[ct.length - 1] - ct[0]) / (ct.length - 1)));
        }

        // Smoothed GPS speed over a multi-second window gates recording on the
        // rowing band (stability: one noisy reading can't flicker strokes in/out).
        const gateSpeed = proc.hasGPS
          ? windowedGpsSpeed(gpsSpeeds, boundaryTime, Math.max(elapsed, SPLIT_WINDOW_MS))
          : null;
        const hasGpsData = gpsSpeeds && gpsSpeeds.length > 0;
        const rowing = hasGpsData
          ? (gateSpeed != null && gateSpeed >= MIN_ROW_SPEED && gateSpeed <= MAX_ROW_SPEED)
          : allowWithoutGps;
        if (rowing) {
          // Per-stroke split (SpeedCoach-style): the mean of THIS stroke's fused
          // absolute speed. GPS-accurate in magnitude yet IMU-smooth. Real m/s
          // only when GPS-anchored; null otherwise, so no split is shown.
          const absVals = seg.filter(s => s.abs != null).map(s => s.abs);
          const meanSpeed = useAbs && absVals.length
            ? absVals.reduce((a, b) => a + b, 0) / absVals.length
            : null;
          // 33-pt speed curve for the free-speed number only (never plotted).
          // From the same unified signal — absolute m/s when locked so free speed
          // reads in real seconds; relative otherwise (→ free speed suppressed).
          const times = seg.map(s => s.t);
          const vals = seg.map(s => (useAbs ? s.abs : s.rel));
          const curve = resample(times, vals, NUM_POINTS);
          curve[NUM_POINTS - 1] = curve[0]; // periodic (catch == catch)
          const freeSec = useAbs ? freeSpeedSecondsFor(curve) : null;
          // Boat attitude over this stroke: p5–p95 roll/pitch swing (degrees).
          // Null when no gravity data was fed.
          const attSwing = strokeAttitudeSwing(proc.att.buf, startTime, boundaryTime);
          // startTime/time bound the stroke for video-sync (which phase is live).
          newStroke = {
            time: boundaryTime, startTime, spm: proc.strokeRate,
            meanSpeed, splitMps: meanSpeed, curve, freeSec,
            rollDeg: attSwing ? attSwing.roll : null,
            pitchDeg: attSwing ? attSwing.pitch : null,
          };
          // Keep the full stroke list (the post-session inspector needs every
          // stroke), but average only the most recent window so the live readout
          // reflects current form, not the whole session including warm-up.
          proc.strokes.push(newStroke);
          proc.strokeCount++;
          proc.lastStroke = curve;
          proc.lastGpsSpeed = meanSpeed;
          proc.avgCurve = averageCurves(
            proc.strokes.length > AVG_WINDOW_STROKES
              ? proc.strokes.slice(-AVG_WINDOW_STROKES)
              : proc.strokes
          );
        }
      }
    }

    // Advance the boundary for the next stroke (the detector self-manages its
    // seekMin/seekMax state — no reset needed here).
    proc.lastBoundaryTime = boundaryTime;
    proc.att.buf = proc.att.buf.filter(s => s.time > now - BUF_RETAIN_MS);
  }

  return newStroke;
}

// Flatten a recording into a single time-sorted event stream (motion /
// orientation / gps). Shared by replay and offline stroke derivation.
export function buildReplayEvents(recording) {
  const events = [];
  for (const m of recording.motion || []) events.push({ k: 'm', t: m.t, d: m });
  for (const o of recording.orientation || []) events.push({ k: 'o', t: o.t, d: o });
  for (const g of recording.gps || []) events.push({ k: 'g', t: g.t, d: g });
  events.sort((a, b) => a.t - b.t);
  return events;
}

// Re-derive the full stroke list from a raw recording, offline. Mirrors the live
// path's accel handling (gravity compensation, GPS window) so the analyzer's
// curves match what the coach saw live. Strokes are in the recording's time
// domain (the rower's clock).
export function deriveStrokes(recording, { allowWithoutGps = true } = {}) {
  if (!recording || !recording.motion || recording.motion.length === 0) return [];
  const proc = makeProc(recording.motion[0]?.t ?? 0);
  let orientation = { beta: 0, gamma: 0 };
  let orientationSeen = false;
  let gps = [];

  for (const ev of buildReplayEvents(recording)) {
    if (ev.k === 'o') {
      if (ev.d.beta != null) { orientation = { beta: ev.d.beta, gamma: ev.d.gamma }; orientationSeen = true; }
    } else if (ev.k === 'g') {
      gps.push({ time: ev.t, speed: ev.d.speed });
      const cutoff = ev.t - 30000;
      gps = gps.filter(s => s.time > cutoff);
    } else {
      let accelValues;
      let gravity = null;
      if (ev.d.ax != null) {
        accelValues = { x: ev.d.ax, y: ev.d.ay, z: ev.d.az };
        // Best attitude source: the fusion's own gravity estimate (axg − ax);
        // fall back to the recorded orientation angles when axg is absent.
        if (ev.d.axg != null) {
          gravity = { x: ev.d.axg - ev.d.ax, y: ev.d.ayg - ev.d.ay, z: ev.d.azg - ev.d.az };
        } else if (orientationSeen) {
          gravity = gravityFromAngles(orientation.beta, orientation.gamma);
        }
      } else if (ev.d.axg != null) {
        accelValues = subtractGravity(
          { x: ev.d.axg, y: ev.d.ayg, z: ev.d.azg }, orientation.beta, orientation.gamma
        );
        if (orientationSeen) gravity = gravityFromAngles(orientation.beta, orientation.gamma);
      } else {
        continue;
      }
      feedSample(proc, accelValues, ev.t, gps, { allowWithoutGps, gravity });
    }
  }
  return proc.strokes;
}

// A continuous, boundary-free boat-speed trace for the rolling graph: the boat's
// fore-aft (surge) acceleration integrated straight through the whole recording —
// no per-stroke windowing, no GPS. Because it ignores stroke boundaries entirely,
// the graph can't inherit the seams / magnitude steps the per-stroke curves have.
//
// Raw integration wanders (any residual acceleration bias ramps up without bound),
// so a slow baseline is subtracted to keep the trace on screen. That is NOT speed
// anchoring — no external truth is used — just a high-pass that drops the runaway
// DC term so the honest surge signal (relative m/s about the local mean) stays
// visible. The baseline's time constant is well above a stroke period, so the
// stroke-rate oscillation passes through untouched. Times are the recording's
// (rower) clock in ms, matching deriveStrokes.
//
// Uses the SAME surgeStep recursion as live capture, with GPS off — so the trace
// is byte-for-byte what it always was (this graph is the ground truth and must
// not change); GPS anchoring only ever adds a slow level on the live/detection path.

export function deriveSpeedSeries(recording) {
  const empty = { samples: [], lo: -1, hi: 1 };
  if (!recording || !recording.motion || recording.motion.length === 0) return empty;

  // Pass 1: gravity-compensated linear acceleration per motion sample, reusing
  // deriveStrokes' sensor handling (linearAccel vs accelIncludingGravity).
  let orientation = { beta: 0, gamma: 0 };
  const accel = []; // {t, x, y, z}
  for (const ev of buildReplayEvents(recording)) {
    if (ev.k === 'o') {
      if (ev.d.beta != null) orientation = { beta: ev.d.beta, gamma: ev.d.gamma };
    } else if (ev.k === 'm') {
      let a;
      if (ev.d.ax != null) a = { x: ev.d.ax, y: ev.d.ay, z: ev.d.az };
      else if (ev.d.axg != null) {
        a = subtractGravity({ x: ev.d.axg, y: ev.d.ayg, z: ev.d.azg }, orientation.beta, orientation.gamma);
      } else continue;
      accel.push({ t: ev.t, x: a.x, y: a.y, z: a.z });
    }
  }
  if (accel.length < 3) return empty;

  // Fore-aft (surge) axis: the dominant axis of the whole recording's acceleration
  // cloud. A single global axis for now — continuous re-estimation (mount drift /
  // remounts) can come with the later calc rework.
  const pd = principalDirection(accel.map(s => s.x), accel.map(s => s.y), accel.map(s => s.z));
  const d = pd ? pd.dir : { x: 0, y: 1, z: 0 };

  // Pass 2: project onto the surge axis and run the shared recursion (GPS off).
  const samples = [];
  const st = { v: 0, base: 0, level: null, prevT: null };
  for (const s of accel) {
    const { rel } = surgeStep(st, s.x * d.x + s.y * d.y + s.z * d.z, s.t, null);
    samples.push({ t: s.t, v: rel });
  }

  return rangeSpeedSamples(samples);
}

// Robust y-range (2nd–98th percentile) for a set of {t, v} speed samples, so a
// rare excursion can't squash the trace. Shared by the offline and live series.
function rangeSpeedSamples(samples) {
  const sorted = samples.map((s) => s.v).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  let lo = pct(0.02), hi = pct(0.98);
  if (hi - lo < 0.3) { lo = sorted[0]; hi = sorted[sorted.length - 1]; }
  const pad = Math.max((hi - lo) * 0.12, 0.15);
  return { samples, lo: lo - pad, hi: hi + pad };
}

// A drawOverlay-ready {samples, lo, hi} series for the LIVE rolling graph, built
// from the proc's rolling buffer (the same `rel` signal the offline graph draws,
// so live and analysis look alike). Returns the recent `windowMs` of samples.
export function liveSpeedSeries(proc, windowMs = BUF_RETAIN_MS) {
  const buf = proc?.speed?.buf;
  const empty = { samples: [], lo: -1, hi: 1 };
  if (!buf || buf.length < 2) return empty;
  const cutoff = buf[buf.length - 1].t - windowMs;
  const samples = [];
  for (const s of buf) if (s.t >= cutoff) samples.push({ t: s.t, v: s.rel });
  if (samples.length < 2) return empty;
  return rangeSpeedSamples(samples);
}
