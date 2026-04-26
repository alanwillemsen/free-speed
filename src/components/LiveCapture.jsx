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
import referenceCurveData from '../data/referenceCurve.json';

ChartJS.register(LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// --- Constants ---
const NUM_POINTS = 33;
const NOISE_ALPHA = 0.4;          // EMA alpha for noise reduction
const STROKE_DETECT_ALPHA = 0.06; // EMA alpha for stroke boundary detection
const MIN_STROKE_MS = 800;
const MAX_STROKE_MS = 4000;
const MAX_STROKES = 20;           // Rolling window for averaging
const UI_UPDATE_MS = 250;
const CALIBRATION_MS = 3000;      // Auto-orientation calibration window

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

function averageCurves(strokes) {
  if (strokes.length === 0) return null;
  const avg = new Array(NUM_POINTS).fill(0);
  for (const s of strokes) {
    for (let i = 0; i < NUM_POINTS; i++) avg[i] += s[i];
  }
  for (let i = 0; i < NUM_POINTS; i++) avg[i] /= strokes.length;
  return avg;
}

// --- Orientation labels for display ---
const ORIENTATION_LABELS = {
  'x+': 'Landscape — right toward bow',
  'x-': 'Landscape — left toward bow',
  'y+': 'Portrait — top toward bow',
  'y-': 'Portrait — bottom toward bow',
};

function orientationLabel(axis, sign) {
  return ORIENTATION_LABELS[`${axis}${sign > 0 ? '+' : '-'}`] || `${axis}-axis`;
}

// --- Component ---

function LiveCapture({ onSaveCurve, onBack }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [sensorStatus, setSensorStatus] = useState('checking');

  // UI state (synced from refs periodically during capture)
  const [strokeRate, setStrokeRate] = useState(0);
  const [strokeCount, setStrokeCount] = useState(0);
  const [lastStroke, setLastStroke] = useState(null);
  const [avgCurve, setAvgCurve] = useState(null);
  const [currentAccel, setCurrentAccel] = useState(0);
  const [calibrationStatus, setCalibrationStatus] = useState('idle'); // idle | calibrating | detected
  const [detectedOrientation, setDetectedOrientation] = useState(null);
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | requesting | active | unavailable
  const [hasGPSAnchoring, setHasGPSAnchoring] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);

  // Processing state lives in refs to avoid stale closures in the 60 Hz handler
  const procRef = useRef(null);
  const axisRef = useRef({ axis: 'y', sign: 1 });
  const orientationRef = useRef({ beta: 0, gamma: 0 });
  const gpsRef = useRef({ speeds: [], watchId: null });
  const wakeLockRef = useRef(null);
  const recordingRef = useRef(null);
  const fileInputRef = useRef(null);

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
        const varX = variance(proc.calibration.samples.x);
        const varY = variance(proc.calibration.samples.y);
        // z-axis is vertical when phone is flat — ignore it
        const maxVar = Math.max(varX, varY);

        if (maxVar < 0.5) {
          // No meaningful motion yet — extend calibration
          proc.calibration.startTime = now;
          proc.calibration.samples = { x: [], y: [], z: [] };
          return;
        }

        const axis = varX > varY ? 'x' : 'y';
        const samples = proc.calibration.samples[axis];
        // Sign: the largest absolute spike is from the drive (forward push)
        const maxAbsIdx = samples.reduce(
          (best, v, i) => Math.abs(v) > Math.abs(samples[best]) ? i : best, 0
        );
        const sign = Math.sign(samples[maxAbsIdx]) || 1;

        axisRef.current = { axis, sign };
        proc.calibration.done = true;
        proc.detectedOrientation = { axis, sign };
      }
      return; // Don't process strokes during calibration
    }

    const { axis, sign } = axisRef.current;
    const raw = (accelValues[axis] ?? 0) * sign;

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
          proc.strokes.push(curve);
          if (proc.strokes.length > MAX_STROKES) proc.strokes.shift();
          proc.strokeCount++;
          proc.lastStroke = curve;
          proc.avgCurve = averageCurves(proc.strokes);

          proc.boundaryTimes.push(now);
          if (proc.boundaryTimes.length > 10) proc.boundaryTimes.shift();
          if (proc.boundaryTimes.length >= 2) {
            const ct = proc.boundaryTimes;
            proc.strokeRate = Math.round(60000 / ((ct[ct.length - 1] - ct[0]) / (ct.length - 1)));
          }
        }
      }

      proc.lastBoundaryTime = now;
      // Trim buffer to last 5 seconds
      const cutoff = now - 5000;
      proc.buffer = proc.buffer.filter(s => s.time > cutoff);
    }
  });

  // Attach / detach the devicemotion listener
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
        orientationRef.current = { beta: e.beta, gamma: e.gamma };
        const rec = recordingRef.current;
        if (rec) rec.orientation.push({ t: performance.now(), beta: e.beta, gamma: e.gamma });
      }
    };
    window.addEventListener('deviceorientation', handler);
    return () => window.removeEventListener('deviceorientation', handler);
  }, [isCapturing]);

  // Periodic UI refresh during capture (avoids 60 Hz React renders)
  useEffect(() => {
    if (!isCapturing) return;
    const id = setInterval(() => {
      const proc = procRef.current;
      if (!proc) return;
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setAvgCurve(proc.avgCurve);
      setCurrentAccel(proc.filteredAccel);
      setHasGPSAnchoring(proc.hasGPS);

      if (proc.calibration.done && proc.detectedOrientation) {
        setCalibrationStatus('detected');
        setDetectedOrientation(proc.detectedOrientation);
      } else if (!proc.calibration.done) {
        setCalibrationStatus('calibrating');
      }
    }, UI_UPDATE_MS);
    return () => clearInterval(id);
  }, [isCapturing]);

  const startCapture = async () => {
    procRef.current = {
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
      avgCurve: null,
      hasGPS: false,
      detectedOrientation: null,
      calibration: {
        startTime: performance.now(),
        samples: { x: [], y: [], z: [] },
        done: false,
      },
    };
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
    setCurrentAccel(0);
    setCalibrationStatus('calibrating');
    setDetectedOrientation(null);
    setHasGPSAnchoring(false);
    setHasRecording(false);
    setIsCapturing(true);

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
            if (rec) rec.gps.push({ t: gpsTime, speed: pos.coords.speed });
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

    // Request screen wake lock so the phone stays awake while rowing
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch { /* wake lock not supported or denied — non-critical */ }
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
    }
    // Stop GPS
    if (gpsRef.current.watchId != null) {
      navigator.geolocation.clearWatch(gpsRef.current.watchId);
      gpsRef.current.watchId = null;
    }
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    const rec = recordingRef.current;
    if (rec && rec.motion.length > 0) setHasRecording(true);
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
    procRef.current = {
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
      avgCurve: null,
      hasGPS: false,
      detectedOrientation: null,
      calibration: {
        startTime: recording.motion[0]?.t ?? 0,
        samples: { x: [], y: [], z: [] },
        done: false,
      },
    };
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
    setCurrentAccel(proc.filteredAccel);
    setHasGPSAnchoring(proc.hasGPS);
    if (proc.detectedOrientation) {
      setCalibrationStatus('detected');
      setDetectedOrientation(proc.detectedOrientation);
    } else {
      setCalibrationStatus('idle');
      setDetectedOrientation(null);
    }
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
    if (!avgCurve || !onSaveCurve) return;

    let scaledSpeeds;
    if (hasGPSAnchoring) {
      // GPS-anchored curves are already in real m/s — pass through as-is
      scaledSpeeds = [...avgCurve];
    } else {
      // Scale captured average so its mean matches the reference curve
      const curAvg = avgCurve.reduce((a, b) => a + b, 0) / avgCurve.length;
      const scale = REF_AVG / curAvg;
      scaledSpeeds = avgCurve.map(v => v * scale);
    }
    onSaveCurve({
      name: `Live Capture ${new Date().toLocaleString()}`,
      desc: `${strokeCount} strokes at ${strokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`,
      speeds: scaledSpeeds,
      strokeRate: strokeRate || 36,
    });
  };

  // --- Chart ---

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

    if (avgCurve) {
      datasets.push({
        label: `Average (${strokeCount} strokes)`,
        data: avgCurve.map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: '#667eea',
        backgroundColor: 'rgba(102, 126, 234, 0.1)',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      });
    }

    if (lastStroke && avgCurve) {
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
  }, [avgCurve, lastStroke, strokeCount]);

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

  if (sensorStatus === 'checking') {
    return (
      <div className="live-capture">
        <div className="live-header">
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Calculator</button>
          <h2>Live Stroke Capture</h2>
        </div>
        <div className="live-message"><p>Checking sensor availability...</p></div>
      </div>
    );
  }

  if (sensorStatus === 'unavailable') {
    return (
      <div className="live-capture">
        <div className="live-header">
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Calculator</button>
          <h2>Live Stroke Capture</h2>
        </div>
        <div className="live-message">
          <h3>Sensors Not Available</h3>
          <p>
            This feature requires a device with an accelerometer.
            Open this page on your phone or tablet and mount it in the boat.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="live-capture">
      <div className="live-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Calculator</button>
        <h2>Live Stroke Capture</h2>
      </div>

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
            Mount your phone flat in the boat with the screen facing up.
            Orientation is detected automatically — just start rowing.
          </div>

          <div className="live-stats">
            <div className="live-stat">
              <span className="live-stat-value">{strokeRate || '—'}</span>
              <span className="live-stat-label">spm</span>
            </div>
            <div className="live-stat">
              <span className="live-stat-value">{strokeCount}</span>
              <span className="live-stat-label">strokes</span>
            </div>
            {isCapturing && (
              <div className="live-stat">
                <span className={`live-stat-value ${currentAccel >= 0 ? 'accel-pos' : 'accel-neg'}`}>
                  {currentAccel.toFixed(1)}
                </span>
                <span className="live-stat-label">m/s²</span>
              </div>
            )}
            <div className="live-stat">
              <span className={`live-stat-value live-gps-value ${gpsStatus === 'active' ? 'gps-active' : ''}`}>
                {gpsStatus === 'active' ? 'GPS' : gpsStatus === 'requesting' ? '...' : '—'}
              </span>
              <span className="live-stat-label">
                {gpsStatus === 'active'
                  ? (hasGPSAnchoring ? 'anchored' : 'waiting')
                  : gpsStatus === 'unavailable' ? 'no gps' : 'gps'}
              </span>
            </div>
          </div>

          <div className="live-chart-container">
            <div className="live-chart-wrapper">
              <Line data={chartData} options={chartOptions} />
            </div>
            {!avgCurve && isCapturing && calibrationStatus === 'calibrating' && (
              <div className="live-chart-overlay">
                <span className="live-calibrating">Detecting orientation — row a few strokes...</span>
              </div>
            )}
            {!avgCurve && isCapturing && calibrationStatus !== 'calibrating' && (
              <div className="live-chart-overlay">Waiting for strokes...</div>
            )}
            {!avgCurve && !isCapturing && strokeCount === 0 && (
              <div className="live-chart-overlay">Tap Start Capture, then row</div>
            )}
          </div>

          <div className="live-axis-config">
            {calibrationStatus === 'detected' && detectedOrientation && (
              <span className="live-orientation-detected">
                {orientationLabel(detectedOrientation.axis, detectedOrientation.sign)}
              </span>
            )}
            {calibrationStatus === 'calibrating' && isCapturing && (
              <span className="live-orientation-detecting">Detecting orientation...</span>
            )}
            {calibrationStatus === 'idle' && (
              <span className="live-orientation-idle">Orientation auto-detected on capture</span>
            )}
          </div>

          <div className="live-actions">
            {!isCapturing ? (
              <button className="btn btn-primary btn-large live-start-btn" onClick={startCapture}>
                {strokeCount > 0 ? 'Restart Capture' : 'Start Capture'}
              </button>
            ) : (
              <button className="btn btn-large live-stop-btn" onClick={stopCapture}>
                Stop Capture
              </button>
            )}
            {!isCapturing && avgCurve && (
              <button className="btn btn-primary btn-large" onClick={handleSave}>
                Save & Open in Calculator
              </button>
            )}
            {!isCapturing && hasRecording && (
              <button className="btn btn-secondary btn-large" onClick={downloadRecording}>
                Download recording
              </button>
            )}
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
    </div>
  );
}

export default LiveCapture;
