import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';

// Outdoor full-screen readout for the rower: just the split, the stroke rate,
// and the stroke speed profile, sized to be legible at arm's length without
// glasses. Two themes — "sun" (dark-on-white, maximum panel brightness for
// direct sunlight) and "dark" (light-on-black for dawn/dusk/night). Capture
// keeps running underneath; this is purely a presentation layer.
//
// Theme palettes. `accent` is the rower's own curve (the line that matters
// most); `potential` is the faint dashed reference; `last` is the most recent
// single stroke.
const THEMES = {
  sun: {
    bg: '#ffffff', fg: '#0a0a0a', muted: '#555555',
    accent: '#0040c0', potential: 'rgba(0,0,0,0.35)', last: 'rgba(0,0,0,0.4)',
    grid: 'rgba(0,0,0,0.12)', good: '#0a8f3c', warn: '#b06a00',
  },
  dark: {
    bg: '#000000', fg: '#ffffff', muted: '#9a9a9a',
    accent: '#ffd000', potential: 'rgba(255,255,255,0.35)', last: 'rgba(255,255,255,0.45)',
    grid: 'rgba(255,255,255,0.14)', good: '#3ad860', warn: '#ffb84d',
  },
};

function LiveBigScreen({ splitText, freeSpeed, strokeRate, chartData, hasGPSAnchoring, onClose }) {
  const [theme, setTheme] = useState('sun');
  // Locked orientation while full-screen. Defaults to landscape (the wide
  // readout layout); the rotate button toggles it. The CSS layout follows the
  // real orientation, so locking portrait re-flows the numbers above the graph.
  const [orientation, setOrientation] = useState('landscape');
  const c = THEMES[theme];
  const rootRef = useRef(null);

  // Go true full-screen and lock to landscape where the platform allows it.
  // Android only honours an orientation lock *while* full-screen, so the lock
  // must come after requestFullscreen() resolves — order matters. The view also
  // works in portrait (numbers above the graph instead of beside it), so if the
  // lock isn't supported (iOS Safari has no screen.orientation.lock) it just
  // degrades to following the phone. iOS Safari likewise lacks element
  // full-screen on phones; the fixed-position overlay still covers the viewport
  // (and the whole screen as an installed PWA), so that degrades gracefully too.
  useEffect(() => {
    const el = rootRef.current;
    (async () => {
      try { if (el?.requestFullscreen) await el.requestFullscreen(); } catch { /* ignore */ }
      // Must run after full-screen is active, or Android rejects it.
      try { await screen.orientation?.lock?.('landscape'); } catch { /* unsupported / rejected */ }
    })();
    return () => {
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
    };
  }, []);

  // Rotate button: flip the locked orientation. We're already full-screen here,
  // so the lock applies immediately; the layout re-flows via CSS. On platforms
  // without the lock (iOS) this no-ops and the view just stays as the phone is.
  const toggleOrientation = async () => {
    const next = orientation === 'landscape' ? 'portrait' : 'landscape';
    setOrientation(next);
    try { await screen.orientation?.lock?.(next); } catch { /* unsupported / rejected */ }
  };

  // If the user leaves full-screen via a system gesture (swipe / Esc), keep
  // React state in sync by closing the overlay.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) onClose(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [onClose]);

  // Recolour and thicken the shared chart datasets for distance reading.
  // The outdoor readout drops the running average — at arm's length the latest
  // stroke (and the potential it's chasing) is what matters — and phase-shifts
  // every curve so the cycle starts and ends at the peak speed instead of at
  // full reach, framing the drive in the middle of the graph.
  const bigData = useMemo(() => {
    const datasets = (chartData.datasets || []).filter(
      (ds) => !/average/i.test(ds.label || '')
    );
    // Peak of the rower's own line (latest / inspected stroke) sets the shift;
    // fall back to the first remaining line so something still anchors it.
    const ownDs = datasets.find((ds) => !/potential/i.test(ds.label || '')) || datasets[0];
    let shift = 0;
    if (ownDs?.data?.length > 1) {
      const period = ownDs.data.length - 1; // curves are periodic: point 0 == last
      let peakY = -Infinity;
      for (let i = 0; i < period; i++) {
        const y = ownDs.data[i].y;
        if (y != null && y > peakY) { peakY = y; shift = i; }
      }
    }
    // Re-index y so position 0 lands on the peak; x stays an even 0..1 sweep.
    // The endpoint wraps back to the peak (period modulo), keeping it periodic.
    const rotate = (data) => {
      if (!shift || !data || data.length < 2) return data;
      const period = data.length - 1;
      return data.map((pt, i) => ({ x: pt.x, y: data[(shift + i) % period].y }));
    };
    return {
      datasets: datasets.map((ds) => {
        const isPotential = /potential/i.test(ds.label || '');
        return {
          ...ds,
          data: rotate(ds.data),
          borderColor: isPotential ? c.potential : c.accent,
          backgroundColor: 'transparent',
          borderWidth: isPotential ? 3 : 6,
          borderDash: isPotential ? [8, 8] : [],
          pointRadius: 0,
          fill: false,
          tension: 0.4,
        };
      }),
    };
  }, [chartData, c]);

  const bigOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, title: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        type: 'linear', min: 0, max: 1,
        ticks: { display: false },
        grid: { color: c.grid },
        border: { color: c.grid },
      },
      y: {
        ...(hasGPSAnchoring ? {} : { min: 2, max: 8 }),
        // Units add nothing at arm's length — the curve shape is the message.
        ticks: { display: false },
        grid: { color: c.grid },
        border: { color: c.grid },
      },
    },
  }), [c, hasGPSAnchoring]);

  return (
    <div
      ref={rootRef}
      className={`bigscreen theme-${theme}`}
      style={{ background: c.bg, color: c.fg }}
    >
      <div className="bigscreen-controls">
        <button
          className="bigscreen-ctrl"
          onClick={toggleOrientation}
          aria-label={`Switch to ${orientation === 'landscape' ? 'portrait' : 'landscape'}`}
          title="Rotate"
        >
          {'⟳'}
        </button>
        <button
          className="bigscreen-ctrl"
          onClick={() => setTheme((t) => (t === 'sun' ? 'dark' : 'sun'))}
          aria-label="Toggle day/night"
        >
          {theme === 'sun' ? '☾' : '☀'}
        </button>
        <button className="bigscreen-ctrl" onClick={onClose} aria-label="Exit full screen">
          {'✕'}
        </button>
      </div>

      <div className="bigscreen-metrics">
        <div className="bigscreen-metric">
          <div className="bigscreen-value bigscreen-split" style={{ color: c.accent }}>{splitText}</div>
          <div className="bigscreen-label" style={{ color: c.muted }}>/500m</div>
          {freeSpeed != null && (
            <div className="bigscreen-delta" style={{ color: freeSpeed > 0.005 ? c.warn : c.good }}>
              {(freeSpeed >= 0 ? '+' : '−') + Math.abs(freeSpeed).toFixed(2) + ' m/s'}
              {' '}
              <span className="bigscreen-delta-cap" style={{ color: c.muted }}>free speed</span>
            </div>
          )}
        </div>
        <div className="bigscreen-metric">
          <div className="bigscreen-value bigscreen-spm">{strokeRate || '—'}</div>
          <div className="bigscreen-label" style={{ color: c.muted }}>spm</div>
        </div>
      </div>

      <div className="bigscreen-graph">
        <Line data={bigData} options={bigOptions} />
      </div>
    </div>
  );
}

export default LiveBigScreen;
