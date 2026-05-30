import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import LiveBigScreen from './LiveBigScreen';
import { usePeerLink } from '../hooks/usePeerLink';
import { useWakeLock } from '../hooks/useWakeLock';
import * as sessionStore from '../utils/sessionStore';
import referenceCurveData from '../data/referenceCurve.json';

ChartJS.register(LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// --- Constants ---
const NUM_POINTS = 33;
const NOISE_ALPHA = 0.4;          // EMA alpha for noise reduction
const STROKE_DETECT_ALPHA = 0.06; // EMA alpha for stroke boundary detection
const MIN_STROKE_MS = 800;
const MAX_STROKE_MS = 4000;
const MAX_STROKES = 500;          // Rolling window for averaging
const UI_UPDATE_MS = 250;
const CALIBRATION_MS = 3000;      // Auto-orientation calibration window
// Continuous orientation re-evaluation (handles a mid-session remount / handoff).
// The boat-motion direction is tracked as a free 3D vector (the PCA principal
// axis of acceleration), so any mounting angle works — not just the device's
// x/y/z faces. Small shifts are followed smoothly; a large, sustained jump is
// treated as a remount and snaps (resetting stroke detection).
const ORIENT_WINDOW_MS = 5000;    // rolling window for the direction estimate (a stroke+)
const ORIENT_REEVAL_MS = 1000;    // recompute the motion direction at most this often
const ORIENT_SWITCH_MS = 2500;    // a remount must persist this long before we snap to it
const ORIENT_SWITCH_DEG = 35;     // direction jump beyond this = remount, not drift
const ORIENT_MIN_VAR = 0.5;       // below this variance = no real motion; don't update
const SEND_BATCH_MS = 100;        // Batch outgoing samples this often when coach-linked
const PERSIST_FLUSH_MS = 2000;    // Flush new samples to IndexedDB this often (crash recovery)
const SPLIT_WINDOW_MS = 5000;     // GPS-speed averaging window for per-stroke split
// Rowing happens only within this 500m-split band. Outside it the boat is
// drifting/stopped (slower than 4:00) or the reading is a GPS spike (faster than
// 1:00). Capture pauses outside the band and auto-resumes inside it; a valid
// in-band GPS speed is required to record at all.
const MIN_ROW_SPEED = 500 / 240;  // 2.08 m/s — a 4:00 /500m split
const MAX_ROW_SPEED = 500 / 60;   // 8.33 m/s — a 1:00 /500m split

const PHASE_TIMES = Array.from({ length: NUM_POINTS }, (_, i) => i / (NUM_POINTS - 1));
const REF_SPEEDS = referenceCurveData.speeds;
const REF_AVG = REF_SPEEDS.reduce((a, b) => a + b, 0) / REF_SPEEDS.length;

// --- Signal processing ---

function resample(times, values, n) {
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

function subtractGravity(accelIncGravity, beta, gamma) {
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

function variance(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

// Identify the boat's fore-aft (surge) direction as a free 3D unit vector: the
// principal axis of the acceleration cloud — the direction along which motion
// varies most. Found by power-iterating the 3×3 covariance, so it works at any
// mounting angle, not just when an axis happens to line up with the boat.
// Shared by the initial calibration and the continuous re-evaluation. Returns a
// signed unit vector (oriented so the drive's biggest spike reads positive) plus
// the variance along it (for the "is the boat really moving" gate). `warm` seeds
// the iteration with the previous direction for fast, continuous convergence.
function principalDirection(x, y, z, warm) {
  const n = x.length;
  if (n < 2) return null;
  // Mean-center so any residual gravity DC can't bias the direction.
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; mz += z[i]; }
  mx /= n; my /= n; mz /= n;
  // Covariance matrix (symmetric — six unique entries).
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my, dz = z[i] - mz;
    cxx += dx * dx; cyy += dy * dy; czz += dz * dz;
    cxy += dx * dy; cxz += dx * dz; cyz += dy * dz;
  }
  cxx /= n; cyy /= n; czz /= n; cxy /= n; cxz /= n; cyz /= n;
  // Power iteration → dominant eigenvector (the principal direction).
  let vx = warm?.x ?? 1, vy = warm?.y ?? 0, vz = warm?.z ?? 0;
  let lambda = 0;
  for (let it = 0; it < 24; it++) {
    const nx = cxx * vx + cxy * vy + cxz * vz;
    const ny = cxy * vx + cyy * vy + cyz * vz;
    const nz = cxz * vx + cyz * vy + czz * vz;
    const mag = Math.hypot(nx, ny, nz);
    if (mag < 1e-12) break;
    vx = nx / mag; vy = ny / mag; vz = nz / mag;
    lambda = mag; // ≈ variance along v (Rayleigh quotient, v is unit)
  }
  // Orient the vector so the drive (largest excursion) projects positive.
  let maxAbs = 0, signedMax = 1;
  for (let i = 0; i < n; i++) {
    const p = (x[i] - mx) * vx + (y[i] - my) * vy + (z[i] - mz) * vz;
    if (Math.abs(p) > maxAbs) { maxAbs = Math.abs(p); signedMax = p; }
  }
  if (signedMax < 0) { vx = -vx; vy = -vy; vz = -vz; }
  return { dir: { x: vx, y: vy, z: vz }, variance: lambda };
}

// Angle (degrees) between two unit vectors.
function angleBetween(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * 180 / Math.PI;
}

function processStroke(samples) {
  if (samples.length < 10) return null;

  // Integrate acceleration → relative velocity (trapezoidal rule)
  const vel = [0];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    vel.push(vel[i - 1] + (samples[i - 1].accel + samples[i].accel) / 2 * dt);
  }

  // Remove linear drift to enforce periodicity (v_start ≈ v_end)
  const drift = (vel[vel.length - 1] - vel[0]) / (vel.length - 1);
  for (let i = 0; i < vel.length; i++) {
    vel[i] -= drift * i;
  }

  const minV = Math.min(...vel);
  const maxV = Math.max(...vel);
  const range = maxV - minV;
  if (range < 0.001) return null;

  // Scale to match the reference curve's speed range for visual comparison
  const refMin = Math.min(...REF_SPEEDS);
  const refMax = Math.max(...REF_SPEEDS);
  const scaled = vel.map(v => refMin + ((v - minV) / range) * (refMax - refMin));

  // Resample to standard point count
  const times = samples.map(s => s.time);
  const resampled = resample(times, scaled, NUM_POINTS);
  resampled[NUM_POINTS - 1] = resampled[0]; // Enforce periodicity
  return resampled;
}

function processStrokeWithGPS(samples, gpsSpeeds) {
  if (samples.length < 10) return null;

  // Trapezoidal integration of acceleration → relative velocity
  const vel = [0];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].time - samples[i - 1].time) / 1000;
    vel.push(vel[i - 1] + (samples[i - 1].accel + samples[i].accel) / 2 * dt);
  }
  const times = samples.map(s => s.time);
  const t0 = times[0], t1 = times[times.length - 1];

  // Find GPS readings within this stroke's time window
  const relevant = gpsSpeeds.filter(g => g.time >= t0 - 500 && g.time <= t1 + 500);
  if (relevant.length < 1) return null; // caller falls back to processStroke

  // Interpolate integrated velocity at each GPS timestamp, compute offsets
  const offsets = relevant.map(g => {
    let idx = 0;
    while (idx < times.length - 2 && times[idx + 1] < g.time) idx++;
    const frac = (times[idx + 1] - times[idx]) > 0
      ? Math.max(0, Math.min(1, (g.time - times[idx]) / (times[idx + 1] - times[idx])))
      : 0;
    const interpVel = vel[idx] + frac * (vel[idx + 1] - vel[idx]);
    return { time: g.time, offset: g.speed - interpVel };
  });

  // Fit linear correction: constant offset (1 GPS point) or linear regression (2+)
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

  // Apply correction → absolute m/s velocity
  const anchored = vel.map((v, i) => v + a + b * times[i]);

  // Sanity check: speeds should be positive and reasonable for rowing (0-10 m/s)
  const minAnchored = Math.min(...anchored);
  if (minAnchored < -1) return null; // GPS data is inconsistent, fall back

  const resampled = resample(times, anchored, NUM_POINTS);
  resampled[NUM_POINTS - 1] = resampled[0];
  return resampled;
}

// Average GPS speed (m/s) over [endTime - windowMs, endTime], dropping
// non-positive and implausibly high readings. GPS is ~1 Hz, so a single stroke
// is too sparse for an accurate split; the multi-second window filters jitter.
// Returns null when no usable sample falls in the window.
function windowedGpsSpeed(gpsSpeeds, endTime, windowMs) {
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

function averageCurves(strokes) {
  if (strokes.length === 0) return null;
  const avg = new Array(NUM_POINTS).fill(0);
  for (const s of strokes) {
    const curve = s.curve ?? s;
    for (let i = 0; i < NUM_POINTS; i++) avg[i] += curve[i];
  }
  for (let i = 0; i < NUM_POINTS; i++) avg[i] /= strokes.length;
  return avg;
}

// "Free speed" (m/s): the average boat speed you'd gain by matching the
// potential curve's *shape* at your current effort. Drag power ∝ v³, so a given
// average power (∝ mean of v³) yields the highest average speed when the speed
// is steadiest — any variation costs speed (Jensen's inequality). We scale the
// potential shape to your stroke's mean-cube (i.e. same power), then compare
// average speeds. Same shape → 0 at any pace; the gain comes only from your
// curve carrying more speed variation than the reference. Positive = speed left
// on the table; negative = you're already smoother than potential (rare).
// Both curves must be in real m/s, so this is GPS-anchored only.
function freeSpeedGain(yourCurve, potentialCurve) {
  if (!yourCurve || yourCurve.length === 0) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const meanCube = (a) => a.reduce((s, v) => s + v * v * v, 0) / a.length;
  const yourPower = meanCube(yourCurve);
  const potPower = meanCube(potentialCurve);
  if (yourPower <= 0 || potPower <= 0) return null;
  const scale = Math.cbrt(yourPower / potPower); // potential rescaled to your power
  return scale * mean(potentialCurve) - mean(yourCurve);
}

// --- Component ---

function LiveCapture({ onSaveCurve, onBack }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [sensorStatus, setSensorStatus] = useState('checking');
  // Outdoor full-screen readout (split + spm + speed profile). Capture keeps
  // running underneath while it's open.
  const [bigScreen, setBigScreen] = useState(false);

  // Coach link: 'rower' = this phone is mounted in the boat and (optionally)
  // streams to a coach; 'coach' = this phone watches a rower's stream and runs
  // the same processing pipeline on the received samples.
  const [linkRole, setLinkRole] = useState('rower');
  const [isWatching, setIsWatching] = useState(false); // coach is receiving a live session
  // Coach can pause the live feed to inspect individual strokes without stopping
  // the stream — the proc keeps accumulating in the background and resume catches up.
  const [isPaused, setIsPaused] = useState(false);

  // UI state (synced from refs periodically during capture)
  const [strokeRate, setStrokeRate] = useState(0);
  const [strokeCount, setStrokeCount] = useState(0);
  const [lastStroke, setLastStroke] = useState(null);
  const [avgCurve, setAvgCurve] = useState(null);
  const [liveSplitSpeed, setLiveSplitSpeed] = useState(null); // GPS speed (m/s) of the latest stroke
  const [calibrationStatus, setCalibrationStatus] = useState('idle'); // idle | calibrating | detected
  // Whether the boat is currently rowing (GPS split within the rowing band).
  // Capture pauses while false and auto-resumes when it goes true.
  const [isActive, setIsActive] = useState(false);
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | requesting | active | unavailable
  const [hasGPSAnchoring, setHasGPSAnchoring] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  // Snapshot of all strokes after stop/replay — enables time-range selection.
  // Each entry: { time: ms, curve: number[NUM_POINTS], avgSpeed: number }.
  const [strokes, setStrokes] = useState([]);
  // Selection in stroke-time coordinates (same units as `time` above), or null = all.
  const [selection, setSelection] = useState(null);
  // Index into `strokes` for showing a single stroke instead of the average.
  // null = show average.
  const [selectedIndex, setSelectedIndex] = useState(null);

  // Processing state lives in refs to avoid stale closures in the 60 Hz handler
  const procRef = useRef(null);
  // Boat fore-aft direction in device frame (unit vector). Default points along
  // +y until calibration locks it; updated continuously while rowing.
  const dirRef = useRef({ x: 0, y: 1, z: 0 });
  const orientationRef = useRef({ beta: 0, gamma: 0 });
  const gpsRef = useRef({ speeds: [], watchId: null });
  const recordingRef = useRef(null);
  const fileInputRef = useRef(null);
  const sendBufferRef = useRef({ motion: [], orientation: [], gps: [] });
  const sendIntervalRef = useRef(null);
  const calibSentRef = useRef(false); // rower: calib message sent to coach once
  const isPausedRef = useRef(false);  // coach: live feed frozen for stroke inspection
  // New samples since the last IndexedDB flush (crash-recovery persistence).
  const persistBufferRef = useRef({ motion: [], orientation: [], gps: [] });
  const persistIntervalRef = useRef(null);

  const wakeLock = useWakeLock();

  // A previous capture that didn't end cleanly (crash / reload / tab reap),
  // offered for recovery on mount. null once handled.
  const [recoverable, setRecoverable] = useState(null);
  // Gates auto-start: we must finish checking IndexedDB for a recoverable
  // session before auto-starting, or a new capture would wipe it first.
  const [recoveryChecked, setRecoveryChecked] = useState(false);

  // Detect sensor availability
  useEffect(() => {
    if (!('DeviceMotionEvent' in window)) {
      setSensorStatus('unavailable');
      return;
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      setSensorStatus('permission_needed');
    } else {
      setSensorStatus('available');
    }
  }, []);

  const requestPermission = async () => {
    try {
      const motionResult = await DeviceMotionEvent.requestPermission();
      let orientResult = 'granted';
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        orientResult = await DeviceOrientationEvent.requestPermission();
      }
      setSensorStatus(
        motionResult === 'granted' && orientResult === 'granted'
          ? 'available'
          : 'denied'
      );
    } catch {
      setSensorStatus('denied');
    }
  };

  // Stable motion handler — reads all dynamic values from refs.
  // `nowOverride` lets offline replay drive the handler with recorded timestamps.
  const handleMotion = useRef((event, nowOverride) => {
    const proc = procRef.current;
    if (!proc) return;
    const now = nowOverride ?? performance.now();

    // Capture raw sample for offline replay (skipped during replay itself)
    const rec = recordingRef.current;
    if (rec) {
      const a = event.acceleration;
      const ag = event.accelerationIncludingGravity;
      const sample = { t: now };
      if (a && a.x != null) { sample.ax = a.x; sample.ay = a.y; sample.az = a.z; }
      if (ag && ag.x != null) { sample.axg = ag.x; sample.ayg = ag.y; sample.azg = ag.z; }
      rec.motion.push(sample);
      // Stream to a connected coach. Guard on nowOverride so coach-fed samples
      // (replay / received stream) never get re-buffered; the flush interval
      // drops the buffer when no peer is connected.
      if (nowOverride == null) {
        sendBufferRef.current.motion.push(sample);
        persistBufferRef.current.motion.push(sample);
      }
    }

    // --- Gravity compensation ---
    let accelValues;
    if (event.acceleration && event.acceleration.x != null) {
      accelValues = event.acceleration;
    } else if (event.accelerationIncludingGravity) {
      const { beta, gamma } = orientationRef.current;
      accelValues = subtractGravity(event.accelerationIncludingGravity, beta, gamma);
    } else {
      return;
    }

    // --- Auto-orientation calibration ---
    if (!proc.calibration.done) {
      proc.calibration.samples.x.push(accelValues.x ?? 0);
      proc.calibration.samples.y.push(accelValues.y ?? 0);
      proc.calibration.samples.z.push(accelValues.z ?? 0);

      if (now - proc.calibration.startTime >= CALIBRATION_MS) {
        const c = proc.calibration.samples;
        // Lock the boat's fore-aft direction from the motion so far — any
        // mounting angle, no axis assumptions.
        const pd = principalDirection(c.x, c.y, c.z);

        if (!pd || pd.variance < ORIENT_MIN_VAR) {
          // No meaningful motion yet — extend calibration
          proc.calibration.startTime = now;
          proc.calibration.samples = { x: [], y: [], z: [] };
          return;
        }

        dirRef.current = pd.dir;
        proc.direction = pd.dir;
        proc.calibration.done = true;
      }
      return; // Don't process strokes during calibration
    }

    proc.lastSampleTime = now;

    // --- Continuous orientation tracking ---
    // The boat-motion direction can change mid-session if the phone is moved or
    // handed to another rower. Keep a rolling window and re-estimate the
    // principal direction periodically. A small change is followed smoothly
    // (handles gradual shifts); a large, sustained change is treated as a
    // remount and snaps, resetting stroke detection so the handoff isn't
    // measured as a stroke. (Variance-based, so rough water doesn't fool it —
    // chop has no consistent direction; the stroke rhythm does.)
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
        w.map(s => s.x), w.map(s => s.y), w.map(s => s.z), dirRef.current
      );
      if (cand && cand.variance >= ORIENT_MIN_VAR) {
        const drift = angleBetween(cand.dir, dirRef.current);
        if (drift < ORIENT_SWITCH_DEG) {
          // Normal drift — follow it, no reset.
          dirRef.current = cand.dir;
          proc.direction = cand.dir;
          ori.pending = null;
        } else {
          // Large jump — candidate remount. Require it to hold before snapping.
          const samePending = ori.pending && angleBetween(cand.dir, ori.pending) < ORIENT_SWITCH_DEG / 2;
          if (samePending && now - ori.pendingSince >= ORIENT_SWITCH_MS) {
            dirRef.current = cand.dir;
            proc.direction = cand.dir;
            ori.pending = null;
            // Reset stroke detection so the handoff jostle isn't a stroke.
            const r = (accelValues.x ?? 0) * cand.dir.x
              + (accelValues.y ?? 0) * cand.dir.y
              + (accelValues.z ?? 0) * cand.dir.z;
            proc.filteredAccel = r;
            proc.strokeDetect = r;
            proc.prevStrokeDetect = r;
            proc.buffer = [];
            proc.lastBoundaryTime = now;
            calibSentRef.current = false; // re-send direction to a linked coach
          } else if (!samePending) {
            ori.pending = cand.dir;
            ori.pendingSince = now;
          }
        }
      }
    }

    const d = dirRef.current;
    const raw = (accelValues.x ?? 0) * d.x + (accelValues.y ?? 0) * d.y + (accelValues.z ?? 0) * d.z;

    // Light EMA for noise reduction
    proc.filteredAccel += NOISE_ALPHA * (raw - proc.filteredAccel);

    // Heavy EMA for stroke boundary detection
    proc.prevStrokeDetect = proc.strokeDetect;
    proc.strokeDetect += STROKE_DETECT_ALPHA * (raw - proc.strokeDetect);

    proc.buffer.push({ time: now, accel: proc.filteredAccel });

    // Detect full reach: positive → negative zero crossing of heavily filtered signal.
    // Full reach is when the rower reaches maximum forward extension — the boat
    // stops gaining "free speed" from the rower decelerating at front stops and
    // begins to decelerate under drag alone until the catch (blade entry).
    if (proc.prevStrokeDetect >= 0 && proc.strokeDetect < 0) {
      const elapsed = now - proc.lastBoundaryTime;

      if (elapsed >= MIN_STROKE_MS && elapsed <= MAX_STROKE_MS && proc.lastBoundaryTime > 0) {
        const strokeSamples = proc.buffer.filter(
          s => s.time >= proc.lastBoundaryTime && s.time <= now
        );

        // Try GPS-anchored processing first, fall back to relative
        let curve = null;
        const gps = gpsRef.current.speeds;
        if (gps && gps.length >= 1) {
          curve = processStrokeWithGPS(strokeSamples, gps);
          if (curve) proc.hasGPS = true;
        }
        if (!curve) {
          curve = processStroke(strokeSamples);
          proc.hasGPS = false;
        }

        if (curve) {
          // Split comes from GPS (accurate absolute speed), not the IMU curve
          // mean (good for shape, drifty for magnitude). Smoothed over a window.
          const gpsSpeed = proc.hasGPS
            ? windowedGpsSpeed(gps, now, Math.max(elapsed, SPLIT_WINDOW_MS))
            : null;
          // Activity gate: only record while the boat is actually rowing — a GPS
          // split inside the band. Requires GPS; pauses and auto-resumes.
          const rowing = gpsSpeed != null && gpsSpeed >= MIN_ROW_SPEED && gpsSpeed <= MAX_ROW_SPEED;
          if (rowing) {
            const avgSpeed = curve.reduce((a, b) => a + b, 0) / curve.length;
            proc.strokes.push({ time: now, curve, avgSpeed, gpsSpeed });
            if (proc.strokes.length > MAX_STROKES) proc.strokes.shift();
            proc.strokeCount++;
            proc.lastStroke = curve;
            proc.lastGpsSpeed = gpsSpeed;
            proc.avgCurve = averageCurves(proc.strokes);

            proc.boundaryTimes.push(now);
            if (proc.boundaryTimes.length > 10) proc.boundaryTimes.shift();
            if (proc.boundaryTimes.length >= 2) {
              const ct = proc.boundaryTimes;
              proc.strokeRate = Math.round(60000 / ((ct[ct.length - 1] - ct[0]) / (ct.length - 1)));
            }
          }
        }
      }

      proc.lastBoundaryTime = now;
      // Trim buffer to last 5 seconds
      const cutoff = now - 5000;
      proc.buffer = proc.buffer.filter(s => s.time > cutoff);
    }
  });

  // --- Coach watch lifecycle (coach side) ---
  // A fresh processing pipeline that consumes the rower's streamed samples
  // instead of local sensors. Mirrors startCapture's proc init.
  const makeProc = (startTime) => ({
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
    direction: null,
    calibration: { startTime, samples: { x: [], y: [], z: [] }, done: false },
    orient: { window: [], lastEval: 0, pending: null, pendingSince: 0 },
  });

  const startWatch = () => {
    // startTime null → set from the first received motion sample, so coach-side
    // calibration spans the right window if the rower wasn't calibrated yet.
    procRef.current = makeProc(null);
    dirRef.current = { x: 0, y: 1, z: 0 };
    orientationRef.current = { beta: 0, gamma: 0 };
    gpsRef.current.speeds = [];
    recordingRef.current = {
      version: 1,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      motion: [],
      orientation: [],
      gps: [],
    };
    setStrokeRate(0);
    setStrokeCount(0);
    setLastStroke(null);
    setAvgCurve(null);
    setLiveSplitSpeed(null);
    setCalibrationStatus('calibrating');
    setIsActive(false);
    setHasGPSAnchoring(false);
    setHasRecording(false);
    setStrokes([]);
    setSelection(null);
    setSelectedIndex(null);
    isPausedRef.current = false;
    setIsPaused(false);
    setIsWatching(true);
  };

  const stopWatch = () => {
    setIsWatching(false);
    isPausedRef.current = false;
    setIsPaused(false);
    const proc = procRef.current;
    if (proc) {
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setAvgCurve(proc.avgCurve);
      setHasGPSAnchoring(proc.hasGPS);
      setStrokes([...proc.strokes]);
      setSelection(null);
      setSelectedIndex(null);
    }
    const rec = recordingRef.current;
    if (rec && rec.motion.length > 0) setHasRecording(true);
  };

  // Coach: freeze the live view and snapshot the strokes so far for inspection.
  // The stream keeps feeding proc in the background; resume returns to live.
  const pauseWatch = () => {
    const proc = procRef.current;
    if (proc) {
      setStrokes([...proc.strokes]);
      setAvgCurve(proc.avgCurve);
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setHasGPSAnchoring(proc.hasGPS);
    }
    setSelection(null);
    setSelectedIndex(null);
    isPausedRef.current = true;
    setIsPaused(true);
  };

  const resumeWatch = () => {
    isPausedRef.current = false;
    setIsPaused(false);
    setStrokes([]);        // back to the live running average
    setSelection(null);
    setSelectedIndex(null);
  };

  // --- Peer link (shared hook) ---
  // Coach consumes the stream; rower resends capture state + calibration to a
  // freshly-connected coach so it can catch up mid-session.
  const handlePeerData = (msg) => {
    if (linkRole !== 'coach') return;
    const proc = procRef.current;
    switch (msg.type) {
      case 'capture':
        if (msg.active) startWatch();
        else stopWatch();
        break;
      case 'calib':
        if (proc && msg.dir) {
          dirRef.current = msg.dir;
          proc.direction = msg.dir;
          proc.calibration.done = true;
        }
        break;
      case 'motion':
        if (proc && Array.isArray(msg.samples)) {
          for (const s of msg.samples) {
            if (proc.calibration.startTime == null) proc.calibration.startTime = s.t;
            const fakeEvent = {
              acceleration: s.ax != null ? { x: s.ax, y: s.ay, z: s.az } : null,
              accelerationIncludingGravity: s.axg != null
                ? { x: s.axg, y: s.ayg, z: s.azg }
                : null,
            };
            // handleMotion records into recordingRef itself (with t = s.t).
            handleMotion.current(fakeEvent, s.t);
          }
        }
        break;
      case 'orientation':
        if (Array.isArray(msg.samples)) {
          const rec = recordingRef.current;
          for (const s of msg.samples) {
            if (s.beta != null) orientationRef.current = { beta: s.beta, gamma: s.gamma };
            if (rec) rec.orientation.push(s);
          }
        }
        break;
      case 'gps':
        if (Array.isArray(msg.samples)) {
          const rec = recordingRef.current;
          for (const s of msg.samples) {
            gpsRef.current.speeds.push({ time: s.t, speed: s.speed });
            if (rec) rec.gps.push(s);
          }
          const speeds = gpsRef.current.speeds;
          if (speeds.length) {
            const cutoff = speeds[speeds.length - 1].time - 30000;
            gpsRef.current.speeds = speeds.filter(g => g.time > cutoff);
          }
        }
        break;
      default:
        break;
    }
  };

  const handlePeerOpen = (conn) => {
    // Rower: catch a coach up if it joins mid-session.
    if (linkRole !== 'rower' || !isCapturing) return;
    try {
      conn.send({ type: 'capture', active: true });
      const proc = procRef.current;
      if (proc?.calibration?.done && proc.direction) {
        conn.send({ type: 'calib', dir: proc.direction });
        calibSentRef.current = true;
      }
    } catch { /* ignore */ }
  };

  const link = usePeerLink({
    page: 'live',
    onData: handlePeerData,
    onOpen: handlePeerOpen,
    onJoin: () => setLinkRole('coach'),
  });
  // Stable references (useCallback in the hook) — safe to use in effect deps.
  const { isOpen: linkIsOpen, sendData: linkSendData, sendBatch: linkSendBatch } = link;

  // Attach / detach the devicemotion listener (rower only — coach never uses
  // its own sensors; it feeds the received stream into handleMotion directly).
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => handleMotion.current(e);
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }, [isCapturing]);

  // Attach / detach the deviceorientation listener (for gravity compensation)
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => {
      if (e.beta != null) {
        const t = performance.now();
        orientationRef.current = { beta: e.beta, gamma: e.gamma };
        const sample = { t, beta: e.beta, gamma: e.gamma };
        const rec = recordingRef.current;
        if (rec) rec.orientation.push(sample);
        sendBufferRef.current.orientation.push(sample);
        persistBufferRef.current.orientation.push(sample);
      }
    };
    window.addEventListener('deviceorientation', handler);
    return () => window.removeEventListener('deviceorientation', handler);
  }, [isCapturing]);

  // Periodic UI refresh during capture or while watching a coach stream
  // (avoids 60 Hz React renders)
  useEffect(() => {
    if (!isCapturing && !isWatching) return;
    const id = setInterval(() => {
      const proc = procRef.current;
      if (!proc) return;
      if (isPausedRef.current) return; // frozen for stroke inspection
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setLiveSplitSpeed(proc.lastGpsSpeed ?? null);
      setAvgCurve(proc.avgCurve);
      setHasGPSAnchoring(proc.hasGPS);

      // Boat rowing? Use the latest processed sample time (works for both the
      // rower's clock and a coach's stream of rower-stamped samples) so the
      // idle indicator updates even when no strokes are being detected.
      const ref = proc.lastSampleTime;
      const spd = ref ? windowedGpsSpeed(gpsRef.current.speeds, ref, SPLIT_WINDOW_MS) : null;
      setIsActive(spd != null && spd >= MIN_ROW_SPEED && spd <= MAX_ROW_SPEED);

      if (proc.calibration.done && proc.direction) {
        setCalibrationStatus('detected');
        // Rower: send the locked direction to the coach, and re-send after a remount.
        if (linkRole === 'rower' && linkIsOpen() && !calibSentRef.current) {
          linkSendData({ type: 'calib', dir: proc.direction });
          calibSentRef.current = true;
        }
      } else if (!proc.calibration.done) {
        setCalibrationStatus('calibrating');
      }
    }, UI_UPDATE_MS);
    return () => clearInterval(id);
  }, [isCapturing, isWatching, linkRole, linkIsOpen, linkSendData]);

  // Clean up the streaming + persistence intervals on unmount (the peer link
  // and wake lock self-clean via their own hooks).
  useEffect(() => () => {
    if (sendIntervalRef.current != null) clearInterval(sendIntervalRef.current);
    if (persistIntervalRef.current != null) clearInterval(persistIntervalRef.current);
  }, []);

  // On mount, check IndexedDB for a session that didn't end cleanly and offer
  // to recover it. Only meaningful for the rower (the phone doing the capture).
  useEffect(() => {
    let cancelled = false;
    sessionStore.load()
      .then((rec) => {
        if (cancelled) return;
        if (rec && rec.motion && rec.motion.length > 0) setRecoverable(rec);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRecoveryChecked(true); });
    return () => { cancelled = true; };
  }, []);

  const recoverSession = () => {
    const rec = recoverable;
    setRecoverable(null);
    sessionStore.clear().catch(() => {});
    if (rec) replayRecording(rec);
  };

  const discardRecoverable = () => {
    setRecoverable(null);
    sessionStore.clear().catch(() => {});
  };

  const startCapture = async () => {
    procRef.current = makeProc(performance.now());
    dirRef.current = { x: 0, y: 1, z: 0 };
    recordingRef.current = {
      version: 1,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      motion: [],
      orientation: [],
      gps: [],
    };
    sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    persistBufferRef.current = { motion: [], orientation: [], gps: [] };
    calibSentRef.current = false;
    setRecoverable(null);
    setStrokeRate(0);
    setStrokeCount(0);
    setLastStroke(null);
    setAvgCurve(null);
    setLiveSplitSpeed(null);
    setCalibrationStatus('calibrating');
    setIsActive(false);
    setHasGPSAnchoring(false);
    setHasRecording(false);
    setStrokes([]);
    setSelection(null);
    setSelectedIndex(null);
    setIsCapturing(true);

    // Tell a connected coach a session is starting, then stream to it.
    linkSendData({ type: 'capture', active: true });
    sendIntervalRef.current = setInterval(() => {
      linkSendBatch(sendBufferRef.current);
      sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    }, SEND_BATCH_MS);

    // Persist raw samples to IndexedDB so a crash / reload / backgrounded-tab
    // reap doesn't lose the session — it can be recovered on next load.
    sessionStore.begin(recordingRef.current).catch(() => {});
    persistIntervalRef.current = setInterval(() => {
      const buf = persistBufferRef.current;
      if (buf.motion.length || buf.orientation.length || buf.gps.length) {
        persistBufferRef.current = { motion: [], orientation: [], gps: [] };
        sessionStore.appendBatch(buf).catch(() => {});
      }
    }, PERSIST_FLUSH_MS);

    // Start GPS tracking
    if ('geolocation' in navigator) {
      setGpsStatus('requesting');
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (pos.coords.speed != null && pos.coords.speed >= 0) {
            const gpsTime = performance.now() - (Date.now() - pos.timestamp);
            gpsRef.current.speeds.push({ time: gpsTime, speed: pos.coords.speed });
            // Keep last 30 seconds
            const cutoff = performance.now() - 30000;
            gpsRef.current.speeds = gpsRef.current.speeds.filter(s => s.time > cutoff);
            const rec = recordingRef.current;
            const gpsSample = { t: gpsTime, speed: pos.coords.speed };
            if (rec) rec.gps.push(gpsSample);
            sendBufferRef.current.gps.push(gpsSample);
            persistBufferRef.current.gps.push(gpsSample);
          }
          setGpsStatus('active');
        },
        () => { setGpsStatus('unavailable'); },
        { enableHighAccuracy: true, maximumAge: 0 }
      );
      gpsRef.current.watchId = watchId;
    } else {
      setGpsStatus('unavailable');
    }

    // Keep the screen awake while rowing — re-acquired automatically if the
    // phone blinks off during the hand-off into the boat.
    wakeLock.request();
  };

  const stopCapture = () => {
    setIsCapturing(false);
    // Copy final state from processing refs
    const proc = procRef.current;
    if (proc) {
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setAvgCurve(proc.avgCurve);
      setHasGPSAnchoring(proc.hasGPS);
      setStrokes([...proc.strokes]);
      setSelection(null);
      setSelectedIndex(null);
    }
    // Stop GPS
    if (gpsRef.current.watchId != null) {
      navigator.geolocation.clearWatch(gpsRef.current.watchId);
      gpsRef.current.watchId = null;
    }
    // Stop streaming and tell the coach the session ended.
    if (sendIntervalRef.current != null) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }
    linkSendData({ type: 'capture', active: false });
    wakeLock.release();
    // Clean stop: flush the tail, then clear the recovery copy so we don't
    // prompt to recover a session the rower already finished.
    if (persistIntervalRef.current != null) {
      clearInterval(persistIntervalRef.current);
      persistIntervalRef.current = null;
    }
    sessionStore.clear().catch(() => {});
    const rec = recordingRef.current;
    if (rec && rec.motion.length > 0) setHasRecording(true);
  };

  // Auto-start so the coach can hand over a phone that's already capturing —
  // no tap required. Fires once per mount, only for the rower, only once
  // sensors are ready, and never over a pending recovery offer or an existing
  // session. On iOS the first capture still needs a tap to grant motion access
  // (requestPermission must follow a user gesture); after that this kicks in.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!recoveryChecked) return; // don't wipe a recoverable session by starting
    if (linkRole !== 'rower') return;
    if (sensorStatus !== 'available') return;
    if (isCapturing || hasRecording || strokeCount > 0) return;
    if (recoverable) return;
    autoStartedRef.current = true;
    startCapture();
    // startCapture is stable enough for this one-shot guarded effect; deps are
    // the readiness signals that gate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkRole, sensorStatus, isCapturing, hasRecording, strokeCount, recoverable, recoveryChecked]);

  // --- Accidental-exit guard (while capturing) ---
  // The phone gets jostled into the boat; a stray tap or back-swipe must not
  // kill the session. beforeunload covers reload / close / PWA dismiss; the
  // history sentinel turns a back gesture into a no-op + hint instead of
  // unmounting the page.
  const [navHint, setNavHint] = useState(false);
  const navHintTimerRef = useRef(null);
  useEffect(() => {
    if (!isCapturing) return;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);

    window.history.pushState({ liveTrap: true }, '');
    const onPop = () => {
      window.history.pushState({ liveTrap: true }, '');
      setNavHint(true);
      if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
      navHintTimerRef.current = setTimeout(() => setNavHint(false), 2600);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPop);
      if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
    };
  }, [isCapturing]);

  // --- Hold-to-stop ---
  // A single tap can't end capture; the stop control must be held for ~1s so a
  // fumble while handling the phone doesn't kill the recording.
  const HOLD_STOP_MS = 1000;
  const [holdPct, setHoldPct] = useState(0);
  const holdRafRef = useRef(null);
  const holdStartRef = useRef(0);
  const cancelHoldStop = () => {
    if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current);
    holdRafRef.current = null;
    setHoldPct(0);
  };
  const beginHoldStop = () => {
    holdStartRef.current = performance.now();
    const tick = () => {
      const pct = Math.min(100, ((performance.now() - holdStartRef.current) / HOLD_STOP_MS) * 100);
      setHoldPct(pct);
      if (pct >= 100) {
        cancelHoldStop();
        stopCapture();
      } else {
        holdRafRef.current = requestAnimationFrame(tick);
      }
    };
    holdRafRef.current = requestAnimationFrame(tick);
  };

  const downloadRecording = () => {
    const rec = recordingRef.current;
    if (!rec || rec.motion.length === 0) return;
    const json = JSON.stringify(rec);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = (rec.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `free-speed-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const replayRecording = (recording) => {
    procRef.current = makeProc(recording.motion[0]?.t ?? 0);
    dirRef.current = { x: 0, y: 1, z: 0 };
    gpsRef.current.speeds = [];
    orientationRef.current = { beta: 0, gamma: 0 };

    // Disable live recording so the replay doesn't double-record into the source data
    recordingRef.current = null;

    const events = [];
    for (const m of recording.motion || []) events.push({ k: 'm', t: m.t, d: m });
    for (const o of recording.orientation || []) events.push({ k: 'o', t: o.t, d: o });
    for (const g of recording.gps || []) events.push({ k: 'g', t: g.t, d: g });
    events.sort((a, b) => a.t - b.t);

    for (const ev of events) {
      if (ev.k === 'o') {
        if (ev.d.beta != null) orientationRef.current = { beta: ev.d.beta, gamma: ev.d.gamma };
      } else if (ev.k === 'g') {
        gpsRef.current.speeds.push({ time: ev.t, speed: ev.d.speed });
        const cutoff = ev.t - 30000;
        gpsRef.current.speeds = gpsRef.current.speeds.filter(s => s.time > cutoff);
      } else {
        const fakeEvent = {
          acceleration: ev.d.ax != null ? { x: ev.d.ax, y: ev.d.ay, z: ev.d.az } : null,
          accelerationIncludingGravity: ev.d.axg != null
            ? { x: ev.d.axg, y: ev.d.ayg, z: ev.d.azg }
            : null,
        };
        handleMotion.current(fakeEvent, ev.t);
      }
    }

    // Restore so a follow-up download re-exports the same recording
    recordingRef.current = recording;

    const proc = procRef.current;
    setStrokeRate(proc.strokeRate);
    setStrokeCount(proc.strokeCount);
    setLastStroke(proc.lastStroke);
    setAvgCurve(proc.avgCurve);
    setHasGPSAnchoring(proc.hasGPS);
    setCalibrationStatus(proc.direction ? 'detected' : 'idle');
    setStrokes([...proc.strokes]);
    setSelection(null);
    setSelectedIndex(null);
    setHasRecording(true);
  };

  const handleLoadRecording = (file) => {
    setIsReplaying(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      // Yield so the "Replaying…" button state renders before the (potentially
      // multi-second) synchronous replay blocks the main thread.
      setTimeout(() => {
        try {
          const recording = JSON.parse(e.target.result);
          if (!recording.motion || !Array.isArray(recording.motion)) {
            throw new Error('missing motion array');
          }
          replayRecording(recording);
        } catch (err) {
          alert('Failed to load recording: ' + err.message);
        }
        setIsReplaying(false);
      }, 50);
    };
    reader.onerror = () => {
      alert('Failed to read file');
      setIsReplaying(false);
    };
    reader.readAsText(file);
  };

  const handleSave = () => {
    const curveToSave = displayAvgCurve;
    if (!curveToSave || !onSaveCurve) return;

    let scaledSpeeds;
    let raceTime;
    if (hasGPSAnchoring) {
      // GPS-anchored curves are already in real m/s — pass through as-is
      scaledSpeeds = [...curveToSave];
      const curAvg = curveToSave.reduce((a, b) => a + b, 0) / curveToSave.length;
      // 2000m finish time at the measured average boat speed
      if (curAvg > 0) raceTime = 2000 / curAvg;
    } else {
      // Scale captured average so its mean matches the reference curve
      const curAvg = curveToSave.reduce((a, b) => a + b, 0) / curveToSave.length;
      const scale = REF_AVG / curAvg;
      scaledSpeeds = curveToSave.map(v => v * scale);
    }
    onSaveCurve({
      name: `Live Capture ${new Date().toLocaleString()}`,
      desc: `${displayCount} strokes at ${strokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`,
      speeds: scaledSpeeds,
      strokeRate: strokeRate || 36,
      raceTime,
    });
  };

  // --- Chart ---

  // When we have a stroke snapshot (after stop/replay), derive the average from
  // the selected subset. Otherwise (live capture) fall back to the running avg.
  const selectedStrokes = useMemo(() => {
    if (strokes.length === 0) return null;
    if (!selection) return strokes;
    return strokes.filter(s => s.time >= selection.min && s.time <= selection.max);
  }, [strokes, selection]);

  const displayAvgCurve = useMemo(() => {
    if (selectedStrokes && selectedStrokes.length > 0) return averageCurves(selectedStrokes);
    return avgCurve;
  }, [selectedStrokes, avgCurve]);

  const displayCount = selectedStrokes ? selectedStrokes.length : strokeCount;

  const individualStroke = (selectedIndex != null && strokes[selectedIndex]) || null;

  const chartData = useMemo(() => {
    const datasets = [
      {
        label: 'Your potential',
        data: REF_SPEEDS.map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: 'rgba(75, 192, 192, 1)',
        borderWidth: 3,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
    ];

    if (displayAvgCurve) {
      datasets.push({
        label: individualStroke
          ? `Average (${displayCount} strokes)`
          : `Average (${displayCount} strokes)`,
        data: displayAvgCurve.map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: individualStroke ? 'rgba(102, 126, 234, 0.35)' : '#667eea',
        backgroundColor: individualStroke
          ? 'rgba(102, 126, 234, 0.04)'
          : 'rgba(102, 126, 234, 0.1)',
        borderWidth: individualStroke ? 2 : 3,
        pointRadius: 0,
        tension: 0.4,
        fill: !individualStroke,
      });
    }

    if (individualStroke) {
      datasets.push({
        label: `Stroke #${selectedIndex + 1} of ${strokes.length}`,
        data: individualStroke.curve.map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      });
    } else if (lastStroke && displayAvgCurve) {
      datasets.push({
        label: 'Last Stroke',
        data: lastStroke.map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: 'rgba(255, 99, 132, 0.4)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      });
    }

    return { datasets };
  }, [displayAvgCurve, lastStroke, displayCount, individualStroke, selectedIndex, strokes.length]);

  // --- Stroke-time chart (one point per stroke, drag-to-select range) ---

  // When GPS-anchored, display y as 500m split (seconds). Faster strokes = lower
  // split = lower on chart, matching standard rowing dashboards.
  const formatSplit = (seconds) => {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  };
  // Per-stroke y value: GPS-derived split (s/500m) when anchored, else the
  // relative curve mean. Null when anchored but this stroke lacked GPS (gaps).
  const strokeY = (s) => {
    if (hasGPSAnchoring) return s.gpsSpeed > 0 ? 500 / s.gpsSpeed : null;
    return s.avgSpeed;
  };

  const t0 = strokes.length > 0 ? strokes[0].time : 0;
  const timeChartData = useMemo(() => {
    if (strokes.length === 0) return { datasets: [] };
    return {
      datasets: [{
        label: 'Stroke split',
        data: strokes.map(s => ({ x: (s.time - t0) / 1000, y: strokeY(s) })),
        spanGaps: true,
        borderColor: '#667eea',
        backgroundColor: (ctx) => ctx.dataIndex === selectedIndex ? '#ef4444' : '#667eea',
        borderWidth: 1.5,
        pointRadius: (ctx) => ctx.dataIndex === selectedIndex ? 6 : 2.5,
        pointHoverRadius: 6,
        tension: 0,
        fill: false,
      }],
    };
  }, [strokes, t0, selectedIndex, hasGPSAnchoring]);

  const timeChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    // Tap the nearest stroke by x — small dense points are otherwise unhittable
    // on touch, especially before zooming in.
    interaction: { mode: 'nearest', intersect: false, axis: 'x' },
    onClick: (_event, elements) => {
      if (elements.length > 0) setSelectedIndex(elements[0].index);
    },
    plugins: {
      legend: { display: false },
      title: {
        display: true,
        text: 'Tap a stroke to inspect • drag the slider to zoom to a range',
        font: { size: 13, weight: 'normal' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'linear',
        // The range slider zooms the chart: with 1000+ strokes the only way to
        // tap an individual one is to narrow the window first. Pad so a narrow
        // (even single-stroke) selection still has width and edge points show.
        ...(selection
          ? (() => {
              const lo = (selection.min - t0) / 1000;
              const hi = (selection.max - t0) / 1000;
              const pad = Math.max((hi - lo) * 0.05, 1);
              return { min: lo - pad, max: hi + pad };
            })()
          : {}),
        title: { display: true, text: 'Time (s)', font: { size: 11 } },
      },
      y: {
        title: {
          display: true,
          text: hasGPSAnchoring ? 'Split / 500m' : 'Avg speed (relative)',
          font: { size: 11 },
        },
        ticks: hasGPSAnchoring
          ? { callback: (v) => formatSplit(v) }
          : undefined,
      },
    },
  }), [hasGPSAnchoring, selection, t0]);

  const resetSelection = () => {
    setSelection(null);
    setSelectedIndex(null);
  };

  // Prev/next step through strokes — when a range is selected, restrict to it.
  const stepStroke = (dir) => {
    if (strokes.length === 0) return;
    const inRange = (i) =>
      !selection ||
      (strokes[i].time >= selection.min && strokes[i].time <= selection.max);
    let i = selectedIndex;
    if (i == null) {
      // Start from the first in-range stroke (or end, depending on direction)
      i = dir > 0 ? -1 : strokes.length;
    }
    for (let step = 0; step < strokes.length; step++) {
      i += dir;
      if (i < 0 || i >= strokes.length) return;
      if (inRange(i)) {
        setSelectedIndex(i);
        return;
      }
    }
  };

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          usePointStyle: true,
          pointStyle: 'line',
          font: { size: 11 },
          generateLabels: (chart) => {
            const labels = ChartJS.defaults.plugins.legend.labels.generateLabels(chart);
            labels.forEach(label => {
              if (label.text.includes('potential')) label.lineDash = [5, 5];
            });
            return labels;
          },
        },
      },
      title: {
        display: true,
        text: 'Stroke Speed Profile',
        font: { size: 16, weight: 'bold' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: 1,
        title: { display: true, text: 'Stroke Phase', font: { size: 12 } },
        ticks: {
          callback: (val) => Math.round(val * 100) + '%',
          maxTicksLimit: 6,
        },
      },
      y: {
        ...(hasGPSAnchoring
          ? { title: { display: true, text: 'Boat Speed (m/s)', font: { size: 12 } } }
          : { min: 2, max: 8, title: { display: true, text: 'Boat Speed (relative)', font: { size: 12 } } }
        ),
      },
    },
  }), [hasGPSAnchoring]);

  // --- Render ---

  const isLive = isCapturing || isWatching;
  const gpsActive = gpsStatus === 'active' || hasGPSAnchoring;

  const peerLabel = ({
    idle: 'Off',
    initializing: 'Initializing…',
    online: linkRole === 'coach' ? 'Ready — connect to the rower' : 'Online — waiting for a coach',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: `Error: ${link.peerError}`,
  })[link.peerStatus] ?? link.peerStatus;

  // Once connected, collapse the whole pairing UI to a one-line indicator —
  // the QR/code/role toggle only matter until the link is established.
  const linkPanel = link.peerStatus === 'connected' ? (
    <div className="live-link live-link-connected">
      <span className="live-link-dot" />
      <span>{linkRole === 'coach' ? 'Connected to rower' : 'Coach connected'}</span>
    </div>
  ) : (
    <div className="live-link">
      <div className="oar-role-toggle">
        <label className={linkRole === 'rower' ? 'active' : ''}>
          <input
            type="radio"
            name="live-role"
            value="rower"
            checked={linkRole === 'rower'}
            onChange={() => setLinkRole('rower')}
            disabled={isCapturing || isWatching}
          />
          This phone is in the boat (rower)
        </label>
        <label className={linkRole === 'coach' ? 'active' : ''}>
          <input
            type="radio"
            name="live-role"
            value="coach"
            checked={linkRole === 'coach'}
            onChange={() => setLinkRole('coach')}
            disabled={isCapturing || isWatching}
          />
          Watch a rower's phone (coach)
        </label>
      </div>

      <p className="oar-status">Coach link: {peerLabel}</p>
      {!link.hasPeer && (
        <button className="btn btn-secondary btn-sm" onClick={link.initPeer}>
          Enable coach link
        </button>
      )}
      {link.hasPeer && (
        <>
          <div className="oar-join-card">
            <div className="oar-short-code">{link.shortCode || '…'}</div>
            <div className="oar-join-hint">
              {linkRole === 'rower'
                ? 'Coach scans this QR or types this code to watch.'
                : "Scan the rower's QR, or enter the rower's code below."}
            </div>
            {link.qrDataUrl && (
              <img className="oar-qr" src={link.qrDataUrl} alt="Join QR code" />
            )}
          </div>
          <div className="oar-row">
            <input
              type="text"
              inputMode="numeric"
              value={link.remoteShortCode}
              onChange={(e) => link.setRemoteShortCode(e.target.value)}
              placeholder="Other phone's code"
              disabled={link.peerStatus === 'connected'}
            />
            <button
              className="btn btn-secondary"
              onClick={() => link.connectToRemote()}
              disabled={!link.myPeerId || !link.remoteShortCode.trim() || link.peerStatus === 'connected'}
            >
              Connect
            </button>
          </div>
        </>
      )}
    </div>
  );

  // Boat speed as a 500m split, from GPS speed (accurate) rather than the IMU
  // curve. Inspecting a stroke → that stroke; reviewing a range → its mean;
  // live → the latest stroke. Only meaningful when GPS-anchored.
  const splitFromStroke = (s) => (s && s.gpsSpeed > 0 ? s.gpsSpeed : null);
  let displaySplitSpeed = null;
  if (individualStroke) {
    displaySplitSpeed = splitFromStroke(individualStroke);
  } else if (selectedStrokes && selectedStrokes.length > 0) {
    const vals = selectedStrokes.map(splitFromStroke).filter((v) => v != null);
    displaySplitSpeed = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  } else {
    displaySplitSpeed = liveSplitSpeed;
  }
  const splitText = hasGPSAnchoring && displaySplitSpeed > 0 ? formatSplit(500 / displaySplitSpeed) : '—';

  // Speed (m/s) available by matching the potential curve's shape at your
  // current effort — see freeSpeedGain. Uses the latest stroke while live so it
  // updates every stroke (the inspected stroke when reviewing one, else the
  // selected average). Only meaningful when GPS-anchored.
  const freeSpeedSource = individualStroke ? individualStroke.curve
    : isLive ? lastStroke
    : displayAvgCurve;
  const freeSpeed = hasGPSAnchoring ? freeSpeedGain(freeSpeedSource, REF_SPEEDS) : null;

  const statsView = (
    <div className="live-stats">
      <div className="live-stat">
        <span className="live-stat-value">{strokeRate || '—'}</span>
        <span className="live-stat-label">spm</span>
      </div>
      <div className="live-stat">
        <span className="live-stat-value">{strokeCount}</span>
        <span className="live-stat-label">strokes</span>
      </div>
      {(isLive || strokes.length > 0) && (
        <div className="live-stat">
          <span className="live-stat-value live-split-value">{splitText}</span>
          <span className="live-stat-label">/500m</span>
        </div>
      )}
      <div className="live-stat">
        <span className={`live-stat-value live-gps-value ${gpsActive ? 'gps-active' : ''}`}>
          {gpsActive ? 'GPS' : gpsStatus === 'requesting' ? '...' : '—'}
        </span>
        <span className="live-stat-label">
          {hasGPSAnchoring
            ? 'anchored'
            : gpsStatus === 'active' ? 'waiting'
            : gpsStatus === 'unavailable' ? 'no gps' : 'gps'}
        </span>
      </div>
    </div>
  );

  const chartView = (
    <div className="live-chart-container">
      <div className="live-chart-wrapper">
        <Line data={chartData} options={chartOptions} />
      </div>
      <button
        className="live-bigscreen-btn"
        onClick={() => setBigScreen(true)}
        aria-label="Full-screen display"
        title="Full-screen display"
      >
        {'⛶'}
      </button>
      {!avgCurve && isLive && calibrationStatus === 'calibrating' && (
        <div className="live-chart-overlay">
          <span className="live-calibrating">
            {linkRole === 'coach' ? 'Receiving — detecting orientation…' : 'Detecting orientation — row a few strokes...'}
          </span>
        </div>
      )}
      {!avgCurve && isLive && calibrationStatus !== 'calibrating' && (
        <div className="live-chart-overlay">Waiting for strokes...</div>
      )}
      {!avgCurve && !isLive && strokeCount === 0 && (
        <div className="live-chart-overlay">
          {linkRole === 'coach' ? 'Waiting for the rower to start…' : 'Tap Start Capture, then row'}
        </div>
      )}
    </div>
  );

  // The stroke inspector is available after a session ends and, for a coach,
  // while paused mid-session.
  const showStrokeInspector = (!isLive || isPaused) && strokes.length > 1;

  // Two-thumb range slider, in stroke-index space. Thumb positions are derived
  // from `selection` (which is in stroke-time ms) so there's a single source of
  // truth; dragging a thumb writes selection back. Touch-friendly, unlike the
  // old mouse-only drag-to-zoom.
  const lastIdx = Math.max(0, strokes.length - 1);
  let rangeLo = 0;
  let rangeHi = lastIdx;
  if (selection) {
    const lo = strokes.findIndex(s => s.time >= selection.min);
    rangeLo = lo < 0 ? 0 : lo;
    for (let i = lastIdx; i >= 0; i--) {
      if (strokes[i] && strokes[i].time <= selection.max) { rangeHi = i; break; }
    }
  }
  const applyRange = (lo, hi) => {
    const a = Math.max(0, Math.min(lo, hi));
    const b = Math.min(lastIdx, Math.max(lo, hi));
    setSelection(a <= 0 && b >= lastIdx ? null : { min: strokes[a].time, max: strokes[b].time });
    setSelectedIndex(null);
  };
  const loPct = lastIdx > 0 ? (rangeLo / lastIdx) * 100 : 0;
  const hiPct = lastIdx > 0 ? (rangeHi / lastIdx) * 100 : 100;

  const timeChartView = showStrokeInspector && (
    <div className="live-time-chart">
      <div className="live-time-chart-wrapper">
        <Line data={timeChartData} options={timeChartOptions} />
      </div>
      <div className="live-range-slider">
        <div className="live-range-track" />
        <div className="live-range-fill" style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }} />
        <input
          className="live-range-input live-range-lo"
          type="range"
          min={0}
          max={lastIdx}
          step={1}
          value={rangeLo}
          /* Raise above the high thumb when stuck at the top end so it stays grabbable. */
          style={rangeLo >= lastIdx ? { zIndex: 5 } : undefined}
          onChange={(e) => applyRange(Math.min(+e.target.value, rangeHi), rangeHi)}
          aria-label="Range start stroke"
        />
        <input
          className="live-range-input live-range-hi"
          type="range"
          min={0}
          max={lastIdx}
          step={1}
          value={rangeHi}
          onChange={(e) => applyRange(rangeLo, Math.max(+e.target.value, rangeLo))}
          aria-label="Range end stroke"
        />
      </div>
      <div className="live-time-chart-footer">
        <span>
          {isPaused ? 'Paused · ' : ''}
          {individualStroke
            ? `Viewing stroke #${selectedIndex + 1} of ${strokes.length}${
                splitText !== '—' ? ` · ${splitText} /500m` : ''}`
            : selection
              ? `${displayCount} of ${strokes.length} strokes selected${
                  splitText !== '—' ? ` · ${splitText} /500m` : ''}`
              : `All ${strokes.length} strokes`}
        </span>
        <div className="live-time-chart-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(-1)} disabled={strokes.length === 0}>
            ← Prev
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(1)} disabled={strokes.length === 0}>
            Next →
          </button>
          {individualStroke && (
            <button className="btn btn-secondary btn-sm" onClick={() => setSelectedIndex(null)}>
              Show average
            </button>
          )}
          {selection && (
            <button className="btn btn-secondary btn-sm" onClick={resetSelection}>
              Reset range
            </button>
          )}
        </div>
      </div>
    </div>
  );

  // Activity indicator. Orientation is now tracked automatically as a free 3D
  // direction, so there's nothing to show about it — what matters to the rower
  // is whether capture is live (rowing) or paused (drifting / stopped / no GPS).
  const activityView = (
    <div className="live-axis-config">
      {isLive && calibrationStatus === 'calibrating' && (
        <span className="live-orientation-detecting">Detecting orientation…</span>
      )}
      {isLive && calibrationStatus !== 'calibrating' && isActive && (
        <span className="live-orientation-detected">● Rowing</span>
      )}
      {isLive && calibrationStatus !== 'calibrating' && !isActive && (
        <span className="live-orientation-idle">
          {gpsStatus === 'unavailable' ? 'Paused — waiting for GPS…'
            : gpsStatus === 'requesting' ? 'Paused — acquiring GPS…'
            : 'Paused — waiting for the boat to move'}
        </span>
      )}
    </div>
  );

  // Save / download (shared by both roles once a session has ended).
  const sessionActions = (
    <>
      {avgCurve && (
        <button className="btn btn-primary btn-large" onClick={handleSave}>
          Save & Open in Calculator
        </button>
      )}
      {hasRecording && (
        <button className="btn btn-secondary btn-large" onClick={downloadRecording}>
          Download recording
        </button>
      )}
    </>
  );

  return (
    <div className="live-capture">
      {bigScreen && (
        <LiveBigScreen
          splitText={splitText}
          freeSpeed={freeSpeed}
          strokeRate={strokeRate}
          chartData={chartData}
          hasGPSAnchoring={hasGPSAnchoring}
          onClose={() => setBigScreen(false)}
        />
      )}
      <div className="live-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Calculator</button>
        <h2>Live Stroke Capture</h2>
      </div>

      {linkPanel}

      {recoverable && !isLive && (
        <div className="live-recover">
          <span className="live-recover-text">
            A previous capture ({recoverable.motion.length.toLocaleString()} samples) didn't finish.
          </span>
          <div className="live-recover-actions">
            <button className="btn btn-primary btn-sm" onClick={recoverSession}>Recover</button>
            <button className="btn btn-secondary btn-sm" onClick={discardRecoverable}>Discard</button>
          </div>
        </div>
      )}

      {navHint && (
        <div className="live-nav-hint" role="status">
          Capture is running — hold <strong>Stop</strong> to end it.
        </div>
      )}

      {linkRole === 'coach' ? (
        <>
          <div className="live-guide">
            {link.peerStatus === 'connected'
              ? (isWatching
                  ? "Receiving live data from the rower's phone."
                  : 'Connected. Waiting for the rower to start capturing…')
              : "Connect to the rower's phone above to watch their live stroke data."}
          </div>
          {statsView}
          {chartView}
          {timeChartView}
          {activityView}
          <div className="live-actions">
            {isWatching && (
              isPaused ? (
                <button className="btn btn-primary btn-large" onClick={resumeWatch}>
                  Resume live
                </button>
              ) : (
                <button className="btn btn-secondary btn-large" onClick={pauseWatch}>
                  Pause to inspect
                </button>
              )
            )}
            {avgCurve && (
              <button className="btn btn-primary btn-large" onClick={handleSave}>
                Save & Open in Calculator
              </button>
            )}
            {(hasRecording || (isWatching && strokeCount > 0)) && (
              <button className="btn btn-secondary btn-large" onClick={downloadRecording}>
                Download recording
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {sensorStatus === 'checking' && (
            <div className="live-message"><p>Checking sensor availability...</p></div>
          )}

          {sensorStatus === 'unavailable' && (
            <div className="live-message">
              <h3>Sensors Not Available</h3>
              <p>
                This feature requires a device with an accelerometer.
                Open this page on your phone or tablet and mount it in the boat.
                {' '}(You can still switch to coach mode above to watch another phone.)
              </p>
            </div>
          )}

          {sensorStatus === 'permission_needed' && (
            <div className="live-permission">
              <p>Motion sensor access is required to capture stroke data.</p>
              <button className="btn btn-primary" onClick={requestPermission}>
                Grant Sensor Access
              </button>
            </div>
          )}

          {sensorStatus === 'denied' && (
            <div className="live-message">
              <h3>Permission Denied</h3>
              <p>Sensor access was denied. Allow motion access in your browser settings and reload the page.</p>
            </div>
          )}

          {sensorStatus === 'available' && (
            <>
              <div className="live-guide">
                Mount your phone anywhere stable in the boat, at any angle — the
                direction is detected automatically. Capture pauses when you stop
                rowing and resumes on its own, so warm-ups and rests don't count.
              </div>

              {statsView}
              {chartView}
              {timeChartView}
              {activityView}

              <div className="live-actions">
                {!isCapturing ? (
                  <button className="btn btn-primary btn-large live-start-btn" onClick={startCapture}>
                    {strokeCount > 0 ? 'Restart Capture' : 'Start Capture'}
                  </button>
                ) : (
                  <button
                    className="btn btn-large live-stop-btn"
                    onPointerDown={beginHoldStop}
                    onPointerUp={cancelHoldStop}
                    onPointerLeave={cancelHoldStop}
                    onPointerCancel={cancelHoldStop}
                    onContextMenu={(e) => e.preventDefault()}
                    style={holdPct > 0 ? {
                      background: `linear-gradient(to right, #7f1d1d ${holdPct}%, #dc2626 ${holdPct}%)`,
                    } : undefined}
                  >
                    {holdPct > 0 ? 'Keep holding to stop…' : 'Hold to Stop'}
                  </button>
                )}
                {!isCapturing && sessionActions}
                {!isCapturing && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/json,.json"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleLoadRecording(f);
                        e.target.value = '';
                      }}
                    />
                    <button
                      className="btn btn-secondary btn-large"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isReplaying}
                    >
                      {isReplaying ? 'Replaying…' : 'Load recording'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default LiveCapture;
