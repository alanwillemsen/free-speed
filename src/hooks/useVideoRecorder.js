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
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = s;
      setStream(s);
      setError('');
      const zc = s.getVideoTracks()[0]?.getCapabilities?.().zoom;
      if (zc && zc.max > zc.min) {
        setZoomCaps({ min: zc.min, max: zc.max, step: zc.step || 0.1 });
        setZoomState(s.getVideoTracks()[0].getSettings?.().zoom ?? zc.min);
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
    const fps = track?.getSettings?.().frameRate || 30;
    const startCoachPerf = performance.now();

    await videoStore.begin({ mime, fps, startedAt: new Date().toISOString() }).catch(() => {});

    const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
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
