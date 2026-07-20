import { useRef, useState, useCallback, useEffect } from 'react';
import * as videoStore from '../utils/videoStore';

// Camera + MediaRecorder for coach-side video. The coach films the rower from
// the launch while connected over the peer link; this hook owns the camera
// stream (for a live preview), the recorder, and crash-recovery persistence.
//
// Usage: enable() to open the camera (shows a preview via `stream`), start() to
// begin recording — start() reports the capture-clock anchor so the caller can
// pair it with the stroke data — and stop() to finish, returning the Blob.

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/mp4',                 // iOS Safari
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const CHUNK_MS = 2000; // timeslice — also the crash-recovery flush cadence

export function useVideoRecorder() {
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const [stream, setStream] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState('');
  // Camera zoom, when the track supports it (Android Chrome, iOS 17+ Safari):
  // zoomCaps = { min, max, step } from getCapabilities(), zoom = current value.
  // Both stay null on cameras without zoom so the UI can hide its controls.
  const [zoom, setZoomState] = useState(null);
  const [zoomCaps, setZoomCaps] = useState(null);

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const mimeRef = useRef('');

  const enable = useCallback(async () => {
    if (!supported) { setError('Camera/recording not supported on this device.'); return null; }
    if (streamRef.current) return streamRef.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        // Ask for 1080p60 — sharper frames and smoother stroke motion for
        // frame-stepping in review. All `ideal`, so weaker cameras fall back
        // gracefully to whatever mode they support.
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
      streamRef.current = s;
      setStream(s);
      setError('');
      const track = s.getVideoTracks()[0];
      const zc = track?.getCapabilities?.().zoom;
      if (zc && zc.max > zc.min) {
        setZoomCaps({ min: zc.min, max: zc.max, step: zc.step || 0.1 });
        // Default the viewfinder to 2× so the rower fills more of the frame from
        // the launch; clamp to the track's range for cameras that top out below 2×.
        const target = Math.min(zc.max, Math.max(zc.min, 2));
        try { await track.applyConstraints({ advanced: [{ zoom: target }] }); } catch { /* ignore */ }
        setZoomState(track.getSettings?.().zoom ?? target);
      } else {
        setZoomCaps(null);
        setZoomState(null);
      }
      return s;
    } catch (e) {
      setError(`Camera access failed: ${e?.message ?? e}`);
      return null;
    }
  }, [supported]);

  const disable = useCallback(() => {
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setZoomCaps(null);
    setZoomState(null);
  }, []);

  // Set the camera zoom (absolute value, clamped to the track's range). Safe to
  // call while recording — MediaRecorder keeps rolling through constraint
  // changes. No-op on cameras without zoom (zoomCaps stays null).
  const setZoom = useCallback((value) => {
    const track = streamRef.current?.getVideoTracks()[0];
    const zc = track?.getCapabilities?.().zoom;
    if (!zc) return;
    const v = Math.min(zc.max, Math.max(zc.min, value));
    track.applyConstraints({ advanced: [{ zoom: v }] })
      .then(() => setZoomState(v))
      .catch(() => {});
  }, []);

  // Begin recording. Returns the anchor { startCoachPerf, mime, fps } (the caller
  // adds the rower↔coach clock offset). The video time-domain origin is the
  // performance.now() captured here.
  const start = useCallback(async () => {
    if (!supported) return null;
    const s = streamRef.current || (await enable());
    if (!s) return null;
    const mime = pickMime();
    mimeRef.current = mime;
    chunksRef.current = [];

    const track = s.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const fps = settings.frameRate || 30;
    const startCoachPerf = performance.now();

    await videoStore.begin({ mime, fps, startedAt: new Date().toISOString() }).catch(() => {});

    // Scale the bitrate to the resolution/fps we actually got — MediaRecorder's
    // default (~2.5 Mbps) is far too low for 1080p and is the main cause of soft,
    // blocky footage. ~0.1 bit/pixel/frame ≈ 12 Mbps at 1080p60 and drops cleanly
    // on cameras that fell back to a smaller mode.
    const w = settings.width || 1920;
    const h = settings.height || 1080;
    const videoBitsPerSecond = Math.round(w * h * fps * 0.1);
    const rec = new MediaRecorder(s, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond,
    });
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunksRef.current.push(e.data);
        videoStore.appendChunk(e.data).catch(() => {});
      }
    };
    rec.start(CHUNK_MS);
    recorderRef.current = rec;
    setIsRecording(true);
    return { startCoachPerf, mime, fps };
  }, [supported, enable]);

  // Stop recording and resolve with the assembled Blob (null if nothing recorded).
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        recorderRef.current = null;
        setIsRecording(false);
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type: mimeRef.current || 'video/webm' })
          : null;
        // Clean stop — drop the crash-recovery copy.
        videoStore.clear().catch(() => {});
        resolve(blob);
      };
      try { rec.stop(); } catch { resolve(null); }
    });
  }, []);

  // Tear down camera + recorder on unmount.
  useEffect(() => () => {
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  return { supported, stream, isRecording, error, enable, disable, start, stop, zoom, zoomCaps, setZoom };
}
