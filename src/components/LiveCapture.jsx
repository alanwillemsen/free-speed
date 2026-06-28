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
import { useVideoRecorder } from '../hooks/useVideoRecorder';
import AppShell from './AppShell';
import { useChartChrome } from '../utils/chartTheme';
import * as sessionStore from '../utils/sessionStore';
import * as pairStore from '../utils/pairStore';
import * as videoStore from '../utils/videoStore';
import { packBundle } from '../utils/videoBundle';
import { catchStartIndex, rollCurve } from '../utils/curves';
import {
  NUM_POINTS, MIN_ROW_SPEED, MAX_ROW_SPEED, SPLIT_WINDOW_MS,
  REF_SPEEDS, REF_AVG, REF_ROLLED, PHASE_TIMES,
  windowedGpsSpeed, averageCurves, freeSpeedSecondsFor,
  makeProc, feedSample, buildReplayEvents, subtractGravity,
} from '../utils/strokePipeline';

ChartJS.register(LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// --- Constants (UI / networking; signal-processing constants and the stroke
// engine live in utils/strokePipeline) ---
const UI_UPDATE_MS = 250;
const SEND_BATCH_MS = 100;        // Batch outgoing samples this often when coach-linked
const PERSIST_FLUSH_MS = 2000;    // Flush new samples to IndexedDB this often (crash recovery)

// --- Component ---

function LiveCapture({ onSaveCurve }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [sensorStatus, setSensorStatus] = useState('checking');
  // Outdoor full-screen readout (split + spm + speed profile). Capture keeps
  // running underneath while it's open.
  const [bigScreen, setBigScreen] = useState(false);

  // Coach link: 'rower' = this phone is mounted in the boat and (optionally)
  // streams to a coach; 'coach' = this phone watches a rower's stream and runs
  // the same processing pipeline on the received samples.
  const [linkRole, setLinkRole] = useState(() => pairStore.getRole());
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
  // Index into `strokes` for showing a single stroke instead of the average.
  // null = show average.
  const [selectedIndex, setSelectedIndex] = useState(null);

  // Processing state lives in refs to avoid stale closures in the 60 Hz handler
  const procRef = useRef(null);
  // Boat fore-aft direction now lives on proc.direction (set by the shared
  // engine in utils/strokePipeline) — no separate ref needed.
  const orientationRef = useRef({ beta: 0, gamma: 0 });
  const gpsRef = useRef({ speeds: [], watchId: null });
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
  const lastPingRef = useRef(null);
  // Coach diagnostics: count samples received from the rower so we can tell
  // "not receiving" apart from "receiving but not detecting".
  const recvRef = useRef({ motion: 0, gps: 0, orientation: 0 });
  const [coachDiag, setCoachDiag] = useState('');

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

    // Run the shared stroke-detection engine (calibration, orientation tracking,
    // boundary detection). It mutates proc and returns the newly completed
    // stroke (or null). Live capture requires GPS to record; replay/coach-fed
    // data (nowOverride set) records without it.
    const stroke = feedSample(proc, accelValues, now, gpsRef.current.speeds, {
      allowWithoutGps: nowOverride != null,
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
    recvRef.current = { motion: 0, gps: 0, orientation: 0 };
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
          recvRef.current.motion += msg.samples.length;
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
          recvRef.current.orientation += msg.samples.length;
          const rec = recordingRef.current;
          for (const s of msg.samples) {
            if (s.beta != null) orientationRef.current = { beta: s.beta, gamma: s.gamma };
            if (rec) rec.orientation.push(s);
          }
        }
        break;
      case 'gps':
        if (Array.isArray(msg.samples)) {
          recvRef.current.gps += msg.samples.length;
          const rec = recordingRef.current;
          for (const s of msg.samples) {
            accumulateDistance(s.t, s.speed);
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
    onJoin: () => setLinkRole('coach'),
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
    if (linkRole === 'rower' && !linkHasPeer && !autoEnabledRef.current) {
      autoEnabledRef.current = true;
      linkInitPeer();
    }
  }, [linkRole, linkHasPeer, linkInitPeer]);

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

  const startVideo = async () => {
    const anchor = await videoRecorder.start();
    if (!anchor) return;
    videoAnchorRef.current = { ...anchor, rowerToCoachOffset: rowerToCoachRef.current ?? 0 };
    setVideoBundle(null);
  };

  // Stop recording and package the footage with the strokes received so far into
  // a downloadable/analyzable ZIP bundle.
  const stopVideo = async () => {
    setSavingBundle(true);
    try {
      const blob = await videoRecorder.stop();
      const rec = recordingRef.current;
      if (!blob || !rec) { setSavingBundle(false); return; }
      const anchor = videoAnchorRef.current || {};
      // Lock in the best clock offset we have at stop time.
      anchor.rowerToCoachOffset = rowerToCoachRef.current ?? anchor.rowerToCoachOffset ?? 0;
      const meta = {
        ...rec,
        video: {
          startCoachPerf: anchor.startCoachPerf ?? 0,
          rowerToCoachOffset: anchor.rowerToCoachOffset,
          mime: anchor.mime || blob.type,
          fps: anchor.fps || 30,
        },
      };
      setVideoBundle({ blob, meta });
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

  const downloadBundle = async () => {
    if (!videoBundle) return;
    const zip = await packBundle(videoBundle.meta, videoBundle.blob);
    const url = URL.createObjectURL(zip);
    const stamp = (videoBundle.meta.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
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

      // Coach diagnostic: what's actually arriving vs. being detected.
      if (isWatching) {
        const r = recvRef.current;
        const gate = proc.hasGPS ? 'gps' : (gpsRef.current.speeds.length ? 'gps(stale)' : 'no-gps');
        setCoachDiag(
          `rx ${r.motion} motion · ${r.gps} gps · calib ${proc.calibration.done ? 'yes' : 'no'} · ` +
          `${gpsRef.current.speeds.length} gps-buf · ${gate} · ${proc.strokes.length} strokes`
        );
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
    if (replayRef.current) {
      replayRef.current.cancel();
      recordingRef.current = replayRef.current.recording;
      replayRef.current = null;
      setLiveReplayActive(false);
    }
    setIsCapturing(false);
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
    if (!isCapturing || replayRef.current) return; // no exit trap during a desk replay
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
    setLastStroke(proc.lastStroke);
    setAvgCurve(proc.avgCurve);
    setHasGPSAnchoring(proc.hasGPS);
    publishAvgFreeSpeed();
    setCalibrationStatus(proc.direction ? 'detected' : 'idle');
    setStrokes([...proc.strokes]);
    setSelection(null);
    setSelectedIndex(null);
    setPieceDistance(distanceRef.current.piece);
    setSessionDistance(distanceRef.current.session);
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
    setGpsStatus(recording.gps && recording.gps.length ? 'active' : 'unavailable');
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
      while (idx < events.length && events[idx].t <= playT) {
        applyReplayEvent(events[idx]);
        idx++;
      }
      if (idx < events.length) {
        state.rafId = requestAnimationFrame(step);
      } else {
        stopCapture(); // snapshots proc → strokes, restores recording, clears replayRef
      }
    };
    state.cancel = () => {
      state.cancelled = true;
      if (state.rafId != null) cancelAnimationFrame(state.rafId);
    };
    replayRef.current = state;
    state.rafId = requestAnimationFrame(step);
  };

  const handleOpenInCalculator = () => {
    // Open whatever's on the chart: a single inspected stroke when one is
    // selected, otherwise the average of the reviewed strokes.
    const curveToSave = individualStroke ? individualStroke.curve : displayAvgCurve;
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
      // Scale the captured curve so its mean matches the reference curve
      const curAvg = curveToSave.reduce((a, b) => a + b, 0) / curveToSave.length;
      const scale = REF_AVG / curAvg;
      scaledSpeeds = curveToSave.map(v => v * scale);
    }
    const desc = individualStroke
      ? `1 stroke at ${displayStrokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`
      : `${displayCount} strokes at ${displayStrokeRate} spm${hasGPSAnchoring ? ' (GPS)' : ''}`;
    onSaveCurve({
      name: `Live Capture ${new Date().toLocaleString()}`,
      desc,
      speeds: scaledSpeeds,
      strokeRate: displayStrokeRate || 36,
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
  // live latest stroke, else the reviewed average.
  const comparisonCurve = individualStroke ? individualStroke.curve
    : (isCapturing || isWatching) ? lastStroke
    : displayAvgCurve;
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
  // in (see catchStartIndex). Driven by the stroke on screen so the average and
  // the inspected/last stroke stay mutually aligned; the reference uses its own.
  const rollStart = comparisonCurve && comparisonCurve.length
    ? catchStartIndex(comparisonCurve)
    : 0;

  // Auto-scale the y-axis to whatever's plotted (scaled potential + the curves
  // shown), padded, so each stroke fills the frame instead of a fixed scale.
  const ys = REF_SPEEDS.map((s) => s * potentialScale);
  if (displayAvgCurve) ys.push(...displayAvgCurve);
  if (individualStroke) ys.push(...individualStroke.curve);
  else if (lastStroke && displayAvgCurve) ys.push(...lastStroke);
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

    if (displayAvgCurve) {
      datasets.push({
        label: individualStroke
          ? `Average (${displayCount} strokes)`
          : `Average (${displayCount} strokes)`,
        data: rollCurve(displayAvgCurve, rollStart).map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
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
        data: rollCurve(individualStroke.curve, rollStart).map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
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
        data: rollCurve(lastStroke, rollStart).map((s, i) => ({ x: PHASE_TIMES[i], y: s })),
        borderColor: 'rgba(255, 99, 132, 0.4)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      });
    }

    return { datasets };
  }, [displayAvgCurve, lastStroke, displayCount, individualStroke, selectedIndex, strokes.length, potentialScale, rollStart]);

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
          : {}),
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
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowLinkConfig((v) => !v)}
            aria-expanded={showLinkConfig}
          >
            {showLinkConfig ? 'Hide coach link setup' : 'Configure coach link'}
          </button>
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
        <button className="btn btn-primary btn-large" onClick={handleOpenInCalculator}>
          Open in Calculator
        </button>
      )}
      {/* Real-time replay of a loaded/captured recording — drive the live UI
          from a desk for testing. Replays the selected stroke range when one is
          set (drag the slider above), otherwise the whole row. */}
      {hasRecording && (
        <div className="live-replay-controls">
          <button
            className="btn btn-secondary btn-large"
            onClick={() => startLiveReplay(recordingRef.current, replaySpeed, selection)}
          >
            {selection ? '▶ Replay range live' : '▶ Replay live'}
          </button>
          <label className="live-replay-speed">
            Speed
            <select
              value={replaySpeed}
              onChange={(e) => setReplaySpeed(Number(e.target.value))}
            >
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
              <option value={8}>8×</option>
            </select>
          </label>
        </div>
      )}
      {hasRecording && (
        <button className="btn btn-secondary btn-large" onClick={downloadRecording}>
          Download recording
        </button>
      )}
    </>
  );

  // Coach-side video recording: film the rower while watching their live data,
  // then package the footage + strokes into a shareable, analyzable bundle. The
  // viewfinder itself is a full-screen overlay (cameraOverlay, below); this
  // inline block is just the entry button and the post-recording actions.
  const videoView = linkRole === 'coach' && videoRecorder.supported && (
    <div className="live-video">
      {!videoArmed && !videoRecorder.isRecording && (
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
          <button className="btn btn-secondary btn-sm" onClick={downloadBundle}>
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
  // phone is held two-handed in landscape. Exit (✕) is top-left, out of the way.
  const cameraOverlay = linkRole === 'coach' && videoRecorder.supported
    && (videoArmed || videoRecorder.isRecording) && (
    <div className="live-camera-fs" ref={cameraFsRef}>
      <video ref={previewVideoRef} className="live-camera-video" muted playsInline />

      {videoRecorder.isRecording
        ? <span className="live-camera-rec">● REC</span>
        : <span className="live-camera-hint">Frame the rower, then tap ● to record</span>}
      {videoRecorder.error && <p className="live-camera-error">{videoRecorder.error}</p>}

      <div className="live-camera-controls">
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
      </div>

      {!videoRecorder.isRecording && (
        <button className="live-camera-close" onClick={closeCamera} aria-label="Close camera" title="Close camera">
          ✕
        </button>
      )}
    </div>
  );

  return (
    <AppShell page="live" title="Live Stroke Capture">
    <div className="live-capture">
      {cameraOverlay}
      {bigScreen && (
        <LiveBigScreen
          splitText={splitText}
          freeSpeedSeconds={freeSpeedSeconds}
          avgFreeSpeedSeconds={avgFreeSpeedSeconds}
          strokeRate={displayStrokeRate}
          pieceDistance={pieceDistance}
          sessionDistance={sessionDistance}
          onResetPiece={resetPiece}
          chartData={chartData}
          hasGPSAnchoring={hasGPSAnchoring}
          onClose={() => setBigScreen(false)}
        />
      )}
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

      {liveReplayActive && (
        <div className="live-replay-banner" role="status">
          ▶ Replaying recording at {replaySpeed}× — hold <strong>Stop</strong> to end.
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
          {isWatching && coachDiag && (
            <div className="live-coach-diag">{coachDiag}</div>
          )}
          {statsView}
          {chartView}
          {timeChartView}
          {activityView}
          {videoView}
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
              <button className="btn btn-primary btn-large" onClick={handleOpenInCalculator}>
                Open in Calculator
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
    </AppShell>
  );
}

export default LiveCapture;
