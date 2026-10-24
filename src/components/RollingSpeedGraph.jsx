import { useCallback, useEffect, useRef } from 'react';
import { drawOverlay } from '../utils/videoBundle';

// A canvas wrapper around drawOverlay (the rolling "EKG" speed trace). Two modes:
//   live: pass `getFrame` — an rAF loop pulls the freshest {series, rowerTime,
//         stroke, hasGPS} each frame so the trace scrolls smoothly from the live
//         buffer (liveSpeedSeries(proc)).
//   static: pass `series` + `rowerTime` (+ optional stroke/hasGPS) — painted on
//         change and on resize (review / analysis).
// `colors` overrides the palette (light big-screen theme); `showReadouts` false
// hides the in-canvas split/spm text when those live elsewhere on screen.
function RollingSpeedGraph({
  live = false, getFrame = null,
  series = null, rowerTime = null, stroke = null, hasGPS = true,
  windowSec = 6, colors = null, showReadouts = false, className = '',
}) {
  const canvasRef = useRef(null);

  const paint = useCallback((frame) => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawOverlay(ctx, { x: 0, y: 0, w, h }, {
      series: frame.series, rowerTime: frame.rowerTime, stroke: frame.stroke ?? null,
      hasGPS: frame.hasGPS ?? true, windowSec, colors, showReadouts,
    });
  }, [windowSec, colors, showReadouts]);

  // Live: animate from getFrame(). Static: paint once per prop change.
  useEffect(() => {
    if (live && getFrame) {
      let raf;
      const loop = () => { paint(getFrame()); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    paint({ series, rowerTime, stroke, hasGPS });
    return undefined;
  }, [live, getFrame, series, rowerTime, stroke, hasGPS, paint]);

  // Repaint the static view when the canvas box resizes.
  useEffect(() => {
    if (live) return undefined;
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => paint({ series, rowerTime, stroke, hasGPS }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [live, series, rowerTime, stroke, hasGPS, paint]);

  return <canvas ref={canvasRef} className={className} />;
}

export default RollingSpeedGraph;
