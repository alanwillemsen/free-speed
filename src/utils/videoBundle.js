// Video analysis bundle: a coach films the rower while connected, and the stroke
// data (raw recording) is paired with the video via a shared clock anchor. The
// pair is packaged as a plain, inspectable ZIP (strokes.json + the video file)
// so it can be downloaded, shared, and re-opened in the analyzer on any device.
//
// This module also owns the clock math that bridges the two time domains and the
// canvas overlay renderer shared by the live analyzer and the burn-in exporter.

import { zipSync, unzipSync } from 'fflate';

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

const ROLL_LP_ALPHA = 0.3; // light low-pass on the roll angle — trims residual jitter

// A time series of the boat's lateral lean (heel / set) for the analyzer's tilt
// indicator. Model: the phone is mounted landscape and roughly level port-to-
// starboard, so boat heel is rotation about the device x-axis — which in the W3C
// device-orientation convention is `beta`. We use the OS sensor-fusion's beta
// directly: it's far steadier than differencing raw acceleration, and because it's
// rotation about x it's immune to bow-stern (fore-aft) mount pitch — that tilt
// lives on gamma and never enters beta. (The old indicator used gamma, which for a
// landscape mount reads the fore-aft tilt, not heel.) We lightly low-pass it and
// recentre on the median so an arbitrary mount offset reads as level. Falls back to
// gamma only if beta is absent. Times are the rower clock (ms) — rowerTime indexes
// straight in.
export function deriveRoll(recording) {
  const src = recording?.orientation;
  if (!Array.isArray(src) || src.length === 0) return [];
  const key = src.some((o) => o && o.beta != null) ? 'beta' : 'gamma';
  const raw = src.filter((o) => o && o[key] != null && o.t != null).sort((a, b) => a.t - b.t);
  if (raw.length === 0) return [];

  const samples = [];
  let r = null;
  for (const o of raw) {
    r = r == null ? o[key] : r + ROLL_LP_ALPHA * (o[key] - r);
    samples.push({ t: o.t, roll: r });
  }
  // Recentre on the median so it reads heel relative to the boat's own average set.
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

// Gap (ms) between adjacent speed samples above which we treat the boat as not
// rowing (dropped strokes / out of the pace band) and break the trace rather
// than drawing a long straight bridge across it.
const SERIES_GAP_MS = 700;

// The rolling-graph series is now built by deriveSpeedSeries (strokePipeline.js) —
// a continuous integration of fore-aft acceleration, independent of stroke
// boundaries. This module just renders whatever {samples, lo, hi} it's handed.

// Interpolated speed at rower-time `t`, or null when `t` is outside the series or
// sits inside a no-rowing gap (so the playhead simply disappears there).
function sampleSpeedAt(samples, t) {
  if (!samples || samples.length < 2) return null;
  if (t < samples[0].t || t > samples[samples.length - 1].t) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid - 1;
  }
  const a = samples[lo - 1], b = samples[lo];
  if (!a || !b || b.t - a.t > SERIES_GAP_MS) return null;
  const f = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * f;
}

// Default rolling-graph palette (tuned for a dark card over video). Callers on a
// light background (the outdoor big screen's "sun" theme) pass overrides.
export const OVERLAY_COLORS = {
  panel: 'rgba(15, 17, 26, 0.62)',
  muted: 'rgba(255,255,255,0.6)',
  grid: 'rgba(255,255,255,0.06)',
  trace: '#8ea2ff',
  avg: 'rgba(255,214,102,0.85)',
  playhead: 'rgba(255,255,255,0.35)',
  dot: '#ef4444',
  text: '#fff',
};

// Draw the speed as a rolling "EKG" trace: the most recent `windowSec` seconds
// of boat speed, scrolling right-to-left with the current instant pinned at the
// right edge as a moving playhead. `series` comes from deriveSpeedSeries /
// liveSpeedSeries; `rowerTime` (ms) is the playhead time; `stroke` is the stroke
// under the playhead, used only for the split / spm / free-speed readouts.
// `colors` overrides the palette; `showReadouts` false hides the text line (when
// the split/spm live elsewhere on screen). Drawn within `rect` {x,y,w,h}.
export function drawOverlay(ctx, rect, { series, rowerTime, windowSec = 4, stroke = null, hasGPS = true, colors, showReadouts = true } = {}) {
  const { x, y, w, h } = rect;
  const col = colors ? { ...OVERLAY_COLORS, ...colors } : OVERLAY_COLORS;
  // Translucent panel.
  ctx.save();
  ctx.fillStyle = col.panel;
  ctx.fillRect(x, y, w, h);

  const samples = series?.samples;
  if (!samples || samples.length < 2 || rowerTime == null) {
    ctx.fillStyle = col.muted;
    ctx.font = `${Math.round(h * 0.09)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('— no speed data —', x + w * 0.08, y + h * 0.5);
    ctx.restore();
    return;
  }

  const padL = w * 0.06, padR = w * 0.04, padT = h * 0.2, padB = h * 0.1;
  const plotX = x + padL, plotY = y + padT;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const t1 = rowerTime;                    // right edge = now
  const t0 = rowerTime - windowSec * 1000; // left edge = windowSec ago
  const { lo, hi } = series;
  const span = hi - lo || 1;
  const tx = (t) => plotX + ((t - t0) / (t1 - t0)) * plotW;
  const vy = (v) => plotY + plotH - ((v - lo) / span) * plotH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();

  // Time-anchored gridlines at each whole rower-second: they slide left with the
  // trace, selling the scrolling motion.
  ctx.strokeStyle = col.grid;
  ctx.lineWidth = 1;
  for (let s = Math.ceil(t0 / 1000); s <= Math.floor(t1 / 1000); s++) {
    const gx = tx(s * 1000);
    ctx.beginPath(); ctx.moveTo(gx, plotY); ctx.lineTo(gx, plotY + plotH); ctx.stroke();
  }

  // The scrolling speed trace, broken across no-rowing gaps.
  ctx.strokeStyle = col.trace;
  ctx.lineWidth = Math.max(2, h * 0.02);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let prev = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.t > t1) break;                                  // don't draw the future
    const next = samples[i + 1];
    if (s.t < t0 && next && next.t < t0) { prev = s; continue; } // skip old, keep the bridge-in point
    if (!prev || s.t - prev.t > SERIES_GAP_MS) ctx.moveTo(tx(s.t), vy(s.v));
    else ctx.lineTo(tx(s.t), vy(s.v));
    prev = s;
  }
  ctx.stroke();

  // Average line: the mean speed across the visible window, drawn as a dashed
  // horizontal reference so the trace's fluctuation reads against its own average.
  let sum = 0, n = 0;
  for (const s of samples) {
    if (s.t < t0) continue;
    if (s.t > t1) break;
    sum += s.v; n++;
  }
  if (n > 0) {
    const avg = sum / n;
    const ay = vy(avg);
    ctx.strokeStyle = col.avg;
    ctx.lineWidth = Math.max(1.5, h * 0.012);
    ctx.setLineDash([Math.max(4, w * 0.02), Math.max(3, w * 0.015)]);
    ctx.beginPath(); ctx.moveTo(plotX, ay); ctx.lineTo(plotX + plotW, ay); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore(); // drop the plot clip

  // Playhead: a faint "now" line down the right edge and a dot at the current
  // speed (only while there's live data under it).
  ctx.strokeStyle = col.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(plotX + plotW, plotY); ctx.lineTo(plotX + plotW, plotY + plotH); ctx.stroke();
  const nowV = sampleSpeedAt(samples, rowerTime);
  if (nowV != null) {
    ctx.fillStyle = col.dot;
    ctx.beginPath();
    ctx.arc(plotX + plotW, vy(nowV), Math.max(3, h * 0.025), 0, Math.PI * 2);
    ctx.fill();
  }

  // Readouts (skipped when the split / spm are shown elsewhere on screen).
  if (showReadouts) {
    ctx.fillStyle = col.text;
    ctx.textBaseline = 'alphabetic';
    const split = hasGPS && stroke?.splitMps > 0 ? `${formatSplit(500 / stroke.splitMps)}/500m` : '';
    const spm = stroke?.spm > 0 ? `${stroke.spm} spm` : '';
    const free = hasGPS && stroke?.freeSec != null ? `+${stroke.freeSec.toFixed(1)}s/2k` : '';
    const parts = [split, spm, free].filter(Boolean).join('   ');
    // Size to height, then shrink to fit the panel width so the readout never
    // clips on a wide/tall overlay (e.g. full-width desktop).
    let fs = Math.round(h * 0.1);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    const maxTextW = w - padL - padR;
    const textW = ctx.measureText(parts).width;
    if (textW > maxTextW && textW > 0) {
      fs = Math.max(10, Math.floor(fs * (maxTextW / textW)));
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
    }
    ctx.fillText(parts, plotX, y + h * 0.15);
  }
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
export async function exportBurnIn(videoBlob, series, strokes, anchor, { onProgress } = {}) {
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
      drawOverlay(ctx, rect, { series, rowerTime, stroke });
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
