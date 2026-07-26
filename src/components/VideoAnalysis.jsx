import { useState, useRef, useEffect, useCallback } from 'react';
import { deriveStrokes } from '../utils/strokePipeline';
import {
  unpackBundle, packBundle, drawOverlay, videoTimeToRowerTime, findStrokeAt, exportBurnIn,
  deriveRoll, rollAt,
} from '../utils/videoBundle';
import { drawAnnotations, makeStroke, PEN_COLORS, DEFAULT_WIDTH } from '../utils/annotations';
import { useAnalysisRecorder } from '../hooks/useAnalysisRecorder';
import * as videoStore from '../utils/videoStore';
import AppShell from './AppShell';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RATES = [0.25, 0.5, 1, 2, 4];

// Common camera frame rates. A noisy rVFC estimate that sits within 5% of one
// of these snaps to it exactly, so frame steps land dead on frame boundaries.
const NICE_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
const snapFps = (f) => {
  if (!f || !isFinite(f)) return null;
  let best = NICE_FPS[0];
  for (const c of NICE_FPS) if (Math.abs(c - f) < Math.abs(best - f)) best = c;
  return Math.abs(best - f) / best < 0.05 ? best : f;
};

// Roll (heel / set) indicator: a line standing in for the boat/rigger that tilts
// with lateral lean, its end bulbs the blade tips (green = starboard, red =
// port). From the rower's seat starboard is to their left and port to their
// right, so green sits on the LEFT.
//
// Drawn to physical scale against a water-surface line below: with the blade
// ~2.4 m outboard, the tip height = OAR_REACH · sin(roll). At level the blades
// float BLADE_CLEARANCE_CM above the water, so the low blade circle just kisses
// the water line once its tip has dropped that far — i.e. at a real ~1.2° heel.
const OAR_REACH_M = 2.4;        // blade tip distance from the boat centreline
const BLADE_CLEARANCE_CM = 5;   // blade height above the water when level
const ROLL_DISPLAY_CM = 9;      // vertical half-range drawn before the blade pegs
function drawRollIndicator(ctx, w, h, roll) {
  const cx = w / 2;
  const len = Math.min(w * 0.58, 96);
  const r = clamp(Math.min(w, h) * 0.13, 6, 11);
  const has = roll != null && isFinite(roll);

  // Vertical scale: fit ±ROLL_DISPLAY_CM of blade travel with the boat pivot
  // centred, then place the water surface BLADE_CLEARANCE_CM below level (offset
  // by the bulb radius so the circle's edge — not its centre — meets the line).
  const pivotY = h * 0.46;
  const pxPerCm = Math.min(pivotY - (r + 3), h - pivotY - (r + 3)) / ROLL_DISPLAY_CM;
  const waterY = pivotY + BLADE_CLEARANCE_CM * pxPerCm + r;

  // Water surface: a translucent band under a bright line.
  ctx.fillStyle = 'rgba(90,150,230,0.20)';
  ctx.fillRect(0, waterY, w, h - waterY);
  ctx.strokeStyle = 'rgba(125,185,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, waterY); ctx.lineTo(w, waterY); ctx.stroke();

  // Blade drop from level (cm) from the *true* roll. +roll = heel to starboard
  // (rower's left) → the green (left) blade drops toward the water.
  const dropCm = has ? OAR_REACH_M * Math.sin(roll * Math.PI / 180) * 100 : 0;
  const dy = clamp(dropCm, -ROLL_DISPLAY_CM, ROLL_DISPLAY_CM) * pxPerCm;
  const dx = len / 2;
  const left = { x: cx - dx, y: pivotY + dy };   // starboard · green
  const right = { x: cx + dx, y: pivotY - dy };  // port · red

  // Rigger line + pivot.
  ctx.strokeStyle = has ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath(); ctx.arc(cx, pivotY, 1.6, 0, Math.PI * 2); ctx.fill();

  const bulb = (p, color) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.stroke();
  };
  bulb(left, has ? '#22c55e' : 'rgba(34,197,94,0.5)');   // starboard
  bulb(right, has ? '#ef4444' : 'rgba(239,68,68,0.5)');  // port
}
// Corner panel for the speed curve when it's burned into a recording.
const CURVE_RECT = (w, h) => ({ x: w * 0.02, y: h * 0.02, w: w * 0.46, h: h * 0.3 });

// A stroke-profile hump: the app's speed curve, used to toggle the graph overlay.
const CurveIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 16 C 6 16 7 5 11 5 C 15 5 15 16 18 16" />
  </svg>
);

// Tilted rigger line with green/red blade dots over a water line — the roll
// indicator in miniature, for the chip that restores it.
const RollIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
    <line x1="4" y1="14.5" x2="20" y2="9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="4" cy="14.5" r="2.4" fill="#22c55e" />
    <circle cx="20" cy="9.5" r="2.4" fill="#ef4444" />
    <line x1="3" y1="19" x2="21" y2="19" stroke="rgba(125,185,255,0.95)" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

// Minimize: a low bar (underscore), for collapsing a widget to its chip —
// distinct from the fullscreen-exit ✕ it would otherwise sit beside.
const MinimizeIcon = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <line x1="5" y1="14" x2="15" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// Artist's palette: opens the colour picker. The dabs use the current colour.
const PaletteIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 0 18 2.4 2.4 0 0 0 1.9-3.9 2.4 2.4 0 0 1 1.9-3.9H17.5A3.5 3.5 0 0 0 21 9.6 9 9 0 0 0 12 3Z" />
    <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

// Microphone, with a slash when muted.
const MicIcon = ({ muted }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
    <path d="M5 9 a5 5 0 0 0 10 0" />
    <line x1="10" y1="14" x2="10" y2="17.5" />
    {muted && <line x1="3" y1="3" x2="17" y2="17" stroke="#ef4444" />}
  </svg>
);

// The video analyzer: play a coach's recording with the stroke speed-profile
// drawn in sync — variable speed, scrubbable, frame-by-frame — on phone or
// computer. Loads a bundle either handed off in-memory from Live Capture or
// from a downloaded .zip.
function VideoAnalysis() {
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [recordedAt, setRecordedAt] = useState(null); // ISO start time from the bundle
  const [hasRoll, setHasRoll] = useState(false); // boat-roll indicator has data
  const [showRoll, setShowRoll] = useState(false); // roll widget shown vs collapsed to a chip (starts collapsed)
  const [rollPos, setRollPos] = useState(null);   // {x,y} once dragged; null = CSS default (top-right)

  // Transport UI
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [nudgeMs, setNudgeMs] = useState(0); // manual sync correction
  const [strokeCount, setStrokeCount] = useState(0);
  const [exporting, setExporting] = useState(0); // 0 = idle, else 0..1 progress
  const [readyClip, setReadyClip] = useState(null); // burned File awaiting share/download
  const [isFs, setIsFs] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });

  // Telestration + analysis recording. Selecting the pen or line tool enters
  // draw mode; tapping the active tool again drops back to normal transport.
  const [activeTool, setActiveTool] = useState(null); // 'pen' | 'line' | null
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [annStrokes, setAnnStrokes] = useState([]); // committed strokes

  // Speed-curve overlay: the rail toggle shows the floating curve in fullscreen
  // AND governs whether the curve is burned into a recording (one control, not two).
  const [showCurve, setShowCurve] = useState(false); // starts collapsed to its chip
  const [curvePos, setCurvePos] = useState({ x: 12, y: 56 });
  const [curveSize, setCurveSize] = useState(null); // {w,h} once resized; null = CSS default

  const videoMetaRef = useRef(null);  // the bundle's meta.video, kept for re-packs

  const annotateMode = activeTool !== null;

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const strokeInputRef = useRef(null);
  const videoWrapRef = useRef(null);
  const zoomRef = useRef({ scale: 1, x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(null);

  // Seek serialization: setting video.currentTime starts an async seek, and on
  // mobile the H.264/HEVC decoder stalls if a new seek lands before the last
  // one's 'seeked' fires (especially stepping backward, which decodes forward
  // from the previous keyframe). We run one seek at a time and collapse any taps
  // that arrive mid-seek down to the latest target.
  const seekingRef = useRef(false);      // a seek is in flight
  const desiredTimeRef = useRef(null);    // latest requested time not yet applied
  const targetTimeRef = useRef(0);        // where the playhead is heading (or is)

  // Measured frame rate: the declared fps is often just 30 (see loadFromVideoFile),
  // so 1/fps steps can land between real frames on 60fps / VFR phone footage and
  // appear to do nothing. We time the true cadence off requestVideoFrameCallback.
  const detectedFpsRef = useRef(null);    // smoothed fps from rVFC cadence
  const lastFrameMetaRef = useRef(null);  // {time, frames} of the previous frame

  // Annotation surface + live-draw refs (drawn imperatively for smoothness).
  const annCanvasRef = useRef(null);
  const annStrokesRef = useRef([]);     // mirrors annStrokes for the record loop
  const currentStrokeRef = useRef(null); // in-progress stroke
  const drawPointerRef = useRef(null);
  const activeToolRef = useRef(activeTool);
  const colorRef = useRef(color);
  const showCurveRef = useRef(showCurve);
  const fsOverlayRef = useRef(null);    // floating fullscreen curve canvas
  const curveDragRef = useRef(null);    // in-flight drag of the floating curve
  const curveResizeRef = useRef(null);  // in-flight corner resize of the curve
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { showCurveRef.current = showCurve; }, [showCurve]);

  // Stable data for the (stable) draw loop.
  const strokesRef = useRef([]);
  const rollRef = useRef([]);           // boat-roll time series
  const rollCanvasRef = useRef(null);   // fullscreen roll indicator canvas
  const rollDragRef = useRef(null);     // in-flight drag of the roll widget
  const anchorRef = useRef({ startCoachPerf: 0, rowerToCoachOffset: 0, fps: 30 });
  const nudgeRef = useRef(0);
  const hasGPSRef = useRef(true);
  const videoBlobRef = useRef(null);
  const zipBlobRef = useRef(null);

  useEffect(() => { nudgeRef.current = nudgeMs; }, [nudgeMs]);

  const fps = anchorRef.current.fps || 30;

  // --- Loading ---
  // persist: keep the bundle in IndexedDB so a tab reload (mobile browsers reap
  // heavy tabs under memory pressure) restores it instead of losing the session.
  // Off when the bundle is already being read back from that store.
  const loadFromZip = useCallback(async (zipBlob, { persist = true } = {}) => {
    setLoading(true);
    setError('');
    try {
      const { meta, videoBlob } = await unpackBundle(zipBlob);
      const strokes = deriveStrokes(meta);
      strokesRef.current = strokes;
      rollRef.current = deriveRoll(meta);
      setHasRoll(rollRef.current.length > 0);
      hasGPSRef.current = strokes.some((s) => s.gpsSpeed > 0);
      anchorRef.current = {
        startCoachPerf: meta.video?.startCoachPerf ?? 0,
        rowerToCoachOffset: meta.video?.rowerToCoachOffset ?? 0,
        fps: meta.video?.fps || 30,
      };
      videoBlobRef.current = videoBlob;
      zipBlobRef.current = zipBlob;
      setRecordedAt(meta.startedAt || null);
      setStrokeCount(strokes.length);
      setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(videoBlob); });
      setNudgeMs(0);
      nudgeRef.current = 0;
      videoMetaRef.current = meta.video || null;
      setHasData(true);
      if (persist) videoStore.putCurrent(zipBlob).catch(() => {});
    } catch (e) {
      setError('Could not load bundle: ' + (e?.message ?? e));
      setHasData(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // A plain video file — e.g. filmed with the phone's NATIVE camera app,
  // whose optical/electronic stabilization no web page can match — wrapped
  // into a bundle with no stroke data. "Add stroke data (.json)" then merges
  // the rower's session and the sync tools line it up. The file's
  // lastModified stamp (≈ end of recording) minus nothing is kept only as a
  // label; sync always comes from the merge + align flow.
  const loadFromVideoFile = useCallback(async (file) => {
    const startedAt = new Date(file.lastModified || Date.now()).toISOString();
    const meta = {
      version: 1,
      startedAt,
      motion: [],
      orientation: [],
      gps: [],
      video: {
        startedAt,
        startCoachPerf: 0,
        rowerToCoachOffset: 0,
        mime: file.type || 'video/mp4',
        fps: 30,
      },
    };
    const zip = await packBundle(meta, file);
    await loadFromZip(zip);
  }, [loadFromZip]);

  // Shared picker for both file inputs: bundles load directly, bare videos
  // get wrapped first.
  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if ((f.type || '').startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name)) loadFromVideoFile(f);
    else loadFromZip(f);
  };

  // On mount, pick up a hand-off from Live Capture; failing that, restore the
  // bundle that was open before a reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await videoStore.takeHandoff().catch(() => null);
      if (cancelled) return;
      if (h?.blob) { loadFromZip(h.blob); return; }
      const cur = await videoStore.getCurrent().catch(() => null);
      if (!cancelled && cur?.blob) loadFromZip(cur.blob, { persist: false });
    })();
    return () => { cancelled = true; };
  }, [loadFromZip]);

  // Revoke the object URL on unmount.
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  // --- Drawing ---
  // Paint the speed overlay into one canvas (the side panel, and/or the floating
  // fullscreen curve), sizing its backing store to its layout box.
  const paintOverlay = useCallback((canvas, stroke, phase) => {
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawOverlay(ctx, { x: 0, y: 0, w, h }, { stroke, phase, hasGPS: hasGPSRef.current });
  }, []);

  // Paint the fullscreen roll indicator, sizing its backing store to its box.
  const paintRoll = useCallback((rowerTime) => {
    const canvas = rollCanvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawRollIndicator(ctx, w, h, rollAt(rollRef.current, rowerTime));
  }, []);

  const draw = useCallback((t) => {
    const rowerTime = videoTimeToRowerTime(t, anchorRef.current) + nudgeRef.current;
    const stroke = findStrokeAt(strokesRef.current, rowerTime);
    const phase = stroke
      ? clamp((rowerTime - stroke.startTime) / (stroke.time - stroke.startTime), 0, 1)
      : 0;
    paintOverlay(fsOverlayRef.current, stroke, phase); // floating speed curve
    paintRoll(rowerTime); // roll indicator
  }, [paintOverlay, paintRoll]);

  // Frame-synced loop while playing (requestVideoFrameCallback for precise
  // mediaTime; rAF fallback). Updates the scrubber and redraws the overlay.
  useEffect(() => {
    if (!playing) return;
    const video = videoRef.current;
    if (!video) return;
    const useRVFC = typeof video.requestVideoFrameCallback === 'function';
    let handle;
    const step = (_now, meta) => {
      const t = meta ? meta.mediaTime : video.currentTime;
      // Estimate the true frame rate from the media-time advance per presented
      // frame (invariant of playbackRate; presentedFrames divides out any drops).
      // Clamp to a sane band so a post-seek jump doesn't poison the average.
      if (meta) {
        const prev = lastFrameMetaRef.current;
        if (prev && meta.presentedFrames > prev.frames && meta.mediaTime > prev.time) {
          const dur = (meta.mediaTime - prev.time) / (meta.presentedFrames - prev.frames);
          if (dur > 0.004 && dur < 0.2) {
            const f = 1 / dur;
            detectedFpsRef.current = detectedFpsRef.current
              ? detectedFpsRef.current * 0.8 + f * 0.2
              : f;
          }
        }
        lastFrameMetaRef.current = { time: meta.mediaTime, frames: meta.presentedFrames };
      }
      draw(t);
      setCurrentTime(t);
      handle = useRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
    };
    handle = useRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
    return () => {
      lastFrameMetaRef.current = null; // don't span the play/pause gap
      if (useRVFC) video.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    };
  }, [playing, draw]);

  // Redraw on demand while paused (scrub, frame step, nudge, fresh load, and when
  // the floating fullscreen curve mounts / un-minimises).
  useEffect(() => {
    if (!playing) draw(currentTime);
  }, [currentTime, nudgeMs, playing, draw, hasData, isFs, showCurve, hasRoll, showRoll]);

  // The floating curve is user-resizable (drag its corner). Repaint it to the new
  // size while paused; the playing frame-loop already keeps it current.
  useEffect(() => {
    if (!showCurve) return undefined;
    const el = fsOverlayRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => draw(videoRef.current?.currentTime ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [showCurve, draw]);

  // --- Annotations (telestration) ---
  // Repaint the on-screen annotation canvas (committed strokes + the live one).
  const redrawAnnotations = useCallback(() => {
    const canvas = annCanvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawAnnotations(ctx, annStrokesRef.current, currentStrokeRef.current, { x: 0, y: 0, w, h });
  }, []);

  // Keep the record-loop mirror and the canvas in sync with committed strokes.
  useEffect(() => { annStrokesRef.current = annStrokes; redrawAnnotations(); }, [annStrokes, redrawAnnotations]);

  // Keep annotations aligned to the footage as the layout changes.
  useEffect(() => {
    if (!hasData) return undefined;
    const onResize = () => redrawAnnotations();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hasData, redrawAnnotations]);

  const pointerToNorm = (e) => {
    const r = annCanvasRef.current.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / r.width, 0, 1),
      y: clamp((e.clientY - r.top) / r.height, 0, 1),
    };
  };

  const onAnnPointerDown = (e) => {
    if (!annotateMode) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawPointerRef.current = e.pointerId;
    const s = makeStroke(activeToolRef.current, colorRef.current, DEFAULT_WIDTH);
    s.points.push(pointerToNorm(e));
    currentStrokeRef.current = s;
    redrawAnnotations();
  };

  const onAnnPointerMove = (e) => {
    if (drawPointerRef.current !== e.pointerId) return;
    const s = currentStrokeRef.current;
    if (!s) return;
    const p = pointerToNorm(e);
    if (s.tool === 'line') s.points[1] = p; // line is start + moving end
    else s.points.push(p);
    redrawAnnotations();
  };

  const onAnnPointerUp = (e) => {
    if (drawPointerRef.current !== e.pointerId) return;
    drawPointerRef.current = null;
    const s = currentStrokeRef.current;
    currentStrokeRef.current = null;
    // A line needs two points; a pen tap (one point) is kept as a dot.
    if (s && (s.tool !== 'line' ? s.points.length >= 1 : s.points.length >= 2)) {
      setAnnStrokes((prev) => [...prev, s]);
    } else {
      redrawAnnotations();
    }
  };

  const undoAnnotation = () => setAnnStrokes((prev) => prev.slice(0, -1));
  const clearAnnotations = () => setAnnStrokes([]);

  // Tapping a tool selects it (entering draw mode); tapping the active tool again
  // exits draw mode back to normal transport.
  const toggleTool = (t) => setActiveTool((cur) => (cur === t ? null : t));

  const footageTransform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;

  // --- Floating fullscreen curve: drag (via its header) ---
  const onCurveDragStart = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const wrap = videoWrapRef.current.getBoundingClientRect();
    curveDragRef.current = {
      id: e.pointerId,
      dx: e.clientX - (wrap.left + curvePos.x),
      dy: e.clientY - (wrap.top + curvePos.y),
    };
  };
  const onCurveDragMove = (e) => {
    const d = curveDragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const wrap = videoWrapRef.current.getBoundingClientRect();
    setCurvePos({
      x: clamp(e.clientX - wrap.left - d.dx, 0, wrap.width - 80),
      y: clamp(e.clientY - wrap.top - d.dy, 0, wrap.height - 40),
    });
  };
  const onCurveDragEnd = (e) => {
    if (curveDragRef.current?.id === e.pointerId) curveDragRef.current = null;
  };

  // --- Roll widget: drag anywhere on it to reposition (the ✕ handles its own
  // tap). Seeds from the current box so a first drag off the CSS default is
  // smooth. ---
  const onRollDragStart = (e) => {
    if (e.target.closest('.va-fs-roll-close')) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const box = e.currentTarget.getBoundingClientRect();
    rollDragRef.current = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top };
  };
  const onRollDragMove = (e) => {
    const d = rollDragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const wrap = videoWrapRef.current.getBoundingClientRect();
    const box = e.currentTarget.getBoundingClientRect();
    setRollPos({
      x: clamp(e.clientX - wrap.left - d.dx, 0, wrap.width - box.width),
      y: clamp(e.clientY - wrap.top - d.dy, 0, wrap.height - box.height),
    });
  };
  const onRollDragEnd = (e) => {
    if (rollDragRef.current?.id === e.pointerId) rollDragRef.current = null;
  };

  // Resize via a finger-sized corner grip (the native CSS resize handle is tiny
  // and doesn't respond to touch). Seed from the element's current box so the
  // first drag continues from the CSS default rather than jumping.
  const onCurveResizeStart = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const box = e.currentTarget.parentElement.getBoundingClientRect();
    curveResizeRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, w: box.width, h: box.height };
  };
  const onCurveResizeMove = (e) => {
    const d = curveResizeRef.current;
    if (!d || d.id !== e.pointerId) return;
    const wrap = videoWrapRef.current.getBoundingClientRect();
    setCurveSize({
      w: clamp(d.w + (e.clientX - d.x), 140, wrap.width * 0.92),
      h: clamp(d.h + (e.clientY - d.y), 96, wrap.height * 0.7),
    });
  };
  const onCurveResizeEnd = (e) => {
    if (curveResizeRef.current?.id === e.pointerId) curveResizeRef.current = null;
  };

  // --- Analysis recording (live telestration + voiceover) ---
  const getRecordSize = useCallback(() => {
    const v = videoRef.current;
    return { w: v?.videoWidth || 1280, h: v?.videoHeight || 720 };
  }, []);

  // Composite one frame for the recorder: footage, optional speed curve, then
  // the annotations on top — all from refs so the loop stays current.
  const drawRecordFrame = useCallback((ctx, w, h) => {
    const v = videoRef.current;
    if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, w, h);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    if (showCurveRef.current) {
      const rowerTime = videoTimeToRowerTime(v ? v.currentTime : 0, anchorRef.current) + nudgeRef.current;
      const stroke = findStrokeAt(strokesRef.current, rowerTime);
      const phase = stroke
        ? clamp((rowerTime - stroke.startTime) / (stroke.time - stroke.startTime), 0, 1)
        : 0;
      drawOverlay(ctx, CURVE_RECT(w, h), { stroke, phase, hasGPS: hasGPSRef.current });
    }
    drawAnnotations(ctx, annStrokesRef.current, currentStrokeRef.current, { x: 0, y: 0, w, h });
  }, []);

  const recorder = useAnalysisRecorder({ getSize: getRecordSize, drawFrame: drawRecordFrame, fps });

  const stopRecording = async () => {
    const blob = await recorder.stop();
    if (!blob) return;
    const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
    const file = new File([blob], `free-speed-analysis.${ext}`, { type: blob.type || 'video/webm' });
    if (navigator.canShare?.({ files: [file] })) setReadyClip(file);
    else downloadFile(file);
  };

  // --- Transport ---
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  };

  const onRate = (r) => {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  };

  // Apply the newest requested seek, one at a time. A seek queued while another
  // is in flight waits here and, when the first completes, jumps straight to the
  // latest target — so a burst of frame-step taps never stacks overlapping seeks.
  const pumpSeek = () => {
    const v = videoRef.current;
    if (!v || seekingRef.current) return;
    const target = desiredTimeRef.current;
    if (target == null) return;
    desiredTimeRef.current = null;
    if (Math.abs(target - v.currentTime) < 1e-3) { setCurrentTime(v.currentTime); return; }
    seekingRef.current = true;
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      seekingRef.current = false;
      setCurrentTime(v.currentTime);
      pumpSeek(); // drain anything requested during this seek
    };
    v.addEventListener('seeked', onSeeked);
    v.currentTime = target;
  };

  const seekTo = (t) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = clamp(t, 0, duration || v.duration || 0);
    targetTimeRef.current = clamped;
    desiredTimeRef.current = clamped;
    setCurrentTime(clamped); // optimistic: scrubber + time-based overlay update now
    pumpSeek();
  };

  const stepFrame = (dir) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) { v.pause(); setPlaying(false); }
    // Step from where we're heading (not the still-lagging displayed frame) so
    // rapid taps accumulate, and by the measured frame duration when we have it.
    const base = seekingRef.current ? targetTimeRef.current : v.currentTime;
    const stepFps = snapFps(detectedFpsRef.current) || fps;
    seekTo(base + dir / stepFps);
  };

  const goToStart = () => seekTo(0);
  const goToEnd = () => seekTo(duration);

  // --- Full screen + pinch-zoom ---
  // Full-screen the video pane only (the blue header and page chrome drop away).
  // Pinch (or wheel) zooms into the footage; two-finger drag pans; pinch back
  // out — or exit full screen — to reset. Gated to full screen so it never
  // fights normal page scrolling.
  const setZoomState = (z) => { zoomRef.current = z; setZoom(z); };
  const resetZoom = () => setZoomState({ scale: 1, x: 0, y: 0 });

  const toggleFullscreen = () => {
    const el = videoWrapRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  };

  useEffect(() => {
    const onFs = () => {
      const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      setIsFs(fs);
      if (!fs) resetZoom();
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  // Scale about a focal point (element coords), keeping that point under the
  // cursor/pinch-centre. Snaps back to identity once we reach 1×.
  const focalZoom = (nextScale, fx, fy, start) => {
    const s = clamp(nextScale, 1, 6);
    if (s <= 1.001) return { scale: 1, x: 0, y: 0 };
    const cx = (fx - start.x) / start.scale;
    const cy = (fy - start.y) / start.scale;
    return { scale: s, x: fx - s * cx, y: fy - s * cy };
  };

  const onVideoPointerDown = (e) => {
    if (!isFs || e.target.closest?.('.va-video-controls, .va-fs-transport, .va-menu, .va-fs-btn')) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const r = videoWrapRef.current.getBoundingClientRect();
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2 - r.left,
        my: (a.y + b.y) / 2 - r.top,
        start: { ...zoomRef.current },
      };
    }
  };

  const onVideoPointerMove = (e) => {
    const p = pointersRef.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const r = videoWrapRef.current.getBoundingClientRect();
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const { start, dist: d0, mx: mx0, my: my0 } = pinchRef.current;
      let z = focalZoom(start.scale * (dist / d0), mx0, my0, start);
      if (z.scale > 1) z = { scale: z.scale, x: z.x + (mx - mx0), y: z.y + (my - my0) };
      setZoomState(z);
    }
  };

  const onVideoPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  const onVideoWheel = (e) => {
    if (!isFs) return;
    const r = videoWrapRef.current.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoomState(focalZoom(zoomRef.current.scale * factor, e.clientX - r.left, e.clientY - r.top, zoomRef.current));
  };

  // Jump to the catch (start) of the previous / next stroke.
  const stepStroke = (dir) => {
    const a = anchorRef.current;
    const rowerNow = videoTimeToRowerTime(currentTime, a) + nudgeRef.current;
    const strokes = strokesRef.current;
    const toVideoTime = (rt) => ((rt - nudgeRef.current) + a.rowerToCoachOffset - a.startCoachPerf) / 1000;
    if (dir > 0) {
      const next = strokes.find((s) => s.startTime > rowerNow + 1);
      if (next) seekTo(toVideoTime(next.startTime));
    } else {
      const prev = [...strokes].reverse().find((s) => s.startTime < rowerNow - 1);
      if (prev) seekTo(toVideoTime(prev.startTime));
    }
  };

  // --- Alignment ---
  // Cross-device clock sync (rower ↔ coach, over the wire, and worse during a
  // sped-up desk replay) can leave the stored anchor off by seconds. These
  // recover alignment from the data itself: nudge is added to the mapped
  // rower-time, so to put video t=0 at a target rower-time we set
  // nudge = target − rowerTime(0, anchor).
  const strokeSpan = () => {
    const s = strokesRef.current;
    return s.length ? [s[0].startTime, s[s.length - 1].time] : null;
  };

  const setNudge = (next) => { nudgeRef.current = next; setNudgeMs(next); };

  // Coarse recovery (used on load when nothing overlaps): pin video t=0 to the
  // first stroke's catch so the whole row plays forward and the curve is visible.
  const autoAlignStart = () => {
    const s = strokesRef.current;
    if (!s.length) return;
    setNudge(s[0].startTime - videoTimeToRowerTime(0, anchorRef.current));
  };

  // Merge a rower's separately-recorded session into a video-only clip. The two
  // phones share no clock (the rower wasn't linked while filming), so we derive
  // the strokes, pin the curve to the video start, and let the coach fine-tune
  // with the sync controls. The merged strokes are re-packed into the bundle so
  // they survive a reload and feed export / burn-in like a linked recording.
  const [merging, setMerging] = useState(false);
  const mergeStrokeData = useCallback(async (file) => {
    setMerging(true);
    setError('');
    try {
      const rec = JSON.parse(await file.text());
      if (!rec.motion || !Array.isArray(rec.motion)) {
        throw new Error('not a Free Speed stroke recording');
      }
      const strokes = deriveStrokes(rec);
      if (!strokes.length) {
        setError('No strokes were detected in that file — check it holds a full row.');
        return;
      }
      strokesRef.current = strokes;
      rollRef.current = deriveRoll(rec);
      setHasRoll(rollRef.current.length > 0);
      hasGPSRef.current = strokes.some((s) => s.gpsSpeed > 0);
      setStrokeCount(strokes.length);
      // No shared clock: pin video t=0 to the first stroke's catch as a starting
      // point (the coach refines with "Align here" + the ± nudge).
      setNudge(strokes[0].startTime - videoTimeToRowerTime(0, anchorRef.current));
      setShowCurve(true); // surface the curve straight away so the merge is visible
      // Re-pack so the merge is durable and export/burn-in see the strokes.
      if (videoBlobRef.current) {
        const meta = { ...rec, video: videoMetaRef.current || {} };
        const zip = await packBundle(meta, videoBlobRef.current);
        zipBlobRef.current = zip;
        videoStore.putCurrent(zip).catch(() => {});
      }
      draw(videoRef.current?.currentTime ?? 0);
    } catch (e) {
      setError('Could not add stroke data: ' + (e?.message ?? e));
    } finally {
      setMerging(false);
    }
  }, [draw]);

  // Refinement (the "Align here" button): the user scrubs to a clear catch in
  // the footage and taps — snap the current playhead to the nearest stroke catch.
  // After the coarse align the error is under one stroke, so "nearest" is exact.
  const alignToStrokes = (atVideoTime) => {
    const s = strokesRef.current;
    if (!s.length) return;
    const cur = videoTimeToRowerTime(atVideoTime, anchorRef.current) + nudgeRef.current;
    let best = s[0].startTime;
    for (const st of s) if (Math.abs(cur - st.startTime) < Math.abs(cur - best)) best = st.startTime;
    setNudge(nudgeRef.current + (best - cur));
  };

  const bumpNudge = (deltaMs) => setNudge(nudgeRef.current + deltaMs);

  // True when the video window (after nudge) overlaps the stroke timeline.
  const isAligned = (dur) => {
    const span = strokeSpan();
    if (!span) return false;
    const lo = videoTimeToRowerTime(0, anchorRef.current) + nudgeRef.current;
    const hi = videoTimeToRowerTime(dur || duration || 0, anchorRef.current) + nudgeRef.current;
    return Math.min(hi, span[1]) - Math.max(lo, span[0]) > 0;
  };

  // --- Export / share ---
  const downloadFile = (file) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Burn the overlay into the clip, then hand it off. The burn-in plays the whole
  // video through a canvas recorder (several seconds), which outlives the tap's
  // transient activation — so navigator.share() can't run here (Android throws
  // "must be handling a user gesture"). Instead we stash the finished file and
  // surface a Share button, whose own tap is a fresh gesture. Download needs no
  // gesture, so where sharing files isn't supported (desktop) we save directly.
  const exportClip = async () => {
    if (!videoBlobRef.current) return;
    setReadyClip(null);
    setExporting(0.0001);
    try {
      const a = anchorRef.current;
      const anchor = {
        startCoachPerf: a.startCoachPerf,
        rowerToCoachOffset: a.rowerToCoachOffset - nudgeRef.current,
        fps: a.fps,
      };
      const burned = await exportBurnIn(videoBlobRef.current, strokesRef.current, anchor, {
        onProgress: (p) => setExporting(Math.max(0.0001, p)),
      });
      const ext = (burned.type || '').includes('mp4') ? 'mp4' : 'webm';
      const file = new File([burned], `free-speed-clip.${ext}`, { type: burned.type || 'video/webm' });
      if (navigator.canShare?.({ files: [file] })) setReadyClip(file);
      else downloadFile(file);
    } catch (e) {
      alert('Export failed: ' + (e?.message ?? e));
    } finally {
      setExporting(0);
    }
  };

  // Fresh-gesture share of the already-burned clip. Falls back to download if
  // sharing fails for any reason other than the user dismissing the share sheet.
  const shareClip = async () => {
    const file = readyClip;
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: 'Free Speed clip' });
      setReadyClip(null);
    } catch (e) {
      if (e?.name === 'AbortError') return; // user dismissed the share sheet
      downloadFile(file);
      setReadyClip(null);
    }
  };

  const downloadBundle = () => {
    if (!zipBlobRef.current) return;
    const url = URL.createObjectURL(zipBlobRef.current);
    const a = document.createElement('a');
    a.href = url;
    a.download = `free-speed-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fmt = (t) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // The bundle's recording date/time, compact enough for the top bar
  // (e.g. "Jul 19 · 2:34 PM"). Falls back to the plain page name.
  const fmtRecorded = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${date} · ${time}`;
  };
  const recordedLabel = hasData && recordedAt ? fmtRecorded(recordedAt) : null;
  const pageTitle = recordedLabel || 'Video Analysis';

  // The speed graph is only meaningful with detected strokes — hide its widget
  // and restore chip entirely when the recording has none.
  const hasStrokes = strokeCount > 0;

  return (
    <AppShell page="analyze" title={pageTitle}>
    <div className="video-analysis">
      {!hasData && (
        <div className="va-loader">
          <p>
            Load a Free Speed video bundle (.zip) recorded in coach mode — the
            stroke curve plays in sync with the footage. Or load a plain video
            filmed with your phone&rsquo;s camera app (its built-in stabilization
            beats anything a web page can do), then add the rower&rsquo;s stroke
            data to it.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip,video/*"
            style={{ display: 'none' }}
            onChange={onPickFile}
          />
          <button className="btn btn-primary btn-large" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            {loading ? 'Loading…' : 'Load bundle (.zip) or video'}
          </button>
          {error && <p className="oar-status va-error">{error}</p>}
        </div>
      )}

      {hasData && (
        <>
          <div className="va-stage">
            <div
              className="va-video-wrap"
              ref={videoWrapRef}
              style={{ touchAction: isFs ? 'none' : undefined }}
              onPointerDown={onVideoPointerDown}
              onPointerMove={onVideoPointerMove}
              onPointerUp={onVideoPointerUp}
              onPointerCancel={onVideoPointerUp}
              onWheel={onVideoWheel}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                muted
                disablePictureInPicture
                controlsList="nodownload nofullscreen noremoteplayback noplaybackrate"
                style={{ transform: footageTransform, transformOrigin: '0 0' }}
                onLoadedMetadata={(e) => {
                  const dur = e.target.duration || 0;
                  setDuration(dur);
                  e.target.playbackRate = rate;
                  // If the stored clock anchor leaves the video and the strokes
                  // not overlapping at all, recover by pinning the video start to
                  // the first stroke so the curve is visible; the user can then
                  // fine-tune with the sync controls.
                  if (strokesRef.current.length && !isAligned(dur)) autoAlignStart();
                  draw(0);
                }}
                onClick={togglePlay}
                onEnded={() => setPlaying(false)}
              />

              {/* Telestration surface. Pointer-events are gated to annotate mode
                  so normal transport (tap-to-play, pinch-zoom) works when it's
                  off. Sits above the footage but below the transport controls. */}
              <canvas
                ref={annCanvasRef}
                className={`va-annotate${annotateMode ? ' active' : ''}`}
                style={{ transform: footageTransform, transformOrigin: '0 0' }}
                onPointerDown={onAnnPointerDown}
                onPointerMove={onAnnPointerMove}
                onPointerUp={onAnnPointerUp}
                onPointerCancel={onAnnPointerUp}
              />

              {recorder.state !== 'idle' && (
                <div className="va-rec-badge" data-paused={recorder.state === 'paused'}>
                  <span className="va-rec-dot" /> {recorder.state === 'paused' ? 'Paused' : 'REC'} {fmt(recorder.elapsedMs / 1000)}
                  {(recorder.muted || !recorder.hasMic) && (
                    <span className="va-rec-nomic" title={recorder.hasMic ? 'Voiceover muted' : 'No microphone — recording without voice'}> · muted</span>
                  )}
                </div>
              )}

              {/* Full-screen toggle over the top-right, player convention.
                  Stays inside the video so it remains reachable in full screen
                  (where the app bar is not rendered). */}
              <button
                className="va-fs-btn"
                onClick={toggleFullscreen}
                title={isFs ? 'Exit full screen' : 'Full screen'}
                aria-label={isFs ? 'Exit full screen' : 'Full screen'}
              >{isFs ? '✕' : '⛶'}</button>

              {/* Telestration + recording rail down the right edge — reachable in
                  full screen. Drawing tools up top, then the curve toggle, mic,
                  and record transport. */}
              <div className="va-rail">
                <button
                  className={`va-rail-btn${activeTool === 'pen' ? ' active' : ''}`}
                  onClick={() => toggleTool('pen')}
                  title="Pen" aria-label="Pen" aria-pressed={activeTool === 'pen'}
                >✏︎</button>
                <button
                  className={`va-rail-btn${activeTool === 'line' ? ' active' : ''}`}
                  onClick={() => toggleTool('line')}
                  title="Line" aria-label="Line" aria-pressed={activeTool === 'line'}
                >╱</button>
                <button
                  className="va-rail-btn va-rail-color"
                  onClick={() => setColorPickerOpen((o) => !o)}
                  title="Colour" aria-label="Colour" aria-expanded={colorPickerOpen}
                ><PaletteIcon /><span className="va-rail-color-dot" style={{ background: color }} /></button>
                <button
                  className="va-rail-btn"
                  onClick={undoAnnotation}
                  disabled={!annStrokes.length}
                  title="Undo" aria-label="Undo"
                >↶</button>
                <button
                  className="va-rail-btn"
                  onClick={clearAnnotations}
                  disabled={!annStrokes.length}
                  title="Clear" aria-label="Clear"
                >🗑</button>
              </div>

              {/* Colour picker — a sibling of the rail so the scrolling rail's
                  overflow can't clip it. */}
              {colorPickerOpen && (
                <>
                  <div className="va-color-scrim" onClick={() => setColorPickerOpen(false)} />
                  <div className="va-color-pop" role="menu">
                    <div className="va-color-grid">
                      {PEN_COLORS.map((c) => (
                        <button
                          key={c}
                          className={`va-swatch${color === c ? ' active' : ''}`}
                          style={{ background: c }}
                          onClick={() => { setColor(c); setColorPickerOpen(false); }}
                          title={c} aria-label={`Colour ${c}`}
                        />
                      ))}
                    </div>
                    <label className="va-color-custom">
                      Custom
                      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                    </label>
                  </div>
                </>
              )}

              {/* Floating speed curve — drag by its header, resize by its
                  corner, or minimize it to the top-left chip. Shown over the
                  footage in both normal and full-screen view. */}
              {hasStrokes && showCurve && (
                <div
                  className="va-fs-curve"
                  style={{ left: curvePos.x, top: curvePos.y, ...(curveSize ? { width: curveSize.w, height: curveSize.h } : null) }}
                >
                  <div
                    className="va-fs-curve-head"
                    onPointerDown={onCurveDragStart}
                    onPointerMove={onCurveDragMove}
                    onPointerUp={onCurveDragEnd}
                    onPointerCancel={onCurveDragEnd}
                  >
                    <span className="va-fs-curve-grip" aria-hidden="true">⠿</span>
                    <span>Speed</span>
                    <button
                      className="va-fs-curve-close"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setShowCurve(false)}
                      title="Minimize speed graph" aria-label="Minimize speed graph"
                    ><MinimizeIcon /></button>
                  </div>
                  <canvas ref={fsOverlayRef} className="va-fs-curve-canvas" />
                  <div
                    className="va-fs-curve-resize"
                    onPointerDown={onCurveResizeStart}
                    onPointerMove={onCurveResizeMove}
                    onPointerUp={onCurveResizeEnd}
                    onPointerCancel={onCurveResizeEnd}
                    title="Drag to resize"
                    aria-hidden="true"
                  >⤡</div>
                </div>
              )}

              {/* Boat-roll (heel / set) indicator. Drag it anywhere; minimize
                  collapses it to the chip. Defaults top-right (left of the
                  full-screen button) until dragged. */}
              {hasRoll && showRoll && (
                <div
                  className="va-fs-roll"
                  style={rollPos ? { left: rollPos.x, top: rollPos.y, right: 'auto' } : undefined}
                  title="Boat roll (green = starboard, red = port) — drag to move"
                  onPointerDown={onRollDragStart}
                  onPointerMove={onRollDragMove}
                  onPointerUp={onRollDragEnd}
                  onPointerCancel={onRollDragEnd}
                >
                  <canvas ref={rollCanvasRef} className="va-fs-roll-canvas" aria-hidden="true" />
                  <button
                    className="va-fs-roll-close"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setShowRoll(false)}
                    title="Minimize roll indicator" aria-label="Minimize roll indicator"
                  ><MinimizeIcon /></button>
                </div>
              )}

              {/* Collapsed roll indicator: a chip that restores it. */}
              {hasRoll && !showRoll && (
                <button
                  className="va-fs-roll-chip"
                  onClick={() => setShowRoll(true)}
                  title="Show roll indicator" aria-label="Show roll indicator"
                ><RollIcon /></button>
              )}

              {/* Collapsed speed graph: a top-left chip that restores it. */}
              {hasStrokes && !showCurve && (
                <button
                  className="va-fs-curve-chip"
                  onClick={() => setShowCurve(true)}
                  title="Show speed graph" aria-label="Show speed graph"
                ><CurveIcon /></button>
              )}

              {exporting > 0 && (
                <div className="va-export-progress">Exporting… {Math.round(exporting * 100)}%</div>
              )}

              {readyClip && exporting === 0 && (
                <div className="va-clip-ready">
                  <span className="va-clip-ready-label">Clip ready</span>
                  <button className="btn btn-primary btn-sm" onClick={shareClip}>Share</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { downloadFile(readyClip); setReadyClip(null); }}>Download</button>
                  <button className="va-clip-ready-close" onClick={() => setReadyClip(null)} aria-label="Dismiss">✕</button>
                </div>
              )}

              {/* Transport overlaid on the footage: start · prev-frame · play ·
                  next-frame · end. Scrubber and settings stay below the graph. */}
              <div className="va-video-controls">
                <button onClick={goToStart} title="Go to start" aria-label="Go to start">⏮</button>
                <button onClick={() => stepFrame(-1)} title="Previous frame" aria-label="Previous frame">◀|</button>
                <button className="va-play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? '⏸' : '▶'}
                </button>
                <button onClick={() => stepFrame(1)} title="Next frame" aria-label="Next frame">|▶</button>
                <button onClick={goToEnd} title="Go to end" aria-label="Go to end">⏭</button>
                {/* Playback speed sits inline with the transport in full screen
                    (the page's own speed control below the footage is hidden). */}
                {isFs && (
                  <select
                    className="va-fs-rate"
                    value={rate}
                    onChange={(e) => onRate(Number(e.target.value))}
                    title="Playback speed"
                    aria-label="Playback speed"
                  >
                    {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
                  </select>
                )}
              </div>

              {/* Full-screen scrubber pinned to the very bottom. The page's
                  scrubber lives below the footage and is hidden while full
                  screen, so this is the only scrubber for that mode. */}
              {isFs && (
                <div className="va-fs-transport">
                  <div className="va-fs-scrub-row">
                    <span className="va-fs-time">{fmt(currentTime)}</span>
                    <input
                      className="va-fs-scrub"
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={0.01}
                      value={currentTime}
                      onChange={(e) => seekTo(Number(e.target.value))}
                      aria-label="Seek"
                    />
                    <span className="va-fs-time">{fmt(duration)}</span>
                  </div>
                </div>
              )}

              {/* Recording transport + mute. Pulled off the right-edge rail (too
                  short for every icon on a phone) and parked at the bottom-right,
                  beside the centred playback controls. */}
              <div className="va-rec-controls">
                <button
                  className={`va-rail-btn${recorder.muted ? ' muted' : ''}`}
                  onClick={recorder.toggleMute}
                  title={recorder.muted ? 'Unmute voiceover' : 'Mute voiceover'}
                  aria-label="Toggle voiceover" aria-pressed={recorder.muted}
                ><MicIcon muted={recorder.muted} /></button>

                {recorder.supported && (
                  <>
                    <button
                      className="va-rail-btn va-rail-rec"
                      data-state={recorder.state}
                      onClick={recorder.state === 'idle' ? recorder.start
                        : recorder.state === 'recording' ? recorder.pause : recorder.resume}
                      title={recorder.state === 'idle' ? 'Record analysis'
                        : recorder.state === 'recording' ? 'Pause recording' : 'Resume recording'}
                      aria-label={recorder.state === 'idle' ? 'Record analysis'
                        : recorder.state === 'recording' ? 'Pause recording' : 'Resume recording'}
                    >
                      {recorder.state === 'recording' ? '❚❚'
                        : recorder.state === 'paused' ? '▶'
                          : <span className="va-rec-circle" />}
                    </button>
                    {recorder.state !== 'idle' && (
                      <button
                        className="va-rail-btn va-rail-stop"
                        onClick={stopRecording}
                        title="Stop & export" aria-label="Stop and export"
                      >■</button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="va-transport">
            <div className="va-scrub-row">
              <input
                className="va-scrub"
                type="range"
                min={0}
                max={duration || 0}
                step={0.01}
                value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))}
              />
              <span className="va-time">{fmt(currentTime)} / {fmt(duration)}</span>
            </div>

            <div className="va-controls-row">
              <div className="va-step-group" role="group" aria-label="Stroke step">
                <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(-1)} title="Previous stroke">‹ Stroke</button>
                <button className="btn btn-secondary btn-sm" onClick={() => stepStroke(1)} title="Next stroke">Stroke ›</button>
              </div>

              <label className="va-rate">
                Speed
                <select value={rate} onChange={(e) => onRate(Number(e.target.value))}>
                  {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
                </select>
              </label>

              <label className="va-nudge">
                Sync
                <button className="btn btn-secondary btn-sm" onClick={() => bumpNudge(-1000)} title="Curve 1s earlier">−1s</button>
                <button className="btn btn-secondary btn-sm" onClick={() => bumpNudge(-1000 / fps)} title="Curve one frame earlier">−</button>
                <span className="va-nudge-val">{nudgeMs > 0 ? '+' : ''}{(nudgeMs / 1000).toFixed(2)}s</span>
                <button className="btn btn-secondary btn-sm" onClick={() => bumpNudge(1000 / fps)} title="Curve one frame later">+</button>
                <button className="btn btn-secondary btn-sm" onClick={() => bumpNudge(1000)} title="Curve 1s later">+1s</button>
              </label>

              <button className="btn btn-secondary btn-sm" onClick={() => alignToStrokes(currentTime)} title="Align the curve to the playhead">
                ⟲ Align here
              </button>
            </div>

            {/* Bundle actions, out in the open (replacing the old ⋮ overflow). */}
            <div className="va-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>Load another</button>
              <button
                className={`btn btn-sm ${hasStrokes ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => strokeInputRef.current?.click()}
                disabled={merging}
                title="Merge a rower's separately-recorded stroke data (.json) into this clip"
              >
                {merging ? 'Adding…' : hasStrokes ? 'Replace stroke data' : 'Add stroke data (.json)'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={downloadBundle}>Download bundle (.zip)</button>
              <button className="btn btn-primary btn-sm" disabled={exporting > 0} onClick={exportClip}>
                {exporting > 0 ? `Exporting… ${Math.round(exporting * 100)}%` : 'Export shareable clip'}
              </button>
            </div>

            {!recorder.supported && (
              <p className="va-rec-unsupported">Recording isn’t supported in this browser — drawing and playback still work.</p>
            )}

            <div className="va-diag">
              {strokeCount === 0
                ? '⚠ No stroke data in this clip — tap “Add stroke data” to merge the rower’s recorded session, or it may be missing / all out of the rowing-speed band.'
                : `${strokeCount} strokes${isAligned() ? '' : ' · curve not lined up — tap “Align here” over a drive, then fine-tune'}`}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip,video/*"
              style={{ display: 'none' }}
              onChange={onPickFile}
            />
            <input
              ref={strokeInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) mergeStrokeData(f); e.target.value = ''; }}
            />
            {error && <p className="oar-status va-error">{error}</p>}
          </div>
        </>
      )}
    </div>
    </AppShell>
  );
}

export default VideoAnalysis;
