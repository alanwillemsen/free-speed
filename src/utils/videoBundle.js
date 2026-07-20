// Video analysis bundle: a coach films the rower while connected, and the stroke
// data (raw recording) is paired with the video via a shared clock anchor. The
// pair is packaged as a plain, inspectable ZIP (strokes.json + the video file)
// so it can be downloaded, shared, and re-opened in the analyzer on any device.
//
// This module also owns the clock math that bridges the two time domains and the
// canvas overlay renderer shared by the live analyzer and the burn-in exporter.

import { zipSync, unzipSync } from 'fflate';
import { REF_SPEEDS } from './strokePipeline';
import { catchStartIndex } from './curves';

// --- ZIP container ---

function videoExt(mime) {
  return mime && mime.includes('mp4') ? 'mp4' : 'webm';
}

// meta = the raw recording { version, startedAt, motion, orientation, gps } plus
// a `video` anchor { startCoachPerf, rowerToCoachOffset, mime, fps, durationMs }.
export async function packBundle(meta, videoBlob) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const videoBytes = new Uint8Array(await videoBlob.arrayBuffer());
  const name = `video.${videoExt(meta.video?.mime)}`;
  // level 0 = store (no compression): video is already compressed, and store
  // keeps packing fast on a phone.
  const zipped = zipSync(
    { 'strokes.json': json, [name]: videoBytes },
    { level: 0 }
  );
  return new Blob([zipped], { type: 'application/zip' });
}

// Minimal zip directory reader for the store-only fast path. packBundle writes
// entries uncompressed, so each file's bytes sit contiguously inside the zip
// and can be sliced straight out of the Blob. Blob.slice is zero-copy and stays
// disk-backed — where unzipSync would materialise the whole clip in memory,
// which is enough to get a phone tab reaped mid-playback.

const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50;  // central directory entry
const LOC_SIG = 0x04034b50;  // local file header

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

async function zipDirectory(zipBlob) {
  // The EOCD record sits in the last 22 + 65535 (max comment) bytes.
  const tail = await view(zipBlob, Math.max(0, zipBlob.size - 65557), zipBlob.size);
  let p = tail.byteLength - 22;
  while (p >= 0 && tail.getUint32(p, true) !== EOCD_SIG) p--;
  if (p < 0) throw new Error('no zip directory');
  const count = tail.getUint16(p + 10, true);
  const cdSize = tail.getUint32(p + 12, true);
  const cdOff = tail.getUint32(p + 16, true);
  if (cdOff === 0xffffffff) throw new Error('zip64 unsupported');
  const cd = await view(zipBlob, cdOff, cdOff + cdSize);
  const dec = new TextDecoder();
  const entries = [];
  for (let i = 0, q = 0; i < count && q + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(q, true) !== CEN_SIG) throw new Error('bad directory entry');
    const nameLen = cd.getUint16(q + 28, true);
    entries.push({
      name: dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nameLen)),
      method: cd.getUint16(q + 10, true),
      size: cd.getUint32(q + 20, true), // compressed size == stored size for method 0
      localOff: cd.getUint32(q + 42, true),
    });
    q += 46 + nameLen + cd.getUint16(q + 30, true) + cd.getUint16(q + 32, true);
  }
  return entries;
}

async function entrySlice(zipBlob, entry, type) {
  if (entry.method !== 0 || entry.size === 0xffffffff || entry.localOff === 0xffffffff) {
    throw new Error('not a stored entry');
  }
  // The local header's name/extra lengths can differ from the directory's, so
  // the data offset has to come from the local header itself.
  const lh = await view(zipBlob, entry.localOff, entry.localOff + 30);
  if (lh.getUint32(0, true) !== LOC_SIG) throw new Error('bad local header');
  const start = entry.localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  return zipBlob.slice(start, start + entry.size, type);
}

export async function unpackBundle(zipBlob) {
  // Fast path: slice the (stored) entries out of the blob without ever loading
  // the video bytes into JS memory.
  try {
    const entries = await zipDirectory(zipBlob);
    const metaEntry = entries.find((e) => e.name === 'strokes.json');
    const videoEntry = entries.find((e) => e.name.startsWith('video.'));
    if (metaEntry && videoEntry) {
      const meta = JSON.parse(await (await entrySlice(zipBlob, metaEntry, 'application/json')).text());
      const videoBlob = await entrySlice(zipBlob, videoEntry, meta.video?.mime || 'video/webm');
      return { meta, videoBlob };
    }
  } catch { /* re-zipped with compression, zip64, … — take the in-memory path */ }

  // Fallback: full in-memory unzip, for bundles re-zipped with compression.
  const bytes = new Uint8Array(await zipBlob.arrayBuffer());
  const files = unzipSync(bytes);
  const metaBytes = files['strokes.json'];
  if (!metaBytes) throw new Error('bundle is missing strokes.json');
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  const videoName = Object.keys(files).find((k) => k.startsWith('video.'));
  if (!videoName) throw new Error('bundle is missing the video file');
  const videoBlob = new Blob([files[videoName]], {
    type: meta.video?.mime || 'video/webm',
  });
  return { meta, videoBlob };
}

// --- Clock sync ---

// Video currentTime (seconds, coach clock) → rower-sample time (the domain the
// strokes live in). anchor = { startCoachPerf, rowerToCoachOffset }.
export function videoTimeToRowerTime(currentTime, anchor) {
  const coachPerf = anchor.startCoachPerf + currentTime * 1000;
  return coachPerf - (anchor.rowerToCoachOffset || 0);
}

// The stroke whose [startTime, time] window contains rowerTime, or null in a gap.
// Strokes are sorted by time; binary-search the window.
export function findStrokeAt(strokes, rowerTime) {
  if (!strokes || strokes.length === 0) return null;
  let lo = 0, hi = strokes.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strokes[mid].time >= rowerTime) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (ans < 0) return null; // past the last stroke
  const s = strokes[ans];
  return rowerTime >= s.startTime && rowerTime <= s.time ? s : null;
}

// --- Roll (boat heel / set) ---

// A time series of the boat's lateral lean for the analyzer's tilt indicator,
// taken from the rower phone's device-orientation stream. `gamma` is the
// left-right tilt (degrees); `beta` would be fore-aft pitch. We recentre on the
// median so an arbitrary phone-mount offset reads as level and the graphic shows
// heel *relative* to the boat's own average set. Returns [] when there's no
// orientation data (older bundles, permission denied). Same `t` domain as
// strokes, so rowerTime from videoTimeToRowerTime indexes straight in.
export function deriveRoll(meta) {
  const src = meta?.orientation;
  if (!Array.isArray(src) || src.length === 0) return [];
  const samples = [];
  for (const s of src) {
    if (s == null || s.gamma == null || s.t == null) continue;
    samples.push({ t: s.t, roll: s.gamma });
  }
  if (samples.length === 0) return [];
  samples.sort((a, b) => a.t - b.t);
  const median = [...samples].map((p) => p.roll).sort((a, b) => a - b)[samples.length >> 1];
  for (const p of samples) p.roll -= median;
  return samples;
}

// Interpolated roll (degrees, +starboard) at rowerTime, or null with no data.
export function rollAt(samples, t) {
  if (!samples || samples.length === 0) return null;
  if (t <= samples[0].t) return samples[0].roll;
  const last = samples[samples.length - 1];
  if (t >= last.t) return last.roll;
  let lo = 0, hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid - 1;
  }
  const a = samples[lo - 1], b = samples[lo];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return a.roll + (b.roll - a.roll) * f;
}

// --- Overlay rendering (shared: analyzer + burn-in export) ---

function formatSplit(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const meanCube = (a) => a.reduce((s, v) => s + v * v * v, 0) / a.length;
const REF_CATCH = catchStartIndex(REF_SPEEDS);

// Draw the current stroke's speed profile, progressively "drawn" up to `phase`
// (0..1 through the stroke window) with a leading playhead dot, plus a dashed
// equal-power potential curve and split/spm/free-speed readouts. Drawn within
// `rect` {x,y,w,h} over a translucent panel so it reads over video. `stroke` is
// a stroke object (with curve[], startTime, time, gpsSpeed, spm, freeSec) or null.
export function drawOverlay(ctx, rect, { stroke, phase, hasGPS = true } = {}) {
  const { x, y, w, h } = rect;
  // Translucent panel.
  ctx.save();
  ctx.fillStyle = 'rgba(15, 17, 26, 0.62)';
  ctx.fillRect(x, y, w, h);

  if (!stroke || !stroke.curve) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(h * 0.09)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('— between strokes —', x + w * 0.08, y + h * 0.5);
    ctx.restore();
    return;
  }

  const curve = stroke.curve;
  const N = curve.length;
  const strokeCatch = catchStartIndex(curve);
  // Align the reference's catch under this stroke's catch on the unrolled
  // (time-through-stroke) axis so both line up and the playhead sweeps L→R.
  const refAligned = curve.map((_, i) => REF_SPEEDS[(i + REF_CATCH - strokeCatch + N) % N]);
  const scale = meanCube(curve) > 0 ? Math.cbrt(meanCube(curve) / meanCube(REF_SPEEDS)) : 1;
  const pot = refAligned.map((v) => v * scale);

  const padL = w * 0.06, padR = w * 0.04, padT = h * 0.2, padB = h * 0.1;
  const plotX = x + padL, plotY = y + padT;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const ys = [...curve, ...pot];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = Math.max((hi - lo) * 0.1, 0.2);
  lo -= pad; hi += pad;
  const px = (i) => plotX + (i / (N - 1)) * plotW;
  const py = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Dashed potential.
  ctx.lineWidth = Math.max(1.5, h * 0.012);
  ctx.strokeStyle = 'rgba(75, 192, 192, 0.9)';
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  pot.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.stroke();
  ctx.setLineDash([]);

  // Stroke curve: faint full, bright up to the playhead.
  ctx.strokeStyle = 'rgba(102, 126, 234, 0.3)';
  ctx.beginPath();
  curve.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.stroke();

  const head = Math.max(0, Math.min(N - 1, Math.round((phase ?? 0) * (N - 1))));
  ctx.strokeStyle = '#8ea2ff';
  ctx.lineWidth = Math.max(2, h * 0.018);
  ctx.beginPath();
  for (let i = 0; i <= head; i++) (i ? ctx.lineTo(px(i), py(curve[i])) : ctx.moveTo(px(i), py(curve[i])));
  ctx.stroke();

  // Playhead dot.
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(px(head), py(curve[head]), Math.max(3, h * 0.025), 0, Math.PI * 2);
  ctx.fill();

  // Readouts.
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  const split = hasGPS && stroke.gpsSpeed > 0 ? `${formatSplit(500 / stroke.gpsSpeed)}/500m` : '';
  const spm = stroke.spm > 0 ? `${stroke.spm} spm` : '';
  const free = hasGPS && stroke.freeSec != null ? `+${stroke.freeSec.toFixed(1)}s/2k` : '';
  const parts = [split, spm, free].filter(Boolean).join('   ');
  // Size to height, then shrink to fit the panel width so the readout never
  // clips on a wide/tall overlay (e.g. full-width desktop).
  let fs = Math.round(h * 0.1);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const maxTextW = w - padL - padR;
  const textW = ctx.measureText(parts).width;
  if (textW > maxTextW) {
    fs = Math.max(10, Math.floor(fs * (maxTextW / textW)));
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
  }
  ctx.fillText(parts, plotX, y + h * 0.15);
  ctx.restore();
}

// --- Burn-in export ---

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// Re-render the source video with the synced overlay baked into the pixels,
// returning a self-contained Blob shareable in any player. Plays the source 1×
// into a canvas and records the canvas. Runs ~clip length; reports 0..1 progress.
export async function exportBurnIn(videoBlob, strokes, anchor, { onProgress } = {}) {
  const url = URL.createObjectURL(videoBlob);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('could not load video for export'));
    });

    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    const mimeType = pickRecorderMime();
    const fps = anchor.fps || 30;
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    // Overlay panel: top-left, ~30% of height.
    const rect = { x: w * 0.02, y: h * 0.02, w: w * 0.46, h: h * 0.3 };

    const renderFrame = (mediaTime) => {
      ctx.drawImage(video, 0, 0, w, h);
      const rowerTime = videoTimeToRowerTime(mediaTime, anchor);
      const stroke = findStrokeAt(strokes, rowerTime);
      const phase = stroke ? (rowerTime - stroke.startTime) / (stroke.time - stroke.startTime) : 0;
      drawOverlay(ctx, rect, { stroke, phase });
      onProgress?.(video.duration ? mediaTime / video.duration : 0);
    };

    const useRVFC = typeof video.requestVideoFrameCallback === 'function';

    const done = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    });

    rec.start();
    await video.play();

    await new Promise((resolve) => {
      if (useRVFC) {
        const step = (_now, meta) => {
          renderFrame(meta.mediaTime);
          if (video.ended) resolve();
          else video.requestVideoFrameCallback(step);
        };
        video.requestVideoFrameCallback(step);
      } else {
        const step = () => {
          renderFrame(video.currentTime);
          if (video.ended) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      video.onended = resolve;
    });

    rec.stop();
    return await done;
  } finally {
    URL.revokeObjectURL(url);
  }
}
