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
    grid: 'rgba(0,0,0,0.12)',
  },
  dark: {
    bg: '#000000', fg: '#ffffff', muted: '#9a9a9a',
    accent: '#ffd000', potential: 'rgba(255,255,255,0.35)', last: 'rgba(255,255,255,0.45)',
    grid: 'rgba(255,255,255,0.14)',
  },
};

function LiveBigScreen({ splitText, strokeRate, chartData, hasGPSAnchoring, onClose }) {
  const [theme, setTheme] = useState('sun');
  const c = THEMES[theme];
  const rootRef = useRef(null);

  // Go true full-screen where the platform allows it. The view works in both
  // orientations (numbers beside the graph in landscape, above it in portrait),
  // so we don't lock orientation — it follows the phone. iOS Safari supports
  // full-screen for non-video elements; the fixed-position overlay still covers
  // the viewport (and the whole screen as an installed PWA), so this degrades
  // gracefully — it just keeps the browser chrome.
  useEffect(() => {
    const el = rootRef.current;
    (async () => {
      try { if (el?.requestFullscreen) await el.requestFullscreen(); } catch { /* ignore */ }
    })();
    return () => {
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
    };
  }, []);

  // If the user leaves full-screen via a system gesture (swipe / Esc), keep
  // React state in sync by closing the overlay.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) onClose(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [onClose]);

  // Recolour and thicken the shared chart datasets for distance reading.
  const bigData = useMemo(() => ({
    datasets: (chartData.datasets || []).map((ds) => {
      const label = ds.label || '';
      const isPotential = /potential/i.test(label);
      const isLast = /last/i.test(label);
      const own = !isPotential && !isLast; // the rower's average / inspected stroke
      return {
        ...ds,
        borderColor: isPotential ? c.potential : isLast ? c.last : c.accent,
        backgroundColor: 'transparent',
        borderWidth: own ? 6 : isPotential ? 3 : 2.5,
        borderDash: isPotential ? [8, 8] : [],
        pointRadius: 0,
        fill: false,
        tension: 0.4,
      };
    }),
  }), [chartData, c]);

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
        ticks: { color: c.muted, font: { size: 18, weight: 'bold' }, maxTicksLimit: 5 },
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
