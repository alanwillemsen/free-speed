// Stroke-detection signal pipeline, extracted from LiveCapture so the live
// capture path AND the offline video analyzer can derive identical strokes from
// the same raw samples. Everything here is pure (no React refs, no DOM): the
// per-sample engine (`feedSample`) mutates a plain `proc` state object, and
// `deriveStrokes` replays a whole recording through it.

import { catchStartIndex, rollCurve } from './curves';
import referenceCurveData from '../data/referenceCurve.json';

// --- Constants ---
export const NUM_POINTS = 33;
const NOISE_ALPHA = 0.4;          // EMA alpha for noise reduction
const STROKE_DETECT_ALPHA = 0.06; // EMA alpha for stroke boundary detection
const MIN_STROKE_MS = 800;
const MAX_STROKE_MS = 4000;
const AVG_WINDOW_STROKES = 500;   // live rolling average spans the most recent N strokes
export const CALIBRATION_MS = 3000; // Auto-orientation calibration window
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
// Reference curve rolled so the catch sits at the left edge (see catchStartIndex).
export const REF_ROLLED = rollCurve(REF_SPEEDS, catchStartIndex(REF_SPEEDS));
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

export function subtractGravity(accelIncGravity, beta, gamma) {
  const G = 9.81;
  const betaRad = (beta ?? 0) * Math.PI / 180;
  const gammaRad = (gamma ?? 0) * Math.PI / 180;
  const gx = G * Math.sin(gammaRad);
  const gy = G * Math.sin(betaRad) * Math.cos(gammaRad);
  const gz = G * Math.cos(betaRad) * Math.cos(gammaRad);
  return {
    x: (accelIncGravity.x ?? 0) - gx,
    y: (accelIncGravity.y ?? 0) - gy,
    z: (accelIncGravity.z ?? 0) - gz,
  };
}

export function variance(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

// Identify the boat's fore-aft (surge) direction as a free 3D unit vector: the
// principal axis of the acceleration cloud. See LiveCapture history for the full
// rationale — power-iterated dominant eigenvector of the 3×3 covariance.
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
  let maxAbs = 0, signedMax = 1;
  for (let i = 0; i < n; i++) {
    const p = (x[i] - mx) * vx + (y[i] - my) * vy + (z[i] - mz) * vz;
    if (Math.abs(p) > maxAbs) { maxAbs = Math.abs(p); signedMax = p; }
  }
  if (signedMax < 0) { vx = -vx; vy = -vy; vz = -vz; }
  return { dir: { x: vx, y: vy, z: vz }, variance: lambda };
}

export function angleBetween(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * 180 / Math.PI;
}

export function processStroke(samples) {
  if (samples.length < 10) return null;
  const vel = [0];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    vel.push(vel[i - 1] + (samples[i - 1].accel + samples[i].accel) / 2 * dt);
  }
  const drift = (vel[vel.length - 1] - vel[0]) / (vel.length - 1);
  for (let i = 0; i < vel.length; i++) vel[i] -= drift * i;
  const minV = Math.min(...vel);
  const maxV = Math.max(...vel);
  const range = maxV - minV;
  if (range < 0.001) return null;
  const refMin = Math.min(...REF_SPEEDS);
  const refMax = Math.max(...REF_SPEEDS);
  const scaled = vel.map(v => refMin + ((v - minV) / range) * (refMax - refMin));
  const times = samples.map(s => s.time);
  const resampled = resample(times, scaled, NUM_POINTS);
  resampled[NUM_POINTS - 1] = resampled[0];
  return resampled;
}

export function processStrokeWithGPS(samples, gpsSpeeds) {
  if (samples.length < 10) return null;
  const vel = [0];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    vel.push(vel[i - 1] + (samples[i - 1].accel + samples[i].accel) / 2 * dt);
  }
  const times = samples.map(s => s.time);
  const t0 = times[0], t1 = times[times.length - 1];
  const relevant = gpsSpeeds.filter(g => g.time >= t0 - 500 && g.time <= t1 + 500);
  if (relevant.length < 1) return null;
  const offsets = relevant.map(g => {
    let idx = 0;
    while (idx < times.length - 2 && times[idx + 1] < g.time) idx++;
    const frac = (times[idx + 1] - times[idx]) > 0
      ? Math.max(0, Math.min(1, (g.time - times[idx]) / (times[idx + 1] - times[idx])))
      : 0;
    const interpVel = vel[idx] + frac * (vel[idx + 1] - vel[idx]);
    return { time: g.time, offset: g.speed - interpVel };
  });
  let a, b;
  if (offsets.length === 1) {
    a = offsets[0].offset;
    b = 0;
  } else {
    const n = offsets.length;
    const sumT = offsets.reduce((s, o) => s + o.time, 0);
    const sumO = offsets.reduce((s, o) => s + o.offset, 0);
    const sumTT = offsets.reduce((s, o) => s + o.time * o.time, 0);
    const sumTO = offsets.reduce((s, o) => s + o.time * o.offset, 0);
    const denom = n * sumTT - sumT * sumT;
    if (Math.abs(denom) < 1e-12) {
      a = sumO / n;
      b = 0;
    } else {
      b = (n * sumTO - sumT * sumO) / denom;
      a = (sumO - b * sumT) / n;
    }
  }
  const anchored = vel.map((v, i) => v + a + b * times[i]);
  const minAnchored = Math.min(...anchored);
  if (minAnchored < -1) return null;
  const resampled = resample(times, anchored, NUM_POINTS);
  resampled[NUM_POINTS - 1] = resampled[0];
  return resampled;
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

// --- Processing engine ---

// A fresh processing pipeline. `startTime` null → set from the first sample, so
// coach-side / replay calibration spans the right window.
export function makeProc(startTime) {
  return {
    filteredAccel: 0,
    strokeDetect: 0,
    prevStrokeDetect: 0,
    buffer: [],
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
    // Set true by feedSample on a remount snap so the caller can re-send the new
    // direction to a linked coach. The caller clears it.
    remounted: false,
  };
}

// Feed one gravity-compensated acceleration sample into the pipeline. Mutates
// `proc` (calibration, orientation tracking, stroke detection, the strokes
// array). Returns the newly completed stroke object, or null. `gpsSpeeds` is the
// recent GPS-speed window (in the same time domain as `now`). `allowWithoutGps`
// records strokes even when no GPS is present (replay / coach-fed data); live
// capture passes false so GPS is required to record.
export function feedSample(proc, accelValues, now, gpsSpeeds, { allowWithoutGps = false } = {}) {
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
          proc.direction = cand.dir;
          ori.pending = null;
          const r = (accelValues.x ?? 0) * cand.dir.x
            + (accelValues.y ?? 0) * cand.dir.y
            + (accelValues.z ?? 0) * cand.dir.z;
          proc.filteredAccel = r;
          proc.strokeDetect = r;
          proc.prevStrokeDetect = r;
          proc.buffer = [];
          proc.lastBoundaryTime = now;
          proc.remounted = true; // caller re-sends direction to a linked coach
        } else if (!samePending) {
          ori.pending = cand.dir;
          ori.pendingSince = now;
        }
      }
    }
  }

  const d = proc.direction;
  const raw = (accelValues.x ?? 0) * d.x + (accelValues.y ?? 0) * d.y + (accelValues.z ?? 0) * d.z;

  proc.filteredAccel += NOISE_ALPHA * (raw - proc.filteredAccel);
  proc.prevStrokeDetect = proc.strokeDetect;
  proc.strokeDetect += STROKE_DETECT_ALPHA * (raw - proc.strokeDetect);
  proc.buffer.push({ time: now, accel: proc.filteredAccel });

  let newStroke = null;

  // Detect full reach: positive → negative zero crossing of the heavily filtered
  // signal (max forward extension).
  if (proc.prevStrokeDetect >= 0 && proc.strokeDetect < 0) {
    const elapsed = now - proc.lastBoundaryTime;

    if (elapsed >= MIN_STROKE_MS && elapsed <= MAX_STROKE_MS && proc.lastBoundaryTime > 0) {
      const startTime = proc.lastBoundaryTime;
      const strokeSamples = proc.buffer.filter(s => s.time >= startTime && s.time <= now);

      let curve = null;
      if (gpsSpeeds && gpsSpeeds.length >= 1) {
        curve = processStrokeWithGPS(strokeSamples, gpsSpeeds);
        if (curve) proc.hasGPS = true;
      }
      if (!curve) {
        curve = processStroke(strokeSamples);
        proc.hasGPS = false;
      }

      if (curve) {
        if (proc.boundaryTimes.length &&
            now - proc.boundaryTimes[proc.boundaryTimes.length - 1] > MAX_STROKE_MS) {
          proc.boundaryTimes = [];
        }
        proc.boundaryTimes.push(now);
        if (proc.boundaryTimes.length > 10) proc.boundaryTimes.shift();
        if (proc.boundaryTimes.length >= 2) {
          const ct = proc.boundaryTimes;
          proc.strokeRate = Math.round(60000 / ((ct[ct.length - 1] - ct[0]) / (ct.length - 1)));
        }

        // Smoothed GPS speed over a multi-second window. Used only to gate
        // recording on the rowing band: its job is stability, so one noisy
        // reading at the pace-band edge can't flicker strokes in and out of the
        // recording. The displayed split is per-stroke instead (see below).
        const gateSpeed = proc.hasGPS
          ? windowedGpsSpeed(gpsSpeeds, now, Math.max(elapsed, SPLIT_WINDOW_MS))
          : null;
        const hasGpsData = gpsSpeeds && gpsSpeeds.length > 0;
        const rowing = hasGpsData
          ? (gateSpeed != null && gateSpeed >= MIN_ROW_SPEED && gateSpeed <= MAX_ROW_SPEED)
          : allowWithoutGps;
        if (rowing) {
          const avgSpeed = curve.reduce((a, b) => a + b, 0) / curve.length;
          // Per-stroke split (like a SpeedCoach): the mean of THIS stroke's
          // GPS-anchored speed curve — one number for one stroke, not a rolling
          // window that blurs consecutive strokes together. GPS-accurate in
          // magnitude (anchored) yet smooth, since the IMU fills in the
          // within-stroke shape that 1 Hz GPS is too sparse to resolve. Real m/s
          // only when GPS-anchored; null otherwise, so no split is shown.
          const gpsSpeed = proc.hasGPS ? avgSpeed : null;
          const freeSec = proc.hasGPS ? freeSpeedSecondsFor(curve) : null;
          // startTime/time bound the stroke for video-sync (which phase is live).
          newStroke = { time: now, startTime, curve, avgSpeed, gpsSpeed, spm: proc.strokeRate, freeSec };
          // Keep the full stroke list (the post-session inspector / slider needs
          // every stroke), but average only the most recent window so the live
          // readout reflects current form, not the whole session including warm-up.
          proc.strokes.push(newStroke);
          proc.strokeCount++;
          proc.lastStroke = curve;
          proc.lastGpsSpeed = gpsSpeed;
          proc.avgCurve = averageCurves(
            proc.strokes.length > AVG_WINDOW_STROKES
              ? proc.strokes.slice(-AVG_WINDOW_STROKES)
              : proc.strokes
          );
        }
      }
    }

    proc.lastBoundaryTime = now;
    const cutoff = now - 5000;
    proc.buffer = proc.buffer.filter(s => s.time > cutoff);
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
  let gps = [];

  for (const ev of buildReplayEvents(recording)) {
    if (ev.k === 'o') {
      if (ev.d.beta != null) orientation = { beta: ev.d.beta, gamma: ev.d.gamma };
    } else if (ev.k === 'g') {
      gps.push({ time: ev.t, speed: ev.d.speed });
      const cutoff = ev.t - 30000;
      gps = gps.filter(s => s.time > cutoff);
    } else {
      let accelValues;
      if (ev.d.ax != null) {
        accelValues = { x: ev.d.ax, y: ev.d.ay, z: ev.d.az };
      } else if (ev.d.axg != null) {
        accelValues = subtractGravity(
          { x: ev.d.axg, y: ev.d.ayg, z: ev.d.azg }, orientation.beta, orientation.gamma
        );
      } else {
        continue;
      }
      feedSample(proc, accelValues, ev.t, gps, { allowWithoutGps });
    }
  }
  return proc.strokes;
}
