import { useState, useRef, useEffect, useCallback } from 'react';
import { deriveStrokes } from '../utils/strokePipeline';
import {
  unpackBundle, drawOverlay, videoTimeToRowerTime, findStrokeAt, exportBurnIn,
} from '../utils/videoBundle';
import { drawAnnotations, makeStroke, PEN_COLORS, DEFAULT_WIDTH } from '../utils/annotations';
import { useAnalysisRecorder } from '../hooks/useAnalysisRecorder';
import * as videoStore from '../utils/videoStore';
import AppShell from './AppShell';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RATES = [0.25, 0.5, 1, 2, 4];
// Corner panel for the speed curve when it's burned into a recording.
const CURVE_RECT = (w, h) => ({ x: w * 0.02, y: h * 0.02, w: w * 0.46, h: h * 0.3 });

// A stroke-profile hump: the app's speed curve, used to toggle the graph overlay.
const CurveIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 16 C 6 16 7 5 11 5 C 15 5 15 16 18 16" />
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
  const [menuOpen, setMenuOpen] = useState(false);

  // Telestration + analysis recording. Selecting the pen or line tool enters
  // draw mode; tapping the active tool again drops back to normal transport.
  const [activeTool, setActiveTool] = useState(null); // 'pen' | 'line' | null
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [annStrokes, setAnnStrokes] = useState([]); // committed strokes

  // Speed-curve overlay: the rail toggle shows the floating curve in fullscreen
  // AND governs whether the curve is burned into a recording (one control, not two).
  const [showCurve, setShowCurve] = useState(true);
  const [curvePos, setCurvePos] = useState({ x: 12, y: 56 });

  const annotateMode = activeTool !== null;

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoWrapRef = useRef(null);
  const zoomRef = useRef({ scale: 1, x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(null);

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
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { showCurveRef.current = showCurve; }, [showCurve]);

  // Stable data for the (stable) draw loop.
  const strokesRef = useRef([]);
  const anchorRef = useRef({ startCoachPerf: 0, rowerToCoachOffset: 0, fps: 30 });
  const nudgeRef = useRef(0);
  const hasGPSRef = useRef(true);
  const videoBlobRef = useRef(null);
  const zipBlobRef = useRef(null);

  useEffect(() => { nudgeRef.current = nudgeMs; }, [nudgeMs]);

  const fps = anchorRef.current.fps || 30;

  // --- Loading ---
  const loadFromZip = useCallback(async (zipBlob) => {
    setLoading(true);
    setError('');
    try {
      const { meta, videoBlob } = await unpackBundle(zipBlob);
      const strokes = deriveStrokes(meta);
      strokesRef.current = strokes;
      hasGPSRef.current = strokes.some((s) => s.gpsSpeed > 0);
      anchorRef.current = {
        startCoachPerf: meta.video?.startCoachPerf ?? 0,
        rowerToCoachOffset: meta.video?.rowerToCoachOffset ?? 0,
        fps: meta.video?.fps || 30,
      };
      videoBlobRef.current = videoBlob;
      zipBlobRef.current = zipBlob;
      setStrokeCount(strokes.length);
      setVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(videoBlob); });
      setNudgeMs(0);
      nudgeRef.current = 0;
      setHasData(true);
    } catch (e) {
      setError('Could not load bundle: ' + (e?.message ?? e));
      setHasData(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount, pick up an in-memory hand-off from Live Capture, if any.
  useEffect(() => {
    let cancelled = false;
    videoStore.takeHandoff()
      .then((h) => { if (!cancelled && h?.blob) loadFromZip(h.blob); })
      .catch(() => {});
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

  const draw = useCallback((t) => {
    const rowerTime = videoTimeToRowerTime(t, anchorRef.current) + nudgeRef.current;
    const stroke = findStrokeAt(strokesRef.current, rowerTime);
    const phase = stroke
      ? clamp((rowerTime - stroke.startTime) / (stroke.time - stroke.startTime), 0, 1)
      : 0;
    paintOverlay(canvasRef.current, stroke, phase);  // side panel (normal view)
    paintOverlay(fsOverlayRef.current, stroke, phase); // floating curve (fullscreen)
  }, [paintOverlay]);

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
      draw(t);
      setCurrentTime(t);
      handle = useRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
    };
    handle = useRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
    return () => {
      if (useRVFC) video.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    };
  }, [playing, draw]);

  // Redraw on demand while paused (scrub, frame step, nudge, fresh load, and when
  // the floating fullscreen curve mounts / un-minimises).
  useEffect(() => {
    if (!playing) draw(currentTime);
  }, [currentTime, nudgeMs, playing, draw, hasData, isFs, showCurve]);

  // The floating curve is user-resizable (drag its corner). Repaint it to the new
  // size while paused; the playing frame-loop already keeps it current.
  useEffect(() => {
    if (!isFs || !showCurve) return undefined;
    const el = fsOverlayRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => draw(videoRef.current?.currentTime ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isFs, showCurve, draw]);

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

  const seekTo = (t) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = clamp(t, 0, duration || v.duration || 0);
    v.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const stepFrame = (dir) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) { v.pause(); setPlaying(false); }
    seekTo((v.currentTime) + dir * (1 / fps));
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
    if (!isFs || e.target.closest?.('.va-video-controls, .va-menu, .va-fs-btn')) return;
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

  // Page-specific actions live in the top bar's right slot (a ⋮ overflow) so
  // they stay separate from the global ☰ navigation. Only meaningful once a
  // clip is loaded.
  const actionsMenu = hasData ? (
    <div className="va-actions-menu">
      <button
        className="app-bar-btn"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Page actions"
        aria-expanded={menuOpen}
      >⋮</button>
      {menuOpen && (
        <>
          <div className="va-menu-scrim" onClick={() => setMenuOpen(false)} />
          <div className="va-menu-panel va-menu-panel-right" role="menu">
            <button role="menuitem" onClick={() => { setMenuOpen(false); fileInputRef.current?.click(); }}>Load another</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); downloadBundle(); }}>Download bundle (.zip)</button>
            <button role="menuitem" disabled={exporting > 0} onClick={() => { setMenuOpen(false); exportClip(); }}>
              Export shareable clip
            </button>
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <AppShell page="analyze" title="Video Analysis" actions={actionsMenu}>
    <div className="video-analysis">
      {!hasData && (
        <div className="va-loader">
          <p>
            Load a Free Speed video bundle (.zip) recorded in coach mode — the
            stroke curve plays in sync with the footage.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFromZip(f); e.target.value = ''; }}
          />
          <button className="btn btn-primary btn-large" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            {loading ? 'Loading…' : 'Load bundle (.zip)'}
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
                style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: '0 0' }}
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
                style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: '0 0' }}
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

                <div className="va-rail-sep" />

                <button
                  className={`va-rail-btn${showCurve ? ' active' : ''}`}
                  onClick={() => setShowCurve((s) => !s)}
                  title={showCurve ? 'Hide speed curve' : 'Show speed curve'}
                  aria-label="Toggle speed curve" aria-pressed={showCurve}
                ><CurveIcon /></button>
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

              {/* Floating speed curve, full screen only — drag by its header.
                  Visibility is the rail's curve toggle. The side panel still
                  carries it in normal view. */}
              {isFs && showCurve && (
                <div className="va-fs-curve" style={{ left: curvePos.x, top: curvePos.y }}>
                  <div
                    className="va-fs-curve-head"
                    onPointerDown={onCurveDragStart}
                    onPointerMove={onCurveDragMove}
                    onPointerUp={onCurveDragEnd}
                    onPointerCancel={onCurveDragEnd}
                  >
                    <span>Speed</span>
                    <span className="va-fs-curve-grip" aria-hidden="true">⠿</span>
                  </div>
                  <canvas ref={fsOverlayRef} className="va-fs-curve-canvas" />
                </div>
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
              </div>

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
            <canvas ref={canvasRef} className="va-overlay" />
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

            {!recorder.supported && (
              <p className="va-rec-unsupported">Recording isn’t supported in this browser — drawing and playback still work.</p>
            )}

            <div className="va-diag">
              {strokeCount === 0
                ? '⚠ No strokes were detected in this recording — the data may be missing or all out of the rowing-speed band.'
                : `${strokeCount} strokes${isAligned() ? '' : ' · curve not lined up — tap “Align here” over a drive, then fine-tune'}`}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFromZip(f); e.target.value = ''; }}
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
