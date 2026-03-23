import { useState, useEffect } from 'react';

const STORAGE_KEY = 'freespeed_curves';

export function encodeCurve(name, desc, speeds, raceTime, strokeRate) {
  const payload = {
    v: 1,
    name,
    desc,
    speeds: speeds.map(s => Math.round(s * 10000) / 10000),
    raceTime,
    strokeRate,
  };
  const json = JSON.stringify(payload);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCurve(encoded) {
  try {
    const json = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    if (payload.v !== 1 || !Array.isArray(payload.speeds)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseShareHash() {
  const hash = window.location.hash;
  const match = hash.match(/^#s=(.+)$/);
  if (!match) return null;
  return decodeCurve(match[1]);
}

export const EXAMPLE_CURVES = [
  {
    id: 'example-micro-pause',
    isExample: true,
    name: 'Micro Pause',
    desc: 'Rower B is delaying the hands-away which forces a rushed slide to maintain the rate',
    speeds: [4.3404,3.908,3.5189,3.3027,3.346,3.4757,3.6054,3.7351,3.8648,4.0377,4.1674,4.2971,4.4268,4.5133,4.5565,4.5998,4.5825,4.5565,4.5142,4.4379,4.3921,4.4734,4.7578,5.0885,5.4532,5.7848,5.8086,5.5911,5.2258,4.8973,4.5928,4.3836,4.3404],
    raceTime: 450,
    strokeRate: 36,
  },
  {
    id: 'example-slow-catch',
    isExample: true,
    name: 'Slow Catch',
    desc: 'Rower B is hanging at the catch or missing water',
    speeds: [4.479,4.0329,3.543,3.0167,2.5467,2.4749,2.9083,3.3935,3.7446,3.9913,4.2439,4.4344,4.5683,4.6575,4.7021,4.7467,4.7289,4.7021,4.6753,4.7913,4.9252,5.059,5.1929,5.3267,5.4606,5.5498,5.532,5.416,5.1929,4.9252,4.7021,4.5236,4.479],
    raceTime: 450,
    strokeRate: 22,
  },
  {
    id: 'example-no-ratio',
    isExample: true,
    name: 'No Ratio',
    desc: 'Rower B drive time is same as recovery',
    speeds: [4.1838,3.7671,3.392,3.1836,3.2253,3.3312,3.4257,3.5871,3.7357,3.8717,4.0058,4.1665,4.3014,4.3967,4.5143,4.604,4.7063,4.7532,4.8108,4.7787,4.6979,4.7041,4.9632,5.2778,5.4802,5.6269,5.672,5.5588,5.3825,5.1062,4.7757,4.4815,4.1838],
    raceTime: 450,
    strokeRate: 22,
  },
];

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function SavedCurves({ onLoad, onNew, onDuplicate, viewingCurveId, refreshKey }) {
  const [saved, setSaved] = useState(loadSaved);

  // Reload when another part of the app saves a new curve
  useEffect(() => {
    setSaved(loadSaved());
  }, [refreshKey]);

  // Keep list fresh if another tab changes it
  useEffect(() => {
    const handler = () => setSaved(loadSaved());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const handleDuplicate = (entry, e) => {
    e.stopPropagation();
    const copy = { ...entry, id: Date.now(), name: `${entry.name} (copy)`, savedAt: new Date().toISOString() };
    const next = [copy, ...saved];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
  };

  const handleDelete = (id, e) => {
    e.stopPropagation();
    const entry = saved.find(s => s.id === id);
    if (!window.confirm(`Delete "${entry?.name ?? 'this curve'}"?`)) return;
    const next = saved.filter(s => s.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
  };

  return (
    <nav className="left-nav">
      <div className="nav-section-label">Examples</div>
      <div className="nav-curve-list nav-curve-list-fixed">
        {EXAMPLE_CURVES.map(entry => (
          <button
            key={entry.id}
            className={`nav-curve-item${entry.id === viewingCurveId ? ' active' : ''}`}
            onClick={() => onLoad(entry)}
          >
            <span className="nav-curve-name">{entry.name}</span>
            {entry.desc && <span className="nav-curve-desc">{entry.desc}</span>}
            <span className="nav-curve-actions">
              <span
                className="nav-curve-action"
                role="button"
                onClick={(e) => { e.stopPropagation(); onDuplicate(entry); }}
                title="Copy to saved curves"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="nav-section-label nav-section-label-row">
        <span>Saved Curves</span>
        <button className="btn btn-primary btn-new-curve" onClick={onNew}>+ New</button>
      </div>

      <div className="nav-curve-list">
        {saved.length === 0 && (
          <p className="nav-empty">No saved curves yet.</p>
        )}
        {saved.map(entry => (
          <button
            key={entry.id}
            className={`nav-curve-item${entry.id === viewingCurveId ? ' active' : ''}`}
            onClick={() => onLoad(entry)}
          >
            <span className="nav-curve-name">{entry.name}</span>
            {entry.desc && <span className="nav-curve-desc">{entry.desc}</span>}
            <span className="nav-curve-actions">
              <span
                className="nav-curve-action"
                role="button"
                onClick={(e) => handleDuplicate(entry, e)}
                title="Duplicate"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </span>
              <span
                className="nav-curve-action nav-curve-delete"
                role="button"
                onClick={(e) => handleDelete(entry.id, e)}
                title="Delete"
              >✕</span>
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export default SavedCurves;
