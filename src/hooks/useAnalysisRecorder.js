import { useRef, useState, useCallback, useEffect } from 'react';

// Real-time analysis recorder ("record analysis"): a screen-capture-style
// telestration recorder for the coach. While the coach plays, pauses, scrubs and
// draws on the footage — talking over it — this composites each frame into an
// offscreen canvas (the caller supplies the per-frame draw via `drawFrame`),
// captures that canvas as a video track, mixes in the microphone, and records
// the lot with MediaRecorder. Supports pause/resume/stop; stop() resolves with
// the finished Blob.
//
// Distinct from useVideoRecorder (the coach's *camera* capture) and from the
// offline exportBurnIn (which re-renders a finished clip at 1×): this one is live.

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/mp4',                        // iOS Safari
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// opts.getSize() → { w, h } for the record canvas (native video resolution).
// opts.drawFrame(ctx, w, h) renders one composite frame.
export function useAnalysisRecorder({ getSize, drawFrame, fps = 30 } = {}) {
  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    !!HTMLCanvasElement.prototype.captureStream;

  const [state, setState] = useState('idle'); // idle | recording | paused
  const [error, setError] = useState('');
  const [hasMic, setHasMic] = useState(false);
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const mutedRef = useRef(false);

  // Keep the latest callbacks in refs so the rAF loop never goes stale and never
  // needs restarting.
  const drawFrameRef = useRef(drawFrame);
  const getSizeRef = useRef(getSize);
  drawFrameRef.current = drawFrame;
  getSizeRef.current = getSize;

  const canvasRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const mimeRef = useRef('');
  const startPerfRef = useRef(0);   // perf clock at the latest (re)start
  const baseElapsedRef = useRef(0); // accumulated time across pause gaps

  const tick = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      try { drawFrameRef.current?.(ctx, canvas.width, canvas.height); } catch { /* keep recording */ }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Tick the displayed timer a few times a second (the draw loop itself runs at
  // rAF rate and carries no React state).
  useEffect(() => {
    if (state !== 'recording') return undefined;
    const id = setInterval(() => {
      setElapsedMs(baseElapsedRef.current + (performance.now() - startPerfRef.current));
    }, 200);
    return () => clearInterval(id);
  }, [state]);

  const start = useCallback(async () => {
    if (!supported) { setError('Recording is not supported on this device.'); return false; }
    setError('');
    const size = getSizeRef.current?.() || { w: 1280, h: 720 };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(size.w));
    canvas.height = Math.max(2, Math.round(size.h));
    canvasRef.current = canvas;

    // Microphone is best-effort — a denied/absent mic still records the visuals.
    let audioStream = null;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch { audioStream = null; }
    audioRef.current = audioStream;
    setHasMic(!!audioStream);
    // Honour a mute set before recording started.
    audioStream?.getAudioTracks().forEach((t) => { t.enabled = !mutedRef.current; });

    const mime = pickMime();
    mimeRef.current = mime;
    const stream = canvas.captureStream(fps);
    if (audioStream) audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
    streamRef.current = stream;

    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      audioStream?.getTracks().forEach((t) => t.stop());
      setError('Could not start the recorder: ' + (e?.message ?? e));
      return false;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    recRef.current = rec;

    baseElapsedRef.current = 0;
    startPerfRef.current = performance.now();
    rec.start(1000);
    setState('recording');
    setElapsedMs(0);
    rafRef.current = requestAnimationFrame(tick);
    return true;
  }, [supported, fps, tick]);

  const pause = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== 'recording') return;
    rec.pause();
    cancelAnimationFrame(rafRef.current);
    baseElapsedRef.current += performance.now() - startPerfRef.current;
    setState('paused');
  }, []);

  const resume = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== 'paused') return;
    rec.resume();
    startPerfRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    setState('recording');
  }, [tick]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return Promise.resolve(null);
    cancelAnimationFrame(rafRef.current);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type: mimeRef.current || 'video/webm' })
          : null;
        audioRef.current?.getTracks().forEach((t) => t.stop());
        audioRef.current = null;
        recRef.current = null;
        canvasRef.current = null;
        setState('idle');
        setElapsedMs(0);
        resolve(blob);
      };
      try { rec.stop(); } catch { resolve(null); }
    });
  }, []);

  // Mute/unmute the voiceover. Toggling mid-recording silences the track without
  // dropping it, so it can be brought back without restarting the recorder.
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      audioRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
      return next;
    });
  }, []);

  // Tear everything down on unmount.
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    try { recRef.current?.stop(); } catch { /* ignore */ }
    audioRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return { supported, state, error, hasMic, muted, toggleMute, elapsedMs, start, pause, resume, stop };
}
