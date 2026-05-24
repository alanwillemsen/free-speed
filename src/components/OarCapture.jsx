import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Peer from 'peerjs';
import QRCode from 'qrcode';
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

ChartJS.register(LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const PREVIEW_WINDOW_MS = 10000; // last 10s of rotation-rate samples
const PREVIEW_UPDATE_MS = 250;

// First-cut capture screen for dual-phone sessions.
//
// One phone is mounted on the oar (role: "rower"), the other in the boat or a
// chase boat (role: "coach"). Both phones record their own raw IMU + GPS to a
// downloadable JSON. A WebRTC data channel (via peerjs) links the two so the
// rower phone can stream live samples to the coach phone; the coach also saves
// the received stream alongside its own.
//
// The goal of this first cut is to get clean, replayable data off the water so
// the derivation work (oar angle from gyro, catch/finish, slip detection,
// current correction from GPS-vs-IMU) can happen offline against real files.

const RECORDING_VERSION = 1;
const UI_UPDATE_MS = 250;
const SEND_BATCH_MS = 100; // batch outgoing samples this often to keep DC happy
const PEER_ID_PREFIX = 'freespeed-';
const PEER_ID_RETRIES = 5;

function makeShortCode() {
  // 5-digit numeric code: easy to read out loud, easy to type.
  return String(Math.floor(10000 + Math.random() * 90000));
}

function shortFromPeerId(peerId) {
  return peerId?.startsWith(PEER_ID_PREFIX) ? peerId.slice(PEER_ID_PREFIX.length) : peerId;
}

function parseJoinFromHash() {
  const m = window.location.hash.match(/[?&]join=([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

function buildJoinUrl(shortCode) {
  return `${window.location.origin}${window.location.pathname}#oar?join=${shortCode}`;
}

function newRecording(role) {
  return {
    version: RECORDING_VERSION,
    role,
    startedAt: new Date().toISOString(),
    startedAtWall: Date.now(),
    startedAtPerf: performance.now(),
    userAgent: navigator.userAgent,
    motion: [],       // { t, tWall, ax, ay, az, axg, ayg, azg, rrA, rrB, rrG, interval }
    orientation: [],  // { t, tWall, alpha, beta, gamma, absolute }
    gps: [],          // { t, tWall, lat, lon, speed, heading, accuracy, altitude, fixTime }
    peer: {
      // Anything we receive over the data channel from the other phone gets
      // appended here. Each sample keeps its own `t` (sender's performance.now)
      // and `tWall` (sender's Date.now). Cross-device alignment is done offline
      // using tWall.
      role: null,
      startedAtWall: null,
      motion: [],
      orientation: [],
      gps: [],
    },
  };
}

function downloadJSON(obj, filenameStem) {
  const json = JSON.stringify(obj);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = (obj.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameStem}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function OarCapture({ onBack }) {
  // --- UI state ---
  const [role, setRole] = useState('rower'); // 'rower' or 'coach'
  const [sensorStatus, setSensorStatus] = useState('unknown'); // unknown | requesting | available | denied
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | requesting | active | unavailable
  const [isCapturing, setIsCapturing] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);

  // --- Peer state ---
  const [myPeerId, setMyPeerId] = useState('');
  const [remoteShortCode, setRemoteShortCode] = useState('');
  const [peerStatus, setPeerStatus] = useState('idle'); // idle | initializing | online | connecting | connected | error
  const [peerError, setPeerError] = useState('');
  const [lastPing, setLastPing] = useState(null); // ms round-trip
  const [qrDataUrl, setQrDataUrl] = useState('');
  const autoConnectOnReadyRef = useRef(false);

  // --- Live counters (refreshed periodically from refs to avoid re-rendering per sample) ---
  const [counts, setCounts] = useState({
    motion: 0, orientation: 0, gps: 0,
    peerMotion: 0, peerGps: 0,
  });

  // --- Persistent refs ---
  const recordingRef = useRef(null);
  const peerRef = useRef(null);
  const connRef = useRef(null);
  const gpsWatchRef = useRef(null);
  const wakeLockRef = useRef(null);
  const sendBufferRef = useRef({ motion: [], orientation: [], gps: [] });
  const sendIntervalRef = useRef(null);
  const pingStartRef = useRef(null);

  // Rolling rotation-rate preview buffers (own and peer). Trimmed periodically
  // by the UI refresh interval, not on every push, to keep the motion handler
  // cheap at high sample rates.
  const ownPreviewRef = useRef([]);
  const peerPreviewRef = useRef([]);
  const [previewSource, setPreviewSource] = useState('own'); // 'own' | 'peer' | 'none'
  const [previewData, setPreviewData] = useState({ t: [], rrA: [], rrB: [], rrG: [] });

  // Rolling deviceorientation buffers — used to compute the magnetometer-derived
  // oar angle (oar.alpha − boat.alpha) when both phones are streaming.
  const ownOrientPreviewRef = useRef([]);
  const peerOrientPreviewRef = useRef([]);
  const [angleData, setAngleData] = useState({ t: [], angle: [] });
  const [angleStatus, setAngleStatus] = useState('waiting'); // waiting | ok | no-compass | no-peer

  // ---------- Sensor permission ----------
  const requestSensors = async () => {
    setSensorStatus('requesting');
    try {
      let motionResult = 'granted';
      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        motionResult = await DeviceMotionEvent.requestPermission();
      }
      let orientResult = 'granted';
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        orientResult = await DeviceOrientationEvent.requestPermission();
      }
      const ok = motionResult === 'granted' && orientResult === 'granted';
      setSensorStatus(ok ? 'available' : 'denied');
    } catch {
      setSensorStatus('denied');
    }
  };

  // ---------- Peer connection (peerjs) ----------
  const setupConnHandlers = useCallback((conn) => {
    connRef.current = conn;
    conn.on('open', () => {
      setPeerStatus('connected');
      // Send a hello so the peer knows our role and startup time.
      try {
        conn.send({
          type: 'hello',
          role,
          startedAtWall: Date.now(),
          startedAtPerf: performance.now(),
        });
      } catch { /* ignore */ }
    });
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const rec = recordingRef.current;
      switch (msg.type) {
        case 'hello':
          if (rec) {
            rec.peer.role = msg.role ?? null;
            rec.peer.startedAtWall = msg.startedAtWall ?? null;
          }
          break;
        case 'motion':
          if (Array.isArray(msg.samples)) {
            if (rec) for (const s of msg.samples) rec.peer.motion.push(s);
            for (const s of msg.samples) {
              if (s.rrA != null || s.rrB != null || s.rrG != null) {
                peerPreviewRef.current.push(s);
              }
            }
          }
          break;
        case 'orientation':
          if (Array.isArray(msg.samples)) {
            if (rec) for (const s of msg.samples) rec.peer.orientation.push(s);
            for (const s of msg.samples) {
              if (s.alpha != null) peerOrientPreviewRef.current.push(s);
            }
          }
          break;
        case 'gps':
          if (rec && Array.isArray(msg.samples)) {
            for (const s of msg.samples) rec.peer.gps.push(s);
          }
          break;
        case 'ping':
          try { conn.send({ type: 'pong', t: msg.t }); } catch { /* ignore */ }
          break;
        case 'pong':
          if (pingStartRef.current && msg.t === pingStartRef.current.t) {
            setLastPing(Math.round(performance.now() - pingStartRef.current.start));
            pingStartRef.current = null;
          }
          break;
        default:
          break;
      }
    });
    conn.on('close', () => {
      setPeerStatus('online');
      connRef.current = null;
    });
    conn.on('error', (err) => {
      setPeerError(String(err?.message ?? err));
      setPeerStatus('error');
    });
  }, [role]);

  const initPeer = useCallback(() => {
    if (peerRef.current) return;
    setPeerStatus('initializing');
    setPeerError('');

    let attempts = 0;
    const tryClaim = () => {
      attempts += 1;
      const shortCode = makeShortCode();
      const desiredId = PEER_ID_PREFIX + shortCode;
      const peer = new Peer(desiredId);
      let opened = false;

      peer.on('open', (id) => {
        opened = true;
        peerRef.current = peer;
        setMyPeerId(id);
        setPeerStatus('online');
      });
      peer.on('connection', (conn) => {
        setupConnHandlers(conn);
        setPeerStatus('connecting');
      });
      peer.on('error', (err) => {
        if (!opened && err?.type === 'unavailable-id' && attempts < PEER_ID_RETRIES) {
          // Collision on the public broker — pick a new code and retry.
          try { peer.destroy(); } catch { /* ignore */ }
          tryClaim();
          return;
        }
        setPeerError(String(err?.message ?? err));
        setPeerStatus('error');
      });
      peer.on('disconnected', () => {
        setPeerStatus((s) => (s === 'connected' ? 'online' : s));
      });
    };
    tryClaim();
  }, [setupConnHandlers]);

  const connectToRemote = useCallback((overrideCode) => {
    if (!peerRef.current) return;
    const raw = (overrideCode ?? remoteShortCode).trim();
    if (!raw) return;
    // Accept either the bare short code ("12345") or the full peer id
    // ("freespeed-12345") so the typed and scanned paths both work.
    const targetId = raw.startsWith(PEER_ID_PREFIX) ? raw : PEER_ID_PREFIX + raw;
    setPeerStatus('connecting');
    const conn = peerRef.current.connect(targetId, { reliable: true });
    setupConnHandlers(conn);
  }, [remoteShortCode, setupConnHandlers]);

  // Generate a QR code for the join URL once we have our own peer id.
  useEffect(() => {
    if (!myPeerId) { setQrDataUrl(''); return; }
    const url = buildJoinUrl(shortFromPeerId(myPeerId));
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [myPeerId]);

  // If the page was opened via a join URL (e.g. by scanning the other phone's
  // QR), prefill the remote code, kick off peer init, and auto-connect once
  // online.
  useEffect(() => {
    const join = parseJoinFromHash();
    if (!join) return;
    setRemoteShortCode(join);
    autoConnectOnReadyRef.current = true;
    initPeer();
  }, [initPeer]);

  // When the auto-connect flag is set and we just came online, trigger connect.
  useEffect(() => {
    if (peerStatus !== 'online') return;
    if (!autoConnectOnReadyRef.current) return;
    autoConnectOnReadyRef.current = false;
    connectToRemote();
  }, [peerStatus, connectToRemote]);

  const sendPing = () => {
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    const t = Math.random().toString(36).slice(2);
    pingStartRef.current = { t, start: performance.now() };
    try { conn.send({ type: 'ping', t }); } catch { /* ignore */ }
  };

  // ---------- Live sensor handlers ----------
  const motionHandlerRef = useRef(null);
  const orientationHandlerRef = useRef(null);

  motionHandlerRef.current = (event) => {
    const rec = recordingRef.current;
    if (!rec) return;
    const t = performance.now();
    const tWall = Date.now();
    const a = event.acceleration;
    const ag = event.accelerationIncludingGravity;
    const rr = event.rotationRate;
    const sample = { t, tWall, interval: event.interval ?? null };
    if (a && a.x != null) { sample.ax = a.x; sample.ay = a.y; sample.az = a.z; }
    if (ag && ag.x != null) { sample.axg = ag.x; sample.ayg = ag.y; sample.azg = ag.z; }
    if (rr && (rr.alpha != null || rr.beta != null || rr.gamma != null)) {
      sample.rrA = rr.alpha;
      sample.rrB = rr.beta;
      sample.rrG = rr.gamma;
    }
    rec.motion.push(sample);
    if (sample.rrA != null || sample.rrB != null || sample.rrG != null) {
      ownPreviewRef.current.push(sample);
    }
    if (connRef.current?.open) sendBufferRef.current.motion.push(sample);
  };

  orientationHandlerRef.current = (event) => {
    const rec = recordingRef.current;
    if (!rec) return;
    const sample = {
      t: performance.now(),
      tWall: Date.now(),
      alpha: event.alpha,
      beta: event.beta,
      gamma: event.gamma,
      absolute: event.absolute ?? null,
    };
    rec.orientation.push(sample);
    if (sample.alpha != null) ownOrientPreviewRef.current.push(sample);
    if (connRef.current?.open) sendBufferRef.current.orientation.push(sample);
  };

  // ---------- Capture lifecycle ----------
  const startCapture = async () => {
    // Guard against accidentally clobbering an undownloaded session — most
    // commonly when the user double-taps Stop and the button has just swapped
    // to Start in the same spot.
    if (recordingRef.current && recordingRef.current.motion.length > 0) {
      const ok = window.confirm(
        'Discard the previous recording and start a new one? ' +
        'Cancel if you still want to download it.'
      );
      if (!ok) return;
    }
    if (sensorStatus !== 'available') {
      await requestSensors();
      // If still not available after request, bail.
      if (sensorStatus !== 'available') return;
    }
    recordingRef.current = newRecording(role);
    sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    setHasRecording(false);
    setIsCapturing(true);

    // Mirror existing hello to a freshly-connected peer (if any) so the peer
    // tags its peer.role/startedAtWall correctly.
    if (connRef.current?.open) {
      try {
        connRef.current.send({
          type: 'hello',
          role,
          startedAtWall: Date.now(),
          startedAtPerf: performance.now(),
        });
      } catch { /* ignore */ }
    }

    // Attach motion + orientation listeners. These dispatch into ref handlers
    // so we don't tear them down on every re-render.
    const motion = (e) => motionHandlerRef.current?.(e);
    const orient = (e) => orientationHandlerRef.current?.(e);
    window.addEventListener('devicemotion', motion);
    window.addEventListener('deviceorientation', orient);
    // Keep references so we can remove them on stop.
    recordingRef.current._listeners = { motion, orient };

    // GPS
    if ('geolocation' in navigator) {
      setGpsStatus('requesting');
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const sample = {
            t: performance.now(),
            tWall: Date.now(),
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
            accuracy: pos.coords.accuracy,
            altitude: pos.coords.altitude,
            fixTime: pos.timestamp,
          };
          const rec = recordingRef.current;
          if (rec) rec.gps.push(sample);
          if (connRef.current?.open) sendBufferRef.current.gps.push(sample);
          setGpsStatus('active');
        },
        () => setGpsStatus('unavailable'),
        { enableHighAccuracy: true, maximumAge: 0 }
      );
      gpsWatchRef.current = watchId;
    } else {
      setGpsStatus('unavailable');
    }

    // Periodically flush the send buffer to the data channel.
    sendIntervalRef.current = setInterval(() => {
      const conn = connRef.current;
      if (!conn || !conn.open) {
        // Drop the buffer — no peer to send to.
        sendBufferRef.current = { motion: [], orientation: [], gps: [] };
        return;
      }
      const buf = sendBufferRef.current;
      if (buf.motion.length) {
        try { conn.send({ type: 'motion', samples: buf.motion }); } catch { /* ignore */ }
      }
      if (buf.orientation.length) {
        try { conn.send({ type: 'orientation', samples: buf.orientation }); } catch { /* ignore */ }
      }
      if (buf.gps.length) {
        try { conn.send({ type: 'gps', samples: buf.gps }); } catch { /* ignore */ }
      }
      sendBufferRef.current = { motion: [], orientation: [], gps: [] };
    }, SEND_BATCH_MS);

    // Wake lock so screen stays on.
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch { /* not critical */ }
  };

  const stopCapture = () => {
    setIsCapturing(false);
    const rec = recordingRef.current;
    if (rec?._listeners) {
      window.removeEventListener('devicemotion', rec._listeners.motion);
      window.removeEventListener('deviceorientation', rec._listeners.orient);
      delete rec._listeners;
    }
    if (gpsWatchRef.current != null) {
      navigator.geolocation.clearWatch(gpsWatchRef.current);
      gpsWatchRef.current = null;
    }
    if (sendIntervalRef.current != null) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setGpsStatus('idle');
    if (rec && rec.motion.length > 0) setHasRecording(true);
  };

  // Periodic UI refresh of counters.
  useEffect(() => {
    if (!isCapturing) return;
    const id = setInterval(() => {
      const rec = recordingRef.current;
      if (!rec) return;
      setCounts({
        motion: rec.motion.length,
        orientation: rec.orientation.length,
        gps: rec.gps.length,
        peerMotion: rec.peer.motion.length,
        peerGps: rec.peer.gps.length,
      });
    }, UI_UPDATE_MS);
    return () => clearInterval(id);
  }, [isCapturing]);

  // Periodic preview-chart refresh. Runs always so a coach phone that hasn't
  // started its own capture still sees the incoming peer rotation stream.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - PREVIEW_WINDOW_MS;
      ownPreviewRef.current = ownPreviewRef.current.filter(s => s.tWall >= cutoff);
      peerPreviewRef.current = peerPreviewRef.current.filter(s => s.tWall >= cutoff);

      // The graph should always try to show the *rower's* oar, regardless of
      // which phone is doing the rendering. So: a rower phone shows its own
      // sensor; a coach phone shows the peer stream when it's arriving (with
      // a tolerant freshness check that accounts for clock skew between
      // devices), falling back to own only when the link is silent.
      const PEER_FRESH_MS = 1500;
      const ownLen = ownPreviewRef.current.length;
      const peerLen = peerPreviewRef.current.length;
      let source = 'none';
      let series = [];
      if (role === 'rower') {
        if (ownLen > 0) { source = 'own'; series = ownPreviewRef.current; }
      } else {
        const peerLast = peerPreviewRef.current[peerLen - 1];
        const peerFresh = peerLast && peerLast.tWall >= Date.now() - PEER_FRESH_MS;
        if (peerLen > 0 && peerFresh) {
          source = 'peer'; series = peerPreviewRef.current;
        } else if (ownLen > 0) {
          source = 'own'; series = ownPreviewRef.current;
        }
      }

      // --- Trim orientation buffers and compute oar.alpha − boat.alpha ---
      ownOrientPreviewRef.current = ownOrientPreviewRef.current.filter(s => s.tWall >= cutoff);
      peerOrientPreviewRef.current = peerOrientPreviewRef.current.filter(s => s.tWall >= cutoff);
      const oarOrient = role === 'rower' ? ownOrientPreviewRef.current : peerOrientPreviewRef.current;
      const boatOrient = role === 'rower' ? peerOrientPreviewRef.current : ownOrientPreviewRef.current;

      // For each oar-orientation sample, find the boat-orientation sample
      // nearest in wall-clock and within tolerance. Subtract, wrap to ±180°.
      const ORIENT_MATCH_TOL_MS = 250;
      const angleT = [], angleY = [];
      let aStatus = 'waiting';
      if (oarOrient.length === 0) {
        aStatus = 'waiting';
      } else if (boatOrient.length === 0) {
        aStatus = 'no-peer';
      } else {
        const t0o = oarOrient[0].tWall;
        let j = 0; // pointer into boatOrient for amortized linear scan
        for (const o of oarOrient) {
          // Advance j while the next boat sample is closer to o.tWall
          while (j + 1 < boatOrient.length &&
                 Math.abs(boatOrient[j + 1].tWall - o.tWall) <
                 Math.abs(boatOrient[j].tWall - o.tWall)) {
            j += 1;
          }
          const b = boatOrient[j];
          if (Math.abs(b.tWall - o.tWall) <= ORIENT_MATCH_TOL_MS &&
              o.alpha != null && b.alpha != null) {
            let d = o.alpha - b.alpha;
            while (d > 180) d -= 360;
            while (d <= -180) d += 360;
            angleT.push((o.tWall - t0o) / 1000);
            angleY.push(d);
          }
        }
        aStatus = angleY.length > 0 ? 'ok' : 'no-peer';
      }
      // Downsample angle series for chart performance.
      let dsT = angleT, dsY = angleY;
      if (angleT.length > 200) {
        const stride = Math.ceil(angleT.length / 200);
        dsT = []; dsY = [];
        for (let i = 0; i < angleT.length; i += stride) {
          dsT.push(angleT[i]); dsY.push(angleY[i]);
        }
      }
      setAngleStatus(aStatus);
      setAngleData({ t: dsT, angle: dsY });

      if (series.length === 0) {
        setPreviewSource(source);
        setPreviewData({ t: [], rrA: [], rrB: [], rrG: [] });
        return;
      }
      // Downsample rotation-rate series too.
      const stride = Math.max(1, Math.ceil(series.length / 200));
      const t = [], rrA = [], rrB = [], rrG = [];
      const t0 = series[0].tWall;
      for (let i = 0; i < series.length; i += stride) {
        const s = series[i];
        t.push((s.tWall - t0) / 1000);
        rrA.push(s.rrA ?? null);
        rrB.push(s.rrB ?? null);
        rrG.push(s.rrG ?? null);
      }
      setPreviewSource(source);
      setPreviewData({ t, rrA, rrB, rrG });
    }, PREVIEW_UPDATE_MS);
    return () => clearInterval(id);
  }, [role]);

  // Tear down peerjs on unmount.
  useEffect(() => () => {
    if (gpsWatchRef.current != null) navigator.geolocation.clearWatch(gpsWatchRef.current);
    if (sendIntervalRef.current != null) clearInterval(sendIntervalRef.current);
    connRef.current?.close?.();
    peerRef.current?.destroy?.();
  }, []);

  const downloadRecording = () => {
    const rec = recordingRef.current;
    if (!rec || rec.motion.length === 0) return;
    // Strip internal listener handles before saving.
    const { _listeners, ...clean } = rec;
    void _listeners;
    downloadJSON(clean, `oar-${rec.role}`);
  };

  const handleLoadRecording = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const rec = JSON.parse(e.target.result);
        if (!rec.motion || !Array.isArray(rec.motion)) {
          throw new Error('missing motion array');
        }
        recordingRef.current = rec;
        setHasRecording(true);
        setCounts({
          motion: rec.motion.length,
          orientation: rec.orientation?.length ?? 0,
          gps: rec.gps?.length ?? 0,
          peerMotion: rec.peer?.motion?.length ?? 0,
          peerGps: rec.peer?.gps?.length ?? 0,
        });
      } catch (err) {
        alert('Failed to load recording: ' + err.message);
      }
    };
    reader.onerror = () => alert('Failed to read file');
    reader.readAsText(file);
  };

  // ---------- Preview chart config ----------
  const previewChartData = useMemo(() => ({
    labels: previewData.t,
    datasets: [
      { label: 'rrA (α)', data: previewData.rrA, borderColor: '#e53e3e', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.15, spanGaps: true },
      { label: 'rrB (β)', data: previewData.rrB, borderColor: '#3182ce', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.15, spanGaps: true },
      { label: 'rrG (γ)', data: previewData.rrG, borderColor: '#38a169', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.15, spanGaps: true },
    ],
  }), [previewData]);

  const previewChartOptions = useMemo(() => ({
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { enabled: false },
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'seconds (relative)' }, ticks: { font: { size: 10 } } },
      y: { title: { display: true, text: 'rotation rate (deg/s)' }, ticks: { font: { size: 10 } } },
    },
  }), []);

  const angleChartData = useMemo(() => ({
    labels: angleData.t,
    datasets: [
      {
        label: 'oar.α − boat.α',
        data: angleData.angle,
        borderColor: '#805ad5',
        backgroundColor: 'transparent',
        pointRadius: 0,
        borderWidth: 1.8,
        tension: 0.15,
        spanGaps: true,
      },
    ],
  }), [angleData]);

  const angleChartOptions = useMemo(() => ({
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'seconds (relative)' }, ticks: { font: { size: 10 } } },
      y: { title: { display: true, text: 'oar angle in boat frame (deg)' }, ticks: { font: { size: 10 } }, min: -180, max: 180 },
    },
  }), []);

  // ---------- Render ----------
  const peerLabel = ({
    idle: 'Not started',
    initializing: 'Initializing…',
    online: 'Online — waiting for connection',
    connecting: 'Connecting…',
    connected: 'Connected',
    error: `Error: ${peerError}`,
  })[peerStatus] ?? peerStatus;

  return (
    <div className="oar-capture">
      <header className="oar-header">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <h1>Oar Capture</h1>
      </header>

      <section className="oar-section">
        <h2>Role</h2>
        <div className="oar-role-toggle">
          <label className={role === 'rower' ? 'active' : ''}>
            <input
              type="radio"
              name="role"
              value="rower"
              checked={role === 'rower'}
              onChange={() => setRole('rower')}
              disabled={isCapturing}
            />
            Rower (phone on oar)
          </label>
          <label className={role === 'coach' ? 'active' : ''}>
            <input
              type="radio"
              name="role"
              value="coach"
              checked={role === 'coach'}
              onChange={() => setRole('coach')}
              disabled={isCapturing}
            />
            Coach (phone in boat / chase boat)
          </label>
        </div>
      </section>

      <section className="oar-section">
        <h2>Peer link</h2>
        <p className="oar-status">Status: {peerLabel}</p>
        {!peerRef.current && (
          <button className="btn btn-primary" onClick={initPeer}>
            Initialize peer
          </button>
        )}
        {peerRef.current && (
          <>
            <div className="oar-join-card">
              <div className="oar-short-code">
                {myPeerId ? shortFromPeerId(myPeerId) : '…'}
              </div>
              <div className="oar-join-hint">
                Other phone can scan this QR or type the code above.
              </div>
              {qrDataUrl && (
                <img className="oar-qr" src={qrDataUrl} alt="Join QR code" />
              )}
            </div>
            <div className="oar-row">
              <input
                type="text"
                inputMode="numeric"
                value={remoteShortCode}
                onChange={(e) => setRemoteShortCode(e.target.value)}
                placeholder="Other phone's code"
                disabled={peerStatus === 'connected'}
              />
              <button
                className="btn btn-secondary"
                onClick={() => connectToRemote()}
                disabled={!myPeerId || !remoteShortCode.trim() || peerStatus === 'connected'}
              >
                Connect
              </button>
            </div>
            {peerStatus === 'connected' && (
              <div className="oar-row">
                <button className="btn btn-secondary" onClick={sendPing}>Ping</button>
                {lastPing != null && <span className="oar-mono">RTT: {lastPing} ms</span>}
              </div>
            )}
          </>
        )}
      </section>

      <section className="oar-section">
        <h2>Sensors</h2>
        <p className="oar-status">
          Motion + orientation: {sensorStatus}
          {' · '}
          GPS: {gpsStatus}
        </p>
        {sensorStatus !== 'available' && (
          <button className="btn btn-primary" onClick={requestSensors}>
            Request sensor access
          </button>
        )}
      </section>

      <section className="oar-section">
        <h2>Capture</h2>
        {!isCapturing ? (
          <button
            className="btn btn-primary btn-large"
            onClick={startCapture}
            disabled={sensorStatus === 'requesting'}
          >
            Start capture
          </button>
        ) : (
          <button className="btn btn-secondary btn-large" onClick={stopCapture}>
            Stop capture
          </button>
        )}
        <div className="oar-counters">
          <div>Own motion: {counts.motion}</div>
          <div>Own orientation: {counts.orientation}</div>
          <div>Own GPS: {counts.gps}</div>
          <div>Peer motion: {counts.peerMotion}</div>
          <div>Peer GPS: {counts.peerGps}</div>
        </div>
      </section>

      <section className="oar-section">
        <h2>
          Rotation rate
          <span className="oar-source-tag">
            {previewSource === 'peer' ? 'peer stream' : previewSource === 'own' ? 'own sensor' : 'no data'}
          </span>
        </h2>
        <div className="oar-chart">
          <Line data={previewChartData} options={previewChartOptions} />
        </div>
      </section>

      <section className="oar-section">
        <h2>
          Oar angle (compass)
          <span className="oar-source-tag">
            {angleStatus === 'ok' ? 'live' : angleStatus === 'no-peer' ? 'needs peer' : angleStatus === 'no-compass' ? 'no compass' : 'waiting'}
          </span>
        </h2>
        <div className="oar-chart">
          <Line data={angleChartData} options={angleChartOptions} />
        </div>
        <p className="oar-hint">
          oar.α − boat.α, wrapped to ±180°. Drifts on phones without a good
          magnetometer; ignore unless both phones report a stable compass.
        </p>
      </section>

      <section className="oar-section">
        <h2>Recording</h2>
        {hasRecording ? (
          <button className="btn btn-primary" onClick={downloadRecording}>
            Download recording (JSON)
          </button>
        ) : (
          <p className="oar-status">No recording yet.</p>
        )}
        <div className="oar-row">
          <label className="btn btn-secondary">
            Load recording
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLoadRecording(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </section>
    </div>
  );
}

export default OarCapture;
