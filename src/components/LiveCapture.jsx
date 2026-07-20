import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Chart as ChartJS,
  LinearScale,
  CategoryScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import LiveBigScreen from './LiveBigScreen';
import TrackMap from './TrackMap';
import { boatFixAt } from '../utils/geo';
import { usePeerLink } from '../hooks/usePeerLink';
import { useWakeLock } from '../hooks/useWakeLock';
import { useVideoRecorder } from '../hooks/useVideoRecorder';
import AppShell from './AppShell';
import { useChartChrome } from '../utils/chartTheme';
import * as sessionStore from '../utils/sessionStore';
import * as replayHandoff from '../utils/replayHandoff';
import * as sessionLibrary from '../utils/sessionLibrary';
import * as pairStore from '../utils/pairStore';
import * as videoStore from '../utils/videoStore';
import { packBundle } from '../utils/videoBundle';
import { catchStartIndex, rollCurve } from '../utils/curves';
import { encodeCurve } from './SavedCurves';
import {
  NUM_POINTS, MIN_ROW_SPEED, MAX_ROW_SPEED, SPLIT_WINDOW_MS,
  REF_SPEEDS, REF_AVG, REF_ROLLED, PHASE_TIMES,
  windowedGpsSpeed, averageCurves, freeSpeedSecondsFor,
  makeProc, feedSample, buildReplayEvents, subtractGravity, gravityFromAngles,
} from '../utils/strokePipeline';

ChartJS.register(LinearScale, CategoryScale, PointElement, LineElement, BarElement, Title, Tooltip, Legend, Filler);

// --- Constants (UI / networking; signal-processing constants and the stroke
// engine live in utils/strokePipeline) ---
const UI_UPDATE_MS = 250;
const SEND_BATCH_MS = 100;        // Batch outgoing samples this often when coach-linked
const PERSIST_FLUSH_MS = 2000;    // Flush new samples to IndexedDB this often (crash recovery)
const PANEL_KEY = 'freespeed_live_panel'; // last-viewed middle panel (stroke | timeline | map)
const FOLDS_KEY = 'freespeed_review_folds'; // which review sections are folded shut

// Compact date/time for the review title bar (matches the Sessions list style).
const fmtSessionWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

// --- Component ---

// `variant="analysis"`: the Stroke Analysis page. Same component, but it never
// captures, never talks to a coach (a second peer with the rower's fixed id
// would collide with the always-mounted live instance), and opens on a "Load
// stroke data" button that leads straight into the review UI.
// `active`: whether this instance is the page currently on screen — the
// always-mounted live instance keeps capturing in the background when false,
// but must not trap Back-button presses made on other pages.
function LiveCapture({ variant, active = true }) {
  const isAnalysis = variant === 'analysis';
  const [isCapturing, setIsCapturing] = useState(false);
  const [sensorStatus, setSensorStatus] = useState('checking');
  // Outdoor full-screen readout (split + spm + speed profile). Capture keeps
  // running underneath while it's open.
  const [bigScreen, setBigScreen] = useState(false);

  // Coach link: 'rower' = this phone is mounted in the boat and (optionally)
  // streams to a coach; 'coach' = this phone watches a rower's stream and runs
  // the same processing pipeline on the received samples.
  const [linkRole, setLinkRole] = useState(() => (isAnalysis ? 'rower' : pairStore.getRole()));
  const [isWatching, setIsWatching] = useState(false); // coach is receiving a live session
  // Persistent coach-link identity (stable peer id + advertised name) and, for a
  // coach, the saved roster of rowers plus their live online/busy presence.
  const [identity] = useState(() => pairStore.getIdentity());
  const [linkName, setLinkName] = useState(identity.name);
  const [roster, setRoster] = useState(() => pairStore.getRoster());
  const [presence, setPresence] = useState({}); // peer id -> { online, busy, name }
  const [linkedPeerName, setLinkedPeerName] = useState(''); // name the connected peer (rower or coach) advertised
  // Mirrors so the peer-link presence responder (called from inside the hook)
  // always sees the current name / capturing state.
  const identityNameRef = useRef(identity.name);
  identityNameRef.current = linkName;
  const isCapturingRef = useRef(false);
  isCapturingRef.current = isCapturing;
  // Coach can pause the live feed to inspect individual strokes without stopping
  // the stream — the proc keeps accumulating in the background and resume catches up.
  const [isPaused, setIsPaused] = useState(false);
  // Rower: the coach link runs automatically, so its QR / code / name pairing UI
  // is tucked behind a "Configure coach link" toggle rather than shown inline.
  const [showLinkConfig, setShowLinkConfig] = useState(false);

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
  // Distance (m) from integrating GPS speed: `piece` resets on demand (long-press
  // in full screen) to mark a new piece; `session` is the whole capture.
  const [pieceDistance, setPieceDistance] = useState(0);
  const [sessionDistance, setSessionDistance] = useState(0);
  // Mean per-stroke free speed (s/2k) over the current piece, or null. Shown on
  // the big screen under the latest stroke's free speed; resets with the piece.
  const [avgFreeSpeedSeconds, setAvgFreeSpeedSeconds] = useState(null);
  const [hasRecording, setHasRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  // Real-time replay: play a recorded row back through the live pipeline at
  // wall-clock pace so the live UI (split, spm, big screen, rowing indicator)
  // animates exactly as on the water — lets UI changes be tested from a desk.
  const [liveReplayActive, setLiveReplayActive] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  // Snapshot of all strokes after stop/replay — enables time-range selection.
  // Each entry: { time: ms, curve: number[NUM_POINTS], avgSpeed: number }.
  const [strokes, setStrokes] = useState([]);
  // Selection in stroke-time coordinates (same units as `time` above), or null = all.
  const [selection, setSelection] = useState(null);
  // Index into `strokes` for showing a single stroke instead of the median.
  // null = show the range's median (typical) stroke.
  const [selectedIndex, setSelectedIndex] = useState(null);
  // Selected histogram bin for the untapped-time distribution (review only).
  // null = default to the bin holding the median.
  const [selectedBin, setSelectedBin] = useState(null);
  // Whether the tappable explainer for the "untapped" free-speed stat is open.
  const [showFreeInfo, setShowFreeInfo] = useState(false);
  // Which main panel is showing: 'stroke' | 'map'. One at a time (the timeline
  // is not a panel — in review mode it's the always-visible navigator at the
  // bottom); persisted so a rower who only ever watches the map lands back on it.
  const [panel, setPanel] = useState(() => {
    try { return localStorage.getItem(PANEL_KEY) === 'map' ? 'map' : 'stroke'; } catch { return 'stroke'; }
  });
  // The drawer's "Rower / Coach Link Setup" destination (#link) is this same
  // page with the pairing panel forced open — review mode hides it otherwise.
  const [setupOpen, setSetupOpen] = useState(() => window.location.hash === '#link');
  useEffect(() => {
    const onHash = () => setSetupOpen(window.location.hash === '#link');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Metadata ({ name, startedAt }) of a library session opened from the Sessions
  // page, so the review title bar can show its name/datetime. null for a live
  // capture's own review or a bare imported file — the title then falls back to
  // the recording's own startedAt.
  const [loadedSession, setLoadedSession] = useState(null);
  // The untapped histogram is folded behind its stats line by default — the
  // timeline needs the vertical space more; remembered across sessions.
  const [histOpen, setHistOpen] = useState(() => {
    try { return localStorage.getItem('freespeed_live_hist') === '1'; } catch { return false; }
  });
  const toggleHist = () => {
    setHistOpen((v) => {
      try { localStorage.setItem('freespeed_live_hist', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };
  // Review mode: every section folds behind its header (true = folded shut);
  // remembered across sessions like the histogram fold.
  const [folds, setFolds] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLDS_KEY)) || {}; } catch { return {}; }
  });
  const toggleFold = (id) => {
    setFolds((f) => {
      const next = { ...f, [id]: !f[id] };
      try { localStorage.setItem(FOLDS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  // Brief lock on the start control after a stop: hold-to-stop completes while
  // the finger is still down, and the button that replaces it must not absorb
  // the release as an instant restart (which would wipe the session view).
  const [startLocked, setStartLocked] = useState(false);
  const startLockTimerRef = useRef(null);

  // Processing state lives in refs to avoid stale closures in the 60 Hz handler
  const procRef = useRef(null);
  // Boat fore-aft direction now lives on proc.direction (set by the shared
  // engine in utils/strokePipeline) — no separate ref needed.
  const orientationRef = useRef({ beta: 0, gamma: 0 });
  const gpsRef = useRef({ speeds: [], watchId: null });
  // GPS fixes with a position ({ t, lat, lon, heading|null }), kept for the whole
  // session — the map's track. Synced to `positions` state ~1/s (fix rate).
  const positionsRef = useRef([]);
  const [positions, setPositions] = useState([]);
  // Accumulated distance (m) from trapezoidal integration of GPS speed. `piece`
  // is resettable; `session` runs the whole capture. last* hold the previous
  // sample for the integration step.
  const distanceRef = useRef({ piece: 0, session: 0, lastTime: null, lastSpeed: 0 });
  // Running sum/count of per-stroke free-speed (s/2k) for the current piece, so
  // the big screen can show a piece average alongside the latest stroke's value.
  // Reset together with the piece distance (start, full reset, piece reset).
  const pieceFreeSpeedRef = useRef({ sum: 0, count: 0 });
  const recordingRef = useRef(null);
  const fileInputRef = useRef(null);
  // Holds the in-flight real-time replay loop ({ cancel, recording, ... }) or
  // null. Non-null marks a live replay (vs. a real sensor capture).
  const replayRef = useRef(null);
  const sendBufferRef = useRef({ motion: [], orientation: [], gps: [] });
  const sendIntervalRef = useRef(null);
  const calibSentRef = useRef(false); // rower: calib message sent to coach once
  const isPausedRef = useRef(false);  // coach: live feed frozen for stroke inspection
  // New samples since the last IndexedDB flush (crash-recovery persistence).
  const persistBufferRef = useRef({ motion: [], orientation: [], gps: [] });
  const persistIntervalRef = useRef(null);
  // Coach video: clock offset bridging the rower's sample clock and the coach's
  // wall/video clock (coachPerf ≈ rowerTime + offset), and the video anchor
  // captured when recording starts. lastPingRef mirrors link.lastPing for the
  // offset's transit correction without re-subscribing handlePeerData.
  const rowerToCoachRef = useRef(null);
  const videoAnchorRef = useRef(null);
  // The exact stroke recording being filmed. Pinned when the camera starts and
  // re-pinned if a new piece begins mid-recording, so the bundle always carries
  // the strokes that match the footage — not whichever piece happens to be
  // current at stop time (the old bug: film piece A at the train bridge, rower
  // starts piece B at the far end, and stopVideo grabbed piece B). The *active*
  // ref lets startWatch — reached from the peer-data handler — see that a camera
  // is rolling; *pieceCount* catches a clip that spanned a piece boundary so we
  // can warn instead of shipping a half-matching bundle.
  const videoRecordingRef = useRef(null);
  const videoRecordingActiveRef = useRef(false);
  const videoPieceCountRef = useRef(0);
  const lastPingRef = useRef(null);
  const wakeLock = useWakeLock();
  const videoRecorder = useVideoRecorder();
  // Coach video UI: whether the camera/preview is armed, and the finished bundle
  // ({ blob, meta }) once a recording stops — surfaces the share/analyze actions.
  const [videoArmed, setVideoArmed] = useState(false);
  const [videoBundle, setVideoBundle] = useState(null);
  const [savingBundle, setSavingBundle] = useState(false);
  const previewVideoRef = useRef(null);
  const cameraFsRef = useRef(null);

  // Integrate one GPS speed sample (m/s at ms `time`) into the running piece and
  // session distances by the trapezoidal rule. Skips backward/large gaps (tab
  // reaps, replay jumps) so a stale speed isn't carried across them.
  const accumulateDistance = (time, speed) => {
    const d = distanceRef.current;
    const v = Math.max(0, speed ?? 0);
    if (d.lastTime != null) {
      const dt = (time - d.lastTime) / 1000;
      if (dt > 0 && dt < 5) {
        const meters = (d.lastSpeed + v) / 2 * dt;
        d.piece += meters;
        d.session += meters;
      }
    }
    d.lastTime = time;
    d.lastSpeed = v;
  };

  const resetDistance = () => {
    distanceRef.current = { piece: 0, session: 0, lastTime: null, lastSpeed: 0 };
    pieceFreeSpeedRef.current = { sum: 0, count: 0 };
    setPieceDistance(0);
    setSessionDistance(0);
    setAvgFreeSpeedSeconds(null);
  };

  // Mark a new piece — full-screen long-press. Keeps the session total but
  // restarts the piece distance and free-speed average.
  const resetPiece = () => {
    distanceRef.current.piece = 0;
    pieceFreeSpeedRef.current = { sum: 0, count: 0 };
    setPieceDistance(0);
    setAvgFreeSpeedSeconds(null);
  };

  // Push the current piece's mean free speed (s/2k) to state, or null if none.
  const publishAvgFreeSpeed = () => {
    const fp = pieceFreeSpeedRef.current;
    setAvgFreeSpeedSeconds(fp.count > 0 ? fp.sum / fp.count : null);
  };

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
      // Gyro rates (deg/s), rounded to keep recordings lean. Not consumed by the
      // pipeline yet — recorded so future attitude analysis has a clean source.
      const rr = event.rotationRate;
      if (rr && rr.alpha != null) {
        sample.ra = Math.round(rr.alpha * 100) / 100;
        sample.rb = Math.round(rr.beta * 100) / 100;
        sample.rg = Math.round(rr.gamma * 100) / 100;
      }
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
    // `gravity` (for roll/pitch tracking) prefers the fusion's own estimate
    // (accelIncludingGravity − linearAccel); orientation angles are the fallback.
    let accelValues;
    let gravity = null;
    if (event.acceleration && event.acceleration.x != null) {
      accelValues = event.acceleration;
      const ag = event.accelerationIncludingGravity;
      if (ag && ag.x != null) {
        gravity = { x: ag.x - accelValues.x, y: ag.y - accelValues.y, z: ag.z - accelValues.z };
      }
    } else if (event.accelerationIncludingGravity && event.accelerationIncludingGravity.x != null) {
      const { beta, gamma } = orientationRef.current;
      accelValues = subtractGravity(event.accelerationIncludingGravity, beta, gamma);
      gravity = gravityFromAngles(beta, gamma);
    } else {
      // No data in this event (browsers without a sensor still fire the event
      // with null fields) — null would coerce to 0s and poison the pipeline.
      return;
    }

    // Run the shared stroke-detection engine (calibration, orientation tracking,
    // boundary detection). It mutates proc and returns the newly completed
    // stroke (or null). Live capture requires GPS to record; replay/coach-fed
    // data (nowOverride set) records without it.
    const stroke = feedSample(proc, accelValues, now, gpsRef.current.speeds, {
      allowWithoutGps: nowOverride != null,
      gravity,
    });

    // Accumulate the piece free-speed average that the big screen reads, and
    // re-send the direction to a linked coach after a remount snap (the engine
    // flags it on proc.remounted).
    if (stroke && stroke.freeSec != null) {
      pieceFreeSpeedRef.current.sum += stroke.freeSec;
      pieceFreeSpeedRef.current.count++;
    }
    if (proc.remounted) {
      proc.remounted = false;
      calibSentRef.current = false;
    }
  });

  // --- Coach watch lifecycle (coach side) ---
  // A fresh processing pipeline that consumes the rower's streamed samples
  // instead of local sensors (makeProc lives in utils/strokePipeline).
  const startWatch = () => {
    // startTime null → set from the first received motion sample, so coach-side
    // calibration spans the right window if the rower wasn't calibrated yet.
    procRef.current = makeProc(null);
    orientationRef.current = { beta: 0, gamma: 0 };
    gpsRef.current.speeds = [];
    positionsRef.current = [];
    setPositions([]);
    recordingRef.current = {
      version: 1,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      motion: [],
      orientation: [],
      gps: [],
    };
    // If the coach is filming as this piece starts, this new piece is the one on
    // camera — pin it to the video bundle so stopVideo can't attach a later piece.
    if (videoRecordingActiveRef.current) {
      videoRecordingRef.current = recordingRef.current;
      videoPieceCountRef.current += 1;
    }
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
    setLoadedSession(null); // a fresh capture/watch isn't an opened library session
    resetDistance();
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
      publishAvgFreeSpeed();
      setStrokes([...proc.strokes]);
      setSelection(null);
      setSelectedIndex(null);
    }
    setPositions([...positionsRef.current]);
    const rec = recordingRef.current;
    if (rec && rec.motion.length > 0) setHasRecording(true);
    // The coach's copy of the row is worth keeping too — save it to the
    // library like the rower's, tagged so the list shows whose phone recorded
    // it. No download fallback here: the coach page has no download UI, and
    // the rower's own save is the durable copy.
    if (rec && rec.motion.length > 0 && (proc?.strokeCount ?? 0) > 0) {
      sessionLibrary.saveSession(rec, {
        startedAt: rec.startedAt,
        strokeCount: proc.strokeCount,
        distance: distanceRef.current.session,
        durationMs: rec.motion[rec.motion.length - 1].t - rec.motion[0].t,
        motionCount: rec.motion.length,
        gpsCount: rec.gps.length,
        kind: 'coach',
      }).catch(() => {});
    }
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
      publishAvgFreeSpeed();
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
    // Either side introduces itself by name on connect (see handlePeerOpen) so
    // the link readout can show who's on the other end; a coach also files the
    // name into the roster. Handle it regardless of role; the rest is coach-only.
    if (msg.type === 'hello') {
      setLinkedPeerName(msg.name || '');
      return;
    }
    if (linkRole !== 'coach') return;
    const proc = procRef.current;
    switch (msg.type) {
      case 'capture':
        if (msg.active) startWatch();
        else stopWatch();
        break;
      case 'calib':
        if (proc && msg.dir) {
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
          // Track the rower↔coach clock offset for video sync: the latest sample
          // (rower time s.t) just arrived at coach wall-time `now`, ~half a
          // round-trip after it was generated. EMA-smoothed against jitter.
          const last = msg.samples[msg.samples.length - 1];
          if (last && last.t != null) {
            const transit = (lastPingRef.current ?? 0) / 2;
            const offset = (performance.now() - transit) - last.t;
            rowerToCoachRef.current = rowerToCoachRef.current == null
              ? offset
              : rowerToCoachRef.current + 0.2 * (offset - rowerToCoachRef.current);
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
            accumulateDistance(s.t, s.speed);
            gpsRef.current.speeds.push({ time: s.t, speed: s.speed });
            if (s.lat != null) {
              positionsRef.current.push({ t: s.t, lat: s.lat, lon: s.lon, heading: s.head ?? null });
            }
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
    // Introduce ourselves by name (both sides) so the other end can show who it's
    // connected to; for a coach this also feeds the roster. A rower then catches a
    // mid-session coach up on capture + calibration.
    try { conn.send({ type: 'hello', name: identityNameRef.current || '' }); } catch { /* ignore */ }
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
    // The invite's `as` param says which role the sender picked for us: a
    // coach's "send link to rower" makes this phone the rower. Links without
    // it (rower QR / pre-`as` links) keep the old meaning: opener watches.
    onJoin: () => {
      const m = window.location.hash.match(/[?&]as=(rower|coach)/);
      setLinkRole(m ? m[1] : 'coach');
    },
    // Recipient of our own invite link / QR takes the opposite role.
    inviteRole: linkRole === 'coach' ? 'rower' : 'coach',
    onClose: () => setLinkedPeerName(''),
    fixedId: identity.id,
    getPresence: () => ({ name: identityNameRef.current, busy: isCapturingRef.current }),
  });
  // Stable references (useCallback in the hook) — safe to use in effect deps.
  const { isOpen: linkIsOpen, sendData: linkSendData, sendBatch: linkSendBatch } = link;

  // Mirror the measured round-trip into a ref so the (unsubscribed) peer-data
  // handler can apply a transit correction to the video clock offset.
  lastPingRef.current = link.lastPing;

  // Rower: enable the coach link automatically so the phone is online and a coach
  // can connect without anyone tapping "Enable coach link" first. Coach mode
  // stays manual (tap to enable, then pick a rower). initPeer is idempotent.
  const { initPeer: linkInitPeer, hasPeer: linkHasPeer } = link;
  const autoEnabledRef = useRef(false);
  useEffect(() => {
    if (isAnalysis) return; // analysis page never goes online
    if (linkRole === 'rower' && !linkHasPeer && !autoEnabledRef.current) {
      autoEnabledRef.current = true;
      linkInitPeer();
    }
  }, [linkRole, linkHasPeer, linkInitPeer, isAnalysis]);

  // Attach / detach the devicemotion listener (rower only — coach never uses
  // its own sensors; it feeds the received stream into handleMotion directly).
  // During a desk replay we drive handleMotion from the recording, so ignore the
  // device's own (stationary) sensor stream — otherwise real samples interleave
  // with the replayed ones and corrupt calibration / stroke detection.
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => { if (replayRef.current) return; handleMotion.current(e); };
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }, [isCapturing]);

  // Attach / detach the deviceorientation listener (for gravity compensation)
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => {
      if (replayRef.current) return; // replay supplies its own orientation
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

  // Keep the screen awake whenever this phone is in coach mode — the coach
  // stares at the readout without touching the screen, so Android would
  // otherwise sleep it mid-piece. The hook returns a fresh wrapper each
  // render, so depend on the stable callbacks rather than the object.
  const { request: wakeLockRequest, release: wakeLockRelease } = wakeLock;
  useEffect(() => {
    if (linkRole !== 'coach') return;
    wakeLockRequest();
    return () => wakeLockRelease();
  }, [linkRole, wakeLockRequest, wakeLockRelease]);

  // Coach: once a data channel opens, remember (or refresh) that rower in the
  // roster. Re-runs when the rower's advertised name arrives so the name sticks.
  useEffect(() => {
    if (linkRole !== 'coach' || !link.connectedPeerId) return;
    setRoster(pairStore.saveRower({ id: link.connectedPeerId, name: linkedPeerName }));
  }, [linkRole, link.connectedPeerId, linkedPeerName]);

  // Coach: while idle (link enabled but not yet watching anyone), sweep the saved
  // roster every few seconds to light up who's currently online. Probes run
  // sequentially to stay gentle on the public broker.
  const { probe: linkProbe } = link;
  useEffect(() => {
    if (linkRole !== 'coach' || !link.hasPeer || link.peerStatus === 'connected') return;
    let cancelled = false;
    let timer;
    // Probe the whole roster in parallel each round (each updates its own dot as
    // it resolves), then schedule the next round only once they've all settled —
    // so offline timeouts never stack up into overlapping sweeps.
    const sweep = async () => {
      await Promise.all(pairStore.getRoster().map(async (r) => {
        const res = await linkProbe(r.id);
        if (!cancelled) setPresence((prev) => ({ ...prev, [r.id]: res }));
      }));
      if (!cancelled) timer = setTimeout(sweep, 4000);
    };
    sweep();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linkRole, link.hasPeer, link.peerStatus, linkProbe]);

  // Coach: dial a saved rower from the roster. Assumes the link is enabled
  // (the roster only renders once our peer is online).
  const connectToRower = (id) => {
    link.setRemoteShortCode(id);
    link.connectToRemote(id);
  };

  const handleRelabelRower = (r) => {
    const next = window.prompt('Label for this rower', pairStore.displayName(r));
    if (next == null) return;
    setRoster(pairStore.relabelRower(r.id, next.trim()));
  };

  const handleRemoveRower = (r) => {
    if (!window.confirm(`Forget ${pairStore.displayName(r)}?`)) return;
    setRoster(pairStore.removeRower(r.id));
  };

  const handleNameChange = (v) => {
    setLinkName(v);
    pairStore.setName(v);
  };

  // Remember the rower/coach choice so the link opens in the same role next time.
  const chooseRole = (role) => {
    setLinkRole(role);
    pairStore.setRole(role);
  };

  // Invitation link (rower → coach or coach → rower): hand the join URL (the
  // same one the QR encodes) to the OS share sheet so it can be texted to the
  // other phone; desktops without navigator.share get a clipboard copy with
  // brief button feedback instead.
  const [linkCopied, setLinkCopied] = useState(false);
  const sendInviteLink = async () => {
    const url = link.joinUrl;
    if (!url) return;
    const name = linkName.trim();
    if (navigator.share) {
      try {
        await navigator.share({
          text: linkRole === 'coach'
            ? `Open this to stream your rowing live to ${name || 'your coach'} on Free Speed`
            : `Watch ${name || 'my'} rowing live on Free Speed`,
          url,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // user dismissed the share sheet
        // fall through to the clipboard on any other failure
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* ignore */ }
  };

  // Bind the live camera stream to the preview <video> element.
  useEffect(() => {
    const el = previewVideoRef.current;
    if (el && videoRecorder.stream) {
      el.srcObject = videoRecorder.stream;
      el.play?.().catch(() => {});
    }
  }, [videoRecorder.stream]);

  // --- Coach video recording ---
  // Arm the camera and switch straight into the landscape full-screen viewfinder
  // (see the camera overlay below + its fullscreen effect). Enabling the camera
  // is async, but we flip `videoArmed` first — without awaiting — so the overlay
  // mounts and requests fullscreen while the tap's activation is still live.
  const armVideo = () => {
    setVideoBundle(null);
    setVideoArmed(true);
    videoRecorder.enable().then((s) => { if (!s) setVideoArmed(false); });
  };

  // Leave the viewfinder: turn the camera off and drop out of full screen (the
  // fullscreen effect's cleanup runs when videoArmed flips false).
  const closeCamera = () => {
    videoRecorder.disable();
    setVideoArmed(false);
  };

  // Enter landscape full screen while the viewfinder is open; restore on exit.
  // Best-effort — fullscreen/orientation-lock aren't on every browser (notably
  // iOS), but the overlay is a fixed full-window layer regardless, so it still
  // fills the screen.
  useEffect(() => {
    if (!videoArmed) return;
    const el = cameraFsRef.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      try {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      } catch { /* ignore */ }
      if (!cancelled) {
        try { await window.screen?.orientation?.lock?.('landscape'); } catch { /* ignore */ }
      }
    })();
    return () => {
      cancelled = true;
      try { window.screen?.orientation?.unlock?.(); } catch { /* ignore */ }
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        try { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); } catch { /* ignore */ }
      }
    };
  }, [videoArmed]);

  // Camera zoom stepping for the viewfinder buttons. Multiplicative steps feel
  // uniform across the range (1 → 1.3 → 1.7 → 2.2 …); the hook clamps to the
  // track's real min/max. `|| 1` guards a track that reports zoom 0.
  const ZOOM_STEP = 1.3;
  const zoomBy = (factor) => videoRecorder.setZoom((videoRecorder.zoom || 1) * factor);

  const startVideo = async () => {
    const anchor = await videoRecorder.start();
    if (!anchor) return;
    // Stamp each clip with its own wall-clock start. The bundle's top-level
    // startedAt is the stroke recording's — shared by every clip of one piece —
    // so without this two clips of the same piece would download under the same
    // filename and the browser would prompt to re-download over the first.
    videoAnchorRef.current = {
      ...anchor,
      startedAt: new Date().toISOString(),
      rowerToCoachOffset: rowerToCoachRef.current ?? 0,
    };
    // Pin the strokes this footage belongs to. If a piece is already live, it's
    // the one being filmed; otherwise the next startWatch pins the piece that
    // starts on camera. Mark the camera active so startWatch knows to (re-)pin.
    videoRecordingActiveRef.current = true;
    videoRecordingRef.current = isWatching ? recordingRef.current : null;
    videoPieceCountRef.current = videoRecordingRef.current ? 1 : 0;
    setVideoBundle(null);
  };

  // Stop recording and package the footage with the strokes received so far into
  // a downloadable/analyzable ZIP bundle.
  const stopVideo = async () => {
    setSavingBundle(true);
    // Camera's stopping — startWatch must not re-pin a piece past this point.
    videoRecordingActiveRef.current = false;
    try {
      const blob = await videoRecorder.stop();
      // Bundle the piece that was pinned while filming, never whichever piece is
      // current now (which may be a later one the rower started downriver).
      const rec = videoRecordingRef.current || recordingRef.current;
      if (!blob) return;
      if (!rec || rec.motion.length === 0) {
        // No rower stream reached us during the clip — a video with nothing to
        // sync to defeats the purpose, so don't ship a data-less bundle.
        alert('No stroke data arrived while filming, so there is nothing to sync the video to. Make sure the rower is connected and capturing before you record.');
        return;
      }
      if (videoPieceCountRef.current > 1) {
        // The clip crossed a piece boundary; only the piece pinned last is a
        // full match. Warn rather than silently ship footage that only partly
        // lines up with its strokes.
        alert('Heads up: the rower started a new piece while you were filming, so only the latest piece is synced to this clip. Film one piece per video for a full frame-by-frame match.');
      }
      const anchor = videoAnchorRef.current || {};
      // Lock in the best clock offset we have at stop time.
      anchor.rowerToCoachOffset = rowerToCoachRef.current ?? anchor.rowerToCoachOffset ?? 0;
      const meta = {
        ...rec,
        video: {
          startedAt: anchor.startedAt,
          startCoachPerf: anchor.startCoachPerf ?? 0,
          rowerToCoachOffset: anchor.rowerToCoachOffset,
          mime: anchor.mime || blob.type,
          fps: anchor.fps || 30,
        },
      };
      const bundle = { blob, meta };
      setVideoBundle(bundle);
      // Auto-download the packaged clip so the coach never has to tap a second
      // time — the share/analyze actions stay available for anything more.
      await downloadBundle(bundle).catch(() => {});
    } finally {
      setSavingBundle(false);
      // Drop out of the landscape viewfinder so the share/analyze actions show.
      closeCamera();
    }
  };

  // Hand the in-memory bundle to the analyzer view without a download round-trip.
  const openInAnalyzer = async () => {
    if (!videoBundle) return;
    try {
      const zip = await packBundle(videoBundle.meta, videoBundle.blob);
      await videoStore.putHandoff(zip, videoBundle.meta);
      window.location.hash = '#analyze';
    } catch (e) {
      alert('Could not open analyzer: ' + (e?.message ?? e));
    }
  };

  const downloadBundle = async (bundle = videoBundle) => {
    if (!bundle) return;
    const zip = await packBundle(bundle.meta, bundle.blob);
    const url = URL.createObjectURL(zip);
    // Prefer the clip's own start time so each clip of a piece downloads under a
    // distinct name (the top-level startedAt is shared across a piece's clips).
    const stampSource = bundle.meta.video?.startedAt || bundle.meta.startedAt || new Date().toISOString();
    const stamp = stampSource.replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `free-speed-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Periodic UI refresh during capture or while watching a coach stream
  // (avoids 60 Hz React renders)
  useEffect(() => {
    if (!isCapturing && !isWatching) return;
    const id = setInterval(() => {
      const proc = procRef.current;
      if (!proc) return;
      // The map track updates even while paused — fixes arrive ~1/s, and the
      // no-change case returns the same array so no render happens.
      setPositions((prev) =>
        prev.length === positionsRef.current.length ? prev : [...positionsRef.current]);
      if (isPausedRef.current) return; // frozen for stroke inspection
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setLiveSplitSpeed(proc.lastGpsSpeed ?? null);
      setAvgCurve(proc.avgCurve);
      setHasGPSAnchoring(proc.hasGPS);
      setPieceDistance(distanceRef.current.piece);
      setSessionDistance(distanceRef.current.session);
      publishAvgFreeSpeed();

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
    if (replayRef.current) replayRef.current.cancel();
  }, []);

  // On mount, check IndexedDB for a session that didn't end cleanly and offer
  // to recover it. Only meaningful for the rower (the phone doing the capture).
  useEffect(() => {
    if (isAnalysis) { setRecoveryChecked(true); return; } // recovery belongs to the live page
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
    positionsRef.current = [];
    setPositions([]);
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
    setLoadedSession(null); // a fresh capture/watch isn't an opened library session
    resetDistance();
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
            accumulateDistance(gpsTime, pos.coords.speed);
            gpsRef.current.speeds.push({ time: gpsTime, speed: pos.coords.speed });
            // Keep last 30 seconds
            const cutoff = performance.now() - 30000;
            gpsRef.current.speeds = gpsRef.current.speeds.filter(s => s.time > cutoff);
            const rec = recordingRef.current;
            // Record position too (when available) so a session can later be
            // drawn on a map. Only speed feeds the live split pipeline; lat/lon
            // ride along in the recording / stream / persistence.
            const gpsSample = { t: gpsTime, speed: pos.coords.speed };
            if (pos.coords.latitude != null) {
              gpsSample.lat = pos.coords.latitude;
              gpsSample.lon = pos.coords.longitude;
              // Device-reported course over ground — only trustworthy in motion.
              const head = pos.coords.heading;
              if (head != null && !Number.isNaN(head) && pos.coords.speed >= 0.5) {
                gpsSample.head = head;
              }
              positionsRef.current.push({
                t: gpsTime, lat: gpsSample.lat, lon: gpsSample.lon, heading: gpsSample.head ?? null,
              });
            }
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
    // End an in-flight real-time replay: stop the loop and restore the source
    // recording so a follow-up download re-exports it. The teardown below is all
    // null-guarded, so it's safe even though a replay never set up GPS/streaming.
    let replaySource = null;
    let replayStoppedAt = null; // playhead (recording time) when the replay was stopped
    if (replayRef.current) {
      replayRef.current.cancel();
      replaySource = replayRef.current.recording;
      replayStoppedAt = replayRef.current.playheadT ?? null;
      recordingRef.current = replaySource;
      replayRef.current = null;
      setLiveReplayActive(false);
    }
    setIsCapturing(false);
    setStartLocked(true);
    if (startLockTimerRef.current) clearTimeout(startLockTimerRef.current);
    startLockTimerRef.current = setTimeout(() => setStartLocked(false), 700);
    // Copy final state from processing refs
    const proc = procRef.current;
    if (proc) {
      setStrokeRate(proc.strokeRate);
      setStrokeCount(proc.strokeCount);
      setLastStroke(proc.lastStroke);
      setAvgCurve(proc.avgCurve);
      setHasGPSAnchoring(proc.hasGPS);
      publishAvgFreeSpeed();
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
    setPositions([...positionsRef.current]);
    const rec = recordingRef.current;
    if (rec && rec.motion.length > 0) setHasRecording(true);
    // A real capture saves its stroke data into the session library on stop so
    // the row can't be lost to a dead battery or a cleared tab. Replays came
    // from a file in the first place, and a session with no detected strokes
    // (the auto-started capture idling at a desk) is junk — skip both. If the
    // save fails (quota, private mode), fall back to the old auto-download —
    // losing the row is never acceptable.
    if (!replaySource && rec && rec.motion.length > 0 && (proc?.strokeCount ?? 0) > 0) {
      sessionLibrary.saveSession(rec, {
        startedAt: rec.startedAt,
        strokeCount: proc.strokeCount,
        distance: distanceRef.current.session,
        durationMs: rec.motion[rec.motion.length - 1].t - rec.motion[0].t,
        motionCount: rec.motion.length,
        gpsCount: rec.gps.length,
        kind: 'rower',
      }).catch(() => downloadRecording(rec));
    }
    // Ending a live replay — hold-to-stop or the recording running out — lands
    // back on the *whole* loaded recording, not the slice that happened to play:
    // fast-forward the full file through the pipeline again, exactly as if it
    // were freshly loaded, so it can be inspected or replayed again without
    // re-loading. Deferred (same trick as handleLoadRecording) so the UI paints
    // before the potentially multi-second synchronous replay blocks the thread.
    if (replaySource) {
      setIsReplaying(true);
      setTimeout(() => {
        replayRecording(replaySource);
        // Land review on the stroke that was playing when the replay stopped
        // (replayRecording just reset the selection to the whole session).
        const full = procRef.current;
        if (replayStoppedAt != null && full && full.strokes.length > 0) {
          const at = full.strokes.findIndex((s) => s.time >= replayStoppedAt);
          setSelectedIndex(at === -1 ? full.strokes.length - 1 : at);
        }
        setIsReplaying(false);
      }, 50);
    }
  };

  // Auto-start so the coach can hand over a phone that's already capturing —
  // no tap required. Fires once per mount, only for the rower, only once
  // sensors are ready, and never over a pending recovery offer or an existing
  // session. On iOS the first capture still needs a tap to grant motion access
  // (requestPermission must follow a user gesture); after that this kicks in.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (isAnalysis) return; // the analysis page never captures
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
  // Reload / close / PWA dismiss would lose the recording wherever the user is
  // in the app (capture runs in the background), so the unload guard is global.
  useEffect(() => {
    if (!isCapturing || replayRef.current) return; // no exit trap during a desk replay
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isCapturing]);
  // The history sentinel only arms while this page is the one on screen —
  // in-app hash navigation no longer ends the capture, so Back elsewhere in
  // the app must behave normally.
  useEffect(() => {
    if (!isCapturing || !active || replayRef.current) return;
    window.history.pushState({ liveTrap: true }, '');
    const onPop = () => {
      window.history.pushState({ liveTrap: true }, '');
      setNavHint(true);
      if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
      navHintTimerRef.current = setTimeout(() => setNavHint(false), 2600);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
    };
  }, [isCapturing, active]);

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

  // Defaults to the current recording; the save-failure fallback passes the
  // stopped capture's recording explicitly, since an auto-started capture may
  // have replaced recordingRef by the time the async save settles.
  const downloadRecording = (rec = recordingRef.current) => {
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

  // buildReplayEvents lives in utils/strokePipeline (shared with the analyzer).

  // Feed one recorded event into the same refs/handlers a live capture uses.
  // Motion events drive handleMotion with the recorded timestamp (nowOverride).
  // During a *real-time* replay (replayRef set), also re-stream the events to a
  // connected coach so the coach view works from a desk replay — handleMotion's
  // own send-push is skipped under replay (nowOverride set, recordingRef null),
  // so we buffer here. The instant fast-forward (replayRecording) leaves
  // replayRef null and never streams.
  const applyReplayEvent = (ev) => {
    const streaming = !!replayRef.current;
    if (ev.k === 'o') {
      if (ev.d.beta != null) orientationRef.current = { beta: ev.d.beta, gamma: ev.d.gamma };
      if (streaming) sendBufferRef.current.orientation.push(ev.d);
    } else if (ev.k === 'g') {
      accumulateDistance(ev.t, ev.d.speed);
      gpsRef.current.speeds.push({ time: ev.t, speed: ev.d.speed });
      if (ev.d.lat != null) {
        positionsRef.current.push({ t: ev.t, lat: ev.d.lat, lon: ev.d.lon, heading: ev.d.head ?? null });
      }
      const cutoff = ev.t - 30000;
      gpsRef.current.speeds = gpsRef.current.speeds.filter(s => s.time > cutoff);
      if (streaming) sendBufferRef.current.gps.push(ev.d);
    } else {
      const fakeEvent = {
        acceleration: ev.d.ax != null ? { x: ev.d.ax, y: ev.d.ay, z: ev.d.az } : null,
        accelerationIncludingGravity: ev.d.axg != null
          ? { x: ev.d.axg, y: ev.d.ayg, z: ev.d.azg }
          : null,
      };
      handleMotion.current(fakeEvent, ev.t);
      if (streaming) sendBufferRef.current.motion.push(ev.d);
    }
  };

  const replayRecording = (recording) => {
    procRef.current = makeProc(recording.motion[0]?.t ?? 0);
    gpsRef.current.speeds = [];
    positionsRef.current = [];
    orientationRef.current = { beta: 0, gamma: 0 };
    resetDistance();

    // Disable live recording so the replay doesn't double-record into the source data
    recordingRef.current = null;

    for (const ev of buildReplayEvents(recording)) applyReplayEvent(ev);

    // Restore so a follow-up download re-exports the same recording
    recordingRef.current = recording;

    const proc = procRef.current;
    setStrokeRate(proc.strokeRate);
    setStrokeCount(proc.strokeCount);
    // "Last Stroke" only means something live (the stroke you just pulled). In a
    // loaded recording it's just the final stroke in the file — an arbitrary,
    // unrepresentative overlay — so don't show it when reviewing.
    setLastStroke(null);
    setAvgCurve(proc.avgCurve);
    setHasGPSAnchoring(proc.hasGPS);
    publishAvgFreeSpeed();
    setCalibrationStatus(proc.direction ? 'detected' : 'idle');
    setStrokes([...proc.strokes]);
    setSelection(null);
    setSelectedIndex(null);
    setPositions([...positionsRef.current]);
    setPieceDistance(distanceRef.current.piece);
    setSessionDistance(distanceRef.current.session);
    setHasRecording(true);
  };

  // Save a just-loaded recording into the Sessions library. Runs after
  // replayRecording, so procRef holds the full stroke summary. Same idempotent
  // startedAt key as the auto-save on stop; a session with no detected strokes
  // (a junk/empty file) is skipped. `name`, when given, rides through — and
  // saveSession preserves an existing name when it isn't, so re-opening a named
  // session doesn't wipe its name.
  const persistLoadedToLibrary = (recording, name) => {
    const proc = procRef.current;
    if (!recording || !recording.motion?.length) return;
    if ((proc?.strokeCount ?? 0) === 0) return;
    const summary = {
      startedAt: recording.startedAt,
      strokeCount: proc?.strokeCount ?? 0,
      distance: distanceRef.current.session,
      durationMs: recording.motion[recording.motion.length - 1].t - recording.motion[0].t,
      motionCount: recording.motion.length,
      gpsCount: recording.gps?.length ?? 0,
      kind: linkRole === 'coach' ? 'coach' : 'rower',
    };
    if (name != null) summary.name = name;
    sessionLibrary.saveSession(recording, summary).catch(() => {});
  };

  // `meta` ({ name, startedAt }) is set when a saved session is opened from the
  // Sessions page — it titles the review bar and its name is preserved on the
  // auto-save below. A bare imported/picked file passes null (title falls back
  // to the recording's own startedAt).
  const handleLoadRecording = (file, meta = null) => {
    setIsReplaying(true);
    setLoadedSession(meta);
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
          // Loading a file always lands it in the Sessions library, so importing
          // stroke data (from the Sessions page or the review picker) saves a
          // session with no separate step. Idempotent on startedAt — re-opening
          // a saved session just overwrites it.
          persistLoadedToLibrary(recording, meta?.name);
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

  // Real-time replay: instead of fast-forwarding the whole recording at once
  // (replayRecording), schedule its events at their recorded pace (× `speed`)
  // so the live UI animates as it would on the water. Reuses the capture state
  // path — setIsCapturing(true) makes the 250 ms UI-refresh interval poll proc,
  // and Hold-to-Stop / the recording's end both finish via stopCapture.
  const startLiveReplay = (recording, speed, range) => {
    if (!recording) return;
    let events = buildReplayEvents(recording);
    if (events.length === 0) {
      alert('Recording has no samples to replay');
      return;
    }

    // Replay only the selected stroke-time range, with a short lead-in so
    // orientation calibration and the stroke-detection EMA warm up before the
    // selected strokes arrive (otherwise the range's first ~3 s is eaten by it).
    if (range) {
      const REPLAY_LEAD_MS = 6000;
      events = events.filter(e => e.t >= range.min - REPLAY_LEAD_MS && e.t <= range.max);
      if (events.length === 0) {
        alert('No samples in the selected range');
        return;
      }
    }

    procRef.current = makeProc(events[0].t);
    gpsRef.current.speeds = [];
    positionsRef.current = [];
    setPositions([]);
    orientationRef.current = { beta: 0, gamma: 0 };
    resetDistance();
    recordingRef.current = null; // replay drives the pipeline; don't re-record

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
    setLoadedSession(null); // a live replay isn't an opened library session
    setGpsStatus(recording.gps && recording.gps.length ? 'active' : 'unavailable');
    // Sync the state to the speed actually playing — a replay handed over from
    // the analysis page carries its own speed, and the banner reads this state.
    setReplaySpeed(speed);
    setLiveReplayActive(true);
    setIsCapturing(true);

    // Stream the replay to a connected coach, exactly as a live capture does, so
    // the coach view (and the new video pairing) can be exercised from a desk.
    // No-ops when no coach is connected; stopCapture tears the interval down and
    // sends capture:false at the end.
    sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    calibSentRef.current = false;
    linkSendData({ type: 'capture', active: true });
    if (sendIntervalRef.current != null) clearInterval(sendIntervalRef.current);
    sendIntervalRef.current = setInterval(() => {
      linkSendBatch(sendBufferRef.current);
      sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    }, SEND_BATCH_MS);

    const firstT = events[0].t;
    const startWall = performance.now();
    let idx = 0;
    const state = { cancelled: false, rafId: null, recording };
    const step = () => {
      if (state.cancelled) return;
      const playT = firstT + (performance.now() - startWall) * speed;
      state.playheadT = playT; // read by stopCapture to land review on this stroke
      while (idx < events.length && events[idx].t <= playT) {
        applyReplayEvent(events[idx]);
        idx++;
      }
      if (idx < events.length) {
        state.rafId = requestAnimationFrame(step);
      } else {
        stopCapture(); // clears replayRef, then rebuilds the full loaded-recording state
      }
    };
    state.cancel = () => {
      state.cancelled = true;
      if (state.rafId != null) cancelAnimationFrame(state.rafId);
    };
    replayRef.current = state;
    state.rafId = requestAnimationFrame(step);
  };

  // Live instance: pick up a replay the Stroke Analysis page handed over (see
  // replayFromSelection). Any running capture ends first — usually the idle
  // auto-started one — so the replay owns the pipeline and streams to a
  // connected coach under this phone's real rower identity.
  useEffect(() => {
    if (isAnalysis || !active) return;
    const handoff = replayHandoff.take();
    if (!handoff) return;
    if (isCapturingRef.current) stopCapture();
    startLiveReplay(handoff.recording, handoff.speed ?? 1, handoff.range ?? null);
    // stopCapture/startLiveReplay are stable enough for this one-shot pickup;
    // it must run exactly when this page becomes the active one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnalysis, active]);

  // Analysis instance: pick up a session the Sessions page handed over. The
  // blob is the same JSON the file picker would supply — FileReader accepts
  // either — so the whole deferred-parse/"Replaying…"/validation path is
  // reused untouched.
  useEffect(() => {
    if (!isAnalysis) return;
    const p = sessionLibrary.takeOpen();
    if (p) handleLoadRecording(p.blob, p.meta);
    // handleLoadRecording is stable enough for this one-shot mount pickup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnalysis]);

  const handleOpenInCalculator = () => {
    // Open whatever the readouts describe: a single inspected stroke when one is
    // selected, otherwise the reviewed range's median (typical) stroke — never a
    // flattened average, which would understate the curve's variation.
    const curveToSave = comparisonCurve;
    if (!curveToSave) return;

    let scaledSpeeds;
    let raceTime;
    if (hasGPSAnchoring) {
      // GPS-anchored curves are already in real m/s — pass through as-is
      scaledSpeeds = [...curveToSave];
      const curAvg = curveToSave.reduce((a, b) => a + b, 0) / curveToSave.length;
      // 2000m finish time at the measured average boat speed
      if (curAvg > 0) raceTime = 2000 / curAvg;
    } else {
      // Scale the captured curve so its mean matches the reference curve
      const curAvg = curveToSave.reduce((a, b) => a + b, 0) / curveToSave.length;
      const scale = REF_AVG / curAvg;
      scaledSpeeds = curveToSave.map(v => v * scale);
    }
    const desc = individualStroke
      ? `1 stroke at ${displayStrokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`
      : `median of ${displayCount} strokes at ${displayStrokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`;
    // Open in a new tab via a share-hash URL so the live session stays loaded
    // here — the calculator decodes the curve from #s= on load (parseShareHash).
    const encoded = encodeCurve(
      `Live Capture ${new Date().toLocaleString()}`,
      desc,
      scaledSpeeds,
      raceTime,
      displayStrokeRate || 36,
    );
    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`;
    window.open(url, '_blank', 'noopener');
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

  // Untapped (free-speed s/2k) for every stroke in the reviewed range, each
  // paired with its index in `strokes`. This is the distribution the coach
  // explores. We work off real per-stroke values rather than a pointwise average
  // of the curves: averaging flattens the speed profile — phase jitter and noise
  // smear the catch dip and drive surge — which shrinks the very variation
  // untapped speed is measured from, so an averaged curve reports less untapped
  // than any real stroke and flatters the rower. Review-only (needs GPS for the
  // untapped metric to be meaningful).
  const rangeUntapped = useMemo(() => {
    if (isCapturing || isWatching || !hasGPSAnchoring || !selectedStrokes || selectedStrokes.length === 0) return null;
    const out = [];
    for (const s of selectedStrokes) {
      const v = freeSpeedSecondsFor(s.curve);
      if (v != null) out.push({ idx: strokes.indexOf(s), v });
    }
    return out.length ? out : null;
  }, [isCapturing, isWatching, hasGPSAnchoring, selectedStrokes]);

  // Median roll/pitch swing (deg/stroke) over the reviewed range — the balance
  // readout for comparing rowers. Roll is the steadiness signal; pitch is mostly
  // the systematic crew-mass movement. Null when strokes lack attitude data.
  const attMedians = useMemo(() => {
    if (!selectedStrokes || selectedStrokes.length === 0) return null;
    const med = (vals) => {
      if (!vals.length) return null;
      const s = [...vals].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const roll = med(selectedStrokes.map((s) => s.rollDeg).filter((v) => v != null));
    const pitch = med(selectedStrokes.map((s) => s.pitchDeg).filter((v) => v != null));
    return roll != null || pitch != null ? { roll, pitch } : null;
  }, [selectedStrokes]);

  // Summary stats over the range's untapped times. Median is the headline
  // central value (robust); mean is shown alongside so a skewed distribution is
  // visible (mean > median ⇒ a tail of bad strokes dragging the average up).
  const untappedStats = useMemo(() => {
    if (!rangeUntapped) return null;
    const vs = rangeUntapped.map((r) => r.v).sort((a, b) => a - b);
    const n = vs.length;
    const mean = vs.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? vs[(n - 1) / 2] : (vs[n / 2 - 1] + vs[n / 2]) / 2;
    const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { n, mean, median, sd, min: vs[0], max: vs[n - 1] };
  }, [rangeUntapped]);

  // The real stroke nearest the median untapped — the "typical" stroke the
  // headline reads off and the calculator opens.
  const medianStroke = useMemo(() => {
    if (!rangeUntapped || !untappedStats) return null;
    let best = null, bestD = Infinity;
    for (const r of rangeUntapped) {
      const d = Math.abs(r.v - untappedStats.median);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best ? strokes[best.idx] : null;
  }, [rangeUntapped, untappedStats]);

  // Histogram of the untapped distribution. Each bin keeps the stroke indices
  // that fall in it, so clicking a bar maps straight to a highlight set on the
  // stroke-time chart. ~√n bins, clamped, for a sane shape at any range size.
  const untappedBins = useMemo(() => {
    if (!rangeUntapped || !untappedStats) return null;
    const { min, max, n } = untappedStats;
    const nBins = Math.max(5, Math.min(15, Math.round(Math.sqrt(n))));
    const width = max > min ? (max - min) / nBins : 1;
    const bins = Array.from({ length: nBins }, (_, i) => ({
      x0: min + i * width, x1: min + (i + 1) * width, idxs: [],
    }));
    for (const { idx, v } of rangeUntapped) {
      let b = Math.floor((v - min) / width);
      if (b >= nBins) b = nBins - 1;
      if (b < 0) b = 0;
      bins[b].idxs.push(idx);
    }
    return bins;
  }, [rangeUntapped, untappedStats]);

  // Which bin is spotlighted: the user's click, else the one holding the median
  // (binned with the same formula as the histogram so they always agree).
  const defaultBin = useMemo(() => {
    if (!untappedBins || !untappedStats) return -1;
    const { min, max, median } = untappedStats;
    const width = max > min ? (max - min) / untappedBins.length : 1;
    return Math.max(0, Math.min(untappedBins.length - 1, Math.floor((median - min) / width)));
  }, [untappedBins, untappedStats]);
  const activeBin = selectedBin != null ? selectedBin : defaultBin;

  // Stroke indices to glow green on the stroke-time chart — the active bin's.
  const highlightedIndices = useMemo(() => {
    if (!untappedBins || activeBin < 0 || !untappedBins[activeBin]) return null;
    return new Set(untappedBins[activeBin].idxs);
  }, [untappedBins, activeBin]);

  // A new range means a new distribution — fall back to the median bin.
  useEffect(() => { setSelectedBin(null); }, [selection]);

  // Stroke-rate readout, mirroring the split: inspecting a stroke → its cadence
  // there; reviewing a range (or the whole session) → the mean cadence; live →
  // the running rate. Per-stroke `spm` is stamped at capture time.
  const strokeRateOf = (s) => (s && s.spm > 0 ? s.spm : null);
  let displayStrokeRate;
  if (individualStroke) {
    displayStrokeRate = strokeRateOf(individualStroke);
  } else if (selectedStrokes && selectedStrokes.length > 0) {
    const vals = selectedStrokes.map(strokeRateOf).filter((v) => v != null);
    displayStrokeRate = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  } else {
    displayStrokeRate = strokeRate;
  }

  // The stroke being compared against potential: the inspected one, else the
  // live latest stroke, else the reviewed range's median (typical) stroke. The
  // headline untapped number reads off this curve, so a range now reports the
  // median real stroke's untapped time, not an averaged-and-flattered one.
  const comparisonCurve = individualStroke ? individualStroke.curve
    : (isCapturing || isWatching) ? lastStroke
    : (medianStroke ? medianStroke.curve : displayAvgCurve);
  // Scale the dashed potential to the stroke on screen the same way freeSpeedGain
  // does — to equal power (mean-cube), not equal mean — so the line you see *is*
  // the curve the free-speed number is measured against: your effort, the
  // optimal shape, sitting above your mean by exactly the gain. Multiplicative
  // scaling holds the reference's shape (relative variation) fixed at every pace.
  const meanCube = (a) => a.reduce((s, v) => s + v * v * v, 0) / a.length;
  const potentialScale = comparisonCurve && comparisonCurve.length && meanCube(comparisonCurve) > 0
    ? Math.cbrt(meanCube(comparisonCurve) / meanCube(REF_SPEEDS))
    : 1;

  // Roll captured curves so the chart begins where the catch deceleration kicks
  // in (see catchStartIndex). rollStart is the catch of the stroke on screen
  // (inspected, else the live last stroke); the reference rolls to its own catch
  // so x=0 is the catch for both lines.
  const rollStart = comparisonCurve && comparisonCurve.length
    ? catchStartIndex(comparisonCurve)
    : 0;

  // Auto-scale the y-axis to whatever's plotted (scaled potential + the curves
  // shown), padded, so each stroke fills the frame instead of a fixed scale.
  const ys = REF_SPEEDS.map((s) => s * potentialScale);
  if (individualStroke) ys.push(...individualStroke.curve);
  else if (lastStroke && (isCapturing || isWatching)) ys.push(...lastStroke);
  const yLo = Math.min(...ys), yHi = Math.max(...ys);
  const yPad = Math.max((yHi - yLo) * 0.1, 0.2);
  const yMin = yLo - yPad, yMax = yHi + yPad;

  const chartData = useMemo(() => {
    const datasets = [
      {
        label: 'Your potential',
        data: REF_ROLLED.map((s, i) => ({ x: PHASE_TIMES[i], y: s * potentialScale })),
        borderColor: 'rgba(75, 192, 192, 1)',
        borderWidth: 3,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
    ];

    if (individualStroke) {
      datasets.push({
        label: `Stroke #${selectedIndex + 1} of ${strokes.length}`,
        data: rollCurve(individualStroke.curve, rollStart).map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      });
    } else if (lastStroke && (isCapturing || isWatching)) {
      datasets.push({
        label: 'Last Stroke',
        data: rollCurve(lastStroke, rollStart).map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: 'rgba(255, 99, 132, 0.4)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      });
    }

    return { datasets };
  }, [lastStroke, individualStroke, selectedIndex, strokes.length, potentialScale, rollStart, isCapturing, isWatching]);

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
        // Red = the inspected stroke; green = strokes in the highlighted untapped
        // bin (the typical band, or whichever histogram bar the coach tapped).
        // When the inspected stroke is itself one of the green ones, ring the red
        // dot in green so you can see you picked a typical stroke.
        backgroundColor: (ctx) => ctx.dataIndex === selectedIndex ? '#ef4444'
          : (highlightedIndices && highlightedIndices.has(ctx.dataIndex)) ? '#10b981' : '#667eea',
        pointBorderColor: (ctx) => {
          const hi = highlightedIndices && highlightedIndices.has(ctx.dataIndex);
          if (ctx.dataIndex === selectedIndex) return hi ? '#10b981' : 'transparent';
          return hi ? '#ffffff' : 'transparent';
        },
        pointBorderWidth: (ctx) => {
          const hi = highlightedIndices && highlightedIndices.has(ctx.dataIndex);
          if (ctx.dataIndex === selectedIndex) return hi ? 3 : 0;
          return hi ? 1 : 0;
        },
        borderWidth: 1.5,
        pointRadius: (ctx) => ctx.dataIndex === selectedIndex ? 6
          : (highlightedIndices && highlightedIndices.has(ctx.dataIndex)) ? 4.5 : 2.5,
        pointHoverRadius: 6,
        tension: 0,
        fill: false,
      }],
    };
  }, [strokes, t0, selectedIndex, highlightedIndices, hasGPSAnchoring]);

  const chrome = useChartChrome();
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
        color: chrome.title,
        font: { size: 13, weight: 'normal' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { color: chrome.grid },
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
          // No selection: pin the axis to the full stroke-time extent so the
          // chart's left/right edges line up with the range slider's ends.
          // Otherwise Chart.js auto-scales to only the drawn points and drops
          // null-y warm-up strokes (no GPS yet), making the axis start partway in.
          : (strokes.length > 0
              ? { min: 0, max: (strokes[strokes.length - 1].time - t0) / 1000 }
              : {})),
        title: { display: true, text: 'Time (s)', color: chrome.title, font: { size: 11 } },
        ticks: { color: chrome.tick },
      },
      y: {
        grid: { color: chrome.grid },
        title: {
          display: true,
          text: hasGPSAnchoring ? 'Split / 500m' : 'Avg speed (relative)',
          color: chrome.title,
          font: { size: 11 },
        },
        ticks: hasGPSAnchoring
          ? { callback: (v) => formatSplit(v), color: chrome.tick }
          : { color: chrome.tick },
      },
    },
  }), [hasGPSAnchoring, selection, t0, chrome]);

  // --- Untapped-time histogram (review only): tap a bar to highlight strokes ---

  const untappedHistData = useMemo(() => {
    if (!untappedBins) return null;
    return {
      labels: untappedBins.map((b) => ((b.x0 + b.x1) / 2).toFixed(1)),
      datasets: [{
        label: 'strokes',
        data: untappedBins.map((b) => b.idxs.length),
        backgroundColor: untappedBins.map((_, i) =>
          i === activeBin ? '#10b981' : 'rgba(102, 126, 234, 0.55)'),
        borderWidth: 0,
        categoryPercentage: 1,
        barPercentage: 0.98,
      }],
    };
  }, [untappedBins, activeBin]);

  const untappedHistOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    onClick: (_event, elements) => {
      if (elements.length > 0) setSelectedBin(elements[0].index);
    },
    plugins: {
      legend: { display: false },
      title: {
        display: true,
        text: 'Untapped spread • tap a bar to spotlight those strokes',
        color: chrome.title,
        font: { size: 13, weight: 'normal' },
      },
      tooltip: {
        callbacks: {
          title: (items) => {
            const b = untappedBins?.[items[0].dataIndex];
            return b ? `${b.x0.toFixed(1)}–${b.x1.toFixed(1)} s untapped` : '';
          },
          label: (item) => `${item.raw} stroke${item.raw === 1 ? '' : 's'}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        title: { display: true, text: 'Untapped (s / 2k)', color: chrome.title, font: { size: 11 } },
        ticks: { color: chrome.tick, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        grid: { color: chrome.grid },
        title: { display: true, text: 'Strokes', color: chrome.title, font: { size: 11 } },
        ticks: { color: chrome.tick, precision: 0 },
        beginAtZero: true,
      },
    },
  }), [chrome, untappedBins]);

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

  const chartOptions = useMemo(() => {
   // Curves are stored phase-normalized (0..1) since strokes vary in length; the
   // stroke rate gives the average period, so phase × period reads out as ms.
   const periodMs = displayStrokeRate > 0 ? 60000 / displayStrokeRate : null;
   return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          usePointStyle: true,
          pointStyle: 'line',
          color: chrome.title,
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
        color: chrome.title,
        font: { size: 16, weight: 'bold' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: 1,
        grid: { color: chrome.grid },
        title: { display: true, text: periodMs ? 'Time (s)' : 'Stroke Phase', color: chrome.title, font: { size: 12 } },
        ticks: {
          callback: periodMs
            ? (val) => (val * periodMs / 1000).toFixed(2)
            : (val) => Math.round(val * 100) + '%',
          color: chrome.tick,
          maxTicksLimit: 6,
        },
      },
      y: {
        // Auto-scaled per stroke (see yMin/yMax) so the curve fills the frame.
        min: yMin,
        max: yMax,
        grid: { color: chrome.grid },
        ticks: { color: chrome.tick },
        title: {
          display: true,
          text: hasGPSAnchoring ? 'Boat Speed (m/s)' : 'Boat Speed (relative)',
          color: chrome.title,
          font: { size: 12 },
        },
      },
    },
   };
  }, [hasGPSAnchoring, displayStrokeRate, yMin, yMax, chrome]);

  // --- Render ---

  const isLive = isCapturing || isWatching;
  const gpsActive = gpsStatus === 'active' || hasGPSAnchoring;

  // --- Mode machine ---
  // The page serves one job at a time:
  //   setup  — role + coach link + sensor status; no session running or loaded
  //   live   — capturing / watching / replaying; glance stats, one panel, stop
  //   review — a finished (or paused) session; timeline-driven analysis
  const mode = (isCapturing || (isWatching && !isPaused)) ? 'live'
    : (strokes.length > 1 || hasRecording) ? 'review'
    : 'setup';

  // App-bar title says what's happening and as whom: live vs replay vs review,
  // rower vs coach. In review it names the session instead — the user-given name
  // if any, else the recording's datetime — so an opened session is identifiable.
  // Setup keeps the page's plain name.
  const roleLabel = linkRole === 'coach' ? 'Coach' : 'Rower';
  const reviewTitle =
    loadedSession?.name ||
    fmtSessionWhen(loadedSession?.startedAt || recordingRef.current?.startedAt) ||
    `Review · ${roleLabel}`;
  const pageTitle = mode === 'live'
    ? `${liveReplayActive ? 'Replay' : 'Live Capture'} · ${roleLabel}`
    : mode === 'review'
      ? reviewTitle
      : isAnalysis ? 'Stroke Analysis' : 'Live Stroke Capture';

  // Boat marker for the map: while inspecting a stroke (tap a dot / Prev / Next)
  // the position and direction of travel at the end of that stroke (strokes are
  // stamped at their end); while live, the latest fix. Otherwise just the track.
  const boatDisplay = useMemo(() => {
    if (positions.length === 0) return null;
    if (individualStroke) return boatFixAt(positions, individualStroke.time);
    if (isLive) return boatFixAt(positions, positions[positions.length - 1].t);
    return null;
  }, [positions, individualStroke, isLive]);

  const mapView = positions.length > 0 && (
    <TrackMap
      track={positions}
      boat={boatDisplay}
      coverTrack={mode === 'review'}
      label={individualStroke
        ? (boatDisplay
            ? `Stroke #${selectedIndex + 1} — position at end of stroke`
            : `Stroke #${selectedIndex + 1} — no GPS fix near this stroke`)
        : isLive ? 'Live position' : 'Session track'}
    />
  );

  // Rower-facing status stays calm: the link runs in the background while the
  // rower is on the water, so anything short of "connected" is just "waiting" —
  // signalling-server hiccups auto-retry (see usePeerLink) and aren't errors.
  const peerLabel = ({
    idle: 'Off',
    initializing: linkRole === 'coach' ? 'Starting…' : 'Not connected — waiting for a coach',
    online: linkRole === 'coach' ? 'Ready — connect to the rower' : 'Not connected — waiting for a coach',
    reconnecting: linkRole === 'coach' ? 'Reconnecting…' : 'Not connected — waiting for a coach',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: `Error: ${link.peerError}`,
  })[link.peerStatus] ?? link.peerStatus;

  // Once connected, collapse the whole pairing UI to a one-line indicator —
  // the QR/code/role toggle only matter until the link is established.
  const linkPanel = link.peerStatus === 'connected' ? (
    <div className="live-link live-link-connected">
      <span className="live-link-dot" />
      <span>
        {linkedPeerName
          ? `Connected to ${linkedPeerName}`
          : (linkRole === 'coach' ? 'Connected to rower' : 'Coach connected')}
      </span>
      <button
        className="btn btn-secondary btn-sm live-link-disconnect"
        onClick={link.disconnect}
      >
        Disconnect
      </button>
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
            onChange={() => chooseRole('rower')}
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
            onChange={() => chooseRole('coach')}
            disabled={isCapturing || isWatching}
          />
          Watch a rower's phone (coach)
        </label>
      </div>

      {linkRole === 'coach' && (
        <div className="oar-row">
          <input
            type="text"
            value={linkName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Your name (coach)"
            maxLength={32}
          />
        </div>
      )}

      {linkRole === 'coach' && link.hasPeer && roster.length > 0 && (
        <div className="live-roster">
          <div className="live-roster-title">Saved rowers</div>
          {roster.map((r) => {
            const p = presence[r.id];
            const online = !!p?.online;
            return (
              <div key={r.id} className={`live-roster-row${online ? ' online' : ''}`}>
                <span className={`live-roster-dot${online ? ' online' : ''}`} />
                <span className="live-roster-name">
                  {pairStore.displayName(r)}
                  {online && p?.busy && <span className="live-roster-busy"> · rowing</span>}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => connectToRower(r.id)}
                  disabled={!online || link.peerStatus === 'connecting'}
                >
                  {online ? 'Connect' : 'Offline'}
                </button>
                <button className="live-roster-edit" onClick={() => handleRelabelRower(r)} title="Rename">✎</button>
                <button className="live-roster-edit" onClick={() => handleRemoveRower(r)} title="Forget">✕</button>
              </div>
            );
          })}
        </div>
      )}

      <p className="oar-status">Coach link: {peerLabel}</p>

      {linkRole === 'rower' ? (
        // The link is already running in the background; this just reveals the
        // pairing details (QR / code) and the rower's name when a coach is
        // setting up. Rowing doesn't require any of it.
        <>
          <div className="live-link-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={sendInviteLink}
              disabled={!link.joinUrl}
            >
              {linkCopied ? 'Link copied ✓' : 'Send link to coach'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowLinkConfig((v) => !v)}
              aria-expanded={showLinkConfig}
            >
              {showLinkConfig ? 'Hide coach link setup' : 'Configure coach link'}
            </button>
          </div>
          {showLinkConfig && (
            <>
              <div className="oar-row">
                <input
                  type="text"
                  value={linkName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Your name (rower)"
                  maxLength={32}
                />
              </div>
              {link.hasPeer ? (
                <div className="oar-join-card">
                  <div className="oar-short-code">{link.shortCode || '…'}</div>
                  <div className="oar-join-hint">Coach scans this QR or types this code to watch.</div>
                  {link.qrDataUrl && <img className="oar-qr" src={link.qrDataUrl} alt="Join QR code" />}
                </div>
              ) : (
                <p className="oar-status">Connecting to the link server…</p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {!link.hasPeer && (
            <button className="btn btn-secondary btn-sm" onClick={link.initPeer}>
              Enable coach link
            </button>
          )}
          {link.hasPeer && (
            <>
              <div className="oar-join-card">
                <div className="oar-short-code">{link.shortCode || '…'}</div>
                <div className="oar-join-hint">Scan the rower's QR, or enter the rower's code below.</div>
                {link.qrDataUrl && <img className="oar-qr" src={link.qrDataUrl} alt="Join QR code" />}
              </div>
              <div className="live-link-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={sendInviteLink}
                  disabled={!link.joinUrl}
                >
                  {linkCopied ? 'Link copied ✓' : 'Send link to rower'}
                </button>
              </div>
              <div className="oar-row">
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
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

  // Free speed (s/2k) available by matching the potential curve's shape at your
  // current effort — see freeSpeedSecondsFor / freeSpeedGain. Uses the same
  // stroke the chart compares against potential (latest while live, the
  // inspected one, else the average). Only meaningful when GPS-anchored.
  const freeSpeedSeconds = hasGPSAnchoring ? freeSpeedSecondsFor(comparisonCurve) : null;

  const statsView = (
    <div className="live-stats">
      <div className="live-stat">
        <span className="live-stat-value">{displayStrokeRate || '—'}</span>
        <span className="live-stat-label">spm</span>
      </div>
      <div className="live-stat">
        {individualStroke ? (
          <>
            <span className="live-stat-value live-stroke-frac">
              {selectedIndex + 1} of {strokes.length}
            </span>
            <span className="live-stat-label">strokes</span>
          </>
        ) : (
          <>
            <span className="live-stat-value">{strokeCount}</span>
            <span className="live-stat-label">strokes</span>
          </>
        )}
      </div>
      {(isLive || strokes.length > 0) && (
        <div className="live-stat">
          <span className="live-stat-value live-split-value">{splitText}</span>
          <span className="live-stat-label">/500m</span>
        </div>
      )}
      {freeSpeedSeconds != null && (
        <div className="live-stat live-free-stat">
          <span
            className="live-stat-value live-free-value"
            style={{ color: freeSpeedSeconds > 0.5 ? 'var(--warning)' : 'var(--success)' }}
          >
            {(freeSpeedSeconds >= 0 ? '+' : '−') + Math.abs(freeSpeedSeconds).toFixed(1) + ' s'}
          </span>
          <span className="live-stat-label">
            untapped
            <button
              type="button"
              className="live-free-info-btn"
              aria-label="What is untapped speed?"
              aria-expanded={showFreeInfo}
              onClick={() => setShowFreeInfo((v) => !v)}
            >
              ⓘ
            </button>
          </span>
          {showFreeInfo && (
            <div className="live-free-info" role="tooltip">
              Seconds per 2k you'd gain at this same effort by smoothing your
              speed curve to match your potential. Lower is better.
              <button
                type="button"
                className="live-free-info-close"
                aria-label="Dismiss"
                onClick={() => setShowFreeInfo(false)}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
      {/* GPS state matters while rowing (is my split real?); in review the
          data is already whatever it is — free the space for the numbers. */}
      {mode !== 'review' && (
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
      )}
    </div>
  );

  const chartView = (
    <div className="live-chart-container">
      <div className="live-chart-wrapper">
        <Line data={chartData} options={chartOptions} />
      </div>
      {avgCurve && (
        <button
          className="live-calc-btn"
          onClick={handleOpenInCalculator}
          aria-label="Open this stroke in the Efficiency Calculator (new tab)"
          title="Open in Efficiency Calculator (new tab)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="2" width="16" height="20" rx="2" />
            <line x1="8" y1="6" x2="16" y2="6" />
            <line x1="8" y1="10" x2="8" y2="10" />
            <line x1="12" y1="10" x2="12" y2="10" />
            <line x1="16" y1="10" x2="16" y2="10" />
            <line x1="8" y1="14" x2="8" y2="14" />
            <line x1="12" y1="14" x2="12" y2="14" />
            <line x1="16" y1="14" x2="16" y2="14" />
            <line x1="8" y1="18" x2="8" y2="18" />
            <line x1="12" y1="18" x2="12" y2="18" />
            <line x1="16" y1="18" x2="16" y2="18" />
          </svg>
        </button>
      )}
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

  // Untapped seconds with an explicit sign, matching the headline readout.
  const fmtUntapped = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + 's';

  // Timeline navigator: the review mode's always-visible scrubber (chart +
  // range slider + prev/next). Lives in the sticky footer so a stroke or the
  // map can be inspected up top while stepping through the row down here.
  const timelineNav = showStrokeInspector && (
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
    </div>
  );

  // Stroke stepper + selection readout: kept OUT of the collapsible timeline so
  // Prev/Next stay reachable (and you can see which stroke you're on) even when
  // the Timeline section is folded shut.
  const timelineFooter = showStrokeInspector && (
    <div className="live-time-chart-footer">
      <span>
        {isPaused ? 'Paused · ' : ''}
        {individualStroke
          ? `Viewing stroke #${selectedIndex + 1} of ${strokes.length}${
              splitText !== '—' ? ` · ${splitText} /500m` : ''}${
              individualStroke.rollDeg != null
                ? ` · roll ${individualStroke.rollDeg.toFixed(1)}° · pitch ${individualStroke.pitchDeg.toFixed(1)}°`
                : ''}`
          : selection
            ? `${displayCount} of ${strokes.length} strokes selected${
                splitText !== '—' ? ` · ${splitText} /500m` : ''}${
                attMedians?.roll != null
                  ? ` · roll ${attMedians.roll.toFixed(1)}° · pitch ${attMedians.pitch.toFixed(1)}°`
                  : ''}`
            : `All ${strokes.length} strokes${
                attMedians?.roll != null
                  ? ` · roll ${attMedians.roll.toFixed(1)}° · pitch ${attMedians.pitch.toFixed(1)}°`
                  : ''}`}
      </span>
      <div className="live-time-chart-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(-1)} disabled={strokes.length === 0}>
          ← Prev
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(1)} disabled={strokes.length === 0}>
          Next →
        </button>
        {selection && (
          <button className="btn btn-secondary btn-sm" onClick={resetSelection}>
            Reset range
          </button>
        )}
      </div>
    </div>
  );

  // Untapped-time distribution: analysis content, scrolls in the review body.
  // Folded behind its stats line by default so the timeline gets the space;
  // tap the line to reveal the histogram.
  const untappedView = showStrokeInspector && untappedStats && untappedHistData && (
    <div className="live-untapped-panel">
      <button
        className="live-untapped-toggle"
        onClick={toggleHist}
        aria-expanded={histOpen}
      >
        <span className="live-untapped-stats">
          <span className="live-untapped-stat">
            <strong>{fmtUntapped(untappedStats.median)}</strong> median
          </span>
          <span className="live-untapped-stat">
            <strong>{fmtUntapped(untappedStats.mean)}</strong> mean
          </span>
          <span className="live-untapped-stat">
            ±{untappedStats.sd.toFixed(1)}s spread
          </span>
          {histOpen && (
            <span className="live-untapped-stat">
              {fmtUntapped(untappedStats.min)}…{fmtUntapped(untappedStats.max)} range
            </span>
          )}
          {histOpen && <span className="live-untapped-stat">{untappedStats.n} strokes</span>}
        </span>
        <span className="live-untapped-chevron" aria-hidden="true">{histOpen ? '▾' : '▸'}</span>
      </button>
      {histOpen && (
        <>
          <div className="live-untapped-hist-wrapper">
            <Bar data={untappedHistData} options={untappedHistOptions} />
          </div>
          {highlightedIndices && (
            <div className="live-untapped-hint">
              <span>
                {highlightedIndices.size} stroke{highlightedIndices.size === 1 ? '' : 's'} highlighted
                {selectedBin == null ? ' (typical band)' : ''}
              </span>
              {selectedBin != null && (
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedBin(null)}>
                  Back to median
                </button>
              )}
            </div>
          )}
        </>
      )}
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

  // Real-time replay of the recording, from wherever the timeline points:
  // the inspected stroke when one is selected, else the start of the selected
  // range, else the whole row.
  const replayFromSelection = () => {
    let range = selection;
    if (selectedIndex != null && strokes[selectedIndex]) {
      const s = strokes[selectedIndex];
      const end = selection ? selection.max : strokes[strokes.length - 1].time;
      range = { min: s.startTime ?? s.time, max: Math.max(end, s.time) };
    }
    // Analysis page: replays must broadcast to a linked coach exactly like a
    // real row, and only the live instance holds the coach link (stable peer
    // id). Hand the recording over and jump home; the live instance picks it
    // up and starts the replay (see the handoff effect below).
    if (isAnalysis) {
      replayHandoff.put(recordingRef.current, { speed: replaySpeed, range });
      window.location.hash = '';
      return;
    }
    startLiveReplay(recordingRef.current, replaySpeed, range);
  };
  const replayLabel = selectedIndex != null
    ? `▶ Replay from #${selectedIndex + 1}`
    : selection ? '▶ Replay range' : '▶ Replay';

  // Coach-side video recording: film the rower while watching their live data,
  // then package the footage + strokes into a shareable, analyzable bundle. The
  // viewfinder itself is a full-screen overlay (cameraOverlay, below); this
  // inline block is just the entry button and the post-recording actions.
  const videoView = linkRole === 'coach' && videoRecorder.supported && (
    <div className="live-video">
      {!videoArmed && !videoRecorder.isRecording && !videoBundle && (
        <button className="btn btn-secondary btn-sm" onClick={armVideo}>
          🎥 Record video
        </button>
      )}
      {videoRecorder.error && !videoArmed && <p className="oar-status">{videoRecorder.error}</p>}
      {videoBundle && (
        <div className="live-video-actions">
          <span className="live-video-ready">Video ready ({Math.round(videoBundle.blob.size / 1e6)} MB)</span>
          <button className="btn btn-primary btn-sm" onClick={openInAnalyzer}>
            Open in Analyzer
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => downloadBundle()}>
            Download bundle (.zip)
          </button>
          <button className="btn btn-secondary btn-sm" onClick={armVideo}>
            🎥 Record again
          </button>
        </div>
      )}
    </div>
  );

  // Full-screen landscape viewfinder. The record/stop control sits on the right
  // edge (camera-app shutter position) so it falls under the right thumb when the
  // phone is held two-handed in landscape; the zoom buttons flank it in the same
  // column so a coach holding the phone right-handed can reach everything with
  // the thumb. Exit (✕) is top-left, out of the way.
  const cameraOverlay = linkRole === 'coach' && videoRecorder.supported
    && (videoArmed || videoRecorder.isRecording) && (
    <div className="live-camera-fs" ref={cameraFsRef}>
      <video ref={previewVideoRef} className="live-camera-video" muted playsInline />

      {videoRecorder.isRecording
        ? <span className="live-camera-rec">● REC</span>
        : <span className="live-camera-hint">Frame the rower, then tap ● to record</span>}
      {videoRecorder.error && <p className="live-camera-error">{videoRecorder.error}</p>}

      <div className="live-camera-controls">
        {videoRecorder.zoomCaps && (
          <>
            <span className="live-camera-zoom-level">{videoRecorder.zoom?.toFixed(1)}×</span>
            <button
              className="live-camera-zoom"
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={videoRecorder.zoom >= videoRecorder.zoomCaps.max}
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
          </>
        )}
        {!videoRecorder.isRecording ? (
          <button
            className="live-camera-shutter live-camera-shutter-rec"
            onClick={startVideo}
            aria-label="Start recording"
            title="Start recording"
          />
        ) : (
          <button
            className="live-camera-shutter live-camera-shutter-stop"
            onClick={stopVideo}
            disabled={savingBundle}
            aria-label="Stop recording"
            title="Stop recording"
          >
            {savingBundle ? '…' : ''}
          </button>
        )}
        {videoRecorder.zoomCaps && (
          <button
            className="live-camera-zoom"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            disabled={videoRecorder.zoom <= videoRecorder.zoomCaps.min}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
        )}
      </div>

      {!videoRecorder.isRecording && (
        <button className="live-camera-close" onClick={closeCamera} aria-label="Close camera" title="Close camera">
          ✕
        </button>
      )}
    </div>
  );

  // --- Main panel switcher (stroke profile | map) ---
  // Both panels stay mounted (hidden via CSS) so the map keeps its zoom/center
  // and the chart its state; TrackMap re-fits itself on unhide via its own
  // ResizeObserver.
  const hasMap = !!mapView;
  const effectivePanel = panel === 'map' && !hasMap ? 'stroke' : panel;
  const choosePanel = (p) => {
    setPanel(p);
    try { localStorage.setItem(PANEL_KEY, p); } catch { /* storage unavailable */ }
  };
  const panelTabsView = (
    <div className="live-panel-tabs" role="tablist" aria-label="Data panel">
      {[
        { id: 'stroke', label: 'Stroke', enabled: true },
        { id: 'map', label: 'Map', enabled: hasMap, hint: 'Available once GPS has a fix' },
      ].map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={effectivePanel === t.id}
          className={`live-panel-tab${effectivePanel === t.id ? ' active' : ''}`}
          disabled={!t.enabled}
          title={t.enabled ? undefined : t.hint}
          onClick={() => choosePanel(t.id)}
        >
          {t.label}
        </button>
      ))}
      {/* Outdoor full-screen readout — a live-rowing display, so only while
          live/replaying; sits in the tab row so it's reachable from the map
          panel too, not just the stroke chart. */}
      {mode === 'live' && (
        <button
          className="live-panel-tab live-panel-tab-fs"
          onClick={() => setBigScreen(true)}
          aria-label="Full-screen display"
          title="Full-screen display"
        >
          {'⛶'}
        </button>
      )}
    </div>
  );
  const panelsView = (
    <div className="live-panels">
      <div className="live-panel" hidden={effectivePanel !== 'stroke'}>{chartView}</div>
      <div className="live-panel" hidden={effectivePanel !== 'map'}>{mapView}</div>
    </div>
  );

  // Review-mode sections fold behind a tappable header (the same idea as the
  // untapped stats line). Content is hidden, not unmounted, so the charts and
  // the map keep their state across a fold.
  const foldSection = (id, title, content) => (
    <div className="live-fold">
      <button
        className="live-fold-toggle"
        onClick={() => toggleFold(id)}
        aria-expanded={!folds[id]}
      >
        <span className="live-fold-title">{title}</span>
        <span className="live-fold-chevron" aria-hidden="true">{folds[id] ? '▸' : '▾'}</span>
      </button>
      <div hidden={!!folds[id]}>{content}</div>
    </div>
  );

  return (
    <AppShell page={isAnalysis ? 'strokes' : setupOpen ? 'link' : 'live'} title={pageTitle}>
    <div className={`live-capture${mode === 'live' ? ' live-embedded' : ''}`}>
      {cameraOverlay}
      {bigScreen && (
        <LiveBigScreen
          defaultPanel={isWatching ? 'graph' : 'map'}
          splitText={splitText}
          freeSpeedSeconds={freeSpeedSeconds}
          avgFreeSpeedSeconds={avgFreeSpeedSeconds}
          strokeRate={displayStrokeRate}
          pieceDistance={pieceDistance}
          sessionDistance={sessionDistance}
          onResetPiece={resetPiece}
          chartData={chartData}
          hasGPSAnchoring={hasGPSAnchoring}
          track={positions}
          onClose={() => setBigScreen(false)}
          onRecordVideo={isWatching && videoRecorder.supported
            ? () => { setBigScreen(false); armVideo(); }
            : undefined}
        />
      )}
      {/* Mode 1: setup — role, pairing, sensor status. In live / review mode
          the pairing panel only shows while on the drawer's Rower / Coach Link
          Setup destination (#link) — capture auto-starts on a rower's phone,
          so that destination must work mid-session too. */}
      {!isAnalysis && (mode === 'setup' || setupOpen) && linkPanel}

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

      {navHint && mode === 'live' && (
        <div className="live-nav-hint" role="status">
          Capture is running — hold <strong>Stop</strong> to end it.
        </div>
      )}

      {liveReplayActive && (
        <div className="live-replay-banner" role="status">
          ▶ Replaying recording at {replaySpeed}× — hold <strong>Stop</strong> to end.
        </div>
      )}

      {/* Stroke Analysis: no capture — just load a saved stroke data file and
          drop into the same review UI a finished row lands on. */}
      {mode === 'setup' && isAnalysis && (
        <>
          <div className="live-guide">
            Load a stroke data file (downloaded when a live capture stops) to
            review the session — every stroke, the timeline, and the map.
          </div>
          <div className="live-actions-secondary">
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
              className="btn btn-primary btn-large"
              onClick={() => fileInputRef.current?.click()}
              disabled={isReplaying}
            >
              {isReplaying ? 'Loading…' : 'Load stroke data'}
            </button>
          </div>
        </>
      )}

      {mode === 'setup' && !isAnalysis && (linkRole === 'coach' ? (
        <div className="live-guide">
          {link.peerStatus === 'connected'
            ? 'Connected. Waiting for the rower to start capturing…'
            : "Connect to the rower's phone above to watch their live stroke data."}
        </div>
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
              <div className="live-actions-secondary">
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
                  {isReplaying ? 'Replaying…' : 'Load stroke data'}
                </button>
              </div>
              <div className="live-actions">
                <button
                  key="start"
                  className="btn btn-primary btn-large live-start-btn"
                  onClick={startCapture}
                  disabled={startLocked}
                >
                  Start Capture
                </button>
              </div>
            </>
          )}
        </>
      ))}

      {/* Mode 2 (coach watching a stream): the same big-screen readout the
          rower sees, fed by the received stream — defaulting to the stroke
          curve (the coach steers the launch, not the shell). 🎥 in the readout
          opens the camera page; Pause drops into the review UI mid-stream. */}
      {mode === 'live' && !isCapturing && (
        <>
          {!bigScreen && (
            <LiveBigScreen
              embedded
              defaultPanel="graph"
              splitText={splitText}
              freeSpeedSeconds={freeSpeedSeconds}
              avgFreeSpeedSeconds={avgFreeSpeedSeconds}
              strokeRate={displayStrokeRate}
              pieceDistance={pieceDistance}
              sessionDistance={sessionDistance}
              onResetPiece={resetPiece}
              chartData={chartData}
              hasGPSAnchoring={hasGPSAnchoring}
              track={positions}
              onEnterFullscreen={() => setBigScreen(true)}
              onRecordVideo={videoRecorder.supported ? armVideo : undefined}
            />
          )}
          {videoBundle && videoView}
          <div className="live-actions">
            {activityView}
            <button className="btn btn-secondary live-pause-btn" onClick={pauseWatch}>
              Pause to inspect
            </button>
          </div>
        </>
      )}

      {/* Mode 2 (capturing / replaying locally): the page body IS the big-screen
          readout — same display as full screen, just under the app bar — with
          hold-to-stop pinned at the bottom. The ⛶ control swaps in the true
          full-screen overlay, which hides both. */}
      {mode === 'live' && isCapturing && (
        <>
          {!bigScreen && (
            <LiveBigScreen
              embedded
              splitText={splitText}
              freeSpeedSeconds={freeSpeedSeconds}
              avgFreeSpeedSeconds={avgFreeSpeedSeconds}
              strokeRate={displayStrokeRate}
              pieceDistance={pieceDistance}
              sessionDistance={sessionDistance}
              onResetPiece={resetPiece}
              chartData={chartData}
              hasGPSAnchoring={hasGPSAnchoring}
              track={positions}
              onEnterFullscreen={() => setBigScreen(true)}
            />
          )}
          <div className="live-actions">
            {activityView}
            <button
              key="stop"
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
          </div>
        </>
      )}

      {/* Mode 3: post-row analysis — the timeline navigator stays pinned at
          the bottom while the stroke or map panel above follows it. Every
          section folds behind its header so any one of them can take the
          screen (the untapped panel folds via its own stats line). */}
      {mode === 'review' && (
        <>
          {foldSection('stats', 'Session stats', statsView)}
          {foldSection('panel', 'Stroke & map', <>{panelTabsView}{panelsView}</>)}
          {untappedView}
          {linkRole !== 'coach' && (isAnalysis || sensorStatus === 'available') && (
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
          )}
          {linkRole === 'coach' && videoView}
          <div className="live-foot">
            {timelineNav && foldSection('timeline', 'Timeline', timelineNav)}
            {timelineFooter}
            <div className="live-foot-actions">
              {hasRecording && (
                <>
                  <button className="btn btn-secondary" onClick={replayFromSelection} disabled={isReplaying}>
                    {replayLabel}
                  </button>
                  <label className="live-replay-speed">
                    <select
                      value={replaySpeed}
                      onChange={(e) => setReplaySpeed(Number(e.target.value))}
                      aria-label="Replay speed"
                    >
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                      <option value={4}>4×</option>
                      <option value={8}>8×</option>
                    </select>
                  </label>
                </>
              )}
              {linkRole === 'coach' ? (
                isWatching && isPaused && (
                  <button className="btn btn-primary" onClick={resumeWatch}>
                    Resume live
                  </button>
                )
              ) : (
                !isAnalysis && sensorStatus === 'available' && (
                  <button
                    key="start"
                    className="btn btn-primary live-start-btn"
                    onClick={startCapture}
                    disabled={startLocked}
                  >
                    Restart Capture
                  </button>
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
    </AppShell>
  );
}

export default LiveCapture;
