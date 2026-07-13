import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { resolveTheme } from '../hooks/useTheme';
import { useWakeLock } from '../hooks/useWakeLock';
import NavMap from './NavMap';

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

// Persisted panel choice (map vs. stroke graph) for the big-screen readout.
const PANEL_KEY = 'freespeed_bigscreen_panel';

function LiveBigScreen({ splitText, freeSpeedSeconds, avgFreeSpeedSeconds, strokeRate, pieceDistance, sessionDistance, onResetPiece, chartData, hasGPSAnchoring, track, onClose }) {
  // Seed from the app theme (dark app → dark readout for night rows), then let
  // the rower flip it with the on-screen toggle — at arm's length in changing
  // light they may want the opposite of the app chrome.
  const [theme, setTheme] = useState(() => (resolveTheme() === 'dark' ? 'dark' : 'sun'));
  // Locked orientation while full-screen. Defaults to landscape (the wide
  // readout layout); the rotate button toggles it. The CSS layout follows the
  // real orientation, so locking portrait re-flows the numbers above the graph.
  const [orientation, setOrientation] = useState('landscape');
  // The graph panel doubles as a course-down navigation map — the rower faces
  // the stern, so the map steers for them (see NavMap). Map by default; the
  // last choice sticks across sessions so the readout opens the way they row.
  const [panel, setPanel] = useState(() => {
    try { return localStorage.getItem(PANEL_KEY) === 'graph' ? 'graph' : 'map'; }
    catch { return 'map'; }
  });
  const togglePanel = () => setPanel((p) => {
    const next = p === 'graph' ? 'map' : 'graph';
    try { localStorage.setItem(PANEL_KEY, next); } catch { /* private mode */ }
    return next;
  });
  const c = THEMES[theme];
  const rootRef = useRef(null);

  // Long-press the piece distance to reset it (start a new piece). ~600 ms so a
  // stray tap on the water doesn't zero it. Brief flash confirms the reset.
  const holdTimerRef = useRef(null);
  const [pieceFlash, setPieceFlash] = useState(false);
  const beginPieceHold = () => {
    cancelPieceHold();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      onResetPiece?.();
      setPieceFlash(true);
      setTimeout(() => setPieceFlash(false), 350);
    }, 600);
  };
  const cancelPieceHold = () => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  };
  useEffect(() => cancelPieceHold, []);

  // Keep the screen awake for as long as the readout is up. The rower stares
  // at it without touching the screen, and capture/coach mode aren't always
  // the ones holding a lock (the readout opens from any state), so it holds
  // its own. useWakeLock re-acquires after the phone blinks off or backgrounds.
  const { request: wakeLockRequest, release: wakeLockRelease } = useWakeLock();
  useEffect(() => {
    wakeLockRequest();
    return () => wakeLockRelease();
  }, [wakeLockRequest, wakeLockRelease]);

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

  const bigOptions = useMemo(() => {
   // Phase (0..1) × the average stroke period reads out as elapsed seconds.
   const periodMs = strokeRate > 0 ? 60000 / strokeRate : null;
   return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, title: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        type: 'linear', min: 0, max: 1,
        ticks: periodMs
          ? { color: c.muted, font: { size: 16, weight: 'bold' }, maxTicksLimit: 10,
              callback: (val) => (val * periodMs / 1000).toFixed(2) }
          : { display: false },
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
   };
  }, [c, hasGPSAnchoring, strokeRate]);

  // Free speed as a signed seconds-per-2k string: "+1.2 s" / "−0.4 s".
  const fmtFree = (s) => (s >= 0 ? '+' : '−') + Math.abs(s).toFixed(1) + ' s';

  // The four metric groups, composed differently per panel: graph mode puts
  // split + SPM on a full-width top row; map mode packs all four in a grid
  // beside a narrow full-height map (the river is course-down, i.e. vertical —
  // a tall sliver shows the river, and any extra width only adds shoreline
  // streets at the cost of number size).
  const splitMetric = (
    <div className="bigscreen-metric">
      <div className="bigscreen-value bigscreen-split" style={{ color: c.accent }}>{splitText}</div>
      <div className="bigscreen-label" style={{ color: c.muted }}>/500m</div>
    </div>
  );
  const spmMetric = (
    <div className="bigscreen-metric">
      <div className="bigscreen-value bigscreen-spm">{strokeRate || '—'}</div>
      <div className="bigscreen-label" style={{ color: c.muted }}>spm</div>
    </div>
  );
  const freeSpeedMetric = (
    <div className="bigscreen-metric">
      <div
        className="bigscreen-value bigscreen-freespeed"
        style={{ color: freeSpeedSeconds == null ? c.muted : freeSpeedSeconds > 0.5 ? c.warn : c.good }}
      >
        {freeSpeedSeconds == null ? '—' : fmtFree(freeSpeedSeconds)}
      </div>
      <div className="bigscreen-label" style={{ color: c.muted }}>untapped / 2k</div>
      {avgFreeSpeedSeconds != null && (
        <div
          className="bigscreen-value bigscreen-freespeed bigscreen-freespeed-avg"
          style={{ color: avgFreeSpeedSeconds > 0.5 ? c.warn : c.good }}
        >
          {fmtFree(avgFreeSpeedSeconds)}
          {' '}
          <span className="bigscreen-delta-cap" style={{ color: c.muted }}>avg</span>
        </div>
      )}
    </div>
  );
  // Distance — long-press to start a new piece (resets the free-speed avg).
  const distanceMetric = (
    <div className="bigscreen-metric">
      <div
        className="bigscreen-distance"
        onPointerDown={beginPieceHold}
        onPointerUp={cancelPieceHold}
        onPointerLeave={cancelPieceHold}
        onPointerCancel={cancelPieceHold}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: 'pointer', userSelect: 'none', touchAction: 'none' }}
        title="Hold to reset the piece"
      >
        <div className="bigscreen-distance-piece" style={{ color: pieceFlash ? c.good : c.fg }}>
          {Math.round(pieceDistance || 0).toLocaleString()} m
          {' '}
          <span className="bigscreen-delta-cap" style={{ color: c.muted }}>piece · hold to reset</span>
        </div>
        <div className="bigscreen-distance-total" style={{ color: c.muted }}>
          {Math.round(sessionDistance || 0).toLocaleString()} m{' '}
          <span className="bigscreen-delta-cap">total</span>
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`bigscreen theme-${theme}${panel === 'map' ? ' panel-map' : ''}`}
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
          onClick={togglePanel}
          aria-label={panel === 'graph' ? 'Show navigation map' : 'Show stroke profile'}
          title={panel === 'graph' ? 'Navigation map' : 'Stroke profile'}
        >
          {panel === 'graph' ? '⌖' : '∿'}
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

      {/* Graph mode: split (left) and SPM (right) span the full width up top —
          the two big numbers the rower steers by. Map mode skips the top row
          so the map gets that height too. */}
      {panel !== 'map' && (
        <div className="bigscreen-toprow">
          {splitMetric}
          {spmMetric}
        </div>
      )}

      <div className="bigscreen-body">
        <div className="bigscreen-metrics">
          {panel === 'map' && splitMetric}
          {panel === 'map' && spmMetric}
          {freeSpeedMetric}
          {distanceMetric}
        </div>

        <div className="bigscreen-graph">
          {panel === 'map'
            ? <NavMap track={track || []} accent={c.accent} trackColor={c.last} />
            : <Line data={bigData} options={bigOptions} />}
        </div>
      </div>
    </div>
  );
}

export default LiveBigScreen;
